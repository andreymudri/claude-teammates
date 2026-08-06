---
name: finishing-a-development-branch
description: Use when implementation is complete and needs integrating - re-runs the gate to verify each phase, then decides how the run branch lands.
---

# Finishing a Development Branch

Work is not finished because the code looks done. It is finished when a gate you just ran
says so — not when a record claims one already did.

## The completion gate

Work is not finished because the code looks done, and never because "the tests looked green"
or "the teammate said it was done" earlier in the conversation. Which check applies depends on
what state the run is in — check in this order.

### 1. Fleet run: `status.gates` is recorded

If `.teammates/<run-id>/status.json` exists and has a non-empty `status.gates`, this is a fleet
run — but a record in `status.gates` is a report written by the agents being enforced, and
`status.json` is agent-writable, so it is never trusted as evidence. A recorded `verdict` of
`PASS` proves nothing by itself:

    {
      "gates": {
        "<phaseName>": {
          "verdict": "PASS",
          "failed": [],
          "skipped": [],
          "pending": [],
          "recordedAt": 1785952191621
        }
      }
    }

Use `status.gates` only to see which phases the run executed. For each of those phases,
**re-run the gate now**:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" gate --run <runId> --plan <planPath> --root <project root> --phase <name>

`gate` recomputes `fileset` and `ownership` from git at the moment it runs — it does not read
or trust the old record. If any phase's fresh run does not exit `0`, the work is not finished —
name the phase and stop.

### 2. Inline run: a run directory exists but gates are absent or empty

`executing-plans` runs plans inline, task by task, and never writes a gate manifest or a
verdict — that's by design, not an omission. If `status.json` exists but `status.gates` is
absent or empty, the run is inline, and the absent gates are expected, not a fault to fix here.

There is no fleet history to derive `fileset` or `ownership` from, so run the gate solo:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" gate --no-fleet --root <project root>

`--no-fleet` is the only way the enforcement checks are skipped, and it runs the project's
full test suite (and any other command checks `teammates.gate.json` declares) fresh — a
remembered result, or a run from earlier in this session, is not evidence. Once it exits
`0`, proceed.

### 3. No run directory at all

Someone may have finished work on a branch without ever calling `init-run` — there's no
`.teammates/<run-id>/` to read. Run the gate solo the same way as case 2, confirm it exits `0`
from fresh output, and proceed the same way.

## Branch taxonomy

Two kinds of branch exist in this plugin, and they are not interchangeable:

- **Teammate branches** are scratch. Each teammate does its work on its own branch, inside its
  own worktree, and that branch is disposable the moment it merges into the run branch.
- **The run branch** is the deliverable. It is the only branch that matters once the run is
  done, and **`tm-integrator` is the sole writer of it.** Teammate branches merge into the run
  branch; the run branch never merges into a teammate branch, and no other role pushes to it
  directly.

If you find yourself about to commit implementation work straight onto the run branch instead
of a teammate branch, stop — that's the wrong direction for this model.

## Worktree cleanup

Teammate branches leave worktrees behind even after their branch has merged and the branch
itself is deleted. Inspect what's left:

    git worktree list

Prune only the worktrees that belong to this run — matching this run's teammate branch names
or paths. Leave worktrees for other runs or other work alone; do not sweep indiscriminately.
For each stale worktree that belongs to this run:

    git worktree remove <path>

If a worktree has uncommitted changes `remove` will refuse — look before forcing anything.

## Surface unresolved findings

Before proposing integration, check for parked or deferred findings from review — anything a
gate check or reviewer flagged but did not block on. Report them explicitly here, individually,
with enough detail to judge. Do not let them get buried in a "looks good" summary. The user
decides whether an unresolved finding blocks integration; that call is not yours to make
silently.

## Integration options

Once a freshly re-run gate has passed for every phase and any parked findings are on the table,
present the choice — do not pick one unilaterally:

1. **Merge to the default branch.**
2. **Open a pull request** for external review before it lands.
3. **Keep the branch for further work** — integration isn't forced just because the gate passed.

Carry out whichever the user picks; don't default to merging in the absence of an answer.
