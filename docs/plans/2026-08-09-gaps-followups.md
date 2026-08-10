# Follow-ups from run `gaps`

Run `gaps` closed thirteen tasks and landed at 1221 passing tests. Its reviews surfaced seven
things it did not close: two real defects, one documentation gap, one portability floor, two
test-quality defects, and one false claim in the plan it was executing. Each is recorded here
with the reproduction that found it, because a step that only says "fix X" invites a fix that
satisfies the sentence rather than the failure.

Nothing in this plan is speculative. Every item was reproduced by a reviewer or by the
orchestrator during run `gaps`, and the reproduction is quoted in the step that owns it.

## Global Constraints

- Node >= 24.2.0
- Zero new runtime dependencies
- Commit messages: single-line, commitlint style, English
- Pure modules (`scripts/finish.mjs`, `scripts/prune.mjs`, `scripts/reviews.mjs`, `scripts/mapnotes.mjs`, `scripts/doctor.mjs`) take data and return data: no filesystem access, no git access, no imports beyond other pure modules and `scripts/git.mjs`'s `GitError`
- Every new behaviour is pinned by a test in `tests/`, run with `node --test tests/*.test.mjs`
- A skipped check is reported as skipped, every time — never silently omitted
- No enforcement check may read map data, and nothing enforced reads `.teammates/<runId>/map.md`
- Run `npm test` in the FOREGROUND; a backgrounded suite never notifies a subagent
- Prose must not claim more than the adjacent code delivers — the most common defect found in every phase of run `gaps`

### Task 1: make a live merge preview un-reapable by construction

**Files:**
- Modify: `scripts/merge-preview.mjs`
- Modify: `scripts/prune.mjs`
- Modify: `scripts/cli.mjs`
- Test: `tests/merge-preview.test.mjs`
- Test: `tests/prune.test.mjs`
- Test: `tests/cli.test.mjs`

**Model:** capable

The leaked-preview reaper can destroy operator data. `git worktree remove --force` follows a
Windows junction and deletes the CONTENTS of the link target — reproduced three separate times
during run `gaps` against throwaway fixtures, most recently by observing a canary file inside the
link target disappear. `preview.link` provisions exactly such junctions into the repository's real
`node_modules`.

`scripts/cli.mjs` sweeps the junctions before removing, which closes the hazard for a preview
whose owner is DEAD. It does not close it for a LIVE one: `isLeakedPreview` classifies by name and
location alone, so a preview belonging to a gate running right now is indistinguishable from a
leaked one. If that gate's `linkInto` creates a junction between the sweep and the removal, the
removal follows it.

Run `gaps` task T13 reported this `blocked` rather than paper over it, and was right to: the
mtime/registration-age heuristic the previous plan floated narrows the window instead of closing
the race. `scripts/prune.mjs` already says so — "a mtime or a lock file would be a guess dressed
as a fact". Any check the reaper performs and then acts on is check-then-act, which is what TOCTOU
means.

The fix is to stop sampling and start observing something the owner HOLDS.

- [ ] **Step 1:** In `scripts/merge-preview.mjs`, write a liveness marker into the preview root
      as soon as the worktree exists and before any link is provisioned. Put the owning pid in it
      so a reader can tell a stale marker from a live one:

```js
  const marker = path.join(dir, '.tm-preview-owner')
  await writeFile(marker, `${process.pid}\n`, 'utf8')
```

      Remove it in the existing `finally`, before `teardownLinks()`, so the ordering is
      marker-gone, then links-gone, then worktree-gone. A killed gate skips the whole `finally`,
      which is exactly the case that must leave the marker behind.

- [ ] **Step 2:** Make the marker's presence a caller-supplied input rather than something
      `scripts/prune.mjs` samples. `prune.mjs` is a pure module and must not gain filesystem
      access. Extend `leakedPreviews` (and `selectPrunableWorktrees` above it) to take a
      `livePreviews` set of paths the caller has determined are live, and exclude those from the
      returned `previews` list, reporting them in `skipped` with the reason
      `a gate owns this preview right now`.

- [ ] **Step 3:** In `scripts/cli.mjs`, read the markers and pass the set in. A marker whose pid
      is no longer running is stale and does NOT make the preview live — check with
      `process.kill(pid, 0)`, which signals nothing and throws `ESRCH` when the pid is gone:

