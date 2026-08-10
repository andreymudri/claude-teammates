# Claims lens, liveness reporting, and distinct task refs

Spec: `docs/specs/2026-08-10-claims-liveness-distinct-refs-design.md`

## Global Constraints

- Node >= 24.2.0
- Zero runtime dependencies and zero dev dependencies; tests use the built-in `node:test` runner
- git >= 2.24; every git invocation passes `--end-of-options`, and a trailing `--` wherever the
  command accepts a pathspec
- Commit messages: single-line, commitlint style, English
- No check may read anything under `.teammates/`; that state is written by the agents being enforced
- Comments state what the code does, never a guarantee it does not deliver — this plan adds a
  reviewer lens whose whole job is finding the difference

### Task 1: reject duplicate task refs in the fileset check

**Files:**
- Modify: `scripts/gate-runner.mjs`
- Test: `tests/gate-runner.test.mjs`
- Test: `tests/adversarial.test.mjs`

- [ ] **Step 1:** Add a run-wide sha collector to `scripts/gate-runner.mjs`, directly above
  `runFilesetCheck`:

```js
// Run-wide, deliberately, and the asymmetry is the point: the SUBJECT of the duplicate rule is
// the phase under check, but the COMPARISON SET is every task ref in the run. A ref parked at a
// merged sibling's tip is the shape the empty-diff test below cannot see — the sibling's sha
// genuinely is a merge parent in range, so `mergedBranchTips` vouches for it — and the sibling
// is usually in an earlier phase, so a phase-wide comparison set would never meet it.
//
// Widening the SUBJECT instead, by asking this of every task in the run, would fail a phase for
// two not-yet-started refs of a LATER phase both sitting exactly where `git checkout -B <task>
// <run branch>` put them. That is not a violation of anything, which is why this does not live
// in `runOwnershipCheck` despite ownership being the run-wide check.
async function runWideTaskShas(git, tasks, runId) {
  const shas = new Map()
  for (const task of tasks ?? []) {
    const branch = resolveTaskBranch(task, runId)
    if (!branch) continue
    if (!(await git.branchExists(branch))) continue
    shas.set(branch, { sha: await git.resolveRef(`refs/heads/${branch}`), taskId: task.id })
  }
  return shas
}
```

- [ ] **Step 2:** In `runFilesetCheck`, build that map once before the `for (const task of
  phaseTasks)` loop, next to the existing `mergedTips` memo, and fail the check if the walk
  itself fails:

```js
  let allTaskShas
  try {
    allTaskShas = await runWideTaskShas(git, ctx.tasks ?? [], runId)
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return checkResult(check, 'fail', `could not resolve this run's task refs: ${err.message}`)
  }
```

- [ ] **Step 3:** Inside the loop, immediately after `branchShas[branch] = sha` and before the
  `mergeBase` call, add the duplicate test. It comes first because a ref parked at a merged
  sibling's tip reaches the empty-diff test below and PASSES it; running the cheap ref comparison
  first is what changes the verdict, and it also produces the accurate message:

```js
      // Before the diff, not after: this shape's diff is empty and `mergedBranchTips` contains
      // its sha, so the empty-diff test below passes it. Two task refs of one run resolving to
      // the same commit has no legitimate shape once the phase is being gated — one of them was
      // moved onto the other.
      const twin = [...allTaskShas].find(([name, rec]) => name !== branch && rec.sha === sha)
      if (twin) {
        problems.push(`${task.id}: branch ${branch} and ${twin[0]} (task ${twin[1].taskId}) are both at commit ${sha} — one is parked at the other's tip and would be credited with work it did not do`)
        continue
      }
```

- [ ] **Step 4:** Extend the block comment above the empty-diff test (currently
  `scripts/gate-runner.mjs:366-382`, the "What this does NOT distinguish" list). Replace its third
  bullet — `Two branches whose tips are the identical sha are indistinguishable here, because
  there is nothing to tell apart.` — with:

```js
      //   - Two branches whose tips are the identical sha are rejected before this test runs, by
      //     the duplicate-ref rule above. What that rule does NOT reject is a NEAR-sibling: an
      //     empty commit on top of the sibling's tip is a distinct sha, so the duplicate test
      //     does not fire, and whether this test fires depends on whether that commit is itself
      //     a merge parent in range. Narrow, open, and recorded here rather than rediscovered.
