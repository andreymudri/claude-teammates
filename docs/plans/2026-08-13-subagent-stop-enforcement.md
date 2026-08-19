# SubagentStop enforcement (agent-teams adoption, retargeted)

Spec: `docs/specs/2026-08-10-agent-teams-adoption-design.md`
Evidence: `docs/specs/2026-08-13-agent-teams-probe-findings.md`

The approved spec targets the `TeammateIdle` hook. Measurement against Claude Code 2.1.231 shows
that event is gated on team context this plugin cannot enter, fires at the same moment as
`SubagentStop` anyway, and carries a different payload than the spec assumes. `SubagentStop` is the
reachable equivalent: it fires for every dispatched subagent, carries `agent_id`, `agent_type` and a
`cwd` that tracks worktree isolation, blocks on exit 2, and needs no experimental flag — so the
enforcement is mode-independent and the spec's "same verdict with the flag on or off" property
becomes trivially true rather than something to defend.

Decisions taken before planning:

- **One block per stop.** The handler returns success when `stop_hook_active` is true, which is the
  harness's own documented guidance. The harness bounds consecutive blocks at 8
  (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, default 8) in-process, so the spec's `idle-blocks.json`
  counter — writable by the teammate it counts — is not built at all.
- **A separate location record, not the claim.** `claim` is invoked on exactly one path today
  (`fleet-lifecycle`'s mid-run **add `<role>`**), never by a dispatched implementer, and its `wx`
  flag means a fix-round respawn re-entering a claimed task writes nothing. A new `locate` command
  writes `.teammates/index/<sha256 of the normalised worktree>.json`, overwrite allowed, run by
  every implementer as its first act after checkout. The record is addressed by the worktree it
  describes, not composed from the run and task ids, and the store sits under the **main**
  repository root — `locate` must derive that root the way the handler does rather than inherit
  `flags.root ?? process.cwd()`, or it files the record inside the teammate's own worktree where
  nothing will ever find it. `claim`'s atomicity guarantee is left exactly as it is.
- **The hook runs `complete --enforcement-only`.** The full gate's `command` checks are the
  project's test suite; running that synchronously inside a stop hook means the common outcome is a
  hook timeout, which is a non-blocking error — enforcement that looks installed and does nothing.
  `fileset`, `ownership` and `merge` answer "did you stray outside your file set, is your branch
  empty, will this merge" in seconds. The phase gate still runs everything.
- **The teammate runs `complete` itself before returning.** Nothing invokes `complete` today, so
  without this the spec's claim that the hook relocates "the verification the teammate was already
  told to run" is false. The teammate runs the full check in its own parallel time; the hook is the
  cheap backstop for a teammate that skips it.
- **No teams-mode detection.** Nothing branches on the flag any more, so `teams-mode` would have no
  caller and a `doctor` line would report a fact that changes no behaviour.

## Global Constraints

- Node >= 24.2.0
- Zero new runtime dependencies
- Commit messages: single-line, commitlint style, English
- Test runner is `node --test tests/*.test.mjs`; `node:test` + `node:assert/strict`, no framework
- No test may spawn `bash` at module load; add cross-file checks instead
- `.teammates/` remains the only coordination store
- No change to any gate check, threshold, or verdict

---

### Task 1: retarget the agent-teams spec to SubagentStop

**Files:**
- Modify: `docs/specs/2026-08-10-agent-teams-adoption-design.md`

**Model:** capable

Inference reads this as a one-file documentation edit and picks `mid`. It is the opposite: precise
corrections to a document whose failure mode — prose asserting a guarantee the code does not
deliver — is this repository's most-found defect class, and the thing a reviewer lens was added to
catch.

- [ ] **Step 1:** Change the status line at the top to
      `Status: approved; retargeted 2026-08-13 to SubagentStop — see docs/specs/2026-08-13-agent-teams-probe-findings.md`.

- [ ] **Step 2:** Replace the three-item list in `## Blocking verification` with a `## What was
      measured` section recording the answers rather than the questions:

      - `isolation: 'worktree'` survives — a spawned agent lands in a linked worktree
        (`--git-dir` = `.git/worktrees/agent-<hash>`, `--git-common-dir` = `.git`), locked and clean.
      - `TeammateIdle` exists in 2.1.231 but is gated on team context (`B_()`), which the
        environment variable does not create and an `Agent`-spawned subagent never has. With
        `TeamCreate` removed there is no way to reach it. Its payload carries `teammate_name` and
        `team_name`, and leaves `agent_id` / `agent_type` undefined.
      - `tm-implementer` dispatches no subagent and declares neither `skills:` nor `mcpServers:`
        frontmatter, confirmed by inspection.

- [ ] **Step 3:** Retitle `## The \`TeammateIdle\` hook` to `## The \`SubagentStop\` hook` and rewrite
      its body to describe the handler this plan builds: no-ops unless `cwd` resolves to a recorded
      worktree, returns success while `stop_hook_active` is true, and blocks **only** on the
      rejection-specific exit code Task 5 adds to `complete --enforcement-only`.

      Do not write "blocks on exit 2 and allows on exit 4". Both are wrong today and in opposite
      directions: `complete` returns **2** for a malformed manifest *or* an argv error, and **4**
      for a gate rejection *or* a cannot-verify. Blocking on 2 blocks a teammate for the
      orchestrator's typo; allowing on 4 waves through the rejection this hook exists to catch.
      That is why Task 5 adds a code meaning *rejected and nothing else*, and why this sentence
      must name that code rather than either of the two it conflates.

- [ ] **Step 4:** Correct the sentence in `## The property this design protects` reading "it is the
      verification the teammate was already told to run before returning, moved to a point the
      teammate cannot skip." As written it was false — nothing invoked `complete` anywhere in the
      repository. Replace it with: this plan adds that instruction to the implementer contract and
      the brief, and the hook is the backstop for a teammate that skips it, running the cheap
      enforcement subset rather than the full gate.

- [ ] **Step 5:** Delete the subsection `### Bounded at two blocks` entirely and replace it with a
      subsection `### The harness bounds this, not us` stating that consecutive blocks are capped at
      8 by `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, that the count is in-process and therefore not
      writable by the teammate it counts, and that the handler returns success while
      `stop_hook_active` is true so one stop costs one forced retry.

- [ ] **Step 6:** Rewrite `### Two arguments the hook is not given`. The plan path is recorded by
      `init-run` as this section already describes, and that part stands. The `--root` derivation
      stands too. Add that the task id comes from a location record written by the teammate at
      start, not from the checked-out branch: the harness checks out `worktree-agent-<hash>`, and
      `teammates/<runId>/<taskId>` exists only because the implementer creates it — so branch
      resolution misses precisely the teammate that did nothing, which is the case the hook exists
      for.

- [ ] **Step 7:** In `### Two limits, stated in the handler`, keep both bullets but retarget the
      first: the location record, like everything under `.teammates/`, is writable by its subject,
      and a teammate that rewrites it loses itself the early catch without buying a passing gate.
      Extend the fail-open bullet with the harness's own behaviour: an exit 2 whose stderr matches
      `no such file|can't open` is downgraded to non-blocking.

- [ ] **Step 8:** Delete the `## Detection` and `## Fan-out` sections in full. Add a short
      `## Why fan-out is not part of this` section: `Agent`-spawned agents are not teammates with
      the flag on either, a direct spawn already returns an id usable with `SendMessage`, and so
      teams mode buys no addressability that the current dispatch lacks. The three-or-more-tasks
      `Workflow` threshold is unchanged in both modes.

- [ ] **Step 9:** Fix the stale citations: `deriveContext` is `scripts/gate-runner.mjs:369` and
      reads the plan at the anchor on `:378` (not `scripts/cli.mjs:861`); the `SendMessage` caveat
      is `skills/fleet-lifecycle/SKILL.md:67`; and the sweep prose lives in this file, not in
      `docs/specs/2026-08-05-claude-teammates-design.md`, which contains none of those terms.

- [ ] **Step 10:** In `## Skill changes`, delete the `fleet-lifecycle` bullet's claim that "in teams
      mode every task's teammate is addressable because no Workflow is involved" and replace it
      with: agents inside a running `Workflow` cannot receive `SendMessage` in either mode, which is
      why fix rounds address directly dispatched teammates only.

- [ ] **Step 11:** Add one sentence to `## Standing risk`: the `SubagentStop` payload shape, the
      block cap and the `B_()` gate were read out of a minified binary, are true of 2.1.231 and
      nothing else, and the handler must degrade to allowing the stop whenever what it expects is
      absent.

---

### Task 2: extract the implementer brief into a shared module

**Files:**
- Create: `scripts/brief.mjs`
- Test: `tests/brief.test.mjs`

The brief currently lives only in `templates/phase-workflow.js`, so it exists only on the `Workflow`
dispatch path. Any direct-`Agent` dispatch composes a brief by hand, unpinned by any test — the same
gap that was closed once already for the plan pointer, branch name, constraints and baseline step.
Generated workflow scripts run without filesystem or module access, so the module cannot be imported
at workflow runtime; the generator composes each brief and substitutes the finished text instead.

- [ ] **Step 1:** Create `scripts/brief.mjs` exporting a pure `composeBrief(options)` with no I/O.
      Move `checkoutSteps` from `templates/phase-workflow.js:34-49` verbatim, changing only its
      closed-over `BASE_BRANCH` into a parameter:

      ```js
      // The brief IS the task specification. Every consumer composes it here so that the
      // plan pointer, the mandatory checkout, the baseline run, the declared file set and the
      // global constraints cannot be present on one dispatch path and missing on another.
      const checkoutSteps = (task, baseBranch) => (baseBranch ? [
        'MANDATORY FIRST STEP. Your worktree does not start on this run\'s base. Run exactly:',
        '',
        '    git checkout -B ' + task.branch + ' ' + baseBranch,
        '    git log --oneline -1',
        '',
        'If the log does not show the tip of ' + baseBranch + ', STOP and report status "blocked".',
        'Every file you read before this command has stale content and must be re-read after it.',
      ] : [
        'MANDATORY FIRST STEP. No base branch was supplied for this phase, so the commit your worktree',
        'starts on is UNVERIFIED and is probably stale. Do not guess a base, and do not run',
        '"git checkout -B ' + task.branch + '" without a start point — that would branch from whatever',
        'HEAD your worktree happens to be on. Ask the orchestrator which commit to start from, then',
        'check out ' + task.branch + ' at that commit. If you cannot get an answer, report status "blocked".',
        'Every file you read before that checkout has stale content and must be re-read after it.',
      ])
      ```

- [ ] **Step 2:** Move `blastRadius` from `templates/phase-workflow.js:56-64` into the same module
      unchanged except for taking the task as its only argument:

      ```js
      const blastRadius = (task) => (task.neighbours && task.neighbours.length ? [
        'BLAST RADIUS. These files are not yours and you may not edit them. They have changed together',
        'with your files in the past, so they are where your change is most likely to break something:',
        ...task.neighbours.map((n) => '  ' + Math.round(n.confidence * 100) + '%  ' + n.path),
        'This is a statistic about history, not a dependency list: it can be wrong in both directions.',
        'Read the ones that look relevant. If your task cannot be done without editing one, that is a',
        'file-set problem — report status "blocked" naming it rather than editing it.',
        '',
      ] : [])
      ```

- [ ] **Step 3:** Add the location step, new to the brief. It runs immediately after the checkout so
      the record exists before any work — a teammate that fails partway through is exactly the one
      the record has to be able to name:

      ```js
      // Written before the work, not after. The stop-time hook maps a cwd back to a task through
      // this record; resolving through the checked-out branch instead would miss a teammate that
      // never created its branch, which is the failure the hook exists to catch.
      const locateStep = (task, runId) => (runId ? [
        'RECORD YOUR WORKTREE. Immediately after the checkout above, run:',
        '',
        '    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" locate --run ' + runId + ' --task ' + task.id,
        '',
        'It takes no path arguments: it reads your worktree and branch from where you run it.',
        'This is how your work is identified if you stop before finishing. Do not skip it.',
        '',
      ] : [])
      ```

- [ ] **Step 4:** Add the self-verification step, also new. It runs before returning, in the
      foreground, and is the instruction the hook backstops:

      ```js
      const verifyStep = (task, runId, planPath) => (runId && planPath ? [
        'BEFORE YOU RETURN "done". Run the task gate on your own work, in the FOREGROUND:',
        '',
        '    ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")',
        '    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" complete \\',
        '      --run ' + runId + ' --task ' + task.id + ' --plan ' + planPath + ' --root "$ROOT"',
        '',
        'ROOT must be the MAIN worktree, which is what that command computes — run from inside your',
        'own worktree the CLI would resolve the run branch to your task branch and answer the wrong',
        'question. Exit 0 means your task passes. Anything else: fix what it names and run it again.',
        'Returning "done" on a non-zero result wastes the phase, because the gate recomputes exactly',
        'this and will reject it.',
        '',
      ] : [])
      ```

- [ ] **Step 5:** Add the full-length body, moved from `templates/phase-workflow.js:66-91` with the
      two new sections spliced in:

      ```js
      const full = ({ task, runId, planPath, baseBranch, constraints }) => [
        'You are tm-implementer for task ' + task.id + ': ' + task.title + '.',
        '',
        ...checkoutSteps(task, baseBranch),
        '',
        ...locateStep(task, runId),
        'BASELINE. Then bootstrap the worktree, before writing anything, in this order:',
        '1. Install the project\'s dependencies as the project requires.',
        '2. Copy over any untracked config the project needs (for example .env).',
        '3. Run the project\'s test command once, IN THE FOREGROUND, and confirm it is green.',
        '   Never background it: nothing notifies you when a backgrounded command finishes.',
        'A fresh worktree starts with none of that in place, and a failure caused by a missing',
        'dependency looks exactly like a RED test, which the gate cannot tell apart from a real one.',
        'Report status "blocked" only if the baseline cannot be made green.',
        '',
        planPath ? 'PLAN. Read ' + planPath + ' and implement the section titled "Task '
          + task.id.replace(/^T/, '') + ':" — every numbered step, in order. The plan is the spec.' : '',
        '',
        'FILES. You may create or modify ONLY these files: ' + task.files.join(', ') + '.',
        'Touching any other file fails the phase gate.',
        '',
        ...blastRadius(task),
        constraints.length ? 'GLOBAL CONSTRAINTS:' : '',
        ...constraints.map((c) => '- ' + c),
        '',
        ...verifyStep(task, runId, planPath),
        'Commit your work on ' + task.branch + ' and return the structured result.',
      ].filter((line) => line !== '').join('\n')
      ```

- [ ] **Step 6:** Move the terse variant from `templates/phase-workflow.js:97` onward into the same
      module as `terse`, taking the same options object, splicing in `locateStep` and `verifyStep`
      unchanged, and keeping its existing comment that the compressed variant reuses `checkoutSteps`
      verbatim and compresses only connective prose. A command line is not connective prose.

- [ ] **Step 7:** Export the single entry point, defaulting every optional input so an omitted value
      drops its section rather than rendering a missing one:

      ```js
      export function composeBrief({ task, runId = '', planPath = '', baseBranch = '', constraints = [], caveman = false }) {
        if (!task || typeof task.id !== 'string') throw new Error('composeBrief: task.id is required')
        if (!Array.isArray(task.files)) throw new Error(`composeBrief: task ${task.id} has no files array`)
        if (typeof task.branch !== 'string' || task.branch === '') {
          throw new Error(`composeBrief: task ${task.id} has no branch`)
        }
        const options = { task, runId, planPath, baseBranch, constraints, caveman }
        return caveman ? terse(options) : full(options)
      }
      ```

- [ ] **Step 8:** Create `tests/brief.test.mjs` asserting, against `composeBrief` directly, that a
      brief with all inputs supplied contains: the exact string `git checkout -B ` followed by the
      task branch and the base branch; the literal `IN THE FOREGROUND`; the plan path; the phrase
      `You may create or modify ONLY these files:` followed by every declared file; and every global
      constraint prefixed with `- `.

- [ ] **Step 9:** Add a test that the brief contains `cli.mjs locate --run <runId> --task <taskId>`
      with the actual run and task ids substituted, and that the locate line appears **before** the
      `BASELINE.` line — the record must be written before the work, not after it.

- [ ] **Step 10:** Add a test that the brief contains `cli.mjs complete` with the run id, task id and
      plan path substituted, and that it appears after the `GLOBAL CONSTRAINTS:` section and before
      the final commit instruction.

- [ ] **Step 11:** Add a test that with `runId: ''` neither the locate nor the verify section is
      rendered, and no line contains the literal `--run  ` with an empty value — an omitted input
      drops its section rather than emitting a command that cannot run.

- [ ] **Step 12:** Add a test that with `baseBranch: ''` the output contains `No base branch was
      supplied` and never names a starting commit for the checkout.

- [ ] **Step 13:** Add a test that `caveman: 'full'` still yields a brief containing the checkout
      command, the locate command, the complete command, `IN THE FOREGROUND`, the plan path and
      every declared file — compression may drop connective prose, never the specification.

- [ ] **Step 14:** Add three tests that `composeBrief` throws when `task.id` is missing, when
      `task.files` is not an array, and when `task.branch` is empty.

---

### Task 3: the worktree location record

**Files:**
- Modify: `scripts/state.mjs`
- Test: `tests/state.test.mjs`

`claimTask` is deliberately not touched. Its `wx` flag is an atomicity guarantee the mid-run
scale-up path depends on, and a record that must be re-writable on every respawn cannot share it.

- [ ] **Step 1:** In `scripts/state.mjs`, add the path normaliser used by both writer and reader, so
      a drive-letter or trailing-separator difference cannot make a worktree fail to match itself:

      ```js
      // Compared, never displayed. Windows paths differ in case and separator between what git
      // prints, what the harness sends in a hook payload, and what a shell reports — three
      // spellings of one directory. Normalising at both ends is what makes the lookup total.
      export function normaliseWorktree(p) {
        if (typeof p !== 'string' || p === '') return ''
        const resolved = path.resolve(p).replace(/[\\/]+$/, '')
        return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved
      }
      ```

- [ ] **Step 2:** Add the writer. Overwrite is the point — a fix-round respawn lands in a new
      worktree and must be able to say so — and the write is atomic by rename so a concurrent reader
      never sees a half-written record:

      ```js
      // Written by the teammate at start, read by the stop-time hook. Overwritable on purpose:
      // a respawned teammate re-enters the same task from a different worktree, and a record
      // that could not be updated would point the hook at a directory that no longer exists.
      export async function writeLocation(root, runId, taskId, { worktree, branch }) {
        const dir = path.join(runDir(root, runId), 'worktrees')
        await mkdir(dir, { recursive: true })
        const target = path.join(dir, `${taskId}.json`)
        const tmp = `${target}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
        await writeFile(tmp, `${JSON.stringify({ taskId, worktree, branch })}\n`, 'utf8')
        await rename(tmp, target)
        return target
      }
      ```

- [ ] **Step 3:** Add the reverse lookup the hook needs, scanning every run rather than requiring the
      caller to already know the run id:

      ```js
      // Returns { runId, taskId, branch } for the location record whose worktree is `worktree`,
      // or null. Reads only; a malformed or unreadable record is skipped rather than thrown,
      // because the sole caller is a hook whose failure mode must be "allow the stop", never
      // "crash every agent on this machine".
      export async function findTaskByWorktree(root, worktree) {
        const want = normaliseWorktree(worktree)
        if (want === '') return null
        let runs
        try {
          runs = await readdir(path.join(root, '.teammates'), { withFileTypes: true })
        } catch { return null }
        for (const run of runs) {
          if (!run.isDirectory()) continue
          const dir = path.join(root, '.teammates', run.name, 'worktrees')
          let files
          try {
            files = await readdir(dir)
          } catch { continue }
          for (const file of files) {
            if (!file.endsWith('.json')) continue
            try {
              const record = JSON.parse(await readFile(path.join(dir, file), 'utf8'))
              if (normaliseWorktree(record.worktree) === want) {
                return { runId: run.name, taskId: record.taskId, branch: record.branch ?? null }
              }
            } catch { continue }
          }
        }
        return null
      }
      ```

- [ ] **Step 4:** Add `readdir` to the `node:fs/promises` import at `scripts/state.mjs:1`.

- [ ] **Step 5:** Extend the comment above `readFixRounds` (`scripts/state.mjs:59-62`) with one
      sentence covering the new record on the same footing: it is writable by the teammate it
      describes, the hook that reads it is an early catch, and its worst failure is losing the catch
      — the gate recomputes every verdict from git and reads nothing here.

- [ ] **Step 6:** In `tests/state.test.mjs`, add a test that `writeLocation` creates its record
      containing `taskId`, `worktree` and `branch`, and that calling it a second time with a
      different worktree overwrites rather than failing. **As built, the store is
      `.teammates/index/<sha256 of the normalised worktree>.json`** — keyed by the worktree, not
      composed from the run and task ids — so assert on the path `writeLocation` returns rather
      than on a path this step composes. The scanning layout this step originally described was
      replaced during the run after its resource bounds failed three separate ways.

- [ ] **Step 7:** Add a test that `findTaskByWorktree` finds a record written under one spelling of a
      path when queried with another — a trailing separator, and on `win32` a differing drive-letter
      case — and returns `{ runId, taskId, branch }`.

- [ ] **Step 8:** Add a test that `findTaskByWorktree` returns `null` for an unknown worktree, for a
      root with no `.teammates` directory, for a root with no `index/` directory, and for a
      record holding malformed JSON — the malformed one must be skipped without throwing.

- [ ] **Step 9:** Add a test that `claimTask` still returns `false` on a second claim and still
      writes exactly `{ taskId, teammate }`, proving this task changed nothing about it.

---

### Task 4: the SubagentStop handler

**Files:**
- Create: `scripts/subagent-stop.mjs`
- Test: `tests/subagent-stop.test.mjs`

**Depends:** T3

A Node script rather than a `hooks/` bash script behind `run-hook.cmd`: the shim exists to find bash
for extensionless shell scripts, and this handler must parse JSON on stdin and reuse `state.mjs`, so
`node` is both simpler and one less thing to detect. It fires for every subagent in every session
with this plugin installed, so the no-op path must be cheap.

- [ ] **Step 1:** Create `scripts/subagent-stop.mjs` reading the payload and failing open on anything
      it does not understand:

      ```js
      #!/usr/bin/env node
      // SubagentStop handler. Runs the cheap enforcement checks on a teammate's own task at the
      // point it tries to stop. Exit 0 allows the stop; exit 2 blocks it and the harness feeds
      // stderr back to the teammate as the reason to keep working.
      //
      // It fires for EVERY subagent on this machine — a reviewer in an unrelated project, this
      // plugin's own read-only tm-reviewer, any agent in a repo with no run at all. Everything
      // below is arranged so those cases cost one git call and exit 0.
      import { readFileSync } from 'node:fs'
      import { execFileSync, spawnSync } from 'node:child_process'
      import path from 'node:path'
      import { fileURLToPath } from 'node:url'
      import { findTaskByWorktree, readState } from './state.mjs'

      const ALLOW = 0
      const BLOCK = 2

      function payload() {
        try {
          return JSON.parse(readFileSync(0, 'utf8'))
        } catch {
          return null
        }
      }

      function git(args, cwd) {
        try {
          return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10_000,
          }).trim()
        } catch {
          return null
        }
      }
      ```

- [ ] **Step 2:** Write the resolution sequence, each step allowing the stop when it cannot answer:

      ```js
      async function main() {
        const input = payload()
        if (!input) return ALLOW

        // The harness caps consecutive blocks at 8 and asks Stop/SubagentStop handlers to return
        // success while this is set. Honouring it makes one stop cost one forced retry: the
        // teammate gets the failure text, works again, and is not blocked a second time for the
        // same stop. The count lives in the harness process, so unlike anything under
        // .teammates/ the teammate cannot reset it.
        if (input.stop_hook_active === true) return ALLOW

        const cwd = typeof input.cwd === 'string' ? input.cwd : ''
        if (cwd === '') return ALLOW

        // One git call in the common case. A cwd outside any repository stops here.
        const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
        if (!commonDir) return ALLOW
        const root = path.dirname(commonDir)

        const found = await findTaskByWorktree(root, cwd)
        if (!found) return ALLOW
        ...
      }
      ```

- [ ] **Step 3:** Read the plan path recorded by `init-run`, and allow the stop when it is absent —
      without it `complete` cannot run, and a teammate must not be blocked by state it did not write:

      ```js
        const plan = await readState(root, found.runId, 'plan')
        const planPath = plan?.planPath
        if (typeof planPath !== 'string' || planPath === '') return ALLOW
      ```

- [ ] **Step 4:** Add the cheap precheck. A missing task branch is the do-nothing case and is blocked
      without paying for anything further:

      ```js
        const branch = found.branch ?? `teammates/${found.runId}/${found.taskId}`
        if (!git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)) {
          process.stderr.write(
            `Task ${found.taskId} has no branch ${branch}. Your work is not on a branch this run can `
            + `merge, so nothing you did is visible to the gate. Your brief names the branch to `
            + `create and the command to create it with; follow that step, commit your work, then `
            + `finish.\n`
          )
          return BLOCK
        }
      ```

      **The remediation must not tell anyone to create or commit to this ref, and must not
      interpolate `branch` into a shell command.** Both were true of the earlier draft
      (`git checkout -B ${branch} <base>`) and both are now forbidden by the adopted design, which
      states: *a ref derived from a record is only as trustworthy as the record, so the handler may
      name one in a diagnosis and must not direct anyone to create it or commit to it.*

      The reason is not shell quoting. `found.branch` is clamped by the reader to the conventional
      name built from the record's own `runId` and `taskId`, but **those ids are attacker-chosen**,
      so a planted record resolves to another task's ref through the honest construction. A victim
      that obeys a create-and-commit instruction puts its commits on that task's branch, where
      `fileset` and `ownership` read them as that task's work — verified by execution, twice. The
      teammate's own brief already carries the branch name from the dispatch, which is the
      trustworthy source; send it there instead of naming a ref the record chose.

- [ ] **Step 5:** Run the enforcement subset and split the exit codes, which is the difference
      between an early catch and a teammate wedged by broken state:

      ```js
        // --enforcement-only on purpose: fileset, ownership and merge answer "did you stray
        // outside your file set, is your branch empty, will this merge" in seconds. The full
        // gate's command checks are the project's test suite, and running that inside a stop
        // hook means the usual outcome is a timeout — which is a non-blocking error, i.e.
        // enforcement that looks installed and does nothing. The phase gate still runs it all.
        //
        // Block on REJECTED and on nothing else. `complete`'s existing codes cannot carry this
        // decision, and the earlier draft of this comment had them backwards in both directions:
        // 2 is a malformed manifest OR an argv error, and 4 is a gate rejection OR a
        // cannot-verify (no manifest, an underivable context, an unknown task id). Blocking on 2
        // costs a teammate a turn for the orchestrator's typo; allowing on 4 waves through the
        // rejection this handler exists to catch. Task 5 adds REJECTED for exactly this, and
        // every other code — including 2 and 4 — allows, because a fact about the run's
        // configuration must never cost a teammate a turn.
        const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs')
        const result = spawnSync(process.execPath, [
          cli, 'complete',
          '--run', found.runId,
          '--task', found.taskId,
          '--plan', planPath,
          '--root', root,
          '--enforcement-only',
        ], { encoding: 'utf8', timeout: 60_000 })

        if (result.status === REJECTED) {
          process.stderr.write(`${(result.stdout || '').trim()}\n`)
          return BLOCK
        }
        return ALLOW
      ```

      `REJECTED` is the code Task 5 adds; it is not `BLOCK`. `BLOCK` is this handler's own exit
      status to the harness (2). Conflating the two is what produced the inverted comment above:
      the code `complete` returns and the code this hook returns are different vocabularies that
      happen to share a number.

- [ ] **Step 6:** Add a comment above the `complete` call recording the one case where it misfires:
      `complete` derives the run branch from whatever the main worktree has checked out, so if the
      operator is not on the run branch it exits 4 and this handler allows the stop. That is the
      correct direction — the gate still runs later — and it is why exit 4 must not block.

- [ ] **Step 7:** End the file with a handler that cannot throw past the process boundary:

      ```js
      main()
        .then((code) => process.exit(code))
        .catch(() => process.exit(ALLOW))
      ```

- [ ] **Step 8:** Create `tests/subagent-stop.test.mjs` driving the script as a child process with a
      JSON payload on stdin, in a temporary git repository. Assert exit 0 for: unparseable stdin, an
      empty payload, `stop_hook_active: true`, a `cwd` outside any repository, and a `cwd` in a repo
      with no `.teammates` directory.

- [ ] **Step 9:** Add a test that with a location record for the worktree and no task branch created,
      the handler exits 2 and its stderr names both the task id and the expected branch.

- [ ] **Step 10:** Add a test that with a location record and the task branch present, but the run's
      `plan.json` carrying no `planPath`, the handler exits 0 — state the teammate did not write must
      never block it.

- [ ] **Step 11:** Add a test asserting the spawned `complete` invocation includes
      `--enforcement-only`, by intercepting it with a stub `cli.mjs` on a temporary path or by
      asserting on the argv the handler builds. A hook that quietly runs the full suite is the
      failure this flag exists to prevent, and it would show up only as a timeout.

- [ ] **Step 12:** Add a test that the handler does not spawn `bash` and completes in under two
      seconds for the no-op path, so the common case stays cheap for every unrelated agent on the
      machine.

---

### Task 5: CLI surface — locate, enforcement-only completion, the plan path, and the brief

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`
- Test: `tests/adversarial.test.mjs`
- Modify: `scripts/brief.mjs`
- Test: `tests/brief.test.mjs`
- Modify: `scripts/gate-runner.mjs`
- Test: `tests/gate-runner.test.mjs`

