# claude-teammates

A Claude Code plugin that runs a superpowers-style development process on background
teammates: worktree-isolated parallel execution, an automated per-phase gate, and
event-driven supervision.

Design: `docs/specs/2026-08-05-claude-teammates-design.md`
Plan: `docs/plans/2026-08-05-claude-teammates.md`

## Development

    npm test

Zero runtime and dev dependencies. Tests use the built-in `node:test` runner.

## Install

    /plugin marketplace add C:\projetos\claude-teammates
    /plugin install claude-teammates

Installing from a local path means skill edits take effect on the next session
without a push.

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
- `finishing-a-development-branch` — verifies recorded gate verdicts, then decides how the run branch lands
- `writing-skills` — creating, editing, and verifying skills before deployment

## Layout

- `skills/` — process and human interaction (entrypoint: `using-teammates`)
- `agents/` — `tm-implementer`, `tm-reviewer`, `tm-integrator`
- `scripts/` — deterministic logic, driven via `scripts/cli.mjs`
- `templates/` — generated Workflow source
- `teammates.gate.json` — this plugin's own phase gate

## Gate manifest

Copy `teammates.gate.json` into any project the fleet runs in, or let
`node scripts/cli.mjs gate --run <id>` infer one from `package.json` and confirm it.
