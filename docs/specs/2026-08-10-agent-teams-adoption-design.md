# Agent teams adoption

Status: approved, not yet planned
Date: 2026-08-10

## Problem

`docs/specs/2026-08-05-claude-teammates-design.md:9` states this plugin's purpose as porting a
development process "onto the Teammates feature (background agents, FleetView, `SendMessage`,
Task tooling)". Agent teams has since shipped as a distinct, environment-gated session mode, and
this plugin does not use it. A sweep for `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `TeamCreate`,
`teammateMode`, `~/.claude/teams`, `~/.claude/tasks`, and the `TeammateIdle` / `TaskCreated` /
`TaskCompleted` hooks returns nothing outside prose in that original spec.

What the plugin uses instead is the `Agent` tool with `isolation: 'worktree'`, a generated
`Workflow` script for phases of three or more tasks, and its own coordination in
`.teammates/<runId>/` behind `cli.mjs claim` / `unclaim`. That is a working design, not a broken
one — but three capabilities the harness now provides are being reimplemented or forgone:

- **Enforcement at the point a teammate finishes.** `TeammateIdle` can refuse to let a teammate go
  idle. Today nothing does; a teammate that committed nothing returns `done`, and the mistake is
  caught later at the gate, after the phase's wall-clock is already spent.
- **Addressability.** `skills/fleet-lifecycle/SKILL.md:66` records that `SendMessage` reaches only
  directly-dispatched teammates, never agents inside a running `Workflow` — which is exactly the
  wide phases where a wrong teammate costs most. The project memory records six agents stalled in
  one run with recovery by `SendMessage` as the containment.
- **Visibility.** Teammates appear in the agent panel and can be read and messaged by the user
  without going through the lead.

## Non-goals

**The harness shared task list.** `.teammates/` stays the only coordination store, so
`cli.mjs claim` / `unclaim` are unchanged and `digest`, `doctor` and `rebuild-state` keep their
single implementation. Two stores that can disagree is the failure this project has paid for
before.

**`TaskCreated` and `TaskCompleted` hooks.** They fire on the harness `TaskCreate` tool, which
this plugin never calls, so they would never run. They are not declared. A declared hook that
cannot fire is documentation asserting a guarantee the code does not deliver — the defect class
this repository's next release adds a reviewer lens to find.

**`teammateMode`, split panes, and `it2` / tmux setup.** The user's settings, not the plugin's.

**Plan approval for teammates.** A teammate planning in read-only mode until the lead approves is
a genuine answer to the stale-plan problem recorded in this project's memory, and it is a separate
design.

**Any change to the gate.** Not one check, threshold, or verdict differs between the two modes.

## The property this design protects

A run must produce the same verdict with the flag on or off. Everything that decides whether work
is correct — the phase gate, the file-set enforcement, `tm-integrator` as the sole writer to the
run branch, `.teammates/` as the only coordination store — is byte-identical in both modes. What
the flag changes is how a phase fans out and what happens when a teammate tries to finish.

That is also why the `TeammateIdle` hook runs `complete` rather than anything new: it is the
verification the teammate was already told to run before returning, moved to a point the teammate
cannot skip.

## Blocking verification

Three questions have no documented answer. The implementation plan opens with them, and the first
one gates the rest of this design.

1. **Does `isolation: 'worktree'` still apply to a teammate spawned under teams mode?** Agent teams
   is a coordination layer — shared task list, mailbox, panel — and worktree isolation is a
   parameter on the `Agent` tool. Nothing in the agent-teams documentation mentions worktrees, and
   its "next steps" points at git worktrees as a *manual* alternative for parallel sessions. If
   isolation does not survive, teammates share the main worktree, "no teammate ever touches the
   main worktree" is false in teams mode, and adoption stops at the hook: **Detection**, **The
   `TeammateIdle` hook** and the `fleet-supervision` half of **Skill changes** ship; **Fan-out**
   does not, and the `Workflow` threshold stays as it is in both modes.
2. **What `TeammateIdle` actually delivers.** The published field list for these three events is
   explicitly partial, and whether the event fires at all for a worktree-isolated teammate is
   unconfirmed. The design depends only on `cwd`, which is a common field — but "the hook fires"
   is itself the assumption.
3. **Whether `tm-implementer` ever dispatches a background subagent.** In-process teammates cannot;
   the attempt returns an error. Answered by inspection — `agents/tm-implementer.md` dispatches
   nothing and declares neither `skills` nor `mcpServers` frontmatter, so the "frontmatter is
   ignored for teammates" caveat does not bite either — and re-confirmed by the plan rather than
   assumed.

## Detection

The variable lives in the lead's environment and every `node scripts/cli.mjs …` the lead spawns
inherits it, so the plugin reads `process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` directly. No
settings file is parsed: `settings.json` is one of several places the value can come from, and
reading the process environment is the one answer that is true however it got there.

Two surfaces, because two readers need it:

- `doctor` gains an `agent teams: on|off` line, so the operator asking why a run fanned out one way
  gets it from the command that already answers "what does the repository say".
- `cli.mjs teams-mode` exits 0 when on and 1 when off, printing nothing. Skills branch on the exit
  code, the same idiom `claim` already uses.

`on` means only that the variable is set to `1`. It is not a claim that a team formed, that the
harness supports it, or that the running version behaves as this spec describes — and the doctor
line says so, because a line reading `agent teams: on` next to a run that spawned no team would
otherwise be read as the plugin's assurance.

## The `TeammateIdle` hook

A new handler, `hooks/teammate-idle`, declared under a `TeammateIdle` key with no matcher — the
event ignores matchers.

### It no-ops far more often than it acts

The hook fires for every idle agent in every session with this plugin installed: a reviewer in an
unrelated project, this plugin's own read-only `tm-reviewer`, any subagent in a repository with no
run at all. It exits 0 immediately unless all of:

- `cwd` resolves inside a git worktree, and
- the branch checked out there matches `teammates/<runId>/<taskId>`, and
- `.teammates/<runId>/` exists.

Anything else is not this plugin's business, and the handler must be cheap enough to say so — the
common case is a single `git rev-parse` in a directory that has nothing to do with a run.

### The task comes from git

The documented payload carries `agent_id` and `agent_type`, and no task identifier. Resolving
`cwd` → branch → `runId` / `taskId` takes it from the ref the teammate is actually committing to,
which is the same ref the gate enforces by convention. A teammate that renamed its branch resolves
to nothing here and is allowed to go idle — and then fails the gate, which is the correct order:
this hook is an early catch, never the thing that decides.

### What it runs

`cli.mjs complete --run <runId> --task <taskId> --plan <planPath> --root <repo root>`. Exit 0
allows the idle. Non-zero exits 2 with the failure text on stderr, which the harness feeds back to
the teammate as the reason to keep working. `complete` is per-task and computable while siblings
are still working, so nothing deadlocks — blocking on the *phase gate* would, because the gate
cannot run until the phase is idle.

### Two arguments the hook is not given

`complete` requires `--plan`, and `deriveContext` reads that plan out of git at the run anchor
(`scripts/cli.mjs:861`), so it is a repo-relative path — not something derivable from `cwd`.
Nothing under `.teammates/<runId>/` records it today. `init-run` starts recording the repo-relative
plan path it was invoked with, and the hook reads it from there.

That record is written into the directory the teammate can edit, and the consequence has to be
stated rather than glossed: a teammate that rewrites the recorded path makes the hook verify
against the wrong plan. What that buys is a teammate that goes idle unchecked — it does **not**
produce a passing gate, because the gate takes its plan path from the operator and reads it from
git at the anchor, and never consults this file. The failure mode is losing the early catch, not
gaining a false PASS, and the hook is designed as an early catch for exactly that reason.

`--root` must be the **main** repository root, not the teammate's worktree: run from inside the
worktree, the CLI would resolve the run branch to the task branch checked out there. The hook
derives it from `git rev-parse --path-format=absolute --git-common-dir` and takes that directory's
parent, which is the main worktree for a linked worktree and the repository itself otherwise.

### Bounded at two blocks

Each block is appended to `.teammates/<runId>/idle-blocks.json` with its reason and the task id. On
the third idle for the same task the hook allows it through and records the task `orphaned` with
the unresolved failure attached. The phase gate still fails: a released teammate is not a passed
task, and nothing reports it done.

### Two limits, stated in the handler

- **The counter is writable by its subject.** The teammate has Bash and can zero
  `idle-blocks.json`. Tamper-evident, not tamper-proof — the same footing as everything else under
  `.teammates/`, which is why no check reads any of it.
- **It fails open.** A handler that cannot run — no `node`, a timeout, a malformed run directory —
  exits non-zero-but-not-2, which the harness treats as a non-blocking error. The teammate goes
  idle and the gate catches what the hook did not. A broken hook must not wedge every agent on the
  machine, and the failure is loud in the transcript rather than silent.

## Fan-out

`skills/parallel-execution/SKILL.md` currently sends phases of three or more tasks through a
generated `Workflow` and everything smaller through direct `Agent` calls. In teams mode that
forfeits the point: `Workflow` agents are not teammates, cannot receive `SendMessage`, and do not
raise `TeammateIdle`.

With the flag on, every task of a phase is dispatched as a named background `Agent`, whatever the
count — still capped by `maxParallel`, still `isolation: 'worktree'`, still
`agentType: claude-teammates:tm-implementer`. With the flag off, the current rule is untouched.

Names are `tm-<runId>-<taskId>`, which satisfies the harness name pattern. Predictable names are
required, not cosmetic: `SendMessage` addresses by name, and the documentation is explicit that
stable names exist only because the lead was told what to call each teammate.

**What is given up with the flag on:** `Workflow`'s deterministic control flow and its
`resumeFromRunId` cache. `.teammates/` plus `rebuild-state` covers part of that and not all of it —
`rebuild-state` reconstructs task state from branches and deliberately reconstructs no gate
history. Stated here rather than discovered during a resumed run.

## Skill changes

- **`fleet-lifecycle`** — the `SendMessage` caveat at `SKILL.md:66` becomes conditional. In teams
  mode every task's teammate is addressable because no `Workflow` is involved; with the flag off
  the caveat stands unchanged and stays true.
- **`fleet-supervision`** — the agent panel shows teammates, and the digest stays authoritative.
  The panel renders harness state; `doctor` and `liveness` read git. A panel row reading "working"
  is the same class of self-report this plugin refuses everywhere else, and the skill says so.
- **`using-teammates`** — the fleet-versus-inline preview names the active mode, so the cost being
  accepted is the one shown.

`liveness` does not become redundant, and the skill must not imply it. The two cover disjoint
failures: `TeammateIdle` fires when a teammate *tries to finish*, and a stalled teammate never
tries, so the hook never runs. The stall case remains `liveness`'s alone.

## Standing risk

Agent teams is experimental, disabled by default, and its behaviour changed across at least five
point releases in the range the documentation cites — mailbox validation, idle-row hiding, effort
inheritance in split panes, error reporting on a failed turn, and the removal of `TeamCreate` and
`TeamDelete` entirely. This plugin must not encode version-specific behaviour it cannot detect.
Where it depends on something version-gated, it says so at the point of dependence rather than in a
compatibility note nobody reads next to the code.

The plugin's own version check already reports its installed version each time it changes; it does
not and should not attempt to gate on a Claude Code version, because there is no interface here for
asking one and a wrong guess would disable a working feature.
