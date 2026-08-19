# Claims lens, liveness reporting, and distinct task refs

Spec: `docs/specs/2026-08-10-claims-liveness-distinct-refs-design.md`

## Global Constraints

- Node >= 24.2.0
- Zero runtime dependencies and zero dev dependencies; tests use the built-in `node:test` runner
- git >= 2.24; every git invocation passes `--end-of-options`, and a trailing `--` wherever the
  command accepts a pathspec. One tested exception exists: `git status --porcelain --ignored`
  returns nothing when given `--end-of-options --` on git 2.53, so `scripts/git.mjs`'s
  `ignoredPaths` deliberately omits both and a test pins their absence
- Commit messages: single-line, commitlint style, English
- No check may read anything under `.teammates/`; that state is written by the agents being enforced
- Comments state what the code does, never a guarantee it does not deliver — this plan adds a
  reviewer lens whose whole job is finding the difference

### Task 1: replace the sha-membership landed test with a declared-files predicate

**Files:**
- Modify: `scripts/gate-runner.mjs`
- Test: `tests/gate-runner.test.mjs`
- Test: `tests/adversarial.test.mjs`

This section originally planned a separate "reject duplicate task refs" step — a run-wide map of
task ref to sha, with a twin-detection test run before the empty-diff test in `runFilesetCheck`.
That mechanism was not built; no `runWideTaskShas` function, and no identical-sha rejection, exist
anywhere in `scripts/gate-runner.mjs`. What shipped instead replaces the old sha-membership test
outright, in both `deriveContext` and `runFilesetCheck`, with a single per-task predicate. This
section records what that predicate is, not the discarded design above.

**What shipped.** `mergedParentFiles(git, { anchorSha, runSha })` walks only the run branch's own
first-parent chain from `runSha` back to `anchorSha` — not every commit in `anchor..run`. For each
chain commit with more than one parent, and for each secondary parent that is itself in
`anchor..run`, it records that parent's own contribution since it diverged from the chain's prior
tip (`changedFiles({ base: firstParent, branch: parent })`, a three-dot diff), indexed by that
parent's sha. A sha named by more than one chain commit has its file sets unioned rather than kept
per-merge.

`landedForFiles(filesBySha, sha, declaredFiles)` is then: true when the indexed file set for `sha`
intersects `declaredFiles`, comparing both sides through the same path normalization
`filesetViolations` uses. A branch already on the run branch (`forkPoint === sha`, so its own diff
is empty) reads as landed only when `landedForFiles` is true for its own declared files — replacing
the old test of whether the sha was merely a member of `mergedBranchTips`. `deriveContext`'s
phase-integration loop and `runFilesetCheck`'s empty-diff branch both call `landedForFiles` against
one shared `mergedParentFiles` index built once per invocation.

**The limit, carried over rather than the reassuring half of it.** The precondition this predicate
needs is that the parked task's declared set must not intersect what the integrating merge actually
carried. Within one phase that always holds, because `scripts/phases.mjs` assigns two tasks to the
same phase only when their declared files are disjoint — but declared sets routinely overlap ACROSS
phases, since a later task modifies a file an earlier task created. When they do overlap, the
predicate cannot tell a parked ref from a genuine one: both read `landedForFiles` true from the
identical, real intersection. This is sibling-tip self-integration with an overlapping declared
set, and it is NOT closed. Executed reproduction: `T1: Create a.mjs`, `T2: Modify a.mjs, Create
b.mjs`; T2 writes nothing and its ref is pointed at T1's own merged tip; verdict PASS, `b.mjs` never
exists. Pinned as a LIMIT in `tests/adversarial.test.mjs`, and named in the "what remains open"
comment above `deriveContext`'s per-task loop in `scripts/gate-runner.mjs`.

What the predicate does close, each confirmed by executing the shape against a real repository
rather than asserted from the design alone: a ref parked at a merged sibling's tip with a disjoint
declared set (fails, correctly); the same shape after the sibling makes a further fix-round commit
that moves its own ref off the shared sha (still fails — the predicate depends on what the merge
carried, not on where any ref currently sits); two idle refs sharing an old run tip that an
unrelated merge turned into a secondary parent, such as a plan-amendment merge or a third task's own
sync merge (neither is accused of parking; both fail on the ordinary "contributes no file changes"
message instead); and a near-sibling — an empty commit built one commit above a merged sibling's
tip, merged under its own name — whose own merge diff is empty and so can never intersect a
non-empty declared set. Fast-forward integration is unchanged and out of scope for this predicate:
a fast-forward leaves no merge commit to name the branch at all, so it is not a key in
`mergedParentFiles` and reads as not-landed regardless.