**Depends:** T2, T3

### Step 3d: a check `kind` must be a string before it selects a runner

Added in phase 2 review, after a reviewer executed it end to end. `--enforcement-only` is **not** the
barrier the handler's comment claims, because a manifest can spell a kind as a JSON **array**:

```
['command'] !== 'command'              → true    survives the enforcement-only filter
RUNNERS[['command']]                   → runner  executes; JS coerces on property lookup
Object.hasOwn(RUNNERS, ['command'])    → true    the guard that looks like a type check is not one
new Set(['fileset']).has(['fileset'])  → false   ALWAYS_ENFORCED_KINDS does not coerce
```

Two reachable consequences, both measured against the merged tree:

- `{"kind": ["command"], ...}` runs an arbitrary shell command through the stop hook — which fires
  for **every subagent on the machine** — with `cwd` set to the main worktree, and returns exit 3,
  the one code the handler blocks on. The manifest is `teammates.gate.json` under the main
  worktree, writable by any teammate, so this needs no other foothold.
- `{"kind": ["fileset"], "optional": true}` runs the **real** fileset check and then does not block,
  because `ALWAYS_ENFORCED_KINDS.has` does not coerce while the runner lookup does. Measured verdict:
  `{"verdict":"PASS","failed":[],"optionalFailed":["fileset"]}` — **a forged manifest producing a
  false gate PASS.** That falsifies the bound stated in
  `docs/specs/2026-08-10-agent-teams-adoption-design.md`, which says no forgery under `.teammates/`
  reaches a false PASS; the manifest is a different file with the same writability.

