# `usage` — per-run token reporting

## Destination

A repeatable command reports where a run's tokens went, broken down by agent role, so a token
optimization is proven by measurement rather than argued from a plausible story.

## Why

The first optimization pass — the quiet test reporter — was found by an ad-hoc script over agent
transcripts, and it worked: `npm test` fell from ~40,372 tokens of output to ~126. The second
finding came the same way and is larger. Both were one-off scripts that no longer exist.

The numbers that drove both decisions:

| category | tokens (3 agents, run `fog`) |
|---|---|
| fresh input | 212 |
| cache **read** | 2,190,488 |
| cache write | 200,558 |
| output | 36,461 |

Cache reads dominate, and they scale with **turns × context**: every token in an agent's context
is re-read on each later turn. The fixed prefix — system prompt, agent definition, tool schemas,
dispatch prompt — accounted for **870,243 tokens, 40% of all cache reads**.

That number is only visible when the report separates prefix from accumulated work:

| agent | declares `tools:` | prefix | turns | prefix × turns | cache_rd |
|---|---|---|---|---|---|
| tm-reviewer (`tests`) | yes, 5 tools | 5,431 | 46 | 249,826 | 902,640 |
| tm-reviewer (`claims`) | yes, 5 tools | 6,610 | 49 | 323,890 | 1,030,266 |
| tm-integrator | **no — inherits all** | **26,957** | 11 | 296,527 | 257,582 |

The integrator looks *cheapest* by cache reads and carries a **5× larger prefix** than a reviewer
whose prompt was longer. A totals-only report hides that completely. All three agents used
exactly one tool: `Bash`.

## Where the data lives

The harness writes a durable, per-project transcript store:

    ~/.claude/projects/<project-slug>/
      <session-id>.jsonl                              the main session
      <session-id>/subagents/agent-<id>.jsonl         one per subagent
      <session-id>/subagents/agent-<id>.meta.json     { agentType, model, description, ... }

`<project-slug>` is the project's absolute path with the separators replaced by `-`. Each
transcript line is a JSON record; those carrying `message.usage` provide `input_tokens`,
`output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`. The `.meta.json`
supplies the agent's role, which is what makes a per-role breakdown possible.

**This layout is harness-internal and not a public API.** Anthropic can change it without notice.
The command therefore fails loudly when it finds nothing, naming the path it looked in and saying
the layout may have changed — never reporting zeros, because a zero reads as "no usage", which
would be a lie.

## Interface

    cli.mjs usage --root <project root> [--session <id>] [--json]

- `--root` locates the project, and the slug is derived from it.
- `--session` selects a session; omitted, the most recently modified one is used.
- `--json` emits the same data as a machine-readable object instead of the table.

Exit codes follow the CLI's existing vocabulary: `0` on success, `1` when no transcripts were
found or the store is unreadable.

## Report

    run <session-id>  (3 subagents)

    agentType                model    turns   prefix  prefix×turns  cache_rd   output
    tm-reviewer              opus        49    6,610       323,890  1,030,266   22,900
    tm-reviewer              opus        46    5,431       249,826    902,640   12,965
    tm-integrator            sonnet      11   26,957       296,527    257,582      596
    ─────────────────────────────────────────────────────────────────────────────────
    TOTAL                               106              870,243  2,190,488   36,461
    fixed prefix = 40% of all cache reads

`prefix` and `prefix × turns` are the reason this command exists rather than a totals line.
Prefix is the per-turn tax a dispatch pays before doing any work; multiplied by turns it is the
quantity a change like restricting an agent's tool set actually moves. Reporting only totals
would have hidden the finding above.

`prefix` is the **minimum** context observed across the agent's messages, not the first message's.
The minimum cannot be inflated by ordering or by a retried first turn, and the same reasoning
applied to the quiet reporter's root-summary decision: prefer the definition that cannot be
fooled.

## Error handling

- **No transcripts at the derived path** — exit 1, naming the path and stating the layout may have
  changed. Never an empty table.
- **A transcript that cannot be read or parsed** — reported as a named row with its reason, and
  counted in a trailing "N transcripts unreadable" line. Never skipped silently: a dropped agent
  understates a total, and understated totals are how an optimization appears to prove a saving it
  did not make.
- **A subagent transcript with no `.meta.json`** — reported with `agentType` shown as `(unknown)`
  rather than dropped. Its tokens were still spent.
- **A record with no `message.usage`** — ignored. Most records are not usage-bearing; this is the
  normal case, not an error.

## Testing

Fixture transcripts written into a temp directory, so no test depends on the developer's real
`~/.claude`. Behaviour pinned by mutation, as the rest of this repository does.

| test | what it pins |
|---|---|
| totals | the four categories sum across all records of an agent |
| prefix | the minimum observed context, not the first message's |
| per-role grouping | `agentType` comes from `.meta.json` |
| missing meta | reported as `(unknown)`, not dropped |
| unreadable transcript | named and counted, not skipped |
| no transcripts | exit 1 naming the path, not an empty table |
| `--json` | carries the same numbers as the table |

The unreadable-transcript test matters most: silently skipping is the failure mode that makes
this tool lie in the direction its author would like.

## Out of Scope

- Cost estimates in currency — rates change and differ per tier and per cache state, so the
  command reports tokens and leaves rates to the reader.
- Any hook change — this is a read-only analysis over files the harness already writes, and
  recording usage at SubagentStop would couple the plugin to a payload shape it does not control.
- Attributing usage to a `.teammates/<run>` id — the transcript store is keyed by session, not by
  run, and inventing a mapping would be guesswork this command cannot verify.
- Restricting any agent's tool set — that is the change this command exists to measure, and
  shipping both together would leave the saving unproven.

## Not Yet Specified

- Should `usage` report the main session alongside its subagents, or is the orchestrator's own
  context a separate question?
- What is the right way to compare two runs — does this command grow a diff mode, or does the
  reader keep the numbers?
