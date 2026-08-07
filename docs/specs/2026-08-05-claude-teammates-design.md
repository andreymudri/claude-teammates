# claude-teammates — Design

Date: 2026-08-05
Status: approved, pre-implementation

## Purpose

A standalone Claude Code plugin that ports the superpowers development process onto the
Teammates feature (background agents, FleetView, `SendMessage`, Task tooling). It adds two
things superpowers does not have: fleet orchestration and fleet supervision.

Superpowers-inspired, not a fork and not a dependency. No superpowers skill is invoked or
required at runtime.

## Scope

v1 delivers four capabilities:

1. **Fleet lifecycle** — spawn a named roster of background teammates, assign roles, message
   them, scale them, shut them down.
2. **Plan → parallel execution** — take a written plan, split it into independent tasks,
   dispatch one teammate per task in an isolated git worktree, collect and integrate results.
3. **Supervision / monitoring** — report who is running, blocked, or failed; suggest scaling;
   restart or reassign; produce a compact digest.
4. **Review & verification team** — fan out adversarial reviewers over a diff, dedupe
   findings, verify before anything is claimed done.

Out of scope for v1: human-collaborator integrations (Slack, Linear), remote/cloud agents,
cross-repo fleets.

## Orchestration model

Hybrid. Skills own lifecycle, supervision, gates, and all human interaction, and run in the
main session. Phase fan-out delegates to a generated `Workflow` script when a phase has three
or more independent tasks; below that threshold the lead spawns background `Agent` calls
directly.

Rationale: `Workflow` gives deterministic control flow, worktree isolation, structured
schemas, and `resumeFromRunId`, and keeps the main session's context small — but its script is
fixed at launch, it cannot receive `SendMessage`, and it needs explicit user opt-in. Direct
`Agent` calls stay fully interactive. Using each where it is strongest avoids both weaknesses.

## Repository layout

```
claude-teammates/
  .claude-plugin/plugin.json
  skills/
    using-teammates/        # entrypoint: when to fleet vs solo
    fleet-lifecycle/        # spawn roster, roles, message, scale, shutdown
    parallel-execution/     # plan -> tasks -> worktree teammates -> integrate
    phase-gate/             # gate manifest + verdict logic
    fleet-supervision/      # digest, unblock, restart, scaling suggestions
  agents/
    tm-implementer.md
    tm-reviewer.md
    tm-integrator.md
  templates/
    teammates.gate.yaml     # per-project gate manifest
    phase-workflow.js       # Workflow script template for fan-out
  tests/                    # scripted dry-run scenarios per skill
  docs/specs/
```

Layer split: skills are process and human interaction; agents are personas with scoped tools;
templates hold the deterministic parts.

## Run state

All run state lives in the target repo at `.teammates/<run-id>/`:

- `plan.json` — tasks: `id`, `title`, `files` (expected touch set), `deps`, `phase`
- `status.json` — per-task state, owning teammate, branch, timestamps
- `findings.json` — reviewer findings with severity and verification verdict
- `digest.md` — appended per phase, plus the final consolidated summary

File-based on purpose: a fresh session, a resumed workflow, and a supervisor agent all read
the same truth. Nothing load-bearing lives only in a running agent's context.

## Execution flow

Per phase, driven by the lead session:

1. **Plan intake** — `parallel-execution` reads a written plan (markdown) and writes
   `plan.json`. Tasks with no shared files and no unmet deps are grouped into the same phase.
2. **Fan-out** — phase with ≥3 independent tasks: generate `phase-workflow.js` from the
   template and invoke `Workflow` (opt-in asked once per run, remembered for that run).
   Fewer than 3: direct `Agent` calls with `run_in_background` and `isolation: "worktree"`.
3. **Per teammate** — `tm-implementer` receives its task spec and its worktree, and is bound
   to touch only its declared files. Returns
   `{ status, branch, filesChanged[], summary, blockers[] }`.
4. **Collect** — the lead waits on completion notifications rather than polling. Each result
   is appended to `status.json`.
5. **Gate** — `phase-gate` runs (below). PASS integrates and advances; FAIL halts.
6. **Integrate** — `tm-integrator` merges teammate branches into the run branch in dependency
   order, resolves trivial conflicts, escalates real ones. Runs only after a PASS, single
   writer, never parallel.
7. **Digest** — `digest.md` appended; consolidated summary at end of run.

Invariant: no teammate ever touches the main worktree. Only the integrator writes to the run
branch.

## Dynamic fleet sizing

Available at any time, on both paths:

- `fleet-lifecycle` ops: `add <role> [n]`, `list`, `message <name>`, `stop <name>`. Adding
  spawns a background agent that reads `.teammates/<run>/` and claims unclaimed tasks. No
  restart required.
- `SendMessage` to any running teammate by name to redirect it mid-task.
- `maxParallel` in `teammates.gate.yaml` (default `min(8, cores-2)`), adjustable between
  phases.

Direct `Agent` path: fully dynamic — spawn, message, kill, at any moment.

`Workflow` path: the script is fixed at launch and cannot take an injected agent mid-run.
Two supported responses:

