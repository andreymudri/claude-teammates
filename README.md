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

## Configuration

Two files, split by trust rather than by topic.

**`teammates.gate.json`** is tracked. Alongside the manifest above it holds every key that can
change a verdict: `phases` (the checks and their fix-round budgets), `lens`, `preview`, and
`agents.reviewer.tier` / `agents.reviewer.effort`. Those go here and nowhere else — see
`SECURITY.md` for why the reviewer's tier counts as enforcement.

**`teammates.local.json`** is gitignored and holds machine-local ergonomics. Allowlisted keys,
and nothing else:

| Key | Domain | Default |
|---|---|---|
| `maxParallel` | integer >= 1 | `max(1, min(8, cores - 2))` |
| `caveman` | `false \| "lite" \| "full" \| "ultra"` | `false` |
| `agents.<role>.tier` | `"cheap" \| "mid" \| "capable"` | unset — see below |
| `agents.<role>.effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | unset — inherits the session's |

`<role>` is `implementer` or `integrator` in the local file; `reviewer` is accepted only in the
tracked manifest. An unknown key, or an enforcement key in the local file, is a hard error naming
the key — a setting that was silently dropped is a setting you believe took effect.

An unset tier resolves differently per role, so "default" is not one answer. The **implementer**
tier is inferred per task by `init-run` from the plan; a configured value overrides that
inference for every task. The **reviewer** and **integrator** are not in the plan and are not
inferred: the dispatching skill fixes them at `capable` and `mid`, and a configured tier replaces
that fixed choice.

### The four subcommands manage ergonomics, not enforcement

    node scripts/cli.mjs config list
    node scripts/cli.mjs config get maxParallel
    node scripts/cli.mjs config set <key> <value> [--local]
    node scripts/cli.mjs config unset <key> [--local]

`get`, `set` and `unset` accept only the four ergonomics keys in the table above. They do **not**
accept `phases`, `lens` or `preview` in either file — including without `--local`:

    $ node scripts/cli.mjs config set lens correctness
    unknown config key: lens        # exit 2

That is deliberate, not a gap. Enforcement policy is edited **by hand** in
`teammates.gate.json` so it lands as a reviewable diff rather than as a CLI mutation that leaves
nothing to read. The consequence is that a hand edit gets none of `config set`'s validation, so
run `config list` afterwards: it re-reads and validates both layers and exits 2 with a message if
the file is no longer valid JSON or an ergonomics key is malformed. The enforcement keys' own
content is exercised by the next `gate` run.

`list` reads both layers; `set` and `unset` write the tracked manifest unless you pass `--local`.

Worked example — raise the fan-out on a large machine without committing that choice:

    $ node scripts/cli.mjs config set maxParallel 12 --local
    wrote teammates.local.json

    $ node scripts/cli.mjs config list
    maxParallel  12  (teammates.local.json)
    caveman      false  (default)
    agents.implementer.tier    -  (default)
    agents.implementer.effort  -  (default)
    agents.reviewer.tier    -  (default)
    agents.reviewer.effort  -  (default)
    agents.integrator.tier    -  (default)
    agents.integrator.effort  -  (default)

In a project whose `.gitignore` does not yet exclude the file, `config set --local` adds the
entry and reports `added teammates.local.json to .gitignore` on a second line. This repository
already carries that entry, so the transcript above is what you get here.

`config list` prints the layer each value came from, so a value you did not expect can be traced
to the file that set it.

**Model names never appear in either file.** Configuration stores a *tier* — `cheap`, `mid` or
`capable`. The map from tier to a concrete model lives in the dispatching skill and reaches the
CLI through `workflow --models`, so this repository and `teammates.gate.json` stay free of model
names that would otherwise go stale. Setting a model name as a tier is rejected.

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