**Fix at the runner lookup, not at the filter.** `scripts/cli.mjs`'s `--enforcement-only` filter is
one of several call sites; a filter-only fix leaves the false-PASS path open. Require
`typeof check.kind === 'string'` where the runner is selected, and refuse a non-string kind loudly
rather than skipping it silently — a manifest that cannot be understood is a configuration fault,
not a pass.

`tests/gate-runner.test.mjs:1067` shows this class was considered: it pins `'toString'`,
`'constructor'`, `'valueOf'` and `'__proto__'` — all **strings**. The array spelling is the one JSON
can express and the one nothing covered. Pin the array spelling for every kind the manifest accepts,
and pin that a non-string kind cannot reach a runner by any route.

`tests/adversarial.test.mjs` is in the set because **step 3b changes an exit code**, and an exit
code is pinned by every test that asserts it. `tests/adversarial.test.mjs:195` asserts
`complete` exits 4 inside *"a forged status.json PASS changes neither the gate verdict nor
complete"*; the subject of that test is unchanged — the forged PASS still buys nothing — and only
the number carrying the rejection moves. It is the only assertion outside `tests/cli.test.mjs`
that touches `complete`'s exit codes, confirmed by grep across `tests/`.

Adjust the number and the adjacent comment clause. Do not weaken, skip or delete the test: its
subject is the tamper-evidence property, which this change does not touch.

