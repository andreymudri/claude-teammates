---
name: fleet-lifecycle
description: Use when spawning, listing, messaging, scaling, stopping, or resuming background teammates on a run.
---

# Fleet Lifecycle

## When the run directory is gone

`.teammates/` is gitignored, so a clean checkout or a stray delete takes a run's bookkeeping with
it. Rebuild it from git rather than hand-writing JSON:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" rebuild-state --run <runId> --plan <planPath> --root <project root>

It derives every task's state from its branch — merged or contributing is `done`, a branch that
exists and contributes nothing is `orphaned`, no branch is `pending` — and refuses to overwrite
state that still exists unless you pass `--force`. It reconstructs **no** gate history: a verdict
is evidence that checks ran, and git carries branches, not evidence. Every phase of a rebuilt run
has to be gated again before anything is reported done.

## Map notes

For what a target project's modules are *for* — the part git statistics cannot supply — a run may
carry hand-written notes on it, verified and refreshed with:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" map-notes --run <runId> --root <project root>

Exit 0 means the stored notes declare the commit the repository is on; the header is a string the
writing agent was told to copy, so this is tamper-evident provenance and not proof — nothing
observes which tree that agent actually read, and nothing detects a header edited afterwards.
Exit 4 means there are none, they carry no header at all, they name a different commit, they were
written for a different run, or the file could not be read, and it prints the exact prompt to
dispatch. Exit 2 means git could not be read, so no comparison happened at all — read that as
unknown, never as current. Dispatch a read-only agent with the printed prompt; it RETURNS the map
and you write it to that path yourself, after checking the header it returned names this run and
this commit. A teammate never writes this file, and nothing enforced ever reads it. The directory
names that
prompt carries are filtered — anything that is not a plain path segment is dropped — because that
prompt is handed to an agent that has Bash and is gated by nothing.

A killed gate cannot run its own cleanup, so `prune-run` also reports leaked merge-preview
worktrees — the gate's own scratch worktrees under the system temp directory — and removes them
with `--yes`.

## Operations

**add `<role>` [n]** — spawn `n` background agents of that role (`tm-implementer` by
default). Each new teammate claims work itself:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" claim --run <id> --task <taskId> --by <teammateName> --root <project root>

Exit 0 means the claim was won; exit 1 means another teammate already owns it — move to the
next unclaimed task. This is what makes mid-run additions safe.

**list** — report every teammate with its task, state, and elapsed time. Use
`fleet-supervision` for the rendered digest.

**message `<name>`** — `SendMessage` to a running teammate to redirect it. Only works for
teammates spawned as direct agents; agents inside a running Workflow cannot receive messages.

**stop `<name>`** — stop one teammate. Its task returns to `pending`, never `done`. Release the
claim so the task is claimable again:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" unclaim --run <id> --task <taskId> --root <project root>

Without this the task stays permanently claimed by the stopped teammate and no respawned
teammate can ever pick it up.

**resume `<run-id>`** — read `.teammates/<run-id>/` and reconstruct state. For the Workflow
path, relaunch with `resumeFromRunId` so completed agents return cached results.

## Scaling mid-run

Both paths support adding teammates at any moment:

- Direct-agent path: spawn immediately, they claim unclaimed tasks.
- Workflow path: the running script is fixed. Either spawn extra agents *alongside* it (they
  claim tasks the workflow did not take), or edit the generated script and relaunch with
  `resumeFromRunId`.

Two separate limits apply — do not conflate them:

- **`maxParallel`** (default `min(8, cores-2)`) is this plugin's own fleet size. It is an
  **ergonomics** key: settable in either layer, but `teammates.local.json` (gitignored,
  machine-local) is the normal place for it — fleet size depends on the machine, so it does not
  belong committed. Change it through `config set maxParallel <n> --local`, never by hand; see
  `teammates-config`. You may change it between phases.
- **`min(16, cores-2)`** is the Workflow tool's built-in per-workflow concurrency cap. It is
  not ours to set. Excess items queue rather than fail.

Whichever binds first is the real limit. Say so when reporting — never imply everything is
running when tasks are waiting.

## When parallel dispatch is safe

Dispatch teammates in parallel only when their tasks are genuinely **independent**: no
shared state, and no sequential dependency between them (one does not need another's
output or edits to proceed). `init-run`'s phase breakdown already enforces this for
declared deps and file sets — but the same rule applies to anything you dispatch outside
the plan, like ad-hoc investigation agents: group work by independent problem domain, one
agent per domain, and issue all the dispatches in a single response so they actually run
concurrently.

A wrongly-parallelised pair does not just run slower — it produces **conflicting edits**,
because both teammates touch state the other assumed was theirs alone. That failure mode
is caught late, at merge, and costs more to unwind than the sequential run it was meant to
speed up. When in doubt about whether two tasks are independent, dispatch them
sequentially.