### Task 2: add the `liveness` command

**Files:**
- Create: `scripts/liveness.mjs`
- Modify: `scripts/git.mjs`
- Modify: `scripts/cli.mjs`
- Modify: `skills/fleet-supervision/SKILL.md`
- Modify: `README.md`
- Test: `tests/liveness.test.mjs`
- Test: `tests/git.test.mjs`
- Test: `tests/cli.test.mjs`

- [ ] **Step 1:** Create `scripts/liveness.mjs` as a pure module — no git, no filesystem, no
  config, the same shape as `scripts/review-gen.mjs`:

```js
// Which teammates are actually working, computed from two signals neither of which is a
// self-report: when each task branch was last committed to, and when anything under its worktree
// was last touched. A teammate mid-edit has a fresh worktree and a stale tip; a teammate parked
// waiting for a notification that never arrives has neither.
//
// This is a supervision aid and nothing reads it. Both signals are forgeable by the teammate they
// describe — GIT_COMMITTER_DATE moves a commit's timestamp, and any background process touching a
// file refreshes an mtime — so it must never be cited as evidence for a gate. It catches the
// failure that actually happens, not an adversary.
//
// Pure so it is testable without a repository: the caller gathers `tips` and `touches` and the
// clock, and this decides.

export const DEFAULT_STALE_MINUTES = 20

// A task with no branch and no worktree has not started. Reporting that as a stall would make
// every queued task of a wide phase look like a hung teammate on the first heartbeat.
export function livenessRows({ tasks = [], tips = {}, touches = {}, now, staleMinutes = DEFAULT_STALE_MINUTES } = {}) {
  if (!Number.isFinite(now)) throw new Error(`livenessRows requires a numeric clock, got ${JSON.stringify(now)}`)
  const thresholdMs = staleMinutes * 60 * 1000
  return (tasks ?? []).map((task) => {
    const tip = tips[task.id] ?? null
    const touch = touches[task.id] ?? null
    const tipAgeMs = tip?.at == null ? null : now - tip.at
    const touchAgeMs = touch?.at == null ? null : now - touch.at
    if (tip == null && touch == null) {
      return { taskId: task.id, branch: tip?.branch ?? null, tipAgeMs: null, touchAgeMs: null, floored: false, state: 'not started', unknownReason: null }
    }
    // A floored measurement is a LOWER bound on freshness: the walk stopped early, so the newest
    // file may be one it never reached. The task can only be more recently touched than reported,
    // never less — so a floored row cannot be called stalled. It cannot be called working either:
    // on a project whose worktree holds more entries than the walk's cap, every walk floors, every
    // row would read working, and the command's only failure signal could never fire on exactly
    // the repositories it exists to supervise. `unknown` is the third answer, meaning freshness was
    // NOT measured, reported rather than dressed up as an all-clear. A fresh TIP still settles the
    // row as working on its own; only when nothing measured is fresh does the touch signal decide
    // between `unknown` and `stalled`. A missing tip is NOT treated as unknown — `branchExists`
    // returning false is a measured negative, so a stale worktree with no branch is a genuine
    // stall.
    const floored = touch?.floored === true
    const touchMeasured = touch != null && touch.at != null && !floored
    const ages = [tipAgeMs, touchAgeMs].filter((a) => a != null)
    const fresh = ages.some((age) => age <= thresholdMs)
    const unknownReason = fresh || touchMeasured
      ? null
      : (floored ? 'walk-capped' : 'no-worktree-measurement')
    const state = fresh ? 'working' : (unknownReason ? 'unknown' : 'stalled')
    return { taskId: task.id, branch: tip?.branch ?? touch?.branch ?? null, tipAgeMs, touchAgeMs, floored, state, unknownReason }
  })
}

export function renderLiveness(rows = [], { staleMinutes = DEFAULT_STALE_MINUTES } = {}) {
  const age = (ms) => (ms == null ? '-' : `${Math.floor(ms / 60000)}m`)
  const lines = [`liveness (stale after ${staleMinutes}m)`, 'task  tip     touched  state']
  for (const row of rows) {
    const note = row.floored ? ' (floor)' : ''
    lines.push(`${row.taskId}  ${age(row.tipAgeMs)}  ${age(row.touchAgeMs)}${note}  ${row.state}`)
  }
  return lines.join('\n')
}

export function hasStall(rows = []) {
  return rows.some((row) => row.state === 'stalled')
}

// Rows whose freshness was never measured. Separate from `hasStall` because the two answer
// different questions: a stall is a measurement, this is the absence of one, and the CLI reports
// them with different exit codes.
export function hasUnknown(rows = []) {
  return rows.some((row) => row.state === 'unknown')
}
```