`scripts/brief.mjs` and `tests/brief.test.mjs` are in the set for the same reason, found by review
rather than foreseen: **an exit code is documented by every place that renders it to a human**, not
only by every test that asserts it. `scripts/brief.mjs:127` renders the exit-code table a teammate
reads, and it maps a gate rejection to exit 4 — the code this task moves to 3. Left alone, a
teammate that hits 3 finds no row for it, and the only "gate does not pass" row it can find sits
under exit 4 beside a sibling row telling it exit 4 is a run-configuration problem to quote and
proceed past. That is worse than a stale test: it is an instruction to ignore the rejection.

**Step 3c:** update that table for the narrowed contract below, and pin it — the brief's exit-code
rows must fail if the code changes again.

### The narrowed contract for exit 3

Review proved by execution that returning 3 for *any* non-PASS verdict blocks a compliant teammate
on facts it does not own: a manifest typo leaving a non-optional check `pending`, uncommitted
changes in the **main** worktree failing `ownership`, and anyone committing directly to the run
branch. `runOwnershipCheck` is deliberately run-wide (`gate-runner.mjs`), and Global Constraints
forbid changing any gate check — so the fix is in the exit-code mapping, not in the check:

```
complete --enforcement-only returns 3 only when a TASK-SCOPED check rejects — fileset, merge.
A run-wide check that fails, and any check that could not run, returns 4.
```

