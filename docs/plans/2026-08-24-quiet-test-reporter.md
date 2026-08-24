# Quiet test reporter — implementation plan

Spec: `docs/specs/2026-08-24-quiet-test-reporter-design.md`

## Global Constraints

- Node >= 20
- Zero new runtime dependencies
- No shell pipelines in npm scripts — Windows CI runs them under `cmd.exe`
- Commit messages: conventional-commit style, English

## Destination

`npm test` reports failures and one summary line instead of 1,843 pass lines, so the command
every agent is told to run stops being the largest single source of context in a fleet run —
measured at ~40,372 tokens today, ~99 with the reporter in place.

## Not Yet Specified

- Should the gate manifest's `test` check re-run with `test:verbose` when a phase FAILS, so the
  retry captures maximum detail?
- Does the summary line's format need to stay stable for anything that greps it, or is it for
  human and agent reading only?

## Out of Scope

- Capping how many times the `claims` lens re-runs the suite — that is a question about that
  lens's mutation budget, not about how the runner reports.
- Trimming skills, agent definitions or briefs — a real lever, since context is re-read per
  turn, but a different change with different risks and its own measurements.
- A `usage` CLI subcommand reporting per-run token totals — worth building, and the transcripts
  already carry the data, but not needed to make this change or to measure it.
- Reducing agent output tokens — the existing `caveman` setting targets those, and measured it
  makes a brief 3% larger on the input side.

### Task 1: the quiet reporter module

**Files:**
- Create: `scripts/quiet-reporter.mjs`
- Test: `tests/quiet-reporter.test.mjs`

**Model:** mid

- [ ] **Step 1:** Create `scripts/quiet-reporter.mjs` exporting a default async generator
      `quietReporter(source)`. It consumes Node test-runner events and yields strings. Hold
      exactly two pieces of state: `rootSummary` (initially `null`) and nothing else derived
      from counting.

- [ ] **Step 2:** For each event, handle these types and ignore all others:

      ```js
      export default async function* quietReporter(source) {
        let rootSummary = null
        for await (const event of source) {
          if (event.type === 'test:fail') {
            yield renderFailure(event.data)
            continue
          }
          if (event.type === 'test:stderr' || event.type === 'test:stdout') {
            yield event.data.message
            continue
          }
          // The ROOT summary is the one with no `file`: the runner emits one per file and one
          // for the whole run. Counting test:pass events instead inflates the total, because a
          // parent suite emits its own alongside its children — measured at 5 where the truth
          // was 4. The evidence rule depends on this number being true.
          if (event.type === 'test:summary' && event.data.file === undefined) {
            rootSummary = event.data
          }
        }
        yield renderSummary(rootSummary)
      }
      ```

- [ ] **Step 3:** Add `renderFailure(data)` above the generator. It returns the failure name and
      the error's stack, and never abbreviates:

      ```js
      // Failure detail is never shortened. The saving in this reporter comes entirely from the
      // success path; an error report that dropped a stack to save tokens would trade the only
      // output anyone actually reads for the output nobody does.
      function renderFailure(data) {
        const error = data.details?.error
        const body = error?.stack ?? error?.message ?? String(error)
        return `✖ ${data.name}\n${body}\n\n`
      }
      ```

- [ ] **Step 4:** Add `renderSummary(summary)` above the generator:

      ```js
      // Printed on green AND red. It is what satisfies this project's evidence rule — a claim
      // that tests pass requires output showing the count and zero failures — so a reporter that
      // summarised only on success would leave a failing run unable to state its own counts.
      // `success` is reported beside the counts so a run can never read as green while its exit
      // code says otherwise.
      function renderSummary(summary) {
        if (!summary) return '\nno test summary was emitted; treat this run as failed\n'
        const c = summary.counts
        const parts = [
          `${c.tests} tests`,
          `${c.passed} pass`,
          `${c.failed} fail`,
          `${c.skipped} skipped`,
        ]
        if (c.cancelled > 0) parts.push(`${c.cancelled} cancelled`)
        if (c.todo > 0) parts.push(`${c.todo} todo`)
        return `\n${parts.join(' | ')}${summary.success ? '' : '  FAILED'}\n`
      }
      ```

- [ ] **Step 5:** Write `tests/quiet-reporter.test.mjs`. Drive the generator directly with a
      hand-built async iterable of event objects, so the tests do not depend on spawning a child
      process. Add a helper:

      ```js
      async function collect(events) {
        async function* source() { for (const e of events) yield e }
        let out = ''
        for await (const chunk of quietReporter(source())) out += chunk
        return out
      }
      ```

- [ ] **Step 6:** Add a test `a green run prints only the summary line`: feed three `test:pass`
      events and a root `test:summary` with
      `counts: { tests: 3, passed: 3, failed: 0, skipped: 0, cancelled: 0, todo: 0 }` and
      `success: true`. Assert the output equals `'\n3 tests | 3 pass | 0 fail | 0 skipped\n'`
      and that it does not match `/test:pass|✔/`.

