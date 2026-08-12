# Claims review lens, liveness reporting, and distinct task refs

Status: approved, not yet planned
Date: 2026-08-10

## Problem

Three losses from runs `gaps` and `followups`, each with a known cause and no mechanism behind it.

**Claims outrun code.** Seven of the twelve findings in the final run were a comment, skill
sentence, or spec line asserting a guarantee the adjacent code did not deliver — an "exhaustive"
residual list missing a variant, a comment asserting a closed window that was open, subject locks
that could never fire. None was a logic error, and none surfaced from reading the diff. Every one
came from the same method: mutate what the claim protects, then check whether anything notices.
The reviewer lens set (`teammates.gate.json:11`) is `correctness`, `security`, `tests`; none of
them does this, and the dispatch prompt is generic per lens (`scripts/review-gen.mjs:54`), so a
lens named `claims` today would inherit the same generic instruction and behave like a fourth
reader.

**Stalls are invisible until someone looks.** Six teammates in one run parked waiting for a
notification that never arrived. `skills/fleet-supervision/SKILL.md:29-31` already prescribes a
20–30 minute heartbeat, and the failure table's last row is "silent past the heartbeat". Nothing
computes that. The operator either eyeballs the digest — which renders `status.json`, written by
the very teammate that stalled — or notices the wall clock.

**A task ref parked at a merged sibling's tip passes `fileset`.** Reproduced and recorded at
`scripts/gate-runner.mjs:191-200`: T3 commits `c.mjs` and is merged `--no-ff`; T2's ref is then
pointed at T3's tip. T2's diff against its fork point is empty, but `mergedBranchTips` contains
that sha because it genuinely is a secondary parent inside `anchor..run`, so the empty-diff test
reads the branch as landed and passes it. T2 is credited with T3's work while T2's own declared
file never reaches the run branch. The comment names the signal — in this shape two task refs
resolve to the identical sha, already reported in `branchShas` — and states that nothing checks it.

## Non-goals

**Self-integration proper**, where a teammate does real work on several refs and merges them
itself, stays out of scope for the reason `docs/specs/2026-08-05-tamper-evident-enforcement-design.md`
already gives: running a teammate's code is arbitrary execution, and at the ancestry level that
shape is identical to legitimate integration.

**Making the liveness report trustworthy against its subject.** Both of its signals are forgeable
by the teammate they describe. It is a supervision aid, not an enforcement check, and it is not
consulted by any gate.

**A CI-parity gate check.** Real (two PRs reported done on a green local suite while CI was red on
two platforms) and deliberately not in this spec — it needs a network dependency and a policy for
an unreachable CI, which is its own design.

**Turning the mutation method into an automated mutation-testing harness.** The lens instructs an
agent to apply the method to a phase diff. A general mutation-testing tool over the whole
repository is a different, much larger thing.

## Threat model

`SECURITY.md:6` states the property everything here rests on: the phase gate is tamper-evident,
not tamper-proof. This spec's three pieces sit at different points against it, and the difference
is deliberate:

- **Distinct task refs** is an enforcement check. It reads git and only git, computes from refs
  that exist at the moment it runs, and reads nothing under `.teammates/`.
- **The claims lens** is an agent check, with the same self-report weakness every agent check has
  and which `scripts/reviews.mjs:28-38` already documents for the review stamp. It raises the cost
  of a false claim surviving; it does not make one impossible.
- **Liveness** is neither. It is an operator report with no verdict, so its forgeable inputs cost
  nothing that was previously guaranteed.

## T1 — A declared-files predicate for "landed", replacing sha membership

