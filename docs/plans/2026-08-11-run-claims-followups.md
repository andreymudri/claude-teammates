# Follow-ups from run `claims`

Source: the 45 review findings of run `claims`. This plan carries only the items no task in that
run could reach, because the file that had to change belonged to no task's declared set. Run
`claims` is held unlanded at `run/claims` (`09f5ad9`) until these land, so one coherent branch
lands rather than a branch plus a list.

Every defect below was reproduced by execution during that run. The reproduction is quoted in the
task, so no step rests on a description of a bug nobody ran.

## Global Constraints

- Node >= 24.2.0
- Zero runtime dependencies and zero dev dependencies; tests use the built-in `node:test` runner
- git >= 2.24; every git invocation passes `--end-of-options`, and a trailing `--` wherever the
  command accepts a pathspec. One tested exception exists: `git status --porcelain --ignored`
  returns nothing when given `--end-of-options --` on git 2.53, so `scripts/git.mjs`'s
  `ignoredPaths` deliberately omits both and a test pins their absence. Measure before adding a
  second exception; do not assume one.
- Commit messages: single-line, commitlint style, English
- No check may read anything under `.teammates/`; that state is written by the agents being enforced
- Run the suite from a Git Bash shell, in the FOREGROUND. Under PowerShell 29 hook tests fail for
  environment reasons — which Task 4 exists to fix. Never background the test command: three
  teammates were lost that way in run `claims`.
- A comment states what the code does, never a guarantee it does not deliver. Run `claims`
  produced eight instances of the opposite in one task, four of them in tests rather than
  comments, and every one was found by mutating something rather than by rereading it.

### Task 1: normalize declared paths when assigning phases

**Files:**
- Modify: `scripts/phases.mjs`
- Test: `tests/phases.test.mjs`

- [ ] **Step 1:** `assignPhases` builds its `taken` set from raw declared strings
  (`scripts/phases.mjs:14,16`), while `filesetViolations` and `landedForFiles` both compare
  normalized paths. Two tasks declaring the same file under different spellings therefore land in
  the SAME phase and write it concurrently, and nothing catches it. Reproduced with the real CLI
  during run `claims`: a plan declaring `Task 1 -> Create: a.mjs` and `Task 2 -> Modify: ./a.mjs`
  with no deps puts both in phase 1, and a parked ref then passes the gate with `b.mjs` never
  existing.

  Import the existing normalizer rather than writing a second one — a second spelling rule is how
  this class of defect recurs:

```js
import { normalizePath } from './enforce.mjs'
```

- [ ] **Step 2:** Compare and record normalized paths in the conflict test:

```js
      const filesFree = t.files.every((f) => !taken.has(normalizePath(f)))
      if (depsReady && filesFree) {
        t.files.forEach((f) => taken.add(normalizePath(f)))
```

  Leave `t.files` itself untouched. The declared list is what the brief shows a teammate and what
  `fileset` enforces; normalizing it here would change what the plan is understood to say.

- [ ] **Step 3:** Add to `tests/phases.test.mjs`: two tasks declaring `a.mjs` and `./a.mjs` land in
  DIFFERENT phases; the same for `a/b.mjs` versus `a\\b.mjs`; a case-only difference (`A.mjs`
  versus `a.mjs`) still lands them in the same phase, because `normalizePath` is deliberately
  case-sensitive and git is too — pin that as intended behaviour, not as an oversight. Confirm each
  test fails with the raw-string comparison restored.

### Task 2: make doctor's landed test agree with the gate, and settle the ownWorkBase limit

**Files:**
- Modify: `scripts/gate-runner.mjs`
- Modify: `scripts/doctor.mjs`
- Modify: `scripts/plan-drift.mjs`
- Test: `tests/gate-runner.test.mjs`
- Test: `tests/doctor.test.mjs`
- Test: `tests/plan-drift.test.mjs`