```js
async function livePreviewPaths(previewPaths) {
  const live = new Set()
  for (const dir of previewPaths) {
    let raw
    try {
      raw = await readFile(path.join(dir, '.tm-preview-owner'), 'utf8')
    } catch {
      continue
    }
    const pid = Number.parseInt(raw.trim(), 10)
    if (!Number.isInteger(pid) || pid <= 0) { live.add(dir); continue }
    try {
      process.kill(pid, 0)
      live.add(dir)
    } catch (err) {
      if (err.code !== 'ESRCH') live.add(dir)
    }
  }
  return live
}
```

      Note the two fail-safe branches: an unparseable marker and a `process.kill` failure that is
      not `ESRCH` (`EPERM` — the pid exists but belongs to another user) both count as LIVE. When
      the answer is unknown, the preview is not reaped.

- [ ] **Step 4:** State the residual honestly in the comment above the reaper, replacing the
      current "closes the hazard only for a preview whose owner is dead" wording. What remains
      after this change: a pid can be recycled by an unrelated process, which makes a dead
      preview look live — that direction only leaves disk behind and never destroys data. The
      race the marker closes is the destructive one, because the marker is HELD by the owner
      across the whole window rather than sampled by the reaper at one instant.

- [ ] **Step 5:** Pin all three directions in `tests/prune.test.mjs` and `tests/cli.test.mjs`: a
      preview with a marker naming the current pid is reported as live and NOT removed; a preview
      with a marker naming a pid that does not exist is reaped; a preview with no marker at all is
      reaped, which is the pre-existing leaked case. Add a `tests/merge-preview.test.mjs` case
      asserting the marker exists during the callback and is gone after a clean run.

- [ ] **Step 6:** Two prose corrections in `scripts/cli.mjs`, both flagged in run `gaps` and both
      in this task's file set:
      - The comment at the `doctor` call site (around `scripts/cli.mjs:1351`) still names the
        removed three-clause ancestry algorithm — "only `past the anchor, on the run branch, and
        not the run tip itself` separates them". Those clauses no longer exist in
        `scripts/doctor.mjs`; the separator is now membership in `mergedBranchTips`. Rewrite it.
      - The test named `the preview link sweep refuses a tree it cannot account for rather than
        sweeping part of it` (around `tests/cli.test.mjs:5682`) promises atomicity the sweep does
        not have. Reproduced: with a junction `aaa-link` sorted before a too-deep sibling
        `zzz/d0../d14`, `readdir` returns `aaa-link` first, it is unlinked, and only then does the
        depth guard throw — so the sweep IS partial. The protection the code actually gives is
        that the WORKTREE is not removed, which the sibling test asserts. Rename it to
        `...refuses to remove a tree it cannot account for` so the name matches both the body and
        the code.

- [ ] **Step 7:** Run the full suite in the FOREGROUND and report the counts.

### Task 2: diff each task branch from its own fork point, not from the run anchor

**Files:**
- Modify: `scripts/gate-runner.mjs`
- Modify: `docs/specs/2026-08-05-tamper-evident-enforcement-design.md`
- Test: `tests/gate-runner.test.mjs`
- Test: `tests/adversarial.test.mjs`

**Model:** capable

`deriveContext` decides whether a phase is integrated by asking whether each of its task branches
changed any file — but it asks that against the run ANCHOR:

```js
      const ownChanges = await git.changedFiles({ base: anchorSha, branch: sha })
      states.push(ownChanges.length > 0 && await git.isAncestor(sha, runSha))
```

From phase 2 onward the run tip is past the anchor, so a branch parked downstream of a sibling's
merge shows THAT SIBLING'S files as its own work. The phase reads integrated, `derivePhase`
advances `currentPhase` past it, and `runFilesetCheck` takes its "every phase in the plan is
integrated" fast path — so the merge-based landed test that run `gaps` spent two fix rounds
hardening is never reached for that task at all.

Reproduction, from the phase-5 correctness review: phase 2 of a run; T5 runs
`git checkout -B teammates/r/T5 run/r` and commits nothing on that ref; the integrator merges
sibling T4, which changes `src/a.mjs`, so the run tip moves past T5's parked commit.
`changedFiles({base: anchorSha, branch: T5sha})` is non-empty because T5's parked commit is
downstream of T4's merge and carries T4's `src/a.mjs`; `isAncestor(T5sha, runSha)` is true; phase 2
joins `integratedPhases`; the empty ref merges as a no-op behind a PASS.

- [ ] **Step 1:** Change the base to each branch's own fork point, which is what "its own work"
      means:

```js
      const forkPoint = await git.mergeBase(runSha, sha)
      const ownChanges = await git.changedFiles({ base: forkPoint, branch: sha })
      states.push(ownChanges.length > 0 && await git.isAncestor(sha, runSha))