What shipped is not a duplicate-sha discriminator layered in front of the empty-diff test — no
such mechanism exists in any form. Instead, the sha-membership test that `deriveContext` and
`runFilesetCheck` both used (whether a branch's sha was merely a member of `git.mergedBranchTips`)
was replaced outright by a single per-task predicate that both call.

### Rule

`mergedParentFiles(git, { anchorSha, runSha })` walks only the run branch's own first-parent chain,
from `runSha` back to `anchorSha` — not every commit in `anchor..run`. For each chain commit with
more than one parent, and for each secondary parent that is itself inside `anchor..run`, it records
that parent's own contribution since it diverged from the chain's prior tip — a three-dot diff,
`changedFiles({ base: firstParent, branch: parent })` — indexed by that parent's sha. A sha named
by more than one chain commit has its file sets unioned, not kept per-merge, because "does some
merge naming this sha carry a declared file" and "does the declared set intersect the union of
every merge naming this sha" are the same existence claim.

`landedForFiles(filesBySha, sha, declaredFiles)` is true when the indexed set for `sha` intersects
`declaredFiles`, both sides compared through the same path normalization `filesetViolations` uses.
A branch already on the run branch — its own diff against its fork point is empty — reads as landed
only when `landedForFiles` is true for its own declared files. Walking the chain rather than every
commit in range, and crediting a secondary parent with only its own diverged files rather than the
whole merge's first-parent diff, both matter: an earlier version of this walk double-credited a
sync merge's target, reading an idle sibling as landed with a file it never touched, purely because
some other task's own `git merge --no-ff run-branch` happened to name the idle sha as a secondary
parent.

### Where it lives

Not a step run before the empty-diff test — the predicate IS how the empty-diff branch decides
"landed" now, in both `runFilesetCheck` and `deriveContext`'s phase-integration loop, sharing one
`mergedParentFiles` index built once per invocation.

### The limit

The precondition the predicate needs: the parked task's declared set must not intersect what the
integrating merge actually carried. Within one phase that always holds, because
`scripts/phases.mjs` assigns two tasks to the same phase only when their declared files are
disjoint — but declared sets routinely overlap ACROSS phases, since a later task modifies a file an
earlier task created. When they do overlap, the predicate cannot tell a parked ref from a genuine
one; both read `landedForFiles` true from the identical, real intersection. This is sibling-tip
self-integration with an overlapping declared set, and it is NOT closed:

- T1 creates `a.mjs`, merged. T2 declares `Modify a.mjs, Create b.mjs`, writes nothing, and its ref
  is pointed at T1's own merged tip. Verdict PASS; `b.mjs` never exists. Executed and pinned as a
  LIMIT in `tests/adversarial.test.mjs`.

What the predicate does close, each confirmed by executing the shape against a real repository:

- A ref parked at a merged sibling's tip with a DISJOINT declared set — `landedForFiles` false,
  correctly failed.
- The same shape after the sibling makes a further fix-round commit moving its own ref off the
  shared sha — the predicate depends only on what the merge already carried, not on where any ref
  currently sits, so it still fails.
- Two idle refs sharing an old run tip that an unrelated merge turned into a secondary parent (a
  plan-amendment merge, or a third task's own sync merge) where neither idle task's declared file
  intersects what that merge carried — both fail on the ordinary "contributes no file changes"
  message, neither is accused of parking.
- A near-sibling — an empty commit built one commit above a merged sibling's tip, merged under its
  own name — whose own merge diff against its own first parent is empty, so it can never intersect
  a non-empty declared set. Closed as a side effect of the predicate, not by design intent.
- Fast-forward integration is unaffected and out of scope: a fast-forward leaves no merge commit to
  name the branch at all, so it is not a key in `mergedParentFiles` and reads as not-landed even
  though the work is genuinely on the run branch — `tm-integrator`'s contract is `--no-ff` for
  exactly this reason, and the out-of-contract state fails closed by design.
- **A teammate that does the integrator's own job** — creating task branches that each carry real
  work and merging them itself — is indistinguishable here from legitimate integration, because at
  this level it IS the same shape. Unchanged from every earlier design, and out of scope for the
  same reason self-integration proper is a non-goal of this spec.

### Cost

One `commitsBetween`/first-parent walk per gate or `complete` invocation, shared by every task and
phase it checks, rather than a separate `resolveRef` per task ref.

### Tests

- `tests/gate-runner.test.mjs`: `mergedParentFiles unions file sets across two merges naming the
  same sha, rather than keeping only the first`; `runFilesetCheck does not read a ref parked at the
  anchor as landed even when a coincidental filename matches`.
- `tests/adversarial.test.mjs`: `gate fails when a task ref is parked at a merged SIBLING's tip`;
  `gate still fails a parked ref after the sibling it parked on makes a further fix-round commit`;
  `gate does not treat two idle siblings as parked when an unrelated commit moves the run tip past
  them`; `gate does not credit an idle ref parked on a run tip that only a sibling's own sync merge
  later named`; `gate fails a ref built one empty commit above a merged sibling's tip, even merged
  under its own name`; `a compliant two-phase run passes phase 1 ... then derives and passes phase
  2`; and the LIMIT test for the overlapping-declared-set shape above, pinning it as open rather
  than asserting it closed.

## T2 — `liveness`

### Split

`scripts/liveness.mjs` is pure: it takes `{tasks, staleMinutes, now, tips, touches}` and returns
rows and a verdict. No git, no filesystem, no config — the same shape as `scripts/review-gen.mjs`,
and testable without a repository. `scripts/cli.mjs` gathers the two evidence streams and feeds it.

### Evidence

**Tip age** needs a new `git.commitTime(ref)` in `scripts/git.mjs` — `log -1 --format=%ct`, with
`--end-of-options` like every other invocation this wrapper makes. Returns epoch seconds.

**Worktree location** comes from `git.worktrees()`, matched on branch name. Not from
`.teammates/`: a teammate that picked its own directory could otherwise point the report at
whatever looks busiest.

**Worktree freshness** is the newest mtime under that directory, pruning what `git.ignoredPaths`
reports the project ignores (plus a hardcoded `.git`, which git never reports as ignored because it
is not part of the working tree), visiting at most 5000 entries. A fixed `.git`/`node_modules` skip
list was tried and rejected during review: it missed every other generated directory (`dist`,
`.next`, `target`, `.venv`), so a repository with any of those floored every walk, and the floored
row was read as `working` — the command's only failure signal was inert on exactly the repositories
it exists to supervise. If the cap trips, the row says the number is a floor rather than a
measurement: the newest file may be one the walk never reached, so the task can only be more
recently touched than reported, never less.

### States

Subject is the current phase's tasks. Four states, not three, because a floored or unmeasured
freshness signal is a distinct case from either `working` or `stalled`:

| State | Condition |
|---|---|
| `working` | tip or worktree freshness measured and within the threshold |
| `stalled` | tip and worktree both measured and older than the threshold (or no branch at all, which is itself a measured negative, with a worktree older than the threshold) |
| `unknown` | freshness was not measured — the walk was capped (`unknownReason: 'walk-capped'`), or no worktree is registered for the branch and there is a branch (`unknownReason: 'no-worktree-measurement'`) |
| `not started` | no task branch and no worktree |

A queued task has no branch and no worktree, and must never read as a stall. A floored row was
originally specified to read `working` — "a floored row is never reported as stalled" — but that
rule was replaced during review: reporting `working` on a measurement that never happened is an
all-clear about a teammate nothing looked at. A floored row reads `unknown` instead. The same is
true of a task with a branch but no registered worktree at all: absence of evidence, not evidence
of absence, so it is `unknown` rather than a measured stall. A missing TIP is different — git is
authoritative that nothing has been committed on that ref — so a stale worktree with no branch is a
genuine, measured `stalled`.

### Interface

    liveness --run <id> --plan <path> [--stale <minutes>] [--root <path>]

Default threshold 20 minutes, matching the heartbeat `fleet-supervision` already prescribes. Three
exit codes, not two. Exit 1 when any row is `stalled` — this wins outright even alongside an
unmeasured row, because the stall is the one thing a supervisor must act on and every row is still
printed either way. Exit 2 when nothing is stalled but some row is `unknown`, or when the report
itself could not be produced: an unreadable plan; a `--stale` that is not a positive number; a run
id whose `.teammates/<runId>` directory does not exist (checked by existence only, never contents —
the one exception to "no check may read anything under `.teammates/`", because this report enforces
nothing and the state it reads is a directory name the orchestrator created, not a teammate's
claim); a failed phase derivation; a `phaseError`; or the derived phase selecting no task from the
plan as currently checked out (the plan has drifted since the anchor). Exit 0 otherwise, including
when every phase of the run is already integrated — a finished run reports "no teammate of this run
is expected to be working" rather than a stall board covering nobody. It decides nothing and
records nothing — the same contract `doctor` has, which is why this is a separate command rather
than a widening of `doctor`: `doctor`'s exit 1 means a structural fault, and a slow-but-healthy
teammate is not one.

`skills/fleet-supervision/SKILL.md` gains a heartbeat section that calls it. The orchestrator does
the nudging, through the harness's `SendMessage`; the CLI has no handle on a subagent and must not
pretend to.

### Limit, stated in the module

Both signals are forgeable by the teammate they describe — `GIT_COMMITTER_DATE` backdates or
postdates a commit, and any background process touching a file refreshes an mtime. This report
catches the failure that actually happens (an agent parked on a notification that never arrives).
It is not evidence for any gate, and nothing reads it.

### Tests

`tests/liveness.test.mjs` covers the pure module: each of the four states, the `unknownReason` for
both `unknown` causes, the threshold boundary in both directions, a task with a branch but no
worktree, a task with a worktree but no commits, a stale branch with no commits at all reading
`stalled` rather than `unknown`, and the capped-walk row rendering. CLI-level tests cover all three
exit codes — including the stall/unknown precedence and every input-validation and derivation
failure path — and the `--stale` flag.

## T3 — The `claims` lens

### Per-lens method blocks

`generateReviewDispatch` gains a lens-to-method map. A lens absent from the map produces today's
prompt byte for byte — pinned by a test, so `correctness`, `security` and `tests` are provably
unchanged by this task.

### The method, as instructed in the prompt

1. Enumerate every claim in the phase diff: code comments, skill prose, spec sentences that assert
   a guarantee ("this cannot happen", "exhaustive", "every X is checked").
2. Rank by assertion strength — a comment claiming a closed window outranks a descriptive one.
3. For the top N (default 8), break what the claim protects in the scratch worktree and run the
   suite.
4. A claim whose mutation leaves the suite green is a finding, cited `file:line`, quoting the claim
   and naming the mutation that survived.
5. List every enumerated-but-unprobed claim by `file:line` in the output.

Step 5 is not optional. A bounded check that reports as though it were exhaustive is the exact
defect class this lens exists to find.

### Severity, so it maps onto `blockOn`

An unpinned claim about an enforcement or security guarantee is `high`. A descriptive comment that
merely drifted from the code is `low`. Stated in the prompt, because `blockOn: ["high"]` is what
decides whether the phase moves.

### Two failure modes designed against

**A suite that cannot run in the scratch worktree makes every claim read as unpinned.** The lens
must establish a green baseline in its scratch worktree before mutating anything, and abort with
"unable to verify" — not findings — if it cannot. This repository has zero dependencies, but the
lens ships for repositories that do, so the dispatch carries the same link paths
`withMergePreview` uses to provision a preview (`scripts/merge-preview.mjs:42`,
`scripts/preview-links.mjs:50`) and the prompt instructs the reviewer to link them in.

**A dispatch with no test command silently degrades to a static reader.** `generateReviewDispatch`
throws at generation time when `claims` is among the lenses and no test command was supplied,
rather than emitting a weaker prompt. `review-dispatch` in `scripts/cli.mjs` resolves the phase's
checks already, so it passes the `command`-kind check's `run` string and the configured link paths
through.

### Output shape

Unchanged. `collectReviewResults` (`scripts/reviews.mjs:61-107`) reads `lens`, `stamp` and
`findings` and ignores every other top-level key, so the unprobed list travels as an extra key and
`reviews.mjs` is not touched by this task.

### Rollout

`claims` is added to this repository's own `teammates.gate.json`, so the next run reviews itself
through it.

### Tests

`tests/review-gen.test.mjs`: the three existing lenses produce byte-identical prompts to today;
`claims` produces a prompt containing the test command, the cap, the baseline requirement and the
unprobed-list requirement; `claims` without a test command throws; the cap is configurable and
appears in the prompt. `tests/skill-contracts.test.mjs` covers the `phase-gate` skill text
describing what a `claims` finding means at the gate.

## What this cost

Run `claims`, which implemented this spec, measured: 45 findings across ten review rounds. T1 took
five fix rounds, T2 three, T3 five. Two fix-round budget overrides were needed, both recorded. The
single largest defect class was a claim stronger than the code — a comment, skill sentence, or spec
line asserting a guarantee the adjacent code did not deliver — with eight instances in T3 alone,
four of them in tests rather than comments. Every one of those eight was found by executing or
mutating something, never by rereading the claim. Three teammates separately stalled on
backgrounded commands during the run and were recovered by messaging them directly, not by any
mechanism in this spec. Whoever plans the next fleet run should see this number before estimating
one: a spec of this size, on this codebase, cost ten review rounds and thirteen fix rounds to land.

## Delivery

Three tasks, two phases. The phasing is forced by `scripts/cli.mjs`: both T2 and T3 register
changes there, and two tasks in one phase cannot declare the same file.

| Phase | Task | Files |
|---|---|---|
| 1 | T1 — distinct task refs | `scripts/gate-runner.mjs`, `tests/gate-runner.test.mjs`, `tests/adversarial.test.mjs` |
| 1 | T2 — liveness | `scripts/liveness.mjs`, `scripts/git.mjs`, `scripts/cli.mjs`, `tests/liveness.test.mjs`, `tests/git.test.mjs`, `tests/cli.test.mjs`, `skills/fleet-supervision/SKILL.md`, `README.md` |
| 2 | T3 — claims lens | `scripts/review-gen.mjs`, `scripts/cli.mjs`, `teammates.gate.json`, `tests/review-gen.test.mjs`, `tests/cli.test.mjs`, `skills/phase-gate/SKILL.md`, `tests/skill-contracts.test.mjs` |

No task depends on another. The split into two phases is forced entirely by `scripts/cli.mjs` and
`tests/cli.test.mjs`, which T2 and T3 both write; `scripts/phases.mjs` separates them on that
overlap alone, and either ordering is correct. The table records the assignment `init-run`
actually produces, verified by running it, rather than the one this spec first guessed.

Both shared files appear in two tasks by design. Being in different phases they are never written
concurrently, and each task declares them so the `fileset` check enforces what it can see.

`README.md` gains the `liveness` command in its command list and a line on the `claims` lens. It is
declared by T2 alone, so exactly one task owns it.