1. Spawn extra teammates alongside the workflow via `Agent`; they claim tasks from `plan.json`
   the workflow did not take. Works live.
2. Edit the generated script and relaunch with `resumeFromRunId` — completed agents return
   cached results, only new or changed calls run.

A single workflow caps concurrency at `min(16, cores-2)`; excess items queue rather than fail.
The skill `log()`s whenever it queues, so a digest never implies everything is running when
some tasks are waiting.

`fleet-supervision` suggests scaling ("4 tasks queued, 2 idle slots — add 2 implementers?")
and does not silently decide.

## Phase gate

Checkpoint-per-phase rhythm, with the approval gate automated. Phases execute end-to-end
autonomously; at the phase boundary the gate produces a verdict. PASS proceeds automatically.
FAIL pauses, surfaces the precise errors and diffs, and requests human intervention.

Configured per project in a committed `teammates.gate.yaml`:

```yaml
maxParallel: 6
phases:
  default:
    checks:
      - name: typecheck
        kind: command
        run: rtk tsc --noEmit
      - name: tests
        kind: command
        run: rtk vitest run
      - name: review
        kind: agent
        agent: tm-reviewer
        lens: [correctness, security, tests]
        blockOn: [high]           # medium/low are advisory
      - name: api-contract
        kind: mcp
        tool: mcp__postman__...
        optional: true            # missing server = skip, not fail
  integration:                    # phase-name override
    checks: [...]
```

Verdict rules:

- `command` — PASS iff exit 0. On failure, capture stderr and the last 40 lines of output.
- `agent` — `tm-reviewer` fans out one agent per lens and returns structured findings. PASS
  iff no finding at a `blockOn` severity. Every blocking finding is then handed to a second
  adversarial verifier prompted to refute it; only findings that survive refutation block.
- `mcp` — the tool result must match the declared `passWhen`. `optional: true` degrades to a
  logged skip, never a silent pass.
- Overall verdict is the AND of all non-optional checks.

On FAIL the run halts before integration and reports: which check failed, the exact command
output or finding list, the offending diff hunks, and the owning teammate. Three offers
follow — retry the failing task with the findings fed back, override and proceed, or abort
the phase.

With no manifest present, the skill infers lint/test/build from `package.json` or
`Cargo.toml`, shows the inferred manifest, and writes it only after confirmation. It never
invents checks silently.

## Supervision and failure modes

Supervision is event-driven. Background agents notify on completion and the supervisor wakes
on those notifications. The only timer is a long heartbeat (20–30 minutes) to catch a teammate
that hangs and never notifies.

Digest shape:

```
run 3f2a · phase 2/4 · 6 tasks
running   4  ████░░  auth-mw(12m) db-schema(9m) ui-form(4m) tests(2m)
done      1  parser ✓
blocked   1  billing — needs schema from db-schema
idle slots 2
```

Failure taxonomy, each with a defined response:

| Failure | Response |
|---|---|
| Teammate returns `null` (died or skipped) | Mark task `orphaned`, never counted as done. Offer respawn. |
| Teammate blocked on another task | Missing edge in `plan.json`. Record the dependency, requeue after the blocker. |
| Teammate touched files outside its declared set | Integrator flags at merge; gate fails listing the stray paths. |
| Merge conflict | Integrator escalates with both hunks. Semantic conflicts are never auto-resolved. |
| Hung teammate (silent past heartbeat) | Surfaced in the digest; user chooses `stop` or wait. |
| Run interrupted | `.teammates/<run>/` persists. `fleet-lifecycle resume <run-id>` reconstructs state; the workflow path uses `resumeFromRunId`. |

Anti-lie rule: nothing is reported done without a gate PASS recorded on disk. A skipped check
is reported as skipped. No "should work".

## Testing the plugin

Each skill gets a scripted dry-run scenario under `tests/`: a fixture `plan.json`, stub
commands with known exit codes, and assertions on the gate verdict and the rendered digest
text. No live agents needed, so the suite is cheap enough to run on every change.

## Decisions on record

| Decision | Choice | Why |
|---|---|---|
| Relationship to superpowers | Standalone, superpowers-inspired | No coupling to upstream releases; free to shape process around teammates. |
| Isolation | Git worktree per teammate | Real parallel edits without conflicts; cost is setup time and disk. |
| Checkpoints | Per phase, gate automated | Autonomy inside a phase, verified boundary between phases. |
| Gatekeeper | Configurable: command, agent, and MCP checks | Projects differ; a fixed backend would either under- or over-verify. |
| Orchestration | Hybrid skills + `Workflow` | Determinism where fan-out is wide, interactivity where messaging matters. |
| Location | Standalone plugin repository | Installable via `/plugin` from a marketplace or a local path. |

## Open items for the implementation plan

- Concrete `plan.json` and `status.json` schemas (JSON Schema, used by agent structured output).
- The `phase-workflow.js` template body and how the skill parameterizes it.
- Task-claiming protocol for teammates added mid-run (avoiding two agents claiming one task).
- Whether `tm-reviewer` reuses the repo's existing review tooling when present.
