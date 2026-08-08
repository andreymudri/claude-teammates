---
name: parallel-execution
description: Use when executing a written plan across background teammates - splits it into phases, dispatches worktree-isolated implementers, and integrates results.
---

# Parallel Execution

## 1. Initialize the run

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" init-run <planPath> --run <runId> --root <project root>

This writes `.teammates/<runId>/plan.json` and `status.json` and prints the phase breakdown.
Tasks land in the same phase only when their deps are satisfied and their file sets are
disjoint.

## 2. Dispatch the phase

Phases with **three or more** tasks go through the Workflow tool:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" workflow --run <runId> --phase <n> --root <project root>

Write that source to a file and invoke `Workflow` with it. The Workflow tool needs the user's
opt-in — ask once per run, then remember it for that run.

**If the user declines, or the Workflow tool is unavailable, do not stop.** Fall back to the
direct-agent path below for the whole phase: dispatch each task as its own background `Agent`
with `isolation: 'worktree'`, respecting `maxParallel`. The result contract is identical, so
nothing downstream changes. Say which path you took.

Phases with fewer than three tasks are dispatched as direct background `Agent` calls with
`isolation: 'worktree'` and the `tm-implementer` persona. Same result contract either way.

Wait on completion notifications. Do not poll in a loop.

## 3. Record results

Append every result to `status.json`. A teammate that returned nothing is `orphaned`, not
`done` — offer to respawn it.

Before dispatching a later phase, check whether the plan still describes the tree:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" plan-drift --run <runId> --plan <planPath> --root <project root>

It compares the working-tree plan against the plan at the anchor and separates drift that still
reaches the work from drift on an already-integrated phase, which exits 1. A later task's brief
that describes interfaces earlier fix rounds replaced, or acceptance criteria still demanding
behaviour a security fix removed, both surface here — and both are corrected in the dispatch, not
only in the plan, because a dispatch already sent carries the old text.

A returned `done` is a claim, not evidence. Check it against git before believing it:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" doctor --run <runId> --plan <planPath> --root <project root>

A teammate that skipped its `checkout -B` commits on the harness's own branch and leaves
`teammates/<runId>/<taskId>` pointing at the run tip with nothing on it: the returned `branch`
names a real ref, the task merges as a no-op, and `fileset` sees no stray path because it sees no
path at all. `doctor` reports that branch as contributing nothing, along with anything else that
moved in the repository while the phase ran.

## 4. Gate, then integrate

Run `phase-gate`. Only on PASS, dispatch `tm-integrator` to merge the teammate branches in
dependency order with `--no-ff`. The integrator is the sole writer to the run branch and runs
alone. No bookkeeping call follows the merge: the next phase is derived from what is merged.

## Choosing a model per dispatch

Every task in `plan.json` carries a `tier`, either declared in the plan or inferred by
`init-run`. Read it; do not re-derive it. Resolve it at dispatch:

    cheap    -> haiku
    mid      -> sonnet
    capable  -> opus

An omitted model inherits the session's, which is usually the most expensive tier, and that
cost multiplies across every teammate in a phase. Set it explicitly on every dispatch — task
dispatches and role dispatches alike. There is no dispatch that legitimately omits its model.

Role dispatches are fixed and not read from the plan: `tm-integrator` runs at `mid`,
`tm-reviewer` at `capable`. Review is the last line of defence before integration.

The `tm-integrator` dispatch carries the configured integrator tier and effort, read with
`config get agents.integrator.tier` and `config get agents.integrator.effort`. `config get` on
an unset key exits 2 with `unset: <key>` — the same exit code every hard config failure uses,
but here it is the normal case, not an error. Tier and effort fall back differently:

- `unset: agents.integrator.tier` — dispatch at the **fixed integrator tier, `mid`** (model
  `sonnet`). Do not omit the model to inherit the session's; the fixed role tier is the
  fallback. A configured tier replaces `mid`. The same shape holds for `tm-reviewer`, whose
  fixed tier is `capable` — see `phase-gate`.
- `unset: agents.integrator.effort` — omit the `effort` option, and the dispatch inherits the
  session's effort. Effort is the only option that falls back by omission.

These two keys are ergonomics, not enforcement, unlike the reviewer's tier and effort: the
integrator merges branches, it does not judge a check, so either layer may set them and the
gitignored `teammates.local.json` is the normal place to.

When generating a Workflow, pass the same map through so the generated dispatches carry
concrete models:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" workflow --run <id> --phase <n> --root <root> \
      --models '{"cheap":"haiku","mid":"sonnet","capable":"opus"}'

## Before dispatching tm-integrator

Detach the main worktree first:

    git checkout --detach

The integrator is the sole writer to the run branch and cannot check it out while the main
worktree holds it. Without this it has no supported way to advance the branch, and reaches for
`git update-ref`, which desyncs the main worktree's index from its HEAD. Re-attach after the
merge with `git checkout <run branch>`.

## Amending a plan mid-run

The gate reads the plan with `git show <mergeBase(base, runBranch)>:<planPath>` — never from the
working tree, so a teammate cannot widen its own file set by editing the plan in its worktree.
That also means an amendment committed only on the run branch changes nothing: the merge-base does
not move, and `fileset` still reads the old plan.

State the limit with the guarantee: the plan is read from git at the anchor, so a working-tree edit
is inert, but a commit on the base branch is authoritative by design and is not distinguishable
from an amendment the user made. A teammate has Bash; if it can move `refs/heads/<base>` it can
commit a widened `**Files:**` list for its own task, and once that reaches the anchor `fileset`
permits every path it declared for itself. What bounds this is write access to the base branch,
not the plan read.

