# Inline review findings — 2026-08-25

The first reviewer pass over the work that landed on `master` **inline, with no gate**: the range
`95a4b03..6a9edff`, 40 commits, +2792/−63. Run `fog` itself was properly gated — all four phases
carry a recorded PASS with 16 findings files behind them. What had never been reviewed by anyone
is everything after the fog merge, which includes the two runs `quiet` and `usage`: both were
`init-run`'d with real plans and then never executed as fleets, so `scripts/usage.mjs`,
`scripts/usage-store.mjs` and `scripts/quiet-reporter.mjs` reached `master` unread.

Four `tm-reviewer` lenses at the fixed `capable` tier (`agents.reviewer.tier` and
`agents.reviewer.effort` both unset), then a refutation reviewer against every `high`.

    verdict PASS — test pass, review pass (0 surviving high), after one fix round
    recorded in .teammates/usage/status.json under `solo:default`
    findings in .teammates/inline-review/reviews/

**Post-refutation tally: 1 high, 11 medium, 10 low.** Five are fixed — the high, three mediums
and one low, each in its own section below. The remaining 17 are recorded rather than fixed, and
nothing in this document is closed by having been written down.

## Fixed

### `scripts/usage-store.mjs:67` — non-recursive store walk (high, survived refutation)

`readdir` on `subagents/` did not recurse. A session whose transcripts live under
`subagents/workflows/<wf-id>/` matched no `.jsonl`, and the command reported `(0 subagents)`, a
zeros table, and **exit 0** — the empty report the module header at `usage-store.mjs:8-10` forbids
and `cli.mjs:3006-3008` independently restates ("a table of zeros reads as *this run cost
nothing*"). Against the real store that concealed 5 transcripts and **31,394,783 cache reads**.

The refutation pass attacked it on four axes and two backfired:

- **Prevalence.** The nesting key is the workflow id — `subagents/workflows/wf_204b1468-a0d`
  against `workflows/wf_204b1468-a0d.json`. The only session with a nested store is the only
  session that ran a workflow; all six flat stores never ran one. Conditional prevalence 1/1, and
  this repo ships `scripts/workflow-gen.mjs`.
- **"Maybe zero is a legitimate output."** It is not. A session that genuinely dispatched no
  subagents has no `subagents/` directory at all, so it throws `missing()` and exits 1. The
  all-zeros table is unreachable except through this bug, so **every all-zeros table the tool could
  emit was a false one**.

Fixed in `3c55f07` with two reproducing tests. Recursing also reached a workflow's `journal.jsonl`
— valid JSONL carrying no usage, so it parsed cleanly into a phantom `(unknown)` row of zeros for
an agent that never ran; the filter now also requires the documented `agent-` basename.

### `scripts/usage-store.mjs:79` — all-or-nothing transcript parse (medium)

`body.split('\n').map(JSON.parse)` sat in one `try`, so **one torn last line** sent every record
in the file to `unreadable` — and a transcript is appended to while its session runs, so reading
one during a live fleet run (exactly when an operator reports on it) catches a half-written line.
A fixture lost 1.7M cache reads while the headline still read `fixed prefix = 100% of all cache
reads`, computed from what survived.

Now parsed per line: the bad line is dropped and counted, the records before it are kept. Fixing
it also closed **`usage-store.mjs:83`** (medium, security lens) — the reason string is now built
from a line count instead of the `JSON.parse` message, which quoted the offending source text back
and so put the operator's real conversation content into a printed report.

`renderUsage` counts the two cases apart, because a transcript that lost one line still
contributed its row, and filing that under "unreadable" states the opposite of what happened in
the one line a reader takes the totals' trustworthiness from.

### `HANDOFF.md:97` — the caveman readers (low)

"read only by `composeBrief`, called only from `workflow-gen.mjs`" was false in both halves:
`renderDigest` (`digest.mjs:45`) also reads `caveman`, and `cli.mjs:2153` is a second
`composeBrief` call site. Corrected in place, with the original quoted so the correction is
auditable.

**The conclusion survives.** Both `composeBrief` call sites produce implementer briefs, and
`renderDigest` shortens the digest this CLI prints to the operator — it reaches no agent output at
all. The argument rests on `review-gen.mjs` having no caveman path, which is verified and holds.

### `tests/usage-store.test.mjs:131` — `newestSession` was unpinned (medium)

Every fixture carried exactly one session, so neither half of the selection rule could be tested:
inverting the sort to pick the **oldest** session, or dropping the `Math.max(own, store.mtimeMs)`
rule the source comment defends at length, both left the suite green. That rule *is* the v1.1.2
fix, so the fix had no regression guard at all.

Three tests now, over a fixture that stamps the session directory and its store independently —
the only way to tell the two halves apart. Each mutation is killed, and by exactly one test:

| mutation | killed by |
|---|---|
| `sort((a, b) => a.mtime - b.mtime)` (pick oldest) | the newest session is chosen, not the oldest |
| `mtime: own` (directory only) | a session whose store is newer wins |
| `mtime: store.mtimeMs` (store only) | a session whose directory is newer wins |

## Open — `usage`, the largest unreviewed surface

| sev | site | finding |
|---|---|---|
| medium | `usage-store.mjs:63` | `--session` is joined into the store path with no filename-component validation. `--session '../../../outside'` walked out of the projects directory and read `.jsonl` files elsewhere on disk, disclosing the first bytes of one in an error message. `reviewFileName` (`scripts/reviews.mjs:86-93`) is the validator this repo already has for exactly this shape; `--session` got no equivalent. Also reachable with no flag at all, since `newestSession` returns a directory name that is re-joined. |
| low | `cli.mjs:3021`, `usage.mjs:53`, `:75`, `:104` | The **only** render module in `scripts/` with zero `printable()` references (doctor 9, digest 9, liveness 3, plan-drift 5, finish 14). `fit()` pads by `String.length` and neutralises nothing, and **a literal newline needs no escape sequence at all** — a three-file fixture printed three fully forged lines with zero `0x1B` bytes, surviving a pager or a plain log. `--json` is not a mitigation: `0x9B`, U+2028 and U+202E all survive `JSON.stringify` raw. Not covered by the accepted bidi exposure, which asserts at `2026-08-22-fog-open-findings.md:104-112` that C1/CR/U+2028 render as tokens — false here. `usage.mjs` landed two days after the audit that set that convention: oversight, not decision. Rated low only because nothing automated consumes the output — `usage` appears in no skill, agent, hook, command, template or gate manifest. |
| low | `usage.mjs:70` | `fit()` truncates numeric cells: `1,000,000,000` renders as `1,000,000,…` in a 12-wide `cache_rd` column. A single reviewer in this session already carries 1.7M cache reads; a long fleet run reaches 10⁹. The headline number of a token report is not a value to truncate. |

## Open — tests that cannot fail

All five confirmed by mutation. These are not coverage gaps in the abstract; each names a mutation
that leaves the suite green.

| sev | site | mutation that survives |
|---|---|---|
| medium | `tests/skill-config.test.mjs:44` | The doc-claim assertions test **co-occurrence, not polarity**. Rewriting the skill to the exact inversion it exists to prevent leaves 6 pass / 0 fail. Same at `:60`, where `/(larger\|longer\|bigger)/i` names neither `caveman` nor `brief` and is satisfied by any unrelated "no longer". |
| medium | `tests/usage-cli.test.mjs:69` | `--session` is documented in USAGE and registered in `KNOWN_FLAGS` but never driven; replacing the expression with `sessionId: null` leaves 500 pass / 0 fail. |
| medium | `tests/usage.test.mjs:91` | The truncation test uses a 30-char fixture against a 32-wide column, so `padEnd` alone satisfies it and the truncation branch never executes. Its comment claims the opposite. |
| medium | `tests/usage-store.test.mjs:63` | The existing-but-empty `subagents/` case is untested — a **second route** to the empty report the header forbids, independent of the recursion bug fixed above. Still open. |
| low | `tests/cli.test.mjs:11007` | `samePlanNotes`' entry-text comparison survives deletion: fog drift is only tested by removing an entry, which changes the count, so a reworded question of the same count is never detected. |
| low | `tests/finish.test.mjs:287` | The singular branch of the unreadable-entry notice is unreachable from the fixtures, which always drop four. |
| low | `tests/quiet-reporter.test.mjs:94` | The `cancelled`/`todo` summary branches survive deletion, though both were confirmed reachable with `--test-timeout` and `{ todo: true }`. |

Verified accurate and **not** findings: the suite really is 1882/1879/0 fail/3 skipped at
`6a9edff`, and the 3 skips are pre-existing legitimate capability skips in `tests/state.test.mjs`
(two win32-only, one runtime UNC-symlink skip), not disabled work. No vacuous assertion, no
non-deterministic fixture ordering, no unawaited async assertion, and no new test asserting POSIX
semantics — the Windows-hostile spots were handled deliberately.

## Open — claims the code does not deliver

| sev | site | finding |
|---|---|---|
| medium | `README.md:241` | "The four levels are validated" — `CAVEMAN_LEVELS` has **three**, and three is pinned by the suite. Repeated verbatim at `skills/teammates-config/SKILL.md:48` and `CHANGELOG.md:23`. |
| medium | `docs/followups/2026-08-22-fog-open-findings.md:124` | `## Phase 4 items — CLOSED` and "Everything above that named a defect or a gap is now addressed" (line 221) assert closure over a subsection the **same document** calls "not clean, they are unexamined". Proven: `scripts/cli.mjs:2959`'s `catch { /* Swallow and print nothing */ }` can be mutated to print a line and the suite stays green. |
| low | `CHANGELOG.md:50`, `HANDOFF.md:16` | "`tm-implementer` declares seven tools" — it declares **six**, and `CHANGELOG.md:110` says six. |
| low | `docs/specs/2026-08-24-quiet-test-reporter-design.md:119` | The Testing table lists a `load failure` test that does not exist. The behaviour itself is correct and was executed. |

Ten mutations confirmed the diff's own closure records **do** hold — including the `printable`
neutralisation of a quoted Out of Scope entry, the `rebuild-state` recovery path, the continuation
lookahead, the section-defect ordering, the staleness advisory, the reviewer's fixed `capable`
tier, and the three-level `CAVEMAN_LEVELS` constant. `config get`/`config set` were exercised
directly across every documented tier/effort path: skills, README table and code agree.

## Not reviewed

The claims lens reached its mutation cap with **9 claims enumerated but unprobed**, and said so
rather than inflating the pass. Carried forward:

- `review-gen.mjs`'s `if (effort) dispatch.effort = effort` — the "unset effort falls back by
  omission" rule (read-verified, not mutated).
- `parallel-execution`'s fixed integrator tier `mid` — skill-only claim, no code path to mutate.
- `HANDOFF.md`'s token measurements (27,499 / 9,610 / 7,867 prefix; 72–76% thinking) and the
  quiet-reporter output-size figures — both depend on transcript stores not present here.
- Five of the six phase-4 "enumerated but never reached" claims; only `cli.mjs:2959` was probed.
- `tests/skill-config.test.mjs`'s "pins each claim twice" — completeness across every sentence.
- `usage --json` payload shape and `CLAUDE_CONFIG_DIR` honouring (read-verified, not mutated).

## A gap in the gate itself

`fix` could not adjudicate this verdict. It hard-requires `--phase <integer>`, but a named-phase
gate emits `phase: undefined, phaseName: "default"`. Since `gate` accepts `--phase <name>` and
`teammates.gate.json` here defines its phase as `"default"`, **any verdict produced by a named
phase is rejected by `fix` with exit 2, always**. The escalation was therefore done by hand. Found
only by running the two commands end to end; no test covers the pairing.