- [ ] **Step 1:** Run `claims` replaced the gate's `landed` test — it no longer asks whether a sha
  is in `mergedBranchTips`, but whether a merge on the run branch's own first-parent chain carried
  at least one of that task's declared files. `scripts/doctor.mjs:66,99` still uses the old
  membership test, so on the parked-at-a-merged-sibling fixture the gate FAILS a task while
  `doctor` reports it `landed: true` with no problem — the diagnostic tool contradicts the check.

  Export the predicate and its index builder from `scripts/gate-runner.mjs` so there is one
  implementation, not two:

```js
export { mergedParentFiles, landedForFiles }
```

- [ ] **Step 2:** In `scripts/doctor.mjs`, build the index once per report (it is a fact about the
  run, like the `mergedTips` walk it replaces) and decide `landed` with the declared-files
  predicate, passing `task.files`. Keep the existing behaviour when the anchor is unavailable:
  no index, no landed test, and the note the report already prints.

- [ ] **Step 3:** Delete the now-stale comment at `scripts/doctor.mjs` describing the
  membership test and the `anchor..run` filtering that justified it. Replace it with what the code
  now does, and state the limit the gate's own comment states — the predicate holds only where the
  task's declared set does not intersect what the integrator's merge carried, which is why
  sibling-tip self-integration with overlapping declared sets is still open.

- [ ] **Step 4:** Add a test asserting gate and doctor AGREE on the parked-at-a-merged-sibling
  fixture that `tests/adversarial.test.mjs` already builds: the gate fails the task and `doctor`
  reports it not landed and names it as a problem. That test is the thing that makes a future
  divergence fail rather than surface as a confusing report.

- [ ] **Step 5:** Settle the `ownWorkBase` limitation rather than carrying it forward unexamined.
  T1 isolated it in run `claims` and confirmed it against the pre-task baseline: a ref of an
  ALREADY-INTEGRATED task, re-pointed by the brief's own `git checkout -B <task> <run branch>`
  step, reads as having done no work. Build that state and run the gate on the current tree. If
  the declared-files predicate already resolves it, say so and pin it with a test. If it does not,
  record it in the `deriveContext` "what remains open" list with the exact reproduction — an
  accurate open limit is worth more than a silent one.

- [ ] **Step 6:** Neutralise control bytes where these two commands print values an enforced
  teammate controls. Added by amendment: Task 3 introduced `printable`/`printableBlock` in
  `scripts/reviews.mjs` and swept `cli.mjs`, `digest.mjs` and `finish.mjs`, but a security review
  found the same hazard in two files outside that sweep, and no file outside it has ever been
  wrapped.

  `scripts/doctor.mjs` prints `git.commitSubject` for a teammate's own branch. A teammate writes
  its own commit messages, so a subject carrying `ESC[2K ESC[1A` erases the line reporting it and
  the line above — reproduced live, with `doctor` still exiting 0. This is the command whose whole
  purpose is telling the operator that a teammate's `done` was a claim rather than evidence, so a
  teammate editing what `doctor` says about it defeats the check at its point of use.

  `scripts/plan-drift.mjs` prints plan-declared file paths. The plan is read from git at the
  anchor, so reaching this needs a commit on the base branch — a higher bar than a commit message,
  which is why it is the milder of the two — but the rendering hazard is identical.

  Import `printable` from `scripts/reviews.mjs`; do not add a third spelling and do not edit
  `reviews.mjs`, which is Task 3's file. Use `printable`, not `printableBlock`: both sites render
  one line per entry, and `printableBlock` deliberately preserves newlines, which is what let a
  check name add a row to `finish`'s summary table earlier in this run.

  Pin each site with a test asserting on BYTES — `Buffer.includes(0x1b)` is false and no line
  matching the forged shape appears — and verify each test FAILS with its own wrapper removed
  INDIVIDUALLY. Stripping every wrapper at once hides a row that passes for the wrong reason; that
  trap has already caught two rows in this run, once where a `\S+` capture truncated the payload
  before it reached the print site, and once where the value was sanitised upstream.

  Do not change what either command reports, and do not change any exit code — only how a value
  renders. Say in the comment which values are neutralised and which are not; do not write that
  the file is safe from forgery generally, because these two sites are all this step covers.