Four states shipped, not two: `working`, `stalled`, `not started`, and `unknown` — with an
`unknownReason` of `walk-capped` or `no-worktree-measurement`. The rule originally planned here —
"a floored row is never reported as stalled", collapsed into `working` — was replaced during
review. Reporting a floored row as `working` was an all-clear about a teammate nothing had actually
measured; a floored row now reads `unknown`, and the CLI exits 2 for it rather than 0.

- [ ] **Step 2:** Add `commitTime` to the object returned by `createGit` in `scripts/git.mjs`,
  next to `commitSubject`. It takes a sha, not a name — the caller resolves through `resolveRef`
  first, for the tag-precedence reason `resolveRef`'s own comment gives:

```js
    // Committer date, in milliseconds, of a sha the caller already resolved. %ct rather than %at:
    // the author date survives a rebase and would report a teammate's work as older than the
    // commit that carries it.
    async commitTime(sha) {
      if (!isNonEmptyString(sha)) {
        throw new GitError(`commitTime requires a non-empty sha, got ${JSON.stringify(sha)}`)
      }
      const out = (await run(['log', '-n', '1', '--format=%ct', '--end-of-options', sha, '--'])).trim()
      const seconds = Number(out)
      if (!Number.isFinite(seconds)) {
        throw new GitError(`commitTime read a non-numeric committer date for ${sha}: ${JSON.stringify(out)}`)
      }
      return seconds * 1000
    },
```

- [ ] **Step 2b:** Add `commitTime` coverage to `tests/git.test.mjs`, following the shape of the
  existing `commitSubject` tests: it returns milliseconds for a resolved sha, it throws a
  `GitError` on an empty or non-string ref, it throws when git returns a non-numeric committer
  date, and the argv it builds carries `--end-of-options` and the trailing `--`.

- [ ] **Step 3:** In `scripts/cli.mjs`, add the bounded mtime walk. It lives here rather than in
  `liveness.mjs` because that module is pure by design:

```js
// Newest mtime under a directory, pruning what git says the project ignores and visiting at most
// MAX_WALK_ENTRIES entries. `floored: true` means the cap stopped the walk, so the answer is a
// lower bound on freshness rather than a measurement — `livenessRows` reports such a row as
// `unknown` rather than as either working or stalled.
//
// `ignored` is supplied by the caller from `git.ignoredPaths`, not hardcoded: a fixed `.git`/
// `node_modules` pair missed every other generated directory (`dist`, `.next`, `target`, `.venv`)
// and named `node_modules` in a project that might legitimately track it, so a repository with any
// of those floored every walk and the command's only failure signal was inert exactly where it was
// needed most. `.git` stays hardcoded — git does not report it as ignored, it is simply not part of
// the working tree — so nothing in the supplied set can cover it.
export const MAX_WALK_ENTRIES = 5000
const WALK_SKIP = new Set(['.git'])

export async function newestMtime(dir, { ignored = new Set() } = {}) {
  let newest = null
  let visited = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      // A worktree deleted without `git worktree prune` is still listed by git; not an error
      // worth failing the report over, only the absence of evidence.
      continue
    }
    for (const entry of entries) {
      if (visited >= MAX_WALK_ENTRIES) return { at: newest, floored: true }
      visited += 1
      if (WALK_SKIP.has(entry.name) || ignored.has(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { stack.push(full); continue }
      try {
        const st = await stat(full)
        if (newest == null || st.mtimeMs > newest) newest = st.mtimeMs
      } catch { /* vanished mid-walk; same reasoning as above */ }
    }
  }
  return { at: newest, floored: false }
}
```

Import `readdir` and `stat` from `node:fs/promises` alongside the existing `readFile` import. Both
the cap and this function are exported so the suite can walk a real tree of `MAX_WALK_ENTRIES + 1`
entries rather than being told the flag — a walk that always floors reports no stall ever, while a
unit test that merely asserts the synthetic flag stays green regardless.

