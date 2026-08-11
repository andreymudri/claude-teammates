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
- Test: `tests/gate-runner.test.mjs`
- Test: `tests/doctor.test.mjs`

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

### Task 3: make an unverified review stop being a pass

**Files:**
- Modify: `scripts/reviews.mjs`
- Modify: `scripts/cli.mjs`
- Modify: `skills/phase-gate/SKILL.md`
- Test: `tests/reviews.test.mjs`
- Test: `tests/cli.test.mjs`

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