To make an amendment authoritative:

1. Commit it on the **base** branch.
2. Merge the base into the run branch with `--no-ff`: that moves the merge-base onto the new base
   tip, and `ownership` accepts the merge because its secondary parent is an ancestor of the base.
   The limit on that acceptance: every secondary parent is checked, so a rogue parent riding
   alongside the base parent still fails. Merging the base into the run branch is the
   orchestrator's operation, not a `tm-integrator` dispatch: the integrator's contract is scoped to
   teammate branches after a passing gate, and an amendment happens precisely when neither holds —
   the base is not a teammate branch, there is no gate PASS (the failing gate is *why* the
   amendment exists), and the merge carries `planPath`, which belongs to no task's declared set, so
   a contracted integrator stops and reports rather than merges. Do it yourself: detach the main
   worktree with `git checkout --detach`, `git checkout <run branch>`, `git merge --no-ff <base>`,
   then re-attach the main worktree to the run branch.
3. Rebase any in-flight task branch onto the new run-branch tip. Not to avoid a `fileset` failure —
   that check diffs each branch from `mergeBase(runBranch, branch)`, the branch's own fork point,
   never from the anchor, so an un-rebased branch still diffs to its own changes only and that
   failure cannot occur. Rebase because the branch needs the amended plan and the interfaces
   earlier phases merged.

If a merge is not appropriate — the base diverged such that merging would drag unrelated work into
the run — rebuild the run branch on the new base tip and re-merge each task branch with `--no-ff`.
Rebuilding the run branch is the orchestrator's operation, not the integrator's: `tm-integrator`
does checkout plus `--no-ff` merge and reports `blocked` rather than reset or force-move a branch,
so a dispatch asking it to rebuild asks for something its contract does not cover.

Amend only when a task's declared file set is genuinely wrong. Correcting a stale *interface* — a
signature an earlier phase's fix rounds changed — belongs in the dispatch brief, not the plan.

## Invariants

- A teammate **never touches the main worktree**; it works only in its own.
- A teammate writes only the files its task declared. Strays are a gate failure, caught at
  merge.
- Phase N+1 does not start before phase N gets a PASS.

## Why fresh implementers, and how review fits between tasks

Each teammate is a **fresh** agent carrying only its own task's context — the brief for
that task, the interfaces it touches, and the global constraints. It never inherits the
session's accumulated history or another teammate's context. A dispatch built from pasted
history of prior tasks defeats this: hand over files and pointers, not narrative.

Review happens **between tasks, not only at the end**: each teammate's result gets its
task-scoped gate (Step 4) before the next phase starts, catching spec and quality gaps
while the context to fix them is still cheap. The broad review at branch completion
(`phase-gate`'s final pass) never substitutes for this — it catches cross-task drift, not
per-task defects.

If a teammate needs a fix round, resume the same teammate first — it still has the task's
context. Only fall back to a fresh implementer on that task if resuming stalls; note in
`status.json` that the task restarted.

## The map

Every generated brief carries a **blast radius**: the files that have historically changed
alongside the task's declared set. They are outside the file set, so the teammate may not edit
them — they are what its change is most likely to break without touching. It is computed from
`git log` at dispatch time and stored nowhere, so it cannot go stale; a repository with no
history simply produces no section. Coupling is computed over a bounded window — the last 500
commits by default, settable with `--commits` — so a repository with more history than that is
answered from a window, not the whole log.

Ask the same question yourself for any file set:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" map --files <a,b> --root <project root>

Coupling is correlation in history, not a dependency: a source and its test, a caller and its
callee, and two files one person kept tidy all look alike to it. Nothing enforces it and no gate
reads it — a map that could fail a phase would be a map worth gaming.

## Worktree mechanics

Each teammate works in its own git worktree — `isolation: 'worktree'` creates one per
teammate automatically; a teammate never shares a worktree with another.

- **Bootstrap before task work starts:** a fresh worktree has no installed dependencies and no
  untracked config the project needs (for example `.env`). Before writing the first test,
  install dependencies as the project requires, copy over any untracked config files the
  project needs, and run the existing test suite once to confirm a clean, green baseline. Do
  this every time, not just when something looks off: a failure caused by a missing dependency
  looks exactly like a RED test from `test-driven-development`, and the gate cannot tell the
  two apart. If the baseline can't be made green, report `blocked` rather than starting task
  work on top of it.
- **Inspect:** `git worktree list` shows every worktree in the repo, including ones from
  other runs. Use it to confirm a teammate actually got an isolated workspace, and to spot
  stale ones before starting a new run.
- **Prune with the command rather than by hand:**

      node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" prune-run --run <runId> --plan <planPath> --root <project root> [--yes]

  It recomputes each phase's gate, removes only this run's worktrees whose phase passes, and
  names every one it left alone and why. Without `--yes` it reports and removes nothing.
- **Prune after the phase passes its gate, not when a teammate returns:** `phase-gate` resolves a
  `retry` by resuming the same teammate, and a resumed teammate whose worktree is gone cannot
  start — it fails with "its worktree no longer exists", and the task's whole context is lost
  with it. Remove the worktree once the phase has a recorded PASS (`git worktree remove <path>`),
  then `git worktree prune`. Only prune worktrees belonging to **this** run. If a task must go to
  a **fresh** implementer instead — because resuming stalled — prune that task's worktree first,
  since a returned teammate's worktree keeps its branch checked out and the new dispatch would
  fail with "already used by worktree"; then restate the findings, the branch and the file set in
  its dispatch, because none of that survives the handover.