4 is what the handler allows, and the phase gate still catches everything. This preserves the
stop-time value the design promised — "did you stray outside your file set, is your branch empty,
will this merge" — while ending the case where one teammate's stop is blocked by another's commit
and the remediation invites it to cherry-pick a foreign commit onto its own branch, which then
trips `fileset`.

**Model:** capable

Inference reads two declared files and picks `cheap`. Those two files are a 167 KB CLI and a 434 KB
test suite, and the task adds two subcommands across four registration tables where omitting one
entry makes a new flag silently unknown.

- [ ] **Step 1:** In `USAGE` (`scripts/cli.mjs:68`), add `locate` and `brief` to the subcommand list
      in the first line, add
      `locate   --run <id> --task <id> [--worktree <path>] [--branch <name>] [--root <path>]` and
      `brief    --run <id> --task <id> --plan <path> [--base <branch>] [--root <path>]`, and append
      `[--enforcement-only]` to the existing `complete` line.

- [ ] **Step 2:** In `REQUIRED` (`scripts/cli.mjs:191`), add `locate: ['run', 'task'],` and
      `brief: ['run', 'task', 'plan'],`.

- [ ] **Step 3:** In `KNOWN_FLAGS` (`scripts/cli.mjs:233`), add
      `locate: ['run', 'task', 'worktree', 'branch'],`, `brief: ['run', 'task', 'plan', 'base'],`
      and extend `complete` to `['run', 'task', 'plan', 'base', 'phase', 'enforcement-only']`. Both
      tables must be updated or a new flag is refused as unknown and a new command goes unvalidated.

      Verified before this run: `complete`'s table genuinely lacks `enforcement-only` today, while
      `root` passes as a `UNIVERSAL_FLAG` (`scripts/cli.mjs:232`) — so this one entry is the whole
      gap, and `complete --enforcement-only` currently prints `complete does not take
      --enforcement-only` and exits **2**.

