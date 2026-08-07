# claude-teammates

A Claude Code plugin that runs a written plan across background teammates, each in its own git
worktree, with an automated gate between phases.

You write a plan. The plugin splits it into phases of tasks whose file sets don't overlap,
dispatches one teammate per task, and refuses to move to the next phase until a gate — computed
from git, not from anything an agent reported — says the phase is clean.

```
phase 1   T1  T2  T3        3 worktrees, in parallel
  gate    merge · test · fileset · ownership · review
phase 2   T4
  gate    ...
          -> merged to the run branch
```

## Requirements

- Claude Code
- Node.js >= 24.2.0
- A git repository — worktree isolation depends on it

Zero runtime and zero dev dependencies. Tests use the built-in `node:test` runner.

## Install

    /plugin marketplace add andreymudri/claude-teammates
    /plugin install claude-teammates

To develop against a local checkout instead, point the marketplace at the directory — skill
edits then take effect on the next session without a push:

    /plugin marketplace add /path/to/claude-teammates
    /plugin install claude-teammates

## Getting started

Say what you want built. The `using-teammates` skill routes you: an unclear idea goes to
`brainstorming`, settled requirements go to `writing-plans`, and a written plan with three or
more disjoint tasks offers you a fleet.

A fleet is worth it when tasks genuinely don't overlap. For a two-task change, running it inline
in one session costs less than orchestrating it — the plugin will say so rather than fan out
regardless.

## What the phase gate guarantees

The gate merges the phase's task branches into a scratch worktree and runs its checks there, so
`test` measures what integration will actually produce. It also checks that each teammate's
**committed** changes stayed inside the files its task declared, and that every commit on the run
branch is explained by a task branch or by the base. It computes all of this from git each time
it runs, and trusts nothing an agent wrote — `.teammates/` state is written by the very agents
the gate exists to enforce, so no check reads it.

**It is tamper-evident, not tamper-proof.** A teammate runs its own tests, and running a
teammate's code is arbitrary execution — so a determined one can do anything you can. The gate
catches drift and mistakes reliably. It is not a security boundary, and nothing here should be
relied on as one. `docs/specs/2026-08-05-tamper-evident-enforcement-design.md` lists exactly
what is out of scope, and `tests/adversarial.test.mjs` pins each limit with a test.

## Skills

- `using-teammates` — entrypoint; routes to the right process or fleet skill before anything else happens
- `brainstorming` — explores intent and design before implementation
- `writing-plans` — turns a spec into a plan this plugin can parse, phase, and dispatch to a fleet
- `executing-plans` — executes a written plan inline in this session, with checkpoints
- `parallel-execution` — splits a plan into phases and dispatches worktree-isolated implementers
- `fleet-lifecycle` — spawns, lists, messages, scales, stops, or resumes background teammates
- `fleet-supervision` — renders the fleet digest and surfaces blocked or failed teammates
- `phase-gate` — runs command, agent, and MCP checks and decides PASS or FAIL for a finished phase
- `test-driven-development` — write the failing test first and watch it fail for the right reason
- `systematic-debugging` — reproduce and isolate before changing anything
- `receiving-code-review` — verify feedback technically rather than agreeing performatively
- `finishing-a-development-branch` — re-runs the gate to verify each phase, then decides how the run branch lands
- `writing-skills` — creating, editing, and verifying skills before deployment

## Gate manifest

Copy `teammates.gate.json` into any project the fleet runs in, or let
`node scripts/cli.mjs gate --run <id>` infer one from `package.json` and print it for you to
confirm. A project whose test runner is itself a dependency should declare what to link into the
preview:

```json
{ "preview": { "link": ["node_modules"] } }
```

The preview contains tracked content only, so without that a command check runs against a tree
with no dependencies installed and fails for a reason that has nothing to do with the code.

## Layout

- `skills/` — process and human interaction (entrypoint: `using-teammates`)
- `agents/` — `tm-implementer`, `tm-reviewer`, `tm-integrator`
- `scripts/` — deterministic logic, driven via `scripts/cli.mjs`
- `templates/` — generated Workflow source
- `hooks/` — SessionStart context injection
- `teammates.gate.json` — this plugin's own phase gate

## Development

    npm test

Design notes: `docs/specs/`.

## License

MIT — see `LICENSE`.

Some skills are adapted from [superpowers](https://github.com/obra/superpowers) (© Jesse Vincent,
MIT). See `NOTICE.md` for what was adapted and `LICENSE-THIRD-PARTY` for the license text.
