---
name: teammates-config
description: Use when changing how the fleet runs — parallelism, or model tier or effort per role.
---

# Teammates Config

## What `config` covers, and what it does not

`config` manages the **ergonomics** keys only: `maxParallel`, `caveman`, and
`agents.<role>.tier`/`agents.<role>.effort`. Those are the only keys `config set`/`config unset`
accept, in either layer, subject to the enforcement rule below.

`teammates.gate.json` is tracked and can also hold the **enforcement** keys `phases`, `lens`, and
`preview`. Those are edited by hand, deliberately: enforcement policy is meant to land as a
reviewable diff in a tracked file, not as a CLI mutation. `config set lens ...`,
`config set phases ...`, and `config set preview ...` all fail with `unknown config key: <key>`
and exit 2 — this skill never attempts them. Neither does `config get`: it routes through the same
key allowlist as `set`, so `config get lens` (or `phases`/`preview`) also exits 2 with
`unknown config key: <key>`. Never reach for `config get` to check a hand edit to one of these
three keys — read the file, or use `config list` as described below, which is a real but partial
check.

`teammates.local.json` is gitignored and holds only the ergonomics keys. An enforcement key never
goes in the local file — the CLI rejects the attempt by name with exit 2, even if a caller reaches
for it through `agents.reviewer.*`: the reviewer produces the verdict for `agent`-kind checks, so
its tier and effort are enforcement, not ergonomics, and are rejected from the local layer for the
same reason `phases`, `lens`, and `preview` are.

## What `caveman` actually reaches

Measured 2026-08-25 against real subagent transcripts. `caveman` is a much narrower knob than its
position beside `maxParallel` suggests, and the measurement contradicts the name, so state its
scope rather than letting an operator infer it.

`caveman` has exactly two consumers: it rewrites the **implementer** brief, and it renders the
local `digest` output terse. Reviewer and integrator dispatches carry no caveman path at all, so the
reviewers — the largest emitters in a run — are unaffected by any value you set.

Within the implementer brief its instruction is scoped to the returned summary and blockers, not
to intermediate turns. That summary is the last message an agent emits, so it is re-read zero
times by the agent that wrote it.

The caveman brief is **larger** than the default, by about 3%. Compressing the connective prose
saves less than the added STYLE block costs, and a brief sits in the agent's prefix, so that cost
is re-read on every turn.

The four levels are validated but not honoured by this plugin's own code: `digest` reads only
whether the value is truthy, and the brief passes the level through to an external
`caveman:caveman` skill, telling the agent to apply the style directly when that skill is absent.

Reach for `agents.<role>.effort` instead when a run's output cost is the problem. Thinking is
72-76% of an agent's output tokens, `effort` is the control for thinking, and no style
instruction can touch it. Lowering it is a real quality trade-off, so raise it with the operator
rather than setting it quietly.

## Read before you write

Always resolve both layers together, for both roots:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" config list --root <project root>

This prints every ergonomics key with the layer that currently wins it, so you know what a
change would override before proposing one. It never prints `phases`, `lens`, or `preview` —
read those straight out of `teammates.gate.json`.

Even though it doesn't print them, `config list` still parses and validates the whole tracked
manifest, including the **shape** of these three keys — a malformed one, such as `lens` written
as a bare string instead of a non-empty array of strings, makes `config list` itself exit
non-zero naming the key. That makes it a real verification step after a hand edit, but only a
partial one: a well-shaped value passes silently, and shape is all it checks. `config list`
says nothing about whether the values are meaningful — a `lens` of `["nonsense"]` is well-shaped
and is accepted; whether those names are real reviewer lenses is only exercised the next time
`gate` dispatches reviewers.

## Collect the change interactively

For an ergonomics key, use `AskUserQuestion` twice — once for the key, once for the value,
offering the permitted values as options — then write through the CLI:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" config set <key> <value> --root <project root> --local

Drop `--local` only when the key should be a tracked default rather than a personal override; the
CLI still accepts ergonomics keys in `teammates.gate.json` and reports which layer rejected the
write if you get it wrong.

If the requested change is to `phases`, `lens`, or `preview`, this skill does not write it. Tell
the user it is an enforcement key, point them at `teammates.gate.json`, and let them (or a
follow-up edit they approve) change it there directly — then confirm with `config list`, which
catches a malformed shape but not a meaningless-but-valid value. Never confirm with `config get`:
it exits 2 with `unknown config key` for all three, which looks like the edit was rejected and
is not.

## Never hand-edit a key `config set` accepts

This skill never uses `Write` or `Edit` on `teammates.gate.json` or `teammates.local.json` for a
key `config set`/`config unset` accepts. Every such change goes through the CLI, so validation
has exactly one implementation and the interactive path can never produce a file the CLI itself
would reject. The one deliberate exception is the enforcement keys above, which `config` cannot
write at all — those are hand-edited by design, not because this skill's rule was skipped.