- [ ] **Step 3b:** Add a **rejection-specific exit code** to `complete`, distinct from every code it
      returns today, and return it only when the recomputed enforcement checks reject the task.
      Task 4's handler blocks on this code and on nothing else.

      This is the load-bearing half of the two. `complete` currently returns **2** for a malformed
      manifest *or* an argv error (`cli.mjs:2760`, `:1242`) and **4** for a gate rejection *or* a
      cannot-verify (`cli.mjs:2761`, `:2811`). Neither can carry a block decision: 2 would block a
      teammate for the orchestrator's typo, 4 would allow the very rejection the hook exists to
      catch.

      `tests/cli.test.mjs:3040` pins the current behaviour under the name *"complete exits 4 when
      the recomputed gate fails"* and asserts both `code === 4` and `/gate does not pass for
      phase/`. That test must be updated in the same step, not left to fail — it is the pin that
      makes the old code meaningful, so changing the code without it leaves the suite red for a
      reason unrelated to the defect being fixed.

- [ ] **Step 4:** Add the `locate` command. It defaults both values from where it is run, so the
      brief can carry one bare command instead of a shell dance the teammate can get wrong, and it
      resolves the main worktree itself:

      ```js
      if (command === 'locate') {
        // Run from inside a teammate's worktree, so `root` here would be that worktree. The
        // record belongs to the run, which lives in the MAIN worktree: --git-common-dir is
        // `<main>/.git` for a linked worktree and the repository's own `.git` otherwise, so its
        // parent is the main worktree in both cases.
        const git = createGit({ cwd: root })
        const commonDir = await git.gitCommonDir()
        const mainRoot = path.dirname(commonDir)
        const worktree = typeof flags.worktree === 'string' ? flags.worktree : root
        const branch = typeof flags.branch === 'string' ? flags.branch : await git.currentBranch()
        const written = await writeLocation(mainRoot, runId, flags.task, { worktree, branch })
        io.out(`recorded ${flags.task} at ${worktree} on ${branch}`)
        return 0
      }
      ```

- [ ] **Step 5:** Add a `gitCommonDir()` method to the git wrapper in `scripts/git.mjs` if one does
      not already exist, running `rev-parse --path-format=absolute --git-common-dir`. Check the file
      first — the wrapper already exposes `currentBranch`, and duplicating an existing method is
      worse than reusing it.

- [ ] **Step 6:** Wire `--enforcement-only` into `complete` (`scripts/cli.mjs:2756`). Replace the
      direct `runChecks(allChecks, taskCtx)` call with the existing shared helper, and add the same
      refusal guard the other two callers use:

      ```js
      const enforcementOnly = flags['enforcement-only'] === true
      if (enforcementOnly) {
        const refusal = enforcementOnlyRefusal(config, [flags.phase ?? 'default'])
        if (refusal) { io.out(refusal); return 2 }
      }
      const results = await runPhaseChecks(allChecks, taskCtx, enforcementOnly)
      ```

- [ ] **Step 7:** In `init-run`, record the plan path so the hook can find it. It arrives as
      `positional[0]`; store it repo-relative with forward slashes, because `deriveContext` reads it
      out of git at the anchor and git paths are always `/`-separated:

      ```js
      // Recorded so a stop-time hook can run `complete` without being told the plan path.
      // Repo-relative on purpose: the gate reads this path out of git at the run anchor, and an
      // absolute path from one machine means nothing on another.
      const planPath = path.relative(root, path.resolve(positional[0])).split(path.sep).join('/')
      await writeState(root, runId, 'plan', { runId, totalPhases, tasks, planPath })
      ```

- [ ] **Step 7b:** Make `init-run` apply the **same id rule as the location record**, and treat the
      store as authoritative where they differ.

      They diverge today on `;`, space, `:`, `*`, a leading `-`, emoji, ZWNJ and tab: `init-run`
      admits ids that `writeLocation` and `findTaskByWorktree` then refuse. A run initialised with
      such an id parses, phases and dispatches normally, and every teammate's `locate` fails at the
      first act after checkout — so the hook resolves nothing for the whole run and enforcement is
      silently off, which is indistinguishable from a clean pass.

      The store's rule, as built: `/^[\p{L}\p{M}\p{N}._-]+$/u`, no component `.` or `..`, no `..`
      anywhere, no leading `-`; a runId may nest, a taskId is exactly one component. It is an
      allowlist, not a blocklist, and that is deliberate — blocklists over Unicode proved
      unbounded, and `Default_Ignorable` alone missed 29 `Cf` points while wrongly excluding
      functional joiners. Reject at `init-run` with a message naming the offending id and
      character, rather than letting the run reach dispatch.

- [ ] **Step 8:** Add the `brief` command. It must source the plan exactly as `workflow` does
      (`scripts/cli.mjs:1416-1428`) — from git at the run anchor, never from the working tree. The
      comment there records why: reading the checked-out copy let the constraints injected into
      briefs come from mutable uncommitted markdown while the gate enforced the committed plan, so a
      teammate could widen its own rules by editing a file. Reuse that block verbatim, including its
      failure on an uncommitted plan, then compose:

      ```js
      if (command === 'brief') {
        const resolved = await resolveConfig(root, io)
        const state = await readState(root, runId, 'plan')
        if (!state) { io.out(`no run ${runId} — run init-run first`); return 4 }
        const task = (state.tasks ?? []).find((t) => t.id === flags.task)
        if (!task) { io.out(`no task ${flags.task} in run ${runId}`); return 4 }
        // planMarkdown comes from the anchor-read block copied from `workflow`.
        io.out(composeBrief({
          task: { ...task, branch: taskBranchName(runId, task.id) },
          runId,
          planPath,
          baseBranch,
          constraints: parseConstraints(planMarkdown),
          caveman: resolved.caveman,
        }))
        return 0
      }
      ```

- [ ] **Step 9:** Apply the same flag coercion `workflow` uses (`scripts/cli.mjs:1414-1415`):
      `const planPath = flags.plan === true ? '' : (flags.plan ?? '')` and the same for `--base`. A
      bare `--plan` parses as the boolean `true`, and coercing it through would render the literal
      `true` as a plan path.

- [ ] **Step 10:** Add the imports: `composeBrief` from `./brief.mjs`, `writeLocation` from
      `./state.mjs` alongside the existing state imports at `scripts/cli.mjs:7`, and `taskBranchName`
      from `./enforce.mjs` — that is the single definition of `teammates/${runId}/${taskId}` and this
      command must not restate it. `parseConstraints` is already defined in this file at
      `scripts/cli.mjs:547`, and `resolveConfig` is called per command block rather than shared, so
      `brief` calls it itself.

- [ ] **Step 11:** In `tests/cli.test.mjs`, add a test that `locate --run r1 --task T1` run from
      inside a linked worktree writes its record **under the main worktree**, with that worktree's
      own path and current branch, and a test that explicit `--worktree` and `--branch` override
      both.

      Assert on **the path `writeLocation` returns**, not on `.teammates/r1/worktrees/T1.json` —
      that is the superseded layout and nothing writes it. As built the record is
      `.teammates/index/<sha256 of the normalised worktree>.json`, so a test that composes the
      path from the ids cannot pass.

      The "under the main worktree" half is the part worth testing hardest: `locate` takes no path
      argument, so an implementation that inherits the CLI's shared default
      (`flags.root ?? process.cwd()`, `scripts/cli.mjs:1258`) files the record inside the
      teammate's own worktree. `.teammates/` is gitignored, so that directory appears silently and
      the command exits 0 with nothing to notice — while the handler, which resolves the main root
      via `git rev-parse --path-format=absolute --git-common-dir` and takes the parent, then finds
      no record for any cwd and allows every stop. Enforcement would be inert and indistinguishable
      from a clean pass.

- [ ] **Step 12:** Add a test that `complete --enforcement-only` on a phase whose manifest declares
      no enforcement check exits 2 with the refusal message, matching `finish` and `prune-run`.

- [ ] **Step 13:** Add a test that `complete --enforcement-only` runs no `command` check — assert the
      results list carries the skip note `skipped by --enforcement-only` for each one.

- [ ] **Step 14:** Add a test that `init-run` writes `planPath` into `plan.json` as a repo-relative
      forward-slash path, given an absolute plan path as its positional argument.

- [ ] **Step 15:** Add a test that `brief --run <id> --task T1 --plan <path> --base master` prints a
      brief containing `git checkout -B teammates/<id>/T1 master`, the locate command, the complete
      command, the plan path and every file the task declares; that an unknown task id exits 4
      naming the task; and that a run whose plan is uncommitted fails non-zero rather than emitting a
      constraint-free brief.

- [ ] **Step 16:** Add a test that `locate --worktree` with no value is refused with the spelling
      advice, and that `brief --commits 5` is refused as an unknown flag — the two guarantees
      `KNOWN_FLAGS` exists to provide.

---

### Task 6: compose briefs at generation time

**Files:**
- Modify: `scripts/workflow-gen.mjs`
- Modify: `templates/phase-workflow.js`
- Test: `tests/workflow-gen.test.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T2, T5