### Task 3: make an unverified review stop being a pass

**Files:**
- Modify: `scripts/reviews.mjs`
- Modify: `scripts/cli.mjs`
- Modify: `scripts/digest.mjs`
- Modify: `scripts/finish.mjs`
- Modify: `skills/phase-gate/SKILL.md`
- Test: `tests/reviews.test.mjs`
- Test: `tests/cli.test.mjs`
- Test: `tests/skill-contracts.test.mjs`

- [ ] **Step 1:** `collectReviewResults` keeps only `lens`, `stamp` and `findings`, so a reviewer
  that reports `unableToVerify` — meaning it could not get a green baseline and probed nothing —
  is collected as `status: "pass"` with zero findings. Verified during run `claims` by calling the
  function directly. The `claims` lens documents `unableToVerify` as its honest answer when the
  suite will not run, so the lens most likely to produce it is the one whose result is most
  wrongly recorded.

  Treat a lens reporting a non-empty `unableToVerify` exactly as `collectReviewResults` already
  treats a missing lens: it is not a clean review, so nothing is emitted and the reason is
  reported. Reuse the existing `missing` machinery rather than inventing a second failure path —
  add the lens to a new `unverified` array, and return early with no results when it is non-empty,
  the way the `missing` guard already does.

- [ ] **Step 2:** Carry `unprobed` into the emitted result's `output` when the collection does
  succeed. A review that reached 8 of 40 claims must not read as an exhaustive clean one; the
  count belongs where the operator sees the verdict, not only in a file they must open.

- [ ] **Step 3:** In `scripts/cli.mjs`'s `collect-reviews` block, report an unverified lens the way
  a missing one is reported, naming the lens and the reason string, and exit 4 — the operator's
  response is the same as for a lost review: respawn that lens, do not record a pass.

- [ ] **Step 4:** Correct `skills/phase-gate/SKILL.md`. It currently states that `collect-reviews`
  reads neither key and that the orchestrator must open the findings file itself — accurate today,
  false once this task lands. Say what the code will then do: an `unableToVerify` lens is refused
  like a missing one, and `unprobed` is surfaced in the check output.

- [ ] **Step 5:** Add to `tests/reviews.test.mjs`: a lens file carrying `unableToVerify` produces
  no results and names that lens; the same file without the key still collects normally;
  `unprobed` reaches the emitted `output`; and a lens carrying an EMPTY `unableToVerify` string is
  treated as verified, so the key's mere presence is not the test. Add a CLI test for the exit-4
  path. Confirm each fails before the change.

- [ ] **Step 6:** Flip the two assertions in `tests/skill-contracts.test.mjs` that pin the old
  behaviour. This file was added to the declared set by amendment after the first attempt returned
  `blocked` on it — correctly, since the file was not its to edit.

  `tests/skill-contracts.test.mjs:97` (`phase-gate documents the two claims results that are not
  findings`) asserts the SKILL.md sentences Step 4 replaces: `/collect-reviews reads neither/i`,
  `/reads lens, stamp and findings and ignores every other key/`, `/you must open the findings file
  yourself/`, `/collected today as status: "pass" with zero findings/`. Rewrite them against the
  new wording, keeping them equally checkable — an `unableToVerify` lens is refused like a missing
  one, `collect-reviews` exits 4 naming the lens and its reason, and the `unprobed` count reaches
  the check's `output`.

  `tests/skill-contracts.test.mjs:141` (`collect-reviews really does collect an unableToVerify
  claims review as a pass`) pins the old behaviour against the code: it asserts
  `out.results.length === 1` and `status === 'pass'` for a fixture carrying `unableToVerify`.
  Invert it — `out.results` empty, the lens named in `out.unverified` with its reason — and keep
  its sibling assertions that `stamp`, `unableToVerify` and `unprobed` are absent as keys from the
  emitted result, which remain true and are worth holding.

  Rename that test so its name states what it now pins. The two flip together by construction: the
  code assertion was written as the pin for the prose, which is why widening the file set was the
  right resolution rather than splitting them across tasks.