- [ ] **Step 7:** Add a test `counts come from the root summary, not from tallying pass events`.
      This is the case the naive implementation gets wrong, so it is pinned directly: feed five
      `test:pass` events (mimicking two leaves, a suite, a subtest and its parent), a per-file
      `test:summary` carrying `file: '/x.test.mjs'` with `counts.tests: 99`, and a root
      `test:summary` with no `file` and `counts: { tests: 4, passed: 4, failed: 0, skipped: 0,
      cancelled: 0, todo: 0 }`. Assert the output reports `4 tests | 4 pass`, and assert it
      does not match `/5 tests/` nor `/99 tests/` — the first catches tallying, the second
      catches using the per-file summary instead of the root.

- [ ] **Step 8:** Add a test `a failing run prints the failure and still prints the summary`:
      feed a `test:fail` event whose
      `data = { name: 'breaks', details: { error: Object.assign(new Error('boom'), { stack: 'Error: boom\n    at x.mjs:1:1' }) } }`
      and a root `test:summary` with `counts.failed: 1`, `success: false`. Assert the output
      contains `✖ breaks`, contains `at x.mjs:1:1`, contains `1 fail`, and contains `FAILED`.

- [ ] **Step 9:** Add a test `stderr and stdout pass through verbatim`: feed
      `{ type: 'test:stderr', data: { message: 'a real warning\n' } }` and
      `{ type: 'test:stdout', data: { message: 'printed by a test\n' } }` plus a root summary.
      Assert the output contains both messages exactly.

- [ ] **Step 10:** Add a test `a run that emits no root summary is reported as failed`: feed
      only a per-file `test:summary` carrying `file: '/x.test.mjs'`, and no root summary. Assert
      the output matches `/treat this run as failed/`. A reporter that silently printed nothing
      here would let a crashed run read as clean output.

- [ ] **Step 11:** Add a test `skipped tests are counted and not named`: feed a root summary with
      `counts: { tests: 5, passed: 3, failed: 0, skipped: 2, cancelled: 0, todo: 0 }` and two
      `test:pass` events whose `data.skip` is `true` and whose names are `'skipped one'` and
      `'skipped two'`. Assert the output contains `2 skipped` and does not match
      `/skipped one|skipped two/`.

- [ ] **Step 12:** Add an end-to-end test `the reporter drives a real run and preserves exit
      codes`. The tests above drive the generator directly and so never observe an exit code,
      which the spec's contract names for both outcomes. Write two fixture files into
      `mkdtemp(path.join(tmpdir(), 'tm-quiet-'))` — one whose single test passes, one whose
      single test throws — and run each with
      `execFileSync('node', ['--test', '--test-reporter', reporterPath, fixture])`, capturing
      status and stdout. Assert the green fixture exits 0 and its stdout matches
      `/1 tests \| 1 pass \| 0 fail/`; assert the red fixture exits 1, its stdout contains
      `✖`, and it still carries a summary line. Remove the temp directory in a `finally`.

### Task 2: wire the reporter into npm test

**Files:**
- Modify: `package.json`
- Test: `tests/npm-scripts.test.mjs`

**Depends:** T1

- [ ] **Step 1:** In `package.json`, replace the `test` script and add `test:verbose`:

      ```json
      "scripts": {
        "test": "node --test --test-reporter=./scripts/quiet-reporter.mjs tests/*.test.mjs",
        "test:verbose": "node --test tests/*.test.mjs"
      }
      ```

- [ ] **Step 2:** Create `tests/npm-scripts.test.mjs`. Read `package.json` and assert the `test`
      script names `./scripts/quiet-reporter.mjs` via `--test-reporter`, and that
      `scripts/quiet-reporter.mjs` exists on disk. This pins the wiring: the reporter passing its
      own unit tests proves nothing about whether `npm test` actually uses it.

- [ ] **Step 3:** Add a test to `tests/npm-scripts.test.mjs` asserting neither script contains a
      shell pipe, `>` redirect, `&&`, or `grep`. Windows CI runs npm scripts under `cmd.exe`,
      where such a pipeline behaves differently or not at all, and this repository's CI has
      already been broken once by a platform assumption. Assert with
      `assert.doesNotMatch(script, /[|>]|&&|\bgrep\b/)` for both `test` and `test:verbose`.

- [ ] **Step 4:** Add a test to `tests/npm-scripts.test.mjs` asserting `test:verbose` does NOT
      name a `--test-reporter`, so the escape hatch to full spec output cannot silently become
      another quiet run.

### Task 3: record the reporter in the contributor docs

**Files:**
- Modify: `README.md`
- Test: `tests/skills.test.mjs`

**Depends:** T1

- [ ] **Step 1:** In `README.md`, in the section describing how to run the test suite, state that
      `npm test` prints failures and a one-line summary, and that `npm run test:verbose` prints
      the full per-test output. Give the reason in one sentence: the suite's per-test lines were
      ~40,000 tokens of context that every agent running the command paid for on every
      subsequent turn.

- [ ] **Step 2:** Add a test to `tests/skills.test.mjs` asserting `README.md` mentions
      `test:verbose`. Without it a contributor hitting a confusing failure has no documented way
      back to the detailed output, and the reporter looks like the suite has gone silent.
