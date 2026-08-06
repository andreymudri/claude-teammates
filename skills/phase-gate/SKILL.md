---
name: phase-gate
description: Use when a phase finished and needs an automated verdict before integration - runs command, agent, and MCP checks and decides PASS or FAIL.
---

# Phase Gate

Phases run autonomously end to end. The boundary is where verification happens.

## Run it

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" gate --run <runId> --root <project root> [--phase <name>]

Exit codes: `0` PASS, `1` FAIL, `3` no manifest (an inferred one was printed).

On exit 3, show the user the inferred manifest, get confirmation, and save it as
`teammates.gate.json`. Never invent checks silently.

## Finish the pending checks

The CLI runs `command` checks itself and returns `agent` and `mcp` checks as `pending` —
those you execute:

- **agent** — dispatch one `tm-reviewer` per lens in parallel over the phase diff. Then take
  every finding at a `blockOn` severity and dispatch a second reviewer prompted to **refute**
  it. Only findings that survive refutation block the gate. This kills plausible-but-wrong
  findings before they stop a run.
- **mcp** — call the declared tool and compare against `passWhen`. If the server is not
  connected and the check is `optional`, record `skip` and say so out loud. A missing optional
  server is never a silent pass.

Feed the completed results back through the CLI verdict shape: FAIL if anything failed or if
any non-optional check is still pending.

## On FAIL

Halt before integration. Report, in this order: which check failed, the exact command output
or finding list, the offending diff hunks, and the owning teammate. Then offer three choices —
retry the failing task with the findings fed back, override and proceed, or abort the phase.

## What the enforcement checks do and do not cover

`fileset` and `ownership` are computed by the gate from git, at the moment it runs. They read
no file from `.teammates/`: the run phase, the anchor, and the plan all come from git, because
`status.json` is written by the agents being enforced. `complete` recomputes rather than
trusting a recorded verdict.

**These checks are tamper-evident, not tamper-proof.** They catch drift, mistakes, and attacks
that are not aimed at them. They do not stop a teammate that targets them: a teammate runs its
own tests, and running a teammate's code is arbitrary execution, so a determined teammate can
do anything the user can — including fast-forwarding the run branch to make a phase look
integrated. `docs/specs/2026-08-05-tamper-evident-enforcement-design.md` lists what is out of
scope; `tests/adversarial.test.mjs` pins each limit with a test.

Skipped only when the caller passes `--no-fleet`. Missing state is a failure, never a skip.

A `fileset` or `ownership` failure is a process violation, not a code defect. Do not widen the
plan's file set to make it pass.

## Reporting rule

**Never report a phase done without a recorded PASS in `status.json`.** A check that was
skipped is reported as skipped, every time. No "should work".

**Evidence before claims, always.** Never claim a task, phase, or fix is complete, fixed,
or passing without having run the verification yourself in this pass and seen its output —
a prior run, an agent's self-report, or "should pass now" is not evidence. "Tests pass"
requires the test command's fresh output showing the count and zero failures, not
recollection of an earlier green run. "Bug fixed" requires re-running the original failing
case and watching it pass now, not the diff alone. If a `tm-implementer` reports DONE,
that report is not the evidence — the gate's own check run against its diff is. Skipping
this because a check "obviously" passes is the same defect as skipping the check.