Amended 2026-08-16: `tests/cli.test.mjs` added to the set. Deleting the `PLAN_PATH`,
`BASE_BRANCH` and `CAVEMAN` template constants (Step 6) obsoletes three assertions in
`tests/cli.test.mjs` that pin the old scalar-constant contract via a `captureWorkflowConstants`
helper — a file this task did not originally declare and therefore could not fix. Step 10 rewrites
them to the new contract.

`T5` was added after phasing was first computed. This task composes briefs that carry the `locate`
step, and `locate` is the command Task 5 builds — generating a brief for a command that does not
exist yet is how a brief ships an invocation the CLI rejects. Adding the dependency moves this task
out of Task 5's phase and into the next one; validated against `init-run`, the layout becomes
phase 1 `T1 T2 T3` · phase 2 `T4 T5` · phase 3 `T6 T7 T8`.

- [ ] **Step 1:** In `scripts/workflow-gen.mjs`, add `BRIEFS` to the marker pattern at line 19:
      `const MARKER = /__(?:META|TASKS|BRIEFS|PLAN_PATH|BASE_BRANCH|CONSTRAINTS|CAVEMAN|EFFORT)__/g`.

- [ ] **Step 2:** Add the substitution alongside the others (`scripts/workflow-gen.mjs:68-78`),
      composing one brief per task through the shared module. `runId` is already a parameter of
      `generatePhaseWorkflow`, so the locate and verify sections render:

      ```js
      __BRIEFS__: () => JSON.stringify(
        Object.fromEntries(slim.map((task) => [task.id, composeBrief({
          task, runId, planPath, baseBranch, constraints, caveman,
        })])),
        null,
        2,
      ),
      ```

- [ ] **Step 3:** Add `import { composeBrief } from './brief.mjs'` at the top of
      `scripts/workflow-gen.mjs`.

- [ ] **Step 4:** In `templates/phase-workflow.js`, delete `checkoutSteps` (lines 34-49),
      `blastRadius` (lines 56-64), `brief` (lines 66-91) and `briefTerse` (line 97 onward), and
      replace them with the substituted map:

      ```js
      // Briefs are composed by the generator, not here: a generated workflow runs without module
      // or filesystem access, so the only way both dispatch paths can share one implementation is
      // for the text to arrive already composed.
      const BRIEFS = __BRIEFS__

      const compose = (t) => BRIEFS[t.id]
      ```

- [ ] **Step 5:** Update the template's header comment (lines 1-6) to name the `BRIEFS` marker and
      drop the description of markers the brief no longer reads directly.

- [ ] **Step 6:** Delete the now-unused `PLAN_PATH`, `BASE_BRANCH`, `CONSTRAINTS` and `CAVEMAN`
      constants from the template, and their markers from `MARKER` and the substitutions map, only
      where no reference remains. Check each one individually before deleting rather than assuming
      the brief was its only reader.

- [ ] **Step 7:** In `tests/workflow-gen.test.mjs`, keep every existing assertion about brief content
      passing against the generated script, so the extraction is proven not to have changed the
      output.

- [ ] **Step 8:** Add a test that the generated script contains no function named `brief`,
      `briefTerse`, `checkoutSteps` or `blastRadius` — the single implementation is the point, and a
      copy silently reappearing in the template is the failure this task exists to prevent.

- [ ] **Step 9:** Add a cross-file test that for one task, `composeBrief` called directly and the
      brief embedded in the generated script are byte-identical.