```

Leave the fast-forward and squash bullets exactly as they are — neither is changed by this task,
and editing them to imply otherwise is the defect class this plan's Task 3 exists to catch.

- [ ] **Step 5:** Update the recorded limitation at `scripts/gate-runner.mjs:191-200`. The bullet
  beginning `A ref parked at a merged SIBLING'S tip` currently ends `A signal exists but is not
  checked anywhere yet ... building the check is not this function's job.` Replace that closing
  sentence with:

```js
      //     `runFilesetCheck` now rejects this by the identical-sha signal named here. What
      //     remains open is the near-sibling variant: a distinct sha one empty commit above the
      //     sibling's tip. This function's own `integratedPhases` computation is unchanged and
      //     still cannot see either shape.
```

- [ ] **Step 6:** Add to `tests/gate-runner.test.mjs`:

```js
test('runFilesetCheck fails a phase branch parked at another task ref', async () => {
  // T2 (phase 2, under check) sits at T1's tip (phase 1, merged). T2's own diff is empty and
  // T1's sha IS a merged tip, so without the duplicate rule this passes.
})

test('runFilesetCheck does not fail the current phase for two refs of a later phase sharing a sha', async () => {
  // T8 and T9 (phase 3, untouched) both sit at the run tip while phase 2 is gated.
})

test('runFilesetCheck names both refs and both task ids in a duplicate failure', async () => {
})
```

Fill each body against the existing fake-git harness in that file, following the shape of
`runFilesetCheck passes on declared changes and records branchShas`.

- [ ] **Step 7:** In `tests/adversarial.test.mjs`, invert the assertion pinning the sibling-tip
  shape as a documented limit: the reproduction (T3 commits, is merged `--no-ff`, T2's ref moves
  to T3's tip) must now assert FAIL. Add a sibling test pinning the near-sibling variant — one
  empty commit above T3's tip — as the limit that remains, so the file records the boundary
  rather than implying the class is closed.

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
      return { taskId: task.id, branch: tip?.branch ?? null, tipAgeMs: null, touchAgeMs: null, floored: false, state: 'not started' }
    }
    // A floored measurement is a LOWER bound on freshness: the walk stopped early, so the newest
    // file may be one it never reached. The task can only be more recently touched than reported,
    // never less — so a floored row is never called stalled.
    const floored = touch?.floored === true
    const ages = [tipAgeMs, touchAgeMs].filter((a) => a != null)
    const fresh = ages.some((age) => age <= thresholdMs)
    const state = fresh || floored ? 'working' : 'stalled'
    return { taskId: task.id, branch: tip?.branch ?? touch?.branch ?? null, tipAgeMs, touchAgeMs, floored, state }
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
```

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
// Newest mtime under a directory, skipping `.git` and `node_modules` and visiting at most
// MAX_WALK_ENTRIES entries. `floored: true` means the cap stopped the walk, so the answer is a
// lower bound on freshness rather than a measurement — `livenessRows` refuses to call a floored
// row stalled for exactly that reason.
const MAX_WALK_ENTRIES = 5000
const WALK_SKIP = new Set(['.git', 'node_modules'])

async function newestMtime(dir) {
  let newest = null
  let visited = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      // A worktree removed mid-walk is not an error worth failing the report over; it is the
      // absence of evidence, which the caller already represents as a missing touch record.
      continue
    }
    for (const entry of entries) {
      if (visited >= MAX_WALK_ENTRIES) return { at: newest, floored: true }
      visited += 1
      if (WALK_SKIP.has(entry.name)) continue
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

Import `readdir` and `stat` from `node:fs/promises` alongside the existing `readFile` import.

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
    // Exit 1 on a stall, mirroring `doctor`, so a caller can branch on it. Still a report: it
    // records nothing and no verdict is issued or implied.
    return hasStall(rows) ? 1 : 0
  }
```

Import `livenessRows`, `renderLiveness`, `hasStall` and `DEFAULT_STALE_MINUTES` from
`./liveness.mjs`.

- [ ] **Step 6:** Create `tests/liveness.test.mjs` covering the pure module: a fresh tip with a
  stale worktree reads `working`; a stale tip with a fresh worktree reads `working`; both stale
  reads `stalled`; no branch and no worktree reads `not started`; a worktree with no commits and a
  stale mtime reads `stalled`; a floored touch never reads `stalled` however old; the threshold
  boundary is inclusive at exactly `staleMinutes` and stalls one millisecond past it; a
  non-numeric `now` throws.

- [ ] **Step 7:** Add CLI-level tests to `tests/cli.test.mjs`: exit 0 when every task is working,
  exit 1 when any is stalled, exit 2 on a `--stale` that is not a positive number, exit 2 on an
  unreadable plan, and that a bare `--stale` with no value is refused rather than read as `1`.

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
