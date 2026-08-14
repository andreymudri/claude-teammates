# Agent teams adoption

Status: approved; retargeted 2026-08-13 to SubagentStop — see docs/specs/2026-08-13-agent-teams-probe-findings.md
Date: 2026-08-10

## Problem

`docs/specs/2026-08-05-claude-teammates-design.md:9` states this plugin's purpose as porting a
development process "onto the Teammates feature (background agents, FleetView, `SendMessage`,
Task tooling)". Agent teams has since shipped as a distinct, environment-gated session mode, and
this plugin does not use it. A sweep for `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `TeamCreate`,
`teammateMode`, `~/.claude/teams`, `~/.claude/tasks`, and the `TeammateIdle` / `TaskCreated` /
`TaskCompleted` hooks matches no code: `scripts/`, `skills/`, `agents/`, `hooks/`, `templates/` and
`tests/` are clean of all of them. The occurrences that remain are prose — this design, its
implementation plan, and the probe findings it cites. In particular the original spec quoted above,
`docs/specs/2026-08-05-claude-teammates-design.md`, contains none of those terms; it frames the
purpose in that sentence and nowhere names the machinery.

What the plugin uses instead is the `Agent` tool with `isolation: 'worktree'`, a generated
`Workflow` script for phases of three or more tasks, and its own coordination in
`.teammates/<runId>/` behind `cli.mjs claim` / `unclaim`. That is a working design, not a broken
one — but three capabilities the harness now provides are being reimplemented or forgone:

- **Enforcement at the point a teammate finishes.** A stop-path hook can refuse to let a teammate
  finish. Today nothing does; a teammate that committed nothing returns `done`, and the mistake is
  caught later at the gate, after the phase's wall-clock is already spent. This is the one item
  that survived measurement, and it is what the rest of this document specifies — against
  `SubagentStop`, not `TeammateIdle`; see **What was measured**.
- **Addressability.** `skills/fleet-lifecycle/SKILL.md:66-67` records that `SendMessage` reaches only
  directly-dispatched teammates, never agents inside a running `Workflow` — which is exactly the
  wide phases where a wrong teammate costs most. The project memory records six agents stalled in
  one run with recovery by `SendMessage` as the containment. *Teams mode does not fix this: see
  **Why fan-out is not part of this**.*
- **Visibility.** Teammates appear in the agent panel and can be read and messaged by the user
  without going through the lead. *Not pursued; nothing below depends on it.*

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
run branch, `.teammates/` as the only coordination store — is byte-identical in both modes. Since
the retarget to `SubagentStop` nothing in the plugin branches on the flag at all, so that property
holds trivially rather than by construction: what this design changes is what happens when a
teammate tries to finish, in both modes alike.

The hook runs `complete` rather than anything new because that is the verification a teammate
should have run before returning. Stated as such in the 2026-08-10 draft, that was false: nothing
in the repository invoked `complete` on any path, so there was no existing instruction to relocate.
This design adds that instruction — to the `tm-implementer` contract and to the dispatched brief —
and the hook is the backstop for a teammate that skips it. The backstop is not the same run: the
hook runs the cheap enforcement subset (`fileset`, `ownership`, `merge`), never the full gate,
because the gate's `command` checks are the project's test suite and running that inside a stop
hook makes a timeout the usual outcome.

## What was measured

The three questions this design opened with were closed by measurement against Claude Code 2.1.231
on 2026-08-13. Evidence, including method and its limits, is in
`docs/specs/2026-08-13-agent-teams-probe-findings.md`.

- **`isolation: 'worktree'` survives.** A spawned agent lands in a linked worktree — `--git-dir` is
  `.git/worktrees/agent-<hash>`, `--git-common-dir` is `.git` — locked and clean.
- **`TeammateIdle` exists in 2.1.231 but is unreachable.** It has an entry in the hook event table,
  an executor and a "prevented continuation" path, and it is gated on team context (`B_()`), which
  the environment variable does not create and an `Agent`-spawned subagent never has. With
  `TeamCreate` removed from the harness there is no way to reach it at all. Its payload carries
  `teammate_name` and `team_name`, and leaves `agent_id` / `agent_type` undefined — not the shape
  the 2026-08-10 draft resolved a task from.
- **`tm-implementer` dispatches no subagent** and declares neither `skills:` nor `mcpServers:`
  frontmatter, confirmed by inspection, so the "frontmatter is ignored for teammates" caveat does
  not bite.

## The `SubagentStop` hook

A new handler, `scripts/subagent-stop.mjs`, declared under a `SubagentStop` key with no matcher —
the event takes none. It is a Node script rather than a `hooks/` shell script because it parses
JSON on stdin and reuses `scripts/state.mjs`.

Everything in this section and its subsections is **specification**, not description: it states what
the implementation plan builds. None of it — the handler, the `locate` command, the location
records, `complete --enforcement-only`, its rejection-specific exit code, the recorded plan path —
existed in the tree this design was written against. Read every sentence below as "will", never as
"does". Where a subsection quotes `scripts/cli.mjs` line numbers, that part *is* description of the
shipped code, and it says so.

### It no-ops far more often than it acts

The hook fires for every subagent stop in every session with this plugin installed: a reviewer in
an unrelated project, this plugin's own read-only `tm-reviewer`, any subagent in a repository with
no run at all. It returns success — allowing the stop — immediately unless all of:

- `stop_hook_active` is false, and
- `cwd` is a string that resolves inside a git repository, and
- a location record exists at the address derived from that worktree — the handler recomputes the
  record's key from `cwd` and opens that one file, rather than searching for a record that names it
  — and
- the run's recorded plan path is present.

Anything else is not this plugin's business, and the handler must be cheap enough to say so — the
common case is a single `git rev-parse` in a directory that has nothing to do with a run.

### The task comes from a record the teammate writes

The payload carries `agent_id` and `agent_type`, and no task identifier. It cannot be resolved
through the checked-out branch either: the harness names the worktree branch `worktree-agent-<hash>`
itself, and `teammates/<runId>/<taskId>` exists only once the implementer creates it — so branch
resolution would miss precisely the teammate that did nothing, which is the case the hook exists
for. So this design adds a location record, addressed by the worktree it describes rather than
composed from the run and task ids: the implementer contract and the dispatched brief gain a step
running `cli.mjs locate --run <runId> --task <taskId>` as the first act after checkout, and the
handler maps `cwd` back to a task through it. A `cwd` that matches no
record is allowed to stop — and then fails the gate, which is the correct order: this hook is an
early catch, never the thing that decides.

That invocation carries no path, and the command therefore resolves two paths of its own that must
not be conflated. The **worktree** the record describes is the directory `locate` is run in — that
is the whole point of taking no path argument, and it is a statement about the command's CLI
surface, not about `state.mjs`'s `writeLocation`, which is given a worktree and phrases its
rejections as `--worktree …`. The **store** the record is filed in is `.teammates/index/` beneath
the **main** repository root, and `locate` must derive that root the way the handler derives its
own — `git rev-parse --path-format=absolute --git-common-dir` and take the parent, as **Three
arguments the hook is not given** sets out below. It must not inherit the CLI's shared default,
`flags.root ?? process.cwd()` (`scripts/cli.mjs:1258`): run inside a teammate's worktree that
files the record under *that* worktree's `.teammates/`, which is gitignored, so the directory
appears and the command exits 0 with nothing to notice. The handler then computes the same key
against the main root and finds no file. Every teammate, every run: the stop is allowed with no
check, and — as with every other way this can go inert — it looks exactly like a clean no-op.

### What it runs

`cli.mjs complete --run <runId> --task <taskId> --plan <planPath> --root <repo root>
--enforcement-only`. `complete` is per-task and computable while siblings are still working, so
nothing deadlocks — blocking on the *phase gate* would, because the gate cannot run until the phase
is finished.

**The exit codes it returns today cannot carry this decision.** As `scripts/cli.mjs` stands:

- **0** — the task passes; the run's status file is written (`cli.mjs:2819`) and the command
  returns at `cli.mjs:2821`.
- **1** — the checks passed but `status.json` is missing or does not list the task
  (`cli.mjs:2815-2817`).
- **2** — `teammates.gate.json` is present and malformed (`cli.mjs:2760`) — **or the invocation
  itself was bad.** Every argv failure exits 2 too: a missing required argument, a rejected flag
  spelling (`cli.mjs:1242`), an unknown flag, an empty `--root`, a `--run` that escapes
  `.teammates/`. So 2 means "broken manifest OR malformed invocation", and a reader taking it as a
  manifest diagnosis will misreport its own bad argv.
- **4** — no gate manifest (`cli.mjs:2761`), an underivable context, a task absent from the plan,
  **or the recomputed gate rejected this task** (`cli.mjs:2811`, printing the rejection at
  `cli.mjs:2803`, pinned by `tests/cli.test.mjs`, "complete exits 4 when the recomputed gate
  fails").

So exit 4 conflates "the gate rejected this task" with "the gate could not run", and exit 2
conflates a broken manifest with a mistyped command line. A handler built on these codes would
block on a malformed manifest or its own bad argv and allow every rejected task through — the
enforcement inert, and silently so, since the inert case looks exactly like a clean pass.

The invocation above does not parse today either: `complete` does not carry `--enforcement-only` in
its known-flag table (`cli.mjs:242`), so the command as written is refused as a bad argv — exit 2,
`complete does not take --enforcement-only` — rather than running the enforcement subset. The flag
lands with the CLI work, alongside the exit code below.

**This design therefore requires a new exit code**, added to `complete` alongside the rest of the
CLI work: a code returned for a gate rejection and for nothing else, distinct from every
"cannot verify" path. The handler blocks on that code and allows every other non-zero result. Like
the rest of this section, that is specification — `complete` has no such code today, and the
handler must not be written against the current ones.

**The handler must not read the printed text to tell the two apart.** The rejection path prints a
line beginning `gate does not pass for phase <name>: <checks>`, and matching on it would work.
Taking a programmatic decision from the shape of a line is precisely what this project refuses
everywhere else; `skills/phase-gate/SKILL.md:86-87` states the rule in as many words — "Read the exit
code, not the shape of a line" — and states it about output this same CLI prints. A *teammate*
reading its own command's output and acting on what it says is a different matter and is fine. A
hook deciding whether to block is not.

### Three arguments the hook is not given

`complete` requires `--plan`, and `deriveContext` (`scripts/gate-runner.mjs:369`) reads that plan
out of git at the run anchor (`scripts/gate-runner.mjs:378`), so it is a repo-relative path — not
something derivable from `cwd`. Nothing under `.teammates/<runId>/` records it today. `init-run`
starts recording the repo-relative plan path it was invoked with, and the hook reads it from there.

`--task` is not derivable either, and not for the same reason. The branch at the teammate's `cwd`
is `worktree-agent-<hash>`, chosen by the harness; `teammates/<runId>/<taskId>` exists only because
the implementer creates it. Resolving the task from the checked-out branch would therefore fail
exactly for a teammate that created no branch — the do-nothing case this hook exists to catch. The
task id comes instead from the location record the teammate writes at start.

`--root` must be the **main** repository root, not the teammate's worktree: run from inside the
worktree, the CLI would resolve the run branch to the task branch checked out there. The hook
derives it from `git rev-parse --path-format=absolute --git-common-dir` and takes that directory's
parent, which is the main worktree for a linked worktree and the repository itself otherwise.

### The harness bounds this, not us

The 2026-08-10 draft specified a block counter in `.teammates/<runId>/idle-blocks.json`. It is not
built, and no part of this design replaces it, because the harness already caps consecutive blocks
itself. That cap is read from `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` and defaults to 8 — established by
direct inspection of the installed 2.1.231 binary, not by the probe findings, which do not record
it. The count lives in the harness process, so unlike anything under `.teammates/` the teammate it
counts cannot reset it.

The handler this design builds additionally returns success whenever `stop_hook_active` is true,
which is the harness's own documented guidance for `Stop` and `SubagentStop` handlers. That makes
one stop cost one forced retry: the teammate is blocked once, gets the failure text, takes another
turn, and is not blocked again for the same stop. The probe findings measure exactly this sequence
— exit 2 blocked a subagent stop, forced a second turn, and the harness set `stop_hook_active` on
the re-stop.

A block hands the teammate a reason; it cannot compel a fix. In that same measurement the probe
agent read the injected stderr, acknowledged it, and returned `status: "done"` anyway. That is why
the phase gate remains the thing that decides.

### Two limits, stated in the handler

- **Any teammate can plant or overwrite the record for any worktree it can name.** The records live
  in one directory, `.teammates/index/`, each filed under the sha256 of its normalised worktree
  path. That directory is *not* under `<runId>/`: it is shared by every run in the repository,
  nothing prunes it, and it is not access-controlled — every teammate has a shell, so the `locate`
  command is one way to write a record, not the only way.

  The reader binds a record to its own address: it recomputes the key from the record's `worktree`
  field and refuses the record unless that key is the file name it was found under. That check buys
  exactly one thing and nothing beyond it — a record cannot be filed under key A while naming
  directory B. It does not stop a record being planted to answer for someone else's directory. A
  record's address *is* its worktree path, and any teammate can read a sibling's worktree path, so
  an attacker who knows the victim's path writes the file at the key of that path, naming that path
  honestly and any `runId`, `taskId` and `branch` it likes. Last writer wins, and the victim's stop
  then resolves to whatever that record says.

  Keying on the worktree alone, with nothing pruning the store, has a second consequence worth
  stating as a limit even where no attacker is involved: worktree paths are reused, so a record
  left behind by a finished run is still the answer for that directory. It does not follow that
  the next occupant is misresolved as a matter of course — the `locate` step above runs first and
  overwrites the stale record, so a teammate that follows its brief resolves to itself. The limit
  bites the teammate that skipped the step, which is exactly the teammate this hook exists to
  catch: instead of matching no record and being allowed through, it is judged against the previous
  occupant's task, in a run that has finished.

  The ref a record resolves to deserves separate statement, because the obvious half of it is
  already closed at the reader and the hazard survives that anyway. The closed half: a record's
  `branch` is returned only when it equals the conventional name built from that record's own
  `runId` and `taskId`, and drops to `null` otherwise (`scripts/state.mjs:482`). So a branch that
  disagrees with the record's own ids — `master`, or a ref belonging to a task the record does not
  name — yields no branch at all and the caller recomputes the conventional name instead. The clamp
  is about agreement, not about ownership, and the distinction matters to anyone building on it: a
  record carrying another task's ids *and* that task's ref agrees with itself, passes, and is
  returned verbatim.

  Which is the half that stays open. The conventional name is built from the ids, and the ids are
  the fields a forged record chooses freely, so a record planted under the victim's worktree naming
  another task's `runId` and `taskId` resolves to that task's ref through the honest construction
  rather than around it. Two consequences follow, according to whether that ref exists. Where it
  does, the victim is waved past on a branch it never created — the do-nothing case this entire
  design exists to catch. Where it does not, the victim is blocked and told to create a branch
  under *another task's* name and commit to it. The handler force-moves nothing itself — its
  precheck blocks only on an absent ref (`docs/plans/2026-08-13-subagent-stop-enforcement.md:507`),
  so at the moment it speaks there is no live ref to move — but the victim's compliance creates
  one, and where those commits end up depends on whether the named task ever starts.

  If it never starts, they stay, and the gate reads them as that task's: a file set and an
  ownership answer for work that task never did. If it does start, its own mandatory first step is
  `git checkout -B teammates/<runId>/<taskId> <base>`, which moves that ref off the planted commits
  and onto the base. The victim's work is then discarded, and the victim is left branchless on the
  task it was actually given and never enforced against it — every stop it makes resolves through
  the planted record to someone else's task, so its own do-nothing case goes uncaught. That
  ordering costs the victim its work and this design its catch, and it is not a consequence the
  paragraph below would otherwise reach.

  The requirement that follows lands on the remediation text rather than on the branch check, which
  is already clamped as far as a record's own contents allow: a ref derived from a record is only
  as trustworthy as the record, so the handler may name one in a diagnosis and must not direct
  anyone to create it or commit to it. A teammate told its branch is missing should be sent back to
  its own brief, which is fixed text already in its context rather than a file the handler consults
  at stop time. That contrast is about *when* the name was fixed, not about who could have written
  it: the brief's branch string is itself built from `.teammates/<runId>/plan.json` — `workflow`
  reads that record (`scripts/cli.mjs:1399`), the branch is composed from its `id`
  (`scripts/workflow-gen.mjs:60`), and it is rendered into the checkout line
  (`scripts/brief.mjs:37`) — and that file is writable by any teammate, like everything else in
  that directory. It fails closed, because the gate resolves the conventional name from the plan
  committed in git and reports a branch that does not exist, so it bounds this argument rather than
  opening a second hole.

  That requirement contradicts what the implementation plan currently prescribes — its precheck
  emits exactly such an instruction, `git checkout -B ${branch} <base>` at
  `docs/plans/2026-08-13-subagent-stop-enforcement.md:502-513` — and the contradiction is this
  requirement's doing, not a defect in the block when it was written against the earlier one.
  Reconciling the two belongs to whoever dispatches that step, before an implementer meets both and
  keeps whichever it read second.

  Consequences reachable from record forgery include, and are not limited to: a teammate leaving
  itself unenforced, so its stop is allowed with no check; a *different* teammate left unenforced,
  its record deleted or overwritten with ids no check will reject; and a teammate judged against a
  task that is not its own, because the record filed under its worktree describes someone else's
  work. Which of these a given forgery produces depends on the file it writes and on which worktree
  that file is addressed to, and this list is not offered as exhaustive — three earlier versions of
  this paragraph each named a single direction of harm and each was falsified by an attack shape it
  had not considered.

  The bound that does hold, and the only one worth resting on, is that **none of it produces a
  false gate PASS**, because the verdict is recomputed from git: `deriveContext` resolves base, run,
  anchor and plan from refs and takes no status argument, the checks receive only that context, and
  `complete` marks a task done only after recomputing.

  Files under `.teammates/` *are* read — for bookkeeping, not for verdicts. `gate` reads
  `status.json` at `cli.mjs:2722` and `complete` at `cli.mjs:2814`; earlier drafts of this
  paragraph said the gate "reads nothing under `.teammates/`", which was never true. What holds is
  that a corrupt one fails the run **closed**, not open: non-JSON in `status.json` makes `readState`
  rethrow, and `gate` reports `FAIL` with `run-state` among the failed checks and exits 1 even
  though every check passed (`cli.mjs:2727-2735`). So the damage from forgery is a wrong or missing
  early catch, or a run that stops — never a failing task recorded as passing. Tamper-evident, not
  tamper-proof, on the same footing as everything else in that directory. `scripts/state.mjs`
  states the same shape at the reader itself; the two must not drift apart.
- **It fails open.** A handler that cannot run — no `node`, a timeout, a malformed run directory —
  exits non-zero-but-not-2, which the harness treats as a non-blocking error. The teammate stops
  and the gate catches what the hook did not. The harness reinforces this from its own side: for
  `SubagentStop` an exit 2 with empty stdout whose stderr matches `no such file|can't open` is
  reported as a missing hook script and downgraded to success, so a hook pointing at nothing cannot
  wedge every agent on the machine. That downgrade, like the block cap above, comes from direct
  inspection of the 2.1.231 binary rather than from the probe findings. The failure is loud in the
  transcript rather than silent.

