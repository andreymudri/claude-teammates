---
name: fleet-supervision
description: Use when checking what a running fleet is doing - renders the digest, surfaces blocked or failed teammates, and suggests scaling.
---

# Fleet Supervision

## Digest

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" digest --run <runId> --root <project root>

Show that block as-is. It is deliberately compact; do not expand it into prose.

## What the repository says

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" doctor --run <runId> --plan <planPath> --root <project root>

The digest renders `status.json`, which the teammates being supervised write; `doctor` asks git
instead. It reports the main worktree's branch and any dirty paths, every worktree and who holds
it, and per task the branch tip and what it actually contributes from its own fork point. Exit 1
means it found problems, all named — a branch with no changes (the work landed on another ref), a
worktree inside the repository, a branch that reached the base branch without the run branch.

Run it after a teammate returns and before a gate. It decides nothing and records nothing: a
teammate is `done` on the strength of this report and the gate, never on its own say-so.

## Event-driven, not polling

Background teammates notify on completion — react to those notifications. The only timer is a
long heartbeat (20-30 minutes) to catch a teammate that hangs and never notifies. Do not sit
in a poll loop.

## The heartbeat

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" liveness --run <runId> --plan <planPath> --root <project root>

Run it on the 20-30 minute heartbeat, not in a loop. Exit 1 means at least one teammate of the
current phase has neither committed nor touched its worktree inside the window.

Exit 2 means it did not measure what you asked about, and is neither a stall nor an all-clear. Fix
what the message names and run it again. It reports that when:

- no current phase can be named — the main worktree is on the base branch, the plan is missing at
  the anchor, or the phases integrated out of order;
- the run id matches no run directory (a typo would otherwise report a board of "not started");
- the plan in the working tree has no task in the derived phase, which an amendment mid-run causes;
- a row reads `unknown`, meaning freshness was not measured for that teammate. Two causes, and the
  output names which: no worktree of that branch could be read — none is registered, because the
  teammate was dispatched without worktree isolation or is working in the main worktree — or the
  walk hit its 5000-entry cap, for which the fix is to add the generated directory to the project
  .gitignore, since the walk skips what git ignores.

A row is only `stalled` when both signals were measured, and a measured stall outranks an unknown
row: a board carrying both exits 1, and names the unmeasured task anyway. A run whose phases are
all integrated is finished, at exit 0.

It reports; it does not act. A stalled row is your cue to message that teammate or offer to stop
it — the CLI has no handle on a subagent. Both of its signals are forgeable by the teammate they
describe, so a stall is a prompt to look, never evidence for a gate.

## Failure handling

| Symptom | Response |
|---|---|
| Result is null (died or skipped) | Mark `orphaned`, never `done`. Offer respawn. |
| Teammate blocked on another task | Missing edge in `plan.json`. Record it, requeue after the blocker. |
| Files touched outside the declared set | Gate failure. Report the stray paths with the owning task. |
| Merge conflict | Escalated by `tm-integrator` with both hunks. Do not resolve semantics yourself. |
| Silent past the heartbeat | Detected by `liveness` above (exit 1). Surface it; offer stop or wait. Never assume progress. |

## Scaling suggestions

When queued tasks exceed idle slots, suggest — never silently decide:

> 4 tasks queued, 2 idle slots. Add 2 implementers?

Route the actual spawn through `fleet-lifecycle`.
