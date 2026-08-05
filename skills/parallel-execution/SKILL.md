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
dependency order. The integrator is the sole writer to the run branch, and it runs alone —
never in parallel with anything.

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

- **Inspect:** `git worktree list` shows every worktree in the repo, including ones from
  other runs. Use it to confirm a teammate actually got an isolated workspace, and to spot
  stale ones before starting a new run.
- **Prune after merge:** once `tm-integrator` has merged a teammate's branch, remove that
  teammate's worktree (`git worktree remove <path>`) and run `git worktree prune` if the
  directory was already deleted out-of-band. Only prune worktrees that belong to **this**
  run — a worktree from a different run or a teammate still in flight is not yours to
  touch.
