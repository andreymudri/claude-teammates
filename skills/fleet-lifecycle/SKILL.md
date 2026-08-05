---
name: fleet-lifecycle
description: Use when spawning, listing, messaging, scaling, stopping, or resuming background teammates on a run.
---

# Fleet Lifecycle

## Operations

**add `<role>` [n]** — spawn `n` background agents of that role (`tm-implementer` by
default). Each new teammate claims work itself:

    node scripts/cli.mjs claim --run <id> --task <taskId> --by <teammateName>

Exit 0 means the claim was won; exit 1 means another teammate already owns it — move to the
next unclaimed task. This is what makes mid-run additions safe.

**list** — report every teammate with its task, state, and elapsed time. Use
`fleet-supervision` for the rendered digest.

**message `<name>`** — `SendMessage` to a running teammate to redirect it. Only works for
teammates spawned as direct agents; agents inside a running Workflow cannot receive messages.

**stop `<name>`** — stop one teammate. Its task returns to `pending`, never `done`.

**resume `<run-id>`** — read `.teammates/<run-id>/` and reconstruct state. For the Workflow
path, relaunch with `resumeFromRunId` so completed agents return cached results.

## Scaling mid-run

Both paths support adding teammates at any moment:

- Direct-agent path: spawn immediately, they claim unclaimed tasks.
- Workflow path: the running script is fixed. Either spawn extra agents *alongside* it (they
  claim tasks the workflow did not take), or edit the generated script and relaunch with
  `resumeFromRunId`.

Two separate limits apply — do not conflate them:

- **`maxParallel`** from the gate manifest (default `min(8, cores-2)`) is this plugin's own
  fleet size. You choose it and may change it between phases.
- **`min(16, cores-2)`** is the Workflow tool's built-in per-workflow concurrency cap. It is
  not ours to set. Excess items queue rather than fail.

Whichever binds first is the real limit. Say so when reporting — never imply everything is
running when tasks are waiting.
