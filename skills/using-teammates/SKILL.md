---
name: using-teammates
description: Use when work could be split across background teammates - decides fleet vs solo and routes to the right teammates skill.
---

# Using Teammates

Decide whether this work wants a fleet, then route.

## Fleet or solo

Run a fleet when **all** of these hold:

- There is a written plan (or one can be written first).
- The plan has three or more tasks that touch disjoint files.
- The repo is a git repo — worktree isolation depends on it.

Otherwise work solo. A two-task change costs more to orchestrate than to do.

## Routing

| Situation | Skill |
|---|---|
| Starting a run from a written plan | `parallel-execution` |
| Spawn, list, message, scale, stop, or resume teammates | `fleet-lifecycle` |
| A phase finished and needs a verdict | `phase-gate` |
| Want to know what the fleet is doing right now | `fleet-supervision` |

## Non-negotiables

- No teammate ever touches the main worktree. Only `tm-integrator` writes to the run branch.
- Nothing is reported done without a recorded gate PASS.
- All run state lives in `.teammates/<run-id>/`, never only in an agent's head.
