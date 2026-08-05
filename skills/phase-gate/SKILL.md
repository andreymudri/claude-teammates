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

## Reporting rule

**Never report a phase done without a recorded PASS in `status.json`.** A check that was
skipped is reported as skipped, every time. No "should work".