- [ ] **Step 4:** Register the command. Add `liveness: ['run', 'plan']` to `REQUIRED`
  (`scripts/cli.mjs:189`), `liveness: ['run', 'plan', 'stale']` to `KNOWN_FLAGS`, `liveness` to
  the command list in `USAGE` (`scripts/cli.mjs:67`), and this usage line under the `doctor` line:

```
  liveness --run <id> --plan <path> [--stale <minutes>] [--root <path>]
```

- [ ] **Step 5:** Add the command block to `scripts/cli.mjs`, immediately after the `doctor` block
  so the two reports sit together:

```js
  if (command === 'liveness') {
    const git = createGit({ cwd: root })
    // Same reasoning as `doctor`: the plan is read from the working tree, because a report that
    // enforces nothing has no reason to read it at the anchor, and a diagnostic that needs a
    // committed plan is useless at the moment a run is going wrong.
    let tasks = []
    try {
      tasks = assignPhases(parsePlan(await readFile(path.resolve(root, flags.plan), 'utf8')))
    } catch (err) {
      io.out(`cannot read the plan at ${flags.plan}: ${err.message}`)
      return 2
    }

    const staleMinutes = numericWindow(flags.stale, DEFAULT_STALE_MINUTES)
    if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) {
      io.out(`--stale takes a positive number of minutes, got ${JSON.stringify(flags.stale)}`)
      return 2
    }

    // The current phase's tasks only. An earlier phase's teammates have returned, and a later
    // phase's have not been dispatched; reporting either as stalled would be noise on every run.
    const derived = await derive(root, runId, { ...flags, plan: flags.plan }).catch(() => null)
    const phase = derived?.currentPhase ?? null
    const subject = phase == null ? tasks : tasks.filter((t) => t.phase === phase)

    // Worktree paths come from git, never from `.teammates/`: a teammate that picked its own
    // directory must not get to point this report at whatever looks busiest.
    const byBranch = new Map()
    for (const wt of await git.worktrees()) {
      if (wt.branch) byBranch.set(wt.branch, wt.path)
    }

    const tips = {}
    const touches = {}
    for (const task of subject) {
      const branch = taskBranchName(runId, task.id)
      if (await git.branchExists(branch)) {
        const sha = await git.resolveRef(`refs/heads/${branch}`)
        tips[task.id] = { branch, at: await git.commitTime(sha) }
      }
      const dir = byBranch.get(branch)
      if (dir) {
        const walked = await newestMtime(dir)
        touches[task.id] = { branch, at: walked.at, floored: walked.floored }
      }
    }

    const rows = livenessRows({ tasks: subject, tips, touches, now: Date.now(), staleMinutes })
    io.out(renderLiveness(rows, { staleMinutes }))
    for (const [reason, explanation] of UNMEASURED_REASONS) {
      const names = rows.filter((row) => row.unknownReason === reason).map((row) => row.taskId)
      if (names.length > 0) io.out(`freshness was not measured for ${names.join(', ')}: ${explanation}`)
    }
    // Precedence is deliberate: a stall is a MEASUREMENT and wins outright over an unmeasured row,
    // so masking a hang behind an unrelated unknown never happens. Every row and every explanation
    // is printed either way.
    if (hasStall(rows)) return 1
    if (hasUnknown(rows)) return 2
    return 0
  }
```

Import `livenessRows`, `renderLiveness`, `hasStall`, `hasUnknown` and `DEFAULT_STALE_MINUTES` from
`./liveness.mjs`.

What shipped has three exit codes, not two, and exit 2 is reached from more places than the stall
count: an unreadable plan; a `--stale` that is not a positive number; a run id whose
`.teammates/<runId>` directory does not exist (checked with `stat`, existence only, never
contents — the one exception to the constraint that no check may read under `.teammates/`, because
this is a report that decides and records nothing, and the state read is a directory name the
orchestrator created rather than a claim a teammate wrote); a failed phase derivation; a
`phaseError` (phases integrated out of order, or a plan parsing to zero tasks at the anchor); the
derived phase selecting no working-tree task (the plan in the working tree has drifted from the
plan at the anchor); and any row reading `unknown`. `derived.currentPhase == null` — every phase
integrated — exits 0 with a message, not a stall board covering nobody. A stall (exit 1) always
outranks an unknown row (exit 2) when both are present, because the stall is the one thing a
supervisor must act on.