- [ ] **Step 7:** Neutralise control bytes in every agent-supplied value this codebase prints.
  Added by amendment after a security review demonstrated the forgery on the real CLI: a value
  carrying `ESC[2K ESC[1G … ESC[K` erases the printed line, returns to column 1 and truncates the
  rest, so a refusal renders to an operator or a reading agent as

      [gate] phase default: all checks PASS

  while the command exited non-zero. A forged PASS line is the sharpest possible violation of this
  project's premise that a claim is not evidence, so the fix is not optional and not cosmetic.

  Two sites remain after the first attempt, which sanitised `collect-reviews`, `map`, `complete`,
  `init-run`'s phase listing and `rebuild`'s task listing:

  `scripts/cli.mjs` — `init-run`'s unknown-tier refusal prints `task.tier` raw. `plan-parser.mjs`
  records `**Model:**` verbatim with `(.+?)` and validates nothing, so the value is agent-written.
  The sibling listing 63 lines later was wrapped; this one was missed, and it is the worse of the
  two, because a refusal is the line worth forging. Note `\r` does not reach this site — JS `.`
  excludes it, so a CR-bearing Model line fails the regex — and `ESC[1G` is the working equivalent.

  `scripts/digest.mjs` — `renderDigest` prints a task title straight from the plan, so a crafted
  `### Task 1:` heading reaches stdout raw. This file was outside every task's declared set, which
  is why the whole file set is being widened rather than the finding deferred. `renderLiveness` in
  `scripts/liveness.mjs` was checked and is NOT affected: `taskId` matches `T<digits>`, `state` is
  computed, and `staleMinutes` is validated — do not widen the file set further for it.

  Reuse the existing `printable`/`printableBlock` helpers rather than adding a third spelling. Pin
  each site with a test asserting on BYTES — `Buffer.includes(0x1b)` and no line matching
  `/^\[gate\]/` — because an assertion on a rendered string is defeated by the very escape it is
  checking for. Confirm each new test fails before the change.

  Bidi and format controls (U+202E, U+2066–2069, U+200E/200F, U+2028/2029) pass through today and
  are deliberately NOT in scope: they cannot erase, cannot move the cursor off the value, and
  cannot start a line, so they reorder rendered text without forging a verdict. Do not claim the
  helpers stop them — correct any comment that says nothing survives as a terminal instruction, so
  the prose matches what the code does.

  Amended once more: U+2028/2029 ARE in scope after all. They are LINE SEPARATOR and PARAGRAPH
  SEPARATOR, so in a CSS-rendered `pre` block — which is how agent transcripts are actually read —
  they start a line (UAX#14 class BK) and a forged verdict line follows. Neutralise those two only.
  The reordering controls (U+202E, U+2066–2069, U+200E/200F, U+061C) stay out of scope, keep passing
  through, and keep their pinned test: they reorder rendered text without starting a line.

- [ ] **Step 8:** `renderRunSummary` in `scripts/finish.mjs` splices manifest check names into a
  rendered table. Added by amendment because Step 7's fix stops at the `cli.mjs` boundary and cannot
  reach it: wrapping there with `printableBlock` prevents a name REDRAWING the table, but
  `printableBlock` preserves newlines by design, so a check name containing `\n` still ADDS A ROW to
  the summary an operator reads to decide whether a run is finished. A forged row in that table is
  the same class of defect as a forged `[gate] … PASS` line, which is why the file set is widened
  rather than the finding deferred.

  Sanitise the check names where the table is built, not only where it is printed. `printableBlock`
  is the wrong helper at this site precisely because it keeps `\n`; use `printable`, whose whole
  purpose is that a value cannot become a line. Pin it with a test asserting on BYTES that a check
  name containing a newline plus a plausible summary row cannot add a row to the rendered table, and
  confirm the test fails before the change. Do not alter what the summary reports or any exit code —
  only how a name renders.

### Task 4: stop the hook tests depending on which bash is on PATH

**Files:**
- Test: `tests/hook.test.mjs`

- [ ] **Step 1:** `contextWith` (`tests/hook.test.mjs:37`) calls
  `execFileSync('bash', [hookScript], ...)` with a Windows path. When node is spawned from
  PowerShell, bash receives the path with its backslashes consumed and fails:
  `/bin/bash: C:UsersandreAppDataLocalTemptm-preview-196vyOhookssession-start: No such file or
  directory`. 29 tests fail under PowerShell and pass under Git Bash — reproduced on unmodified
  master during run `claims`, in a throwaway worktree, so it is neither new nor caused by any
  change. It matters because the gate's `test` check inherits it: the same tree passes or fails
  depending on which shell launched the gate.

- [ ] **Step 2:** Pass bash a path it cannot re-parse. Convert to forward slashes at the call site:

```js
  const out = execFileSync('bash', [hookScript.replace(/\\/g, '/')], {
```

  Apply the same conversion everywhere a path is handed to bash in this file.

- [ ] **Step 3:** Pin it so the fragility cannot return: assert that the argument passed to bash
  contains no backslash. A test that merely runs the hook passes under Git Bash either way, which
  is exactly why this went unnoticed — the assertion has to be about the argument, not the result.

- [ ] **Step 4:** Verify from BOTH shells: run `node --test tests/hook.test.mjs` from Git Bash and
  from PowerShell, and report both counts. This is the one task whose fix cannot be confirmed from
  a single shell, and reporting one count would restate the bug as its own verification.

### Task 5: reconcile the plan and spec of run `claims` with what shipped

**Files:**
- Modify: `docs/plans/2026-08-10-claims-liveness-distinct-refs.md`
- Modify: `docs/specs/2026-08-10-claims-liveness-distinct-refs-design.md`

- [ ] **Step 1:** Both documents describe behaviour the code no longer has, which is the same
  defect class the `claims` lens exists to catch, sitting in the documents that specified it.
  Correct them against the code on `run/claims` (`09f5ad9`), reading the code rather than the
  round summaries.

- [ ] **Step 2:** `liveness` in the spec and in the plan's Task 2 has exit codes 0 and 1. It now
  has three, with four distinct causes of exit 2: a failed derivation, a `phaseError`, a derived
  phase selecting no working-tree task, and a run directory that does not exist. `unknown` is a
  row state alongside `working`, `stalled` and `not started`, with an `unknownReason` of
  `walk-capped` or `no-worktree-measurement`. The spec's rule that "a floored row is never
  reported as stalled" was replaced during review — a floored row now reads `unknown` and exits 2,
  because reporting `working` was an all-clear about a teammate nothing had measured.

- [ ] **Step 3:** The spec's T1 section describes a duplicate-sha discriminator that no longer
  exists in any form. What shipped is a per-task predicate: a branch counts as landed only if a
  merge on the run branch's own first-parent chain carried at least one of that task's declared
  files. Rewrite the section to describe that, and carry over the limits the code states —
  including that it holds only where the declared set does not intersect what the merge carried.

- [ ] **Step 4:** The plan's Global Constraints assert that every git invocation passes
  `--end-of-options`. One tested exception now exists (`ignoredPaths`, git 2.53). Record it.

- [ ] **Step 5:** Add a short "What this cost" section to the spec recording what the run
  measured: 45 findings across ten review rounds, T1 five fix rounds, T2 three, T3 five, two budget
  overrides, and the single largest defect class — a claim stronger than the code, eight instances
  in one task, four of them in tests rather than comments. Whoever plans the next fleet run should
  see that number before estimating one.
