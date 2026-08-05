# claude-teammates

A Claude Code plugin that runs a superpowers-style development process on background
teammates: worktree-isolated parallel execution, an automated per-phase gate, and
event-driven supervision.

Design: `docs/specs/2026-08-05-claude-teammates-design.md`
Plan: `docs/plans/2026-08-05-claude-teammates.md`

## Development

    npm test

Zero runtime and dev dependencies. Tests use the built-in `node:test` runner.