- [ ] **Step 10:** In `tests/cli.test.mjs`, three tests pin the removed scalar constants and now
      fail. Rewrite each to assert the **composed brief text** carries the same guarantee the old
      constant did, not that the constant exists. The generator no longer emits `PLAN_PATH`,
      `BASE_BRANCH` or `CAVEMAN` — it emits a `BRIEFS` object mapping task id to already-composed
      brief text, so `captureWorkflowConstants` (which evaluates `return { PLAN_PATH, BASE_BRANCH }`
      out of the generated source) has nothing to capture and must be replaced or removed.

      - `workflow with a valueless --base renders the no-base brief rather than the word true`:
        assert the brief text for the task renders the **no-base variant** (the "No base branch was
        supplied" wording), not that `BASE_BRANCH` equals `''`.
      - `workflow with a valueless --plan renders the no-plan brief rather than failing to read "true"`:
        assert the brief text reflects the empty plan path in the same way `composeBrief` renders it,
        not that `PLAN_PATH` equals `''`.
      - `workflow renders a caveman brief when the local layer configures one`: assert the brief text
        is the **caveman-compressed** form (and keep the existing `assert.match(src, /MANDATORY FIRST
        STEP/)` check — the safety instructions survive compression), not that `CAVEMAN = 'full'`
        appears.

      Do not change any behaviour, threshold, or other test. This step only realigns three
      assertions with the contract Steps 4 and 6 establish.

---

### Task 7: declare the hook

**Files:**
- Modify: `hooks/hooks.json`
- Test: `tests/hook.test.mjs`

**Depends:** T4

- [ ] **Step 1:** Add a `SubagentStop` key to `hooks/hooks.json` alongside the existing
      `SessionStart` entry, with no matcher — the event takes none — and synchronous, because a hook
      that must be able to block cannot be async:

      ```json
      "SubagentStop": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/subagent-stop.mjs\"",
              "async": false
            }
          ]
        }
      ]
      ```

- [ ] **Step 2:** Add a test to `tests/hook.test.mjs` asserting `hooks.json` declares exactly one
      `SubagentStop` entry, that it carries no `matcher` key, and that it is `"async": false`.

- [ ] **Step 3:** Add a test asserting the declared command names a file that exists at
      `scripts/subagent-stop.mjs`, so a rename cannot leave a hook pointing at nothing.

- [ ] **Step 4:** Add a test asserting the `SubagentStop` command does **not** route through
      `run-hook.cmd` — it is a Node script and needs no bash — while the `SessionStart` entries still
      do.

- [ ] **Step 5:** Add these assertions without introducing a new `bash` spawn at module load: use
      file reads and JSON parsing only, per the constraint this suite already carries.

---

### Task 8: agent contract and skills

**Files:**
- Modify: `agents/tm-implementer.md`
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/fleet-lifecycle/SKILL.md`
- Modify: `skills/fleet-supervision/SKILL.md`
- Modify: `skills/using-teammates/SKILL.md`
- Test: `tests/agents.test.mjs`
- Test: `tests/skill-contracts.test.mjs`

**Depends:** T4, T5

- [ ] **Step 1:** In `agents/tm-implementer.md`, add a hard rule immediately after the branch rule at
      line 24: record the worktree as the first act after checking out the task branch, with
      `node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" locate --run <runId> --task <taskId>`, which takes
      no path arguments. State why: if the teammate stops before finishing, this record is the only
      thing that identifies its work, because the harness checks out `worktree-agent-<hash>` and the
      task branch exists only once the teammate creates it.

- [ ] **Step 2:** In the same file, extend the existing "Before returning `done`, prove your work is
      on that branch" rule at line 34 with the gate run: after pasting the log and diff, run
      `complete` in the foreground against the main worktree root and fix whatever it reports before
      returning `done`. Give the exact command, including the `ROOT=$(dirname ...)` derivation and
      why it is needed.

- [ ] **Step 3:** In the same file, add one sentence stating that stopping without doing this is
      caught: a `SubagentStop` hook runs the enforcement checks and can refuse the stop, returning
      the failure text. It is a backstop, not a substitute — it runs the cheap subset, and the phase
      gate still runs everything.

- [ ] **Step 4:** In `skills/parallel-execution/SKILL.md`, state that the brief comes from
      `node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" brief --run <id> --task <id> --plan <path> --base
      <branch> --root <project root>` rather than being composed by hand, on both the direct-`Agent`
      path and any fallback dispatch.

- [ ] **Step 5:** In the same file, rewrite the fix-round step to address the live teammate first:
      `SendMessage` the teammate that owns the failing task, by the id its dispatch returned, with
      the finding text; respawn only when that teammate is gone. Its worktree still holds the
      context a cold respawn would have to rebuild, and a respawned teammate re-runs `locate`, which
      overwrites the record with its new worktree.

- [ ] **Step 6:** Add one line to the same step: a teammate inside a running `Workflow` cannot
      receive `SendMessage`, so a phase dispatched through the `Workflow` tool has no live teammate
      to address and its fix round respawns.

- [ ] **Step 7:** In `skills/fleet-lifecycle/SKILL.md:66-67`, leave the `SendMessage` caveat exactly
      as written — it is true in both modes — and add a sentence that this is why fix rounds address
      directly dispatched teammates only.

- [ ] **Step 8:** In `skills/fleet-supervision/SKILL.md`, add that a teammate's stop runs the
      `SubagentStop` hook and that a blocked stop appears in its transcript, while `liveness` remains
      the only thing that sees a teammate which never stops at all — no stop-path hook fires for a
      parked agent.

- [ ] **Step 9:** In `skills/using-teammates/SKILL.md`, leave the fleet-versus-inline preview
      unchanged. The spec's plan to name the active mode there is dropped: nothing in the plugin
      behaves differently with the flag on, so naming it would imply a difference that does not
      exist.

- [ ] **Step 10:** In `tests/agents.test.mjs`, add assertions that `agents/tm-implementer.md`
      contains the literal `cli.mjs locate` and the literal `cli.mjs complete`, so the contract
      cannot drift from the commands it tells teammates to run.

- [ ] **Step 11:** In `tests/skill-contracts.test.mjs`, add an assertion that
      `skills/parallel-execution/SKILL.md` contains the literal `cli.mjs brief`, so the dispatch
      instructions cannot drift from the CLI they call.

- [ ] **Step 12:** Add an assertion that no skill or agent file claims the `SubagentStop` hook
      catches a stalled or parked teammate: any sentence containing `SubagentStop` and `stall` must
      also contain `liveness`.

- [x] **Step 13 (DEFERRED 2026-08-16):** The live enforcement window is real — a phase dispatched
      directly (fewer than three tasks, no `Workflow`) leaves `runBranch` unrecorded, so the
      `SubagentStop` guard **fails open**. The originally prescribed fix — have
      `skills/parallel-execution/SKILL.md` instruct a `git checkout <run branch>` before dispatch —
      was found false in review: a checkout writes **no** record. `rememberRunBranch` is called only
      by `gate`, `finish`, `prune-run` and `workflow` (`scripts/cli.mjs`); neither `git checkout` nor
      `cli.mjs brief` records `runBranch`, so the checkout closes nothing. What Task 8 shipped instead
      is the honest disclosure: `skills/parallel-execution/SKILL.md` now states the guard is fail-open
      on the direct path and that the phase gate is the enforcement there, pinned by a
      `tests/skill-contracts.test.mjs` assertion on the literal `fail-open` (and a negative assertion
      that the false closure claim cannot return).

      **Closed 2026-08-16 (followup) — by a skill reorder, no `cli.mjs` change.** `locate` cannot
      record the run branch (it runs in the teammate's worktree and never has it), but `init-run`
      already records the branch it is invoked on — `runBranch = (head === base ? null : head)`,
      written through `writePlan` fill-if-absent. So the fix is order: check out the run branch
      **before** `init-run`, and init-run records it, arming the guard before any teammate can stop.
      `skills/parallel-execution/SKILL.md` §1 now states that order and §2 keeps the residual for when
      it is skipped; pinned by `tests/cli.test.mjs` ("init-run records the checked-out run branch, and
      records none on the base branch") and the `tests/skill-contracts.test.mjs` §1-order assertion.

---

### Task 9: re-measure the integration-time citations and record the closed enforcement window

**Files:**
- Modify: `docs/specs/2026-08-10-agent-teams-adoption-design.md`
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `scripts/brief.mjs`
- Modify: `scripts/state.mjs`
- Modify: `agents/tm-implementer.md`
- Modify: `skills/fleet-supervision/SKILL.md`
- Test: `tests/cli.test.mjs`
- Test: `tests/skill-contracts.test.mjs`

**Depends:** T8

This task exists because two corrections can only be made against the integrated tree, and the
plan's own "Follow-up owed after Task 5 lands" section says so: the spec's `cli.mjs` citations
drift the moment Task 5 edits `cli.mjs`, and the §1/§2 disclosure in `skills/parallel-execution`
can only be settled once Task 5's `init-run` behaviour and Task 8's skill text are both merged.
Neither is doable on a phase 1–3 branch. Declaring them here keeps them inside the ownership
model instead of arriving as a direct write to the run branch.

- [ ] **Step 1:** Re-measure every `scripts/cli.mjs` citation in
      `docs/specs/2026-08-10-agent-teams-adoption-design.md` against the merged tree — not against
      any task branch — and correct the exit-code and false-PASS citations that moved.

- [ ] **Step 2:** In `skills/parallel-execution/SKILL.md` §1, instruct checking the run branch out
      **before** `init-run`, and state the mechanism: `init-run` records HEAD as the run branch
      whenever HEAD is not the base, and records nothing when it is. That record is what the
      `SubagentStop` guard resolves a stopping teammate to its task through.

- [ ] **Step 3:** In §2, keep the residual honest — a bare checkout writes no record, so where the
      §1 order is skipped the guard stays fail-open until a later `gate`, `finish`, `prune-run` or
      `workflow` records the branch.

- [ ] **Step 4:** Pin Step 2's mechanism in `tests/cli.test.mjs`: `init-run` on a non-base branch
      records that branch, and on the base branch records none.

- [ ] **Step 5:** Pin Steps 2 and 3 in `tests/skill-contracts.test.mjs`: §1 must state the order,
      and §2 must keep the `fail-open` disclosure with a negative assertion that the false
      "a checkout by itself records the run branch" claim cannot return.

---

## Follow-up owed after Task 5 lands

- [ ] **Re-measure the spec's `cli.mjs` citations.** `docs/specs/2026-08-10-agent-teams-adoption-design.md`
      cites `scripts/cli.mjs` at roughly ten places (`:242`, `:1242`, `:1258`, `:1399`, `:2722`,
      `:2727-2735`, `:2760`, `:2761`, `:2803`, `:2811`, `:2814`, `:2815-2817`, `:2819`, `:2821`).
      All were verified correct against the pre-Task-5 tree and will drift the moment Task 5 edits
      `cli.mjs`. The spec is **not** in Task 5's declared file set, so Task 5 cannot fix them and
      must not try — this is a separate follow-up, and whoever dispatches it owns re-measuring
      every one against the merged tree rather than against a task branch.

      A stale citation here is not cosmetic: this run already produced a medium where six added
      comment lines moved a clamp from `state.mjs:482` to `:488` and left the spec pointing at
      prose. That defect existed only in the merge and was invisible on either branch alone.

## Verification

- [ ] `node --test tests/*.test.mjs` is green.
- [ ] `node scripts/cli.mjs init-run docs/plans/2026-08-13-subagent-stop-enforcement.md --run plancheck --root .`
      prints four phases: T1 T2 T3 / T4 T5 / T6 T7 T8 / T9. Remove `.teammates/plancheck` afterwards.
- [ ] With the plugin installed, a teammate that stops having created no branch is blocked once and
      told which branch to create; stopping a second time is allowed through, and the phase gate
      still fails the task.
- [ ] A teammate that strays outside its declared file set is blocked at stop time, and the block
      arrives in seconds rather than after a full test run.
