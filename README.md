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

    /plugin install claude-teammates

Or point Claude Code at this repo as a local plugin.

## Layout

- `skills/` — process and human interaction (entrypoint: `using-teammates`)
- `agents/` — `tm-implementer`, `tm-reviewer`, `tm-integrator`
- `scripts/` — deterministic logic, driven via `scripts/cli.mjs`
- `templates/` — generated Workflow source
- `teammates.gate.json` — this plugin's own phase gate

## Gate manifest

Copy `teammates.gate.json` into any project the fleet runs in, or let
`node scripts/cli.mjs gate --run <id>` infer one from `package.json` and confirm it.
