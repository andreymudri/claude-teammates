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

## T1 — Distinct task refs, in the fileset check

### Rule

`runFilesetCheck` builds a run-wide map of task ref to sha — every task in `ctx.tasks`, not just
the current phase's. For each branch of the phase under check, if its sha equals the sha of any
other task ref in the run, that is a violation naming both refs and both task ids.

### Why the subject is the phase and the comparison set is the run

Two shapes have to be told apart:

- T4 (phase 2, under check) sits at T1's tip (phase 1, merged). A violation. Only visible if the
  comparison set includes phases other than the one being gated.
- T8 and T9 (phase 3, not yet started) both sit at the run tip because that is where
  `git checkout -B` put them. Not a violation of anything, and must not fail the phase-2 gate.

A run-wide subject — putting the rule in `runOwnershipCheck`, which is already run-wide — fails
the second. A phase-wide comparison set misses the first. Phase subject, run-wide comparison is
the only combination that gets both.

### Order

Before the empty-diff test at `scripts/gate-runner.mjs:339`. A ref parked at a merged sibling's
tip currently reaches that test and passes it, so checking duplicates first is what changes the
verdict; it also produces the accurate message ("T4 is parked at T1's tip") rather than a pass.

A ref parked at the *run tip* keeps failing the empty-diff test exactly as it does today. The new
rule does not need to cover it, and must not be written up as though it does.

### What it does not catch

Stated in the module comment as what is true, in the style `gate-runner.mjs` already uses for its
other limits:

- **A near-sibling ref that is not byte-identical.** An empty commit on top of the sibling's tip
  produces a distinct sha, so the duplicate rule does not fire. Its diff against its fork point is
  empty, so the empty-diff test does fire — but only if that commit is not itself a merge parent
  in range. The residual case is narrow and open, and recording it is the point.
- **Two refs both parked at the run tip.** Caught by the empty-diff test, not by this rule.
- **Fast-forward and squash integration.** Unchanged; the existing comment's statement of those
  limits stands and must not be edited to imply otherwise.

### Cost

One `resolveRef` per task outside the current phase, on a check that already resolves every task
of the current phase. `branchShas` continues to record only what it records today — the rule reads
the wider map, it does not widen what the verdict carries, because widening it would make a
sibling's branch movement invalidate this phase's verdict through `verdictCoversTree`.

### Tests

- `tests/gate-runner.test.mjs`: a phase branch equal to another phase's branch fails; two branches
  outside the current phase sharing a sha do not fail the current phase; the message names both
  refs and both task ids.
- `tests/adversarial.test.mjs`: the reproduction recorded at `gate-runner.mjs:191` — T3 commits,
  is merged `--no-ff`, T2's ref moves to T3's tip — asserted as FAIL. This file currently pins
  that shape as a documented limit; that assertion is inverted, not deleted, and the near-sibling
  variant above is added as the limit that remains.

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

**Worktree freshness** is the newest mtime under that directory, skipping `.git` and
`node_modules`, visiting at most 5000 entries. If the cap trips, the row says the number is a
floor rather than reporting it as a measurement — the newest file may be one the walk never
reached, so the task can only be more recently touched than reported, never less. A floored row
is therefore never reported as `stalled`.

### States

Subject is the current phase's tasks. Three states, because two would misreport:

| State | Condition |
|---|---|
| `working` | tip or worktree touched within the threshold |
| `stalled` | both older than the threshold, or no commits and worktree older than the threshold |
| `not started` | no task branch and no worktree |

A queued task has no branch and no worktree, and must never read as a stall.

### Interface

    liveness --run <id> --plan <path> [--stale <minutes>] [--root <path>]

Default threshold 20 minutes, matching the heartbeat `fleet-supervision` already prescribes. Exit
1 when any row is `stalled`, 0 otherwise. It decides nothing and records nothing — the same
contract `doctor` has, which is why this is a separate command rather than a widening of `doctor`:
`doctor`'s exit 1 means a structural fault, and a slow-but-healthy teammate is not one.

`skills/fleet-supervision/SKILL.md` gains a heartbeat section that calls it. The orchestrator does
the nudging, through the harness's `SendMessage`; the CLI has no handle on a subagent and must not
pretend to.

### Limit, stated in the module

Both signals are forgeable by the teammate they describe — `GIT_COMMITTER_DATE` backdates or
postdates a commit, and any background process touching a file refreshes an mtime. This report
catches the failure that actually happens (an agent parked on a notification that never arrives).
It is not evidence for any gate, and nothing reads it.

### Tests

`tests/liveness.test.mjs` covers the pure module: each of the three states, the threshold boundary
in both directions, a task with a branch but no worktree, a task with a worktree but no commits,
and the capped-walk row rendering. CLI-level tests cover exit codes and the `--stale` flag.

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

## Delivery

Three tasks, two phases. The phasing is forced by `scripts/cli.mjs`: both T2 and T3 register
changes there, and two tasks in one phase cannot declare the same file.

| Phase | Task | Files |
|---|---|---|
| 1 | T1 — distinct task refs | `scripts/gate-runner.mjs`, `tests/gate-runner.test.mjs`, `tests/adversarial.test.mjs` |
| 1 | T2 — liveness | `scripts/liveness.mjs`, `scripts/git.mjs`, `scripts/cli.mjs`, `tests/liveness.test.mjs`, `tests/cli.test.mjs`, `skills/fleet-supervision/SKILL.md`, `README.md` |
| 2 | T3 — claims lens | `scripts/review-gen.mjs`, `scripts/cli.mjs`, `teammates.gate.json`, `tests/review-gen.test.mjs`, `tests/cli.test.mjs`, `skills/phase-gate/SKILL.md`, `tests/skill-contracts.test.mjs` |

No task depends on another. The split into two phases is forced entirely by `scripts/cli.mjs` and
`tests/cli.test.mjs`, which T2 and T3 both write; `scripts/phases.mjs` separates them on that
overlap alone, and either ordering is correct. The table records the assignment `init-run`
actually produces, verified by running it, rather than the one this spec first guessed.

Both shared files appear in two tasks by design. Being in different phases they are never written
concurrently, and each task declares them so the `fileset` check enforces what it can see.

`README.md` gains the `liveness` command in its command list and a line on the `claims` lens. It is
declared by T2 alone, so exactly one task owns it.