```

      This is the same base `runFilesetCheck` already diffs from, so the two stop disagreeing
      about what a branch contributed.

- [ ] **Step 2:** Read what depends on `integratedPhases` before assuming Step 1 is the whole
      change. `derivePhase` consumes it, `finish` reports on it, and `runFilesetCheck` has a
      `currentPhase === null` fast path that passes vacuously. Changing what "integrated" means
      moves all three. Work through each, and if any needs a corresponding change, make it in
      this task — it is the same file. If one needs a file outside this set, report `blocked`
      naming it rather than reaching for it.

- [ ] **Step 3:** Preserve what the existing comment block above this code is defending. It
      documents two earlier attacks that shaped the current shape: a teammate creating every task
      branch at the run tip and committing nothing (which is why "is an ancestor" alone is not
      enough), and `git commit --allow-empty` satisfying "has a commit" while changing no file
      (which is why it counts changed FILES, not commits). Your change must still defeat both.
      Say so in the comment, and say plainly that the fork-point base is what makes "did work"
      mean the branch's own work rather than anything already on the run branch.

- [ ] **Step 4:** Add a real-repository test to `tests/gate-runner.test.mjs` — not a fake git,
      because the defect lives in what real `merge-base` and `changedFiles` return. Build: a base
      branch, a run branch, two task branches, one carrying real work and merged `--no-ff` so the
      run tip moves, and a second parked at the run tip as it stood before that merge with no
      commits of its own. Assert the phase does NOT read as integrated, and that
      `runFilesetCheck` reports the parked branch as contributing nothing. Confirm it fails
      against the current `base: anchorSha` code before your change.

- [ ] **Step 5:** Confirm the existing tests that pin the two documented attacks still pass, and
      that a genuinely integrated phase still reads as integrated. Report the full-suite counts
      before and after.

- [ ] **Step 6:** AMENDMENT, added after the first attempt. This change CLOSES a limitation the
      project documents as accepted, so `tests/adversarial.test.mjs` now fails — it pins the old
      behaviour deliberately. The failing test is `LIMIT (self-integration): fast-forwarding to your
      own tip and pointing another task branch at it reads as integrated`, around
      `tests/adversarial.test.mjs:318`, which asserts `code === 0` and a `PASS` for a fixture where
      T2's ref sits at a run tip already carrying T1's real work. Confirmed failing: the adversarial
      suite runs 43 tests, 42 pass, 1 fail.

      Do NOT revert your fix or loosen your new test to make it green. The section comment above
      that test says why those tests exist — "an untested limitation drifts into an implied
      guarantee, which is the exact defect that started this work" — and the same reasoning runs in
      reverse: a closed limitation still recorded as open understates the guarantee, and the next
      reader will not know the gate now catches this.

      Separate the two shapes the old test conflated:
      - **Parked branch** — a teammate points a task ref at a run tip already carrying someone
        else's real work and commits nothing itself. NOW DEFENDED by your change: it shows no own
        work against its fork point, so the phase does not read as integrated and the check runs.
      - **Self-integration proper** — a teammate creates its own branches, does real work on each,
        and merges them itself, bypassing `tm-integrator`. STILL NOT DEFENDED, out of scope by
        design: running a teammate's code is arbitrary execution.

      Rewrite the failing test to pin the new behaviour for the parked-branch shape — same fixture,
      now asserting the gate FAILs and that the output names the parked task as contributing no file
      changes — and move it out of the "limits that are NOT defended" section, since it is no longer
      one. Then add a test in that section for the variant that genuinely remains open, asserting
      whatever the current behaviour actually is (run it; do not assume), with a comment naming the
      limitation and pointing at the spec, matching the shape of its neighbours.

- [ ] **Step 7:** Update the "Not defended against — the honest list" section of
      `docs/specs/2026-08-05-tamper-evident-enforcement-design.md`. Its self-integration entry
      covers both shapes in one bullet. Split it: say the parked-branch variant is now caught, name
      the mechanism — `deriveContext` measures each branch against its own fork point, so a branch
      that contributed nothing does not make its phase read as integrated — and keep the remaining
      variant on the list with its reasoning intact.

- [ ] **Step 8:** Search the rest of the repository for other prose describing the closed variant as
      undefended: `docs/specs/`, `skills/`, and comments in `scripts/` are the likely places. Report
      what you find. Anything outside your declared files is NOT yours to edit — list it so it can be
      tasked separately.

- [ ] **Step 9:** Run the full suite in the FOREGROUND and report the counts. The adversarial suite
      must be fully green and no other suite may have regressed.

### Task 3: document the commands the skills do not mention

**Files:**
- Modify: `skills/parallel-execution/SKILL.md`
- Test: `tests/skill-contracts.test.mjs`

**Model:** mid

Run `gaps` added two commands that no skill documents, so an orchestrator following the skills
will never know they exist:

- `finish --enforcement-only` and `prune-run --enforcement-only`, which skip the `command` checks
  and report the always-enforced kinds alone. On run `codemap` a `prune-run` exceeded a
  120-second timeout deciding whether a directory could be deleted; this is the flag that fixes
  that, and it was used to reap a leaked preview at the end of run `gaps`.
- `map-notes --write <path>`, which validates an agent's returned map with `mapNotesWritable`
  before writing `.teammates/<runId>/map.md`. Without it the orchestrator writes that file by
  hand and the validation never runs.

`skills/fleet-lifecycle/SKILL.md` already documents `map-notes --write`. This task covers
`parallel-execution`, which is the skill an orchestrator reads while running a fleet.

- [ ] **Step 1:** Read the real behaviour before writing a word about it: the `finish` and
      `prune-run` handlers in `scripts/cli.mjs`, `enforcementOnlyRefusal`, and the
      `ENFORCEMENT_ONLY_SKIPPED` tagging in `runPhaseChecks`. Do not describe behaviour you have
      not read — prose overstating adjacent code is the defect class this plan's own constraints
      name.

- [ ] **Step 2:** Document `--enforcement-only` in `skills/parallel-execution/SKILL.md`, next to
      the existing prune guidance. State all four of these, because each was a real defect fixed
      during run `gaps` and a description missing any of them is misleading:
      - it drops only `command` checks; `fileset`, `ownership` and `merge` always run
      - every dropped check is reported as `skip`, never silently omitted
      - it REFUSES with exit 2 when a phase's manifest declares no `fileset` and no `ownership`
        check, because with nothing to report the verdict would be meaningless
      - `prune-run` will not remove a worktree for a phase whose PASS carries checks the flag
        skipped — a cheap verdict is enough to report, not enough to delete

- [ ] **Step 3:** Add a sentence naming what the flag is FOR: `finish` and `prune-run` otherwise
      run every `command` check of every phase, which for a five-phase run is five full test
      suites, to answer a question that usually does not need them.

- [ ] **Step 4:** Pin both in `tests/skill-contracts.test.mjs` using the existing `assertClaim` /
      `assertStatement` helpers from `tests/md-contract.mjs`. Anchor every `claim:`, `then:` and
      `allow:` pattern end-to-end with `^...$`. Run `gaps` spent three fix rounds on exactly this:
      an unanchored pattern is a substring match, so a clause appended to the pinned sentence
      escapes the lock — including, in one reproduced case, a clause that inverted the claim
      outright while the suite stayed green.

- [ ] **Step 5:** Run the full suite in the FOREGROUND and report the counts.

### Task 4: stop a doctor test from passing when the walk fails

**Files:**
- Test: `tests/doctor.test.mjs`

**Model:** cheap

The real-repository test `a branch parked at the anchor is reported as a problem after a plan
amendment` passes for the wrong reason. `collectDoctorReport`'s catch pushes an extra problem,
leaves `mergedTips` undefined, and every task then reads `landed === false` — which is exactly
what the test's two assertions demand. So if `mergedBranchTips` throws for ANY reason, the test
still passes.

Reproduced in the phase-5 tests review: making `mergedBranchTips` throw a `GitError`
unconditionally fails eight tests across `git`/`doctor`/`gate-runner`, including both
`gate-runner` real-repo counterparts — but not this one.

Why it matters beyond tidiness: on git older than 2.24, `rev-list --end-of-options` is rejected
for every user, `doctor` degrades to reporting every integrated task as contributing nothing, and
this test — whose own comment claims it is kept in step with its `gate-runner` counterpart —
reports nothing.

- [ ] **Step 1:** Tighten the assertions so a failed walk is distinguishable from the expected
      problem. Assert that `report.problems` contains exactly the one expected entry, and add a
      negative assertion that it does not match the walk-failure message:

```js
  assert.equal(report.problems.length, 1)
  assert.doesNotMatch(report.problems[0], /could not determine which branches/i)
