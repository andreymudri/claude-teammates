# Plugin configuration

Status: approved, not yet planned
Date: 2026-08-07

## Problem

The plugin has exactly one configuration surface, `teammates.gate.json`, and it mixes two
unrelated concerns. Enforcement policy (which checks run, what blocks, how many fix rounds)
belongs to the project and must be reviewable. Ergonomics (how many teammates run at once,
which model tier each role gets, how verbose the output is) belongs to the machine and the
operator, and committing it forces one person's choice on everyone.

`maxParallel` is the visible symptom: `teammates.gate.json:2` pins `6` for every clone of this
repository, while `defaultMaxParallel()` (`scripts/gate-config.mjs:9`) exists precisely because
the right value is `min(8, cores - 2)` on the machine actually running.

Three further gaps:

- A reviewer lens set is repeated inside every `agent` check; there is no project-level default.
- Model tier and reasoning effort per agent role cannot be expressed at all. `templates/phase-workflow.js:84`
  passes a per-task `model` and nothing else; `effort` is never passed anywhere.
- There is no command for changing any of this. Every change is a hand edit of JSON with no
  validation, and a typo surfaces as a confusing runtime failure rather than an error.

## Non-goals

Three things were considered and deliberately excluded.

**Configurable worktree root.** `.claude/worktrees/` is created by the Claude Code harness when a
dispatch passes `isolation: 'worktree'`. This plugin never runs `git worktree add`; it only
recognises the path so ownership checks skip it (`scripts/git.mjs:6`). The knob cannot exist here
because the directory is not ours.

**Configurable `stateDir`.** `.teammates/` is hardcoded in `scripts/state.mjs:7` and feeds the
`assertContained()` path-containment guards at `scripts/cli.mjs:341,343`. Making it configurable
adds attacker-influenced input to the exact code whose job is preventing path escape, in exchange
for no named use case.

**Configurable ownership-ignore patterns.** Same shape of trade: a wide pattern blinds the
ownership check, and the hardcoded `/^\.claude\//` has not caused a problem.

## Threat model

`SECURITY.md:6` states the property the design rests on: the phase gate is **tamper-evident, not
tamper-proof**. A teammate editing `teammates.gate.json` is already documented as out of scope
(`SECURITY.md:19`) — but it is out of scope *because it leaves evidence*. The manifest is tracked,
so editing it dirties the worktree, and the `fileset` and `ownership` checks catch that. The
behaviour is pinned at `tests/adversarial.test.mjs:745`.

A gitignored configuration file has no such evidence. Anything it can change, a teammate can
change silently. Therefore the split between the two files is by trust class, not by convenience:

- **Enforcement keys** decide verdicts. Tracked file only. Their appearance in the local file is
  an error.
- **Ergonomics keys** cannot change a verdict. Either file; local wins.

This preserves tamper-evidence exactly as documented. No existing claim in `SECURITY.md` needs
rewording.

## Design

### Layer 1 — `teammates.gate.json` (tracked, enforcement)

Every current key keeps its current meaning. One key is added:

- `lens: string[]` — top-level. Default lens set for any check of kind `agent` that does not
  declare its own `lens`. Absent, the existing per-check behaviour is unchanged.

Enforcement keys, which may appear **only** here: `phases.*.checks`, `phases.*.fixRounds`,
`blockOn` (within a check), `lens`, `preview.link`.

### Layer 2 — `teammates.local.json` (gitignored, ergonomics)

Allowlisted keys, and nothing else:

| Key | Domain | Default |
|---|---|---|
| `maxParallel` | integer >= 1 | `min(8, cores - 2)` |
| `caveman` | `false \| "lite" \| "full" \| "ultra"` | `false` |
| `agents.<role>.tier` | `"cheap" \| "mid" \| "capable"` | unset — routing infers per task |
| `agents.<role>.effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | unset — inherits session |

`<role>` is one of `implementer`, `reviewer`, `integrator`.

`caveman` reuses the vocabulary of the `caveman:caveman` skill rather than inventing levels, so
the value passed through to a teammate means there what it means here.

An unknown key in this file, or an enforcement key in this file, is a hard error naming the
offending key. Silently ignoring it would let an operator believe a setting took effect when it
did not — which for an enforcement key is the exact failure the trust split exists to prevent.

### Model tiers, not model names

`scripts/cli.mjs:429-431` records a deliberate invariant: concrete model names never enter this
repository or `teammates.gate.json`. They live in the dispatching skill, which passes a tier map
through `--models`. Naming a model in config would break that and go stale.

So configuration stores a **tier** from `TIERS` (`scripts/routing.mjs:2`). Resolution at dispatch:

    agents.reviewer.tier = "capable"
    --models '{"capable": "<name>"}'
    -> agent(..., { model: "<name>", effort: <agents.reviewer.effort> })

A configured role tier overrides what `inferTier()` would have chosen for that role; `escalateTier()`
on retry continues to apply on top of the resulting tier.

`effort` is new plumbing: `templates/phase-workflow.js` currently spreads only `model`, and the
reviewer and integrator dispatches are prose in `skills/phase-gate/SKILL.md` and
`skills/parallel-execution/SKILL.md`. Both paths must carry it, or the value is advisory and the
config lies about what it does.

### Resolution — `scripts/config.mjs` (new)

    loadConfig(root) -> { resolved, sources }

`resolved` is the merged view. `sources[key]` names the layer that won, so `config list` can show
provenance rather than a bare value. Precedence for ergonomics keys is local > gate > default;
enforcement keys have no local layer to consider.

`gate-config.mjs` keeps every export it has today with unchanged behaviour. The new module layers
over it. Two call sites move onto the resolved view:

- `scripts/cli.mjs:386` and `scripts/cli.mjs:518` — `maxParallel`
- `checksForPhase()` — fills a missing per-check `lens` from the top-level `lens`

Validation is per key: type, then domain. A value outside its domain exits 2 with the key name and
the permitted values.

### CLI

    cli.mjs config list            --root <p>
    cli.mjs config get   <key>     --root <p>
    cli.mjs config set   <key> <v> --root <p> [--local]
    cli.mjs config unset <key>     --root <p> [--local]

Keys are dotted paths (`agents.reviewer.tier`). Values are parsed as JSON, falling back to a bare
string so `config set agents.reviewer.tier capable` works without quoting.

`--local` targets `teammates.local.json`; without it the target is `teammates.gate.json`.

`config set --local` also ensures `teammates.local.json` is listed in `.gitignore`, appending it if
absent and reporting that it did. Without this the local file is committed on the first run and the
trust split silently inverts — the gitignored ergonomics layer becomes a tracked file that a
reviewer now has to police.

Exit codes: `0` success; `2` unknown key, invalid value, or an enforcement key with `--local`.

### Slash wrapper — `skills/teammates-config/`

A skill that reads current state through `config list`, collects a key and value through
`AskUserQuestion`, and writes through `config set`. It never edits JSON directly, so validation
has one implementation and the interactive path cannot produce a file the CLI would reject.

### Caveman mode

Four surfaces, all gated on the resolved `caveman` level.

1. **CLI output.** `scripts/digest.mjs` gains a terse renderer for gate verdicts and findings.
   Formatting only; no verdict changes.
2. **Agent briefs.** `scripts/workflow-gen.mjs` passes the level into
   `templates/phase-workflow.js`, which selects a compressed brief variant.
3. **Response style.** The brief gains a directive that `summary` and `blockers` be written in
   caveman. Affects what the operator reads at the gate, not what the teammate does.
4. **Skill proxy.** The brief carries an instruction to use `caveman:caveman` at the configured
   level. That skill is a separately installed user plugin and may be absent in the teammate's
   environment, so the wording is conditional and its absence is not an error.

Surface 2 is the risk. A brief is the task specification, and compressing it can drop load-bearing
wording. The compressed variant therefore keeps **verbatim**:

- the entire MANDATORY FIRST STEP block, including the literal `git checkout -B <branch> <base>`
  and `git log --oneline -1` lines and the blocked-status instruction
- the BASELINE numbered steps
- the FILES list and the sentence stating that touching another file fails the gate
- the global constraints list

Only connective prose between those blocks compresses. A test asserts each of those substrings is
still present when caveman is on.

## Testing

- `tests/config.test.mjs` — layer precedence; unknown key rejected; enforcement key in the local
  file rejected by name; each validation domain; dotted get and set; `.gitignore` append, including
  the case where the entry already exists.
- `tests/cli.test.mjs` — `config` subcommand exit codes, including `set --local` on an enforcement
  key exiting 2.
- `tests/workflow-gen.test.mjs` — with caveman on, the generated brief still contains every
  verbatim clause listed above.
- `tests/adversarial.test.mjs` — a hostile `teammates.local.json` declaring `checks`, `blockOn` or
  `fixRounds` neither changes a verdict nor is silently ignored.

## Documentation

- `README.md` — a configuration section covering both files and the `config` subcommand.
- `SECURITY.md` — a line recording that the local layer is ergonomics-only by construction, so a
  report of "the gitignored config can be edited by a teammate" has a written answer.