## Why fan-out is not part of this

The 2026-08-10 draft proposed dispatching every task of a phase as a named background `Agent` with
the flag on, and leaving the three-or-more-tasks `Workflow` threshold alone with it off. That
rationale does not survive the measurement. It rested on `Workflow` agents not being teammates —
but `Agent`-spawned agents are not teammates with the flag on either, and a direct spawn already
returns an id usable with `SendMessage`. Teams mode therefore buys no addressability the current
dispatch lacks, so the section is dropped rather than made conditional. The `Workflow` threshold in
`skills/parallel-execution/SKILL.md` is unchanged, in both modes.

## Skill changes

- **`fleet-lifecycle`** — the `SendMessage` caveat at `SKILL.md:66-67` stands exactly as written: an
  agent inside a running `Workflow` cannot receive `SendMessage` in either mode. That is why fix
  rounds address directly dispatched teammates only, and why a phase dispatched through `Workflow`
  has no live teammate to address and respawns instead.
- **`fleet-supervision`** — the agent panel shows teammates, and the digest stays authoritative.
  The panel renders harness state; `doctor` and `liveness` read git. A panel row reading "working"
  is the same class of self-report this plugin refuses everywhere else, and the skill says so.
- **`using-teammates`** — unchanged. The 2026-08-10 draft had the fleet-versus-inline preview name
  the active mode; with nothing in the plugin behaving differently with the flag on, naming it
  would imply a difference that does not exist.

`liveness` does not become redundant, and the skill must not imply it. The two cover disjoint
failures: `SubagentStop` fires when a teammate *ends a turn*, and a stalled teammate never does, so
no stop-path hook runs for it. `TeammateIdle` would not have helped here either — it is dispatched
from inside the Stop executor, at the same moment, so "idle" there means the same thing. The stall
case remains `liveness`'s alone.

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

That applies with full force to the retarget. The `SubagentStop` payload shape, the consecutive
block cap and the `B_()` team-context gate were read out of a minified binary rather than a
documented interface; they are true of 2.1.231 and of nothing else. The handler must therefore
degrade to allowing the stop whenever what it expects is absent — an unparseable payload, a missing
`cwd`, a `complete` exit it does not recognise — rather than assuming any of them will be there.