- [ ] **Step 6:** Create `tests/liveness.test.mjs` covering the pure module: a fresh tip with a
  stale worktree reads `working`; a stale tip with a fresh worktree reads `working`; both stale and
  the touch genuinely measured reads `stalled`; no branch and no worktree reads `not started`; a
  worktree with no commits and a stale, measured mtime reads `stalled`; a floored touch reads
  `unknown` with `unknownReason: 'walk-capped'`, never `stalled`, however old; a task with a branch
  but no registered worktree reads `unknown` with `unknownReason: 'no-worktree-measurement'`; a
  stale branch with a measured negative (no branch at all) still reads `stalled`, not `unknown`;
  the threshold boundary is inclusive at exactly `staleMinutes` and stalls or unknowns one
  millisecond past it; a non-numeric `now` throws.

- [ ] **Step 7:** Add CLI-level tests to `tests/cli.test.mjs`: exit 0 when every task is working;
  exit 1 when any is stalled, even alongside an unknown row; exit 2 when any row is `unknown` and
  none is stalled; exit 2 on a `--stale` that is not a positive number; exit 2 on an unreadable
  plan; exit 2 on a run id with no `.teammates` directory; exit 2 on a failed derivation or
  `phaseError`; exit 0 with a message when every phase is integrated; exit 2 when the working-tree
  plan has no task in the derived phase; and that a bare `--stale` with no value is refused rather
  than read as `1`.

- [ ] **Step 8:** Add a heartbeat section to `skills/fleet-supervision/SKILL.md`, under
  "Event-driven, not polling":

```markdown
## The heartbeat

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" liveness --run <runId> --plan <planPath> --root <project root>

Run it on the 20-30 minute heartbeat, not in a loop. Exit 1 means at least one teammate of the
current phase has neither committed nor touched its worktree inside the window.

It reports; it does not act. A stalled row is your cue to message that teammate or offer to stop
it — the CLI has no handle on a subagent. Both of its signals are forgeable by the teammate they
describe, so a stall is a prompt to look, never evidence for a gate.
```

Also change the last row of the failure table from `Silent past the heartbeat | Surface it; offer
stop or wait. Never assume progress.` to name the command as the way that row is detected.

- [ ] **Step 9:** Add `liveness` to the command list in `README.md` under "Seeing what is actually
  there", with a one-line description, and a sentence on the `claims` lens where the reviewer
  lenses are described. Both features must be described as what they do, not as guarantees: the
  liveness report is forgeable by its subject, and the claims lens probes a bounded number of
  claims.

### Task 3: add the `claims` reviewer lens

**Files:**
- Modify: `scripts/review-gen.mjs`
- Modify: `scripts/cli.mjs`
- Modify: `teammates.gate.json`
- Modify: `skills/phase-gate/SKILL.md`
- Test: `tests/review-gen.test.mjs`
- Test: `tests/cli.test.mjs`
- Test: `tests/skill-contracts.test.mjs`

- [ ] **Step 1:** In `scripts/review-gen.mjs`, add the per-lens method map above
  `generateReviewDispatch`:

```js
// A lens name alone tells a reviewer what to look for, not how to find it. For most lenses that
// is enough — reading a diff for correctness is a thing a reviewer already knows how to do.
//
// `claims` is not one of those. Seven of the twelve findings in run `followups` were a comment,
// skill sentence or spec line asserting a guarantee the adjacent code did not deliver, and none
// of them surfaced from reading the diff: they looked correct, which is why they survived review
// in the first place. What found them was mutating what the claim protected and checking whether
// anything noticed. A lens named `claims` with the generic prompt would be a fourth reader.
//
// A lens absent from this map produces the generic prompt byte for byte.
const LENS_METHODS = {
  claims: ({ testCommand, mutationCap, linkPaths, scratchWorktree }) => [
    '',
    'This lens has a method, and it is not the generic one. A claim is any sentence in the diff asserting a guarantee: a code comment, a skill sentence, a spec line. Reading a claim cannot tell you whether the code delivers it. Mutating what it protects can.',
    '',
    `1. Establish a green baseline BEFORE mutating anything. Create your scratch worktree at ${scratchWorktree}${linkPaths.length > 0 ? `, link these paths in from the repository root so the suite can run: ${linkPaths.join(', ')}` : ''}, then run \`${testCommand}\` unmodified. If it is not green, STOP: return zero findings and an "unableToVerify" key naming the failure. Every mutation below reads as "nothing pins this claim" when the suite cannot run, so findings from a red baseline would be fabrications.`,
    '2. Enumerate every claim in the diff, citing each as file:line.',
    '3. Rank them by assertion strength. A claim that a window is closed, that a list is exhaustive, or that every case is covered outranks a descriptive comment.',
    `4. Take the top ${mutationCap}. For each, break what the claim protects in your scratch worktree — delete the filter, widen the guard, remove the branch — and run \`${testCommand}\`.`,
    '5. A claim whose mutation leaves the suite green is a finding. Quote the claim, name the mutation that survived, and cite file:line.',
    `6. List every claim you enumerated but did NOT probe, by file:line, under an "unprobed" key in your findings JSON. You probed at most ${mutationCap} of what you found, and a bounded review that reports as though it were exhaustive is the exact defect this lens exists to catch.`,
    '',
    'Severity: an unpinned claim about an enforcement or security guarantee is high. A descriptive comment that has merely drifted from the code is low.',
  ].join('\n'),
}
```

- [ ] **Step 2:** Add the three parameters to `generateReviewDispatch`'s destructured argument —
  `testCommand = ''`, `mutationCap = 8`, `linkPaths = []` — and the refusal, next to the existing
  empty-lenses and empty-branches guards:

```js
  // Thrown at generation time, not degraded into a weaker prompt. Without a command to run, the
  // method above collapses into "read the claims and reason about them" — which is the static
  // review the mutation step exists to replace, delivered under a name that says otherwise.
  if (lenses.includes('claims') && !testCommand) {
    throw new Error('the claims lens mutates code and runs the suite, so it needs a test command; this phase declares no command check to take one from')
  }