```

      Read `scripts/doctor.mjs`'s catch branch first and match the real message text rather than
      trusting the pattern above.

- [ ] **Step 2:** Verify by mutation: make `mergedBranchTips` throw unconditionally in a scratch
      copy, confirm this test now FAILS, revert, and confirm it passes. Report both counts. This
      test already kills the mutations it was written for — dropping the range filter, unbounding
      the range — so confirm those still fail too and you have narrowed rather than replaced it.

- [ ] **Step 3:** Run the full suite in the FOREGROUND and report the counts.

### Task 5: declare and check the git version this plugin requires

**Files:**
- Modify: `scripts/git.mjs`
- Modify: `README.md`
- Test: `tests/git.test.mjs`

**Model:** mid

`scripts/git.mjs` uses `--end-of-options` in eight places. It was added in git 2.24 (November
2019), and on anything older every one of those commands fails. The failure is not loud: `doctor`
degrades to reporting every integrated task as contributing nothing, and at least one test passes
anyway (Task 4 fixes that test).

Do NOT remove `--end-of-options` to widen compatibility. It is what stops a branch or base name
beginning with `-` from being read as an option, and the comments at `scripts/git.mjs:47` and
`:88` explain what it defends. Declare the floor instead.

- [ ] **Step 1:** Add the requirement to `README.md` beside the Node version requirement, naming
      the version and one sentence of why: `git >= 2.24`, because every git invocation passes
      `--end-of-options` to stop a ref name beginning with `-` from being parsed as a flag.

- [ ] **Step 2:** Give `GitError` a clearer failure for this case. When a git invocation fails
      and the stderr names `--end-of-options` as unknown, wrap it with a message that says the
      installed git is too old and names 2.24, rather than surfacing git's raw complaint. Read how
      `runRaw` builds its `GitError` message and extend that path; do not add a version probe on
      every call.

- [ ] **Step 3:** Pin it in `tests/git.test.mjs` with a fake exec that returns the stderr an old
      git produces for an unknown option, asserting the raised `GitError` names 2.24. Do not
      attempt to install or simulate an old git binary.

- [ ] **Step 4:** Run the full suite in the FOREGROUND and report the counts.

### Task 6: correct the false claim in the run `gaps` plan

**Files:**
- Modify: `docs/plans/2026-08-08-tooling-gaps.md`

**Model:** cheap

Task 11 Step 3 of that plan instructs the implementer to write two claims, both false. The
implementer declined to write them, verified the real behaviour, and pinned the truth with a
real-repository test — but the plan still carries the false text, and a later reader takes the
plan as the spec.

The bullet claims a fast-forwarded branch "has a non-empty diff and never reaches the landed test
at all", and that `scripts/enforce.mjs` "already reports fast-forward integration of a task branch
as a violation in its own right". Both are wrong:

- A fast-forward makes `merge-base(run, branch)` the branch's own tip, so its diff IS empty and it
  DOES reach the landed test — and now fails it with a message naming a cause that is not the one.
- `ownershipViolations` flags `unexplainedCommits`, defined as commits reachable from no task
  branch of this run. A fast-forwarded branch's commits ARE reachable from that branch, so they
  are explained and ownership stays silent. Verified by reading `scripts/enforce.mjs:94-114`.

- [ ] **Step 1:** Replace that bullet with what is true, and mark it as a correction rather than
      silently editing history — a plan is a record of what was asked for, and a reader comparing
      it against the merged code should be able to see that the code is right and the plan was
      wrong. State: a fast-forwarded branch's diff is empty, it does reach the landed test, it now
      fails as not-landed, no other check covers that shape, and the reason this is acceptable is
      that `tm-integrator`'s contract is `--no-ff`, so the state is out-of-contract rather than
      undetected.

- [ ] **Step 2:** Check the rest of Task 11 for the two other inaccuracies its implementer
      reported, and correct them the same way: the Step 1 `rev-list` snippet does not run
      (`--not` must precede non-option arguments, and options must precede `--end-of-options`),
      and the Step 5 test fixture sets `resolveRef: async () => 'runSha2'` with
      `ctx.runSha: 'runSha2'`, which parks the branch at the run tip — a case the tip exclusion
      already caught, so the test passed against unchanged code and did not test the intermediate
      case it was written for.

- [ ] **Step 3:** No test changes and no code changes. This task edits one document. Do not touch
      `scripts/` or `tests/`.
