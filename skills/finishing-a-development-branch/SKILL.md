---
name: finishing-a-development-branch
description: Use when implementation is complete and needs integrating - verifies recorded gate verdicts, then decides how the run branch lands.
---

# Finishing a Development Branch

Work is not finished because the code looks done. It is finished when the record says so.

## The completion gate

Read `.teammates/<run-id>/status.json` and check `status.gates`. Each phase that ran must
have an entry there, and that entry's `verdict` must be `PASS`:

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

Walk every phase the run actually executed. If a phase is missing from `status.gates`, or its
`verdict` is not `PASS`, the work is not finished — name the phase and stop. Do not present the
branch as ready on the strength of "the tests looked green" or "the teammate said it was done".
Only a recorded PASS counts.

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

Once the gate has recorded PASS for every phase and any parked findings are on the table,
present the choice — do not pick one unilaterally:

1. **Merge to the default branch.**
2. **Open a pull request** for external review before it lands.
3. **Keep the branch for further work** — integration isn't forced just because the gate passed.

Carry out whichever the user picks; don't default to merging in the absence of an answer.