```

- [ ] **Step 3:** Append the method inside the `lenses.map` callback, after the existing `prompt`
  is built, so a lens with no method keeps today's prompt unchanged:

```js
    const method = LENS_METHODS[lens]?.({ testCommand, mutationCap, linkPaths, scratchWorktree }) ?? ''
    const prompt = method ? `${basePrompt}\n${method}` : basePrompt
```

Rename the existing `const prompt = [...].join('\n')` to `basePrompt`.

- [ ] **Step 4:** In `scripts/cli.mjs`, in the `review-dispatch` block, resolve the test command
  and the link paths from the manifest already loaded there, and pass them through:

```js
    // The phase's own command check is where the suite lives. Taken from the TRACKED manifest for
    // the same reason the reviewer tier is: the party being judged must not pick the command its
    // judge runs.
    const commandCheck = checksForPhase(config, phaseName).find((c) => c.kind === 'command')
    const testCommand = commandCheck?.run ?? ''
    const linkPaths = config.preview?.link ?? []
```

Add `testCommand` and `linkPaths` to the `generateReviewDispatch({ ... })` call. The existing
`catch` around that call already turns the new throw into `io.out(err.message); return 4`.

- [ ] **Step 5:** Add `"claims"` to the `lens` array in `teammates.gate.json`, so it reads
  `"lens": ["correctness", "security", "tests", "claims"]`.

- [ ] **Step 6:** Add to `skills/phase-gate/SKILL.md`, in the section describing reviewer findings,
  what a `claims` result means at the gate:

```markdown
A `claims` finding is a claim whose mutation left the suite green — the code does not deliver what
the comment, skill or spec says it does. At `high` that blocks the phase, and the fix is either to
make the code deliver the claim or to correct the claim. Weakening the test is not a fix.

Two `claims` results are not findings and must not be read as a clean review:

- `unableToVerify` means the reviewer could not get a green baseline in its scratch worktree, so
  it probed nothing. Treat it as the check not having run.
- `unprobed` lists claims it enumerated and did not reach. The lens is bounded; that list is the
  boundary, and it is reported rather than hidden.
```

- [ ] **Step 7:** Add to `tests/review-gen.test.mjs`: `correctness`, `security` and `tests`
  produce prompts byte-identical to the current output (snapshot the exact strings, so this is a
  real regression pin and not a substring check); a `claims` dispatch contains the test command,
  the cap, the baseline-first requirement and the `unprobed` requirement; `claims` without a
  `testCommand` throws with a message naming the lens; `mutationCap` is configurable and the value
  appears in the prompt; `linkPaths` appear when supplied and the clause is absent when not.

- [ ] **Step 8:** Add to `tests/cli.test.mjs`: `review-dispatch` for a phase whose manifest has a
  command check emits a `claims` prompt carrying that command; a phase with `claims` in its lens
  list and no command check exits 4 with the thrown message on stdout.

- [ ] **Step 9:** Add to `tests/skill-contracts.test.mjs` an assertion that
  `skills/phase-gate/SKILL.md` documents `unableToVerify` and `unprobed`, so the two non-finding
  results cannot be dropped from the skill without a test failing.
