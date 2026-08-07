---
name: teammates-config
description: Use when changing how the fleet runs — parallelism, model tier or effort per role, caveman output, or the project's default reviewer lens.
---

# Teammates Config

## The two-file split

`teammates.gate.json` is tracked and holds **enforcement** policy: `phases`, `lens`, `preview`,
and `agents.reviewer.tier`/`agents.reviewer.effort`. `teammates.local.json` is gitignored and
holds **ergonomics**: `maxParallel`, `caveman`, and `agents.implementer.*`/`agents.integrator.*`.
An enforcement key never goes in the local file — the CLI rejects the attempt with exit 2.

## Read before you write

Always resolve both layers together, for both roots:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" config list --root <project root>

This prints every key with the layer that currently wins it, so you know what a change would
override before proposing one.

## Collect the change interactively

Use `AskUserQuestion` twice — once for the key, once for the value, offering the permitted
values as options — then write through the CLI:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" config set <key> <value> --root <project root> --local

Drop `--local` only when the key is an enforcement key and belongs in the tracked manifest
instead; the CLI tells you which layer a key belongs to if you get it wrong.

## Never edit the files directly

This skill never writes `teammates.gate.json` or `teammates.local.json` with `Write` or `Edit`.
Every change goes through `config set` (or `config unset`), so validation has exactly one
implementation and the interactive path can never produce a file the CLI itself would reject.
