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

- **agent** — dispatch one `tm-reviewer` per lens in parallel over the phase diff, **without a
  `name`**. A named reviewer becomes an addressable teammate that goes idle without emitting its
  result, and the review is lost; unnamed reviewers return normally. Six consecutive named
  dispatches were lost this way in run `preview` before the pattern was identified. Each dispatch
  carries the configured reviewer tier and effort, read with
  `config get agents.reviewer.tier` and `config get agents.reviewer.effort`. `config get` on an
  unset key exits 2 with `unset: <key>` — the same exit code every hard config failure uses, but
  here it is the normal case, not an error. The two keys fall back differently, and treating them
  alike is how a reviewer ends up judging below its guaranteed tier:
    - `unset: agents.reviewer.tier` — dispatch at the **fixed reviewer tier, `capable`** (model
      `opus`, per the tier→model map in `parallel-execution` — remap there and this line follows).
      Never omit the model to inherit the session's: in a `mid` session that would have
      the reviewer grading every `agent` check a full tier below what this skill guarantees. A
      configured tier replaces `capable`; nothing else does.
    - `unset: agents.reviewer.effort` — omit the `effort` option, and the dispatch inherits the
      session's effort. Only effort falls back this way.

  Both come from the tracked manifest only — the reviewer grades the diff, so
  letting the gitignored layer choose its tier would let the party being judged pick its own
  judge. Then take every finding at a `blockOn` severity and
  dispatch a second reviewer prompted to **refute** it. Only findings that survive refutation
  block the gate.
- **mcp** — call the declared tool and compare against `passWhen`. If the server is not
  connected and the check is `optional`, record `skip` and say so out loud. A missing optional
  server is never a silent pass.

Then hand those results back and let the CLI recompute:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" gate --run <runId> --plan <planPath> --root <project root> --results <path>

The file is `{ "results": [ { "name": "review", "kind": "agent", "status": "pass", "findings": [] } ] }`.
Only `agent` and `mcp` checks may be supplied; a `command`, `fileset`, or `ownership` entry is
rejected, because those are computed and supplying one would be a way to hand the gate a passing
enforcement check. The verdict is recomputed from the merged set, so a recorded PASS is always
CLI-computed — never hand-written into `status.json`.

## What the `merge` check does

Before the `command` checks run, the gate merges the phase's task branches into a scratch
worktree under the system temp directory and runs those checks there. So `test` measures what
integration will actually produce, not the run branch as it stands.

The preview contains **tracked content only** — `git worktree add` does not materialize
`node_modules`, virtualenvs, or generated artifacts. A project whose test runner is itself a
dependency declares what to link:

    { "preview": { "link": ["node_modules"] } }

The gate symlinks each declared directory into the preview after the merge and removes the links
before the worktree. Entries must be repo-relative and inside the repository; an absolute path, a
`..` escape, a missing target, or a path the repository already tracks fails the `merge` check
naming the entry and the reason. A link that cannot be made is reported as a merge failure rather
than left to surface as a command-check failure, because a preview missing its build inputs
produces errors that look like code defects and are not.

**Links are shared, not copies.** A check that writes into `node_modules` writes to the real one,
because it is the same directory. That is the cost of linking; copying a real dependency tree is
minutes per gate run.

`--no-fleet` builds no preview, so nothing is linked and `preview.link` is not consulted.

A conflict fails the `merge` check and names both branches and the conflicting paths. The
`command` checks are then recorded `skip` — never `pass`. Treat a conflict like a process
violation: escalate it, do not retry. No single teammate can fix a conflict between two file
sets, so redispatching one owner cannot resolve it.

The preview is a preview. `tm-integrator` still performs the real merge with `--no-ff`, and a
passing preview is not permission to skip it.

## On FAIL

Ask the CLI for a fix decision before asking the user. Hand it the run, the failing phase, the
run root, and the verdict JSON you just produced; it prints one of three decisions — `none`,
`retry`, or `escalate` — and exits 0 for all three, so read the `decision` field rather than the
exit status.

The exact invocation and that exit-0-for-all-three contract are specified by the task that adds
the decision subcommand — plan task T8, phase 2 — and are documented alongside it once it lands.
Until then the command is not there to run: **pending, not missing.**

**The verdict you hand it must be the JSON this gate printed in this same pass, and must never be
read back from `.teammates/`.** The only verdict persisted on disk lives in
`status.gates[<phase>]` inside `.teammates/<run>/status.json`, written by the very agents this
gate exists to enforce — the same file `scripts/enforce.mjs` refuses to consult when picking a
branch. Feeding that record in today degenerates harmlessly, because the persisted object carries
no `results` key and the decision comes back `none`; that is incidental, not guaranteed. Treat it
as a rule so a change that starts persisting `results` cannot quietly turn the on-disk record into
a decision input.

On `none`, the decision engine found no failing check in the verdict you handed it. **This does
not mean "the failure needs no fix" and it is never permission to integrate.** You reached this
section because the gate failed, so a `none` decision means the verdict you passed is not the
one that failed — a stale file, the wrong phase, the wrong run root, or a verdict written before
the last check completed. Re-derive the verdict by running the gate again from scratch and ask
again. Integrate only on a freshly recomputed PASS, never on `none`.

On `retry`, redispatch each listed task at the listed `tier`, resuming the same teammate so it
keeps its task context, and hand it the failing check names and the surviving findings. Then run
the gate again from scratch — never reuse the previous verdict, and never re-run only the
failing check.

A retried teammate that returns `blocked` ends the loop immediately. `blocked` means missing
input, and further rounds cannot supply it.

On `escalate`, halt before integration and report, in this order: the escalation reason, which
check failed, the exact command output or finding list, the offending diff hunks, the owning
teammate, and the round history — which tier ran each round and what failed each time. Then
offer three choices: retry the failing task with the findings fed back, override and proceed,
or abort the phase.

A PASS reached after N fix rounds is reported as such, never as a clean first-pass PASS.

**The round budget is a cost bound, not a security bound.** `fixRounds` lives in `status.json`,
which is written by the agents the gate enforces. A teammate that rewrites its own count buys
itself more retries — wasted tokens, not a false PASS, because the verdict is recomputed from
git every round. Do not describe the loop as tamper-evident; only `fileset` and `ownership`
carry that property.

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
