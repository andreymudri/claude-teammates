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
cost multiplies across every teammate in a phase. Set it explicitly on every dispatch.

Role dispatches are fixed and not read from the plan: `tm-integrator` runs at `mid`,
`tm-reviewer` at `capable`. Review is the last line of defence before integration.

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
working tree, so a teammate cannot widen its own file set by editing the plan. That also means an
amendment committed only on the run branch changes nothing: the merge-base does not move, and
`fileset` still reads the old plan.

To make an amendment authoritative:

1. Commit it on the **base** branch.
2. Rebuild the run branch on the new base tip, via `tm-integrator`, re-merging each task branch
   with `--no-ff`.
3. Rebase any in-flight task branch onto the new run-branch tip, or its diff against the new
   anchor will contain every file the earlier phases merged.

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
- **Prune as soon as a teammate returns, not only after merge:** a finished teammate's worktree
  keeps its branch checked out, and the next dispatch that needs that branch — a fix round, a
  retry, a rebase — fails with "already used by worktree". Remove the worktree when the task
  returns (`git worktree remove <path>`), then `git worktree prune`. Only prune worktrees
  belonging to **this** run. This blocked two dispatches in run `preview`, both times costing a
  re-dispatch.
