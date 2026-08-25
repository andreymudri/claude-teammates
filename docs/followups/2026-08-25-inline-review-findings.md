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

**Post-refutation tally: 1 high, 11 medium, 10 low — all 22 fixed.** The last of them,
`quiet-reporter.mjs:54`, was first recorded here as accepted-not-fixed; that judgement was wrong
and is corrected above. Two of the 22 were missing from
this document's own first draft (`cli.mjs:2955` and `quiet-reporter.mjs:54`) — a silent drop of
exactly the kind the reviews exist to catch, found when re-reading the lens files against the
record.

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

### `tests/skill-config.test.mjs:44` and `:60` — assertions that tested co-occurrence (medium)

The file exists to bind the caveman measurement's prose to the code, so an unfalsifiable assertion
in it defeats its whole purpose. Two were:

- `:44` required only that `caveman` and `reviewer` appear in **one statement**, so the sentence
  could be rewritten to its exact opposite — "Reviewer dispatches also apply caveman, so the
  reviewers obey any value you set" — with the suite green. Now pinned on polarity, plus an
  `assertNoStatement` refusing the inversion outright, so one sentence cannot satisfy the
  assertion while another asserts the opposite.
- `:60` matched a bare `/(larger|longer|bigger)/i` naming neither `caveman` nor `brief`, so any
  unrelated "no longer" satisfied it and the claim could be **deleted outright**. Now requires the
  named subject and the comparison, plus a refusal of "smaller".

Closed **`README.md:241`** in the same pass: "The four levels are validated" while
`CAVEMAN_LEVELS` has three (`lite`, `full`, `ultra`). Corrected in the skill, the README and
`CHANGELOG.md:23`, and now bound to the constant — the test imports `CAVEMAN_LEVELS` and asserts
the prose names the count the code validates, so the two cannot drift apart again in either
direction.

Each of the four mutations was run and killed by its intended test:

| mutation | killed by |
|---|---|
| reviewers *do* apply caveman | caveman reaches only implementer briefs |
| delete the larger-than-default claim | the terse brief is larger, not smaller |
| claim the brief is *smaller* | the terse brief is larger, not smaller |
| level count drifts back to four | the level count the code actually validates |

### `scripts/usage-store.mjs:63` — `--session` path traversal (medium)

`--session` was joined into the store path with no filename-component validation, so
`--session '../../../outside'` walked out of the projects directory and read `.jsonl` files
elsewhere on disk — disclosing the first bytes of one through a parse-error line, plus the names of
every `.jsonl` under any reachable `*/subagents/`.

Refused by name now, on the same rule `reviewFileName` (`scripts/reviews.mjs:86-93`) already
applies to a lens: non-empty, no separators, not `.` or `..`. Validated in `readSessionUsage`
rather than only at the CLI, because `--session` is not the only way a name reaches that join —
`newestSession` returns a directory name that is joined again, so a directory an attacker can
create is the same primitive.

### `tests/usage-cli.test.mjs:69` — `--session` was never driven (medium)

Documented in USAGE and registered in `KNOWN_FLAGS`, but no test exercised it: replacing the
expression with `sessionId: null` left 500 pass / 0 fail. Now driven against a **two-session**
fixture, so selecting one means something — with a single session in the store the flag could still
be ignored and every assertion pass.

Three mutations run, each killed:

| mutation | killed by |
|---|---|
| `sessionId: null` (CLI ignores the flag) | `--session` reports on the named session |
| drop the validation entirely | both traversal tests |
| validation allows `..` | a session name with a separator is refused |

### `docs/followups/2026-08-22-fog-open-findings.md:124` — closure asserted over unexamined work (medium)

`## Phase 4 items — CLOSED` and "Everything above that named a defect or a gap is now addressed"
covered the *"Claims the phase 4 review enumerated but never reached"* subsection — which the same
document calls "not clean, they are unexamined". A review that did not reach a claim closes nothing.

Corrected rather than papered over: the heading is scoped, and the closing summary now says
explicitly that the 49 unprobed claims across the four phases are **carried, not closed**. Both
corrections quote what they replaced.

Verified rather than inherited: mutating `scripts/cli.mjs`'s `catch { /* Swallow and print
nothing */ }` to print a line leaves the suite at **1894 tests, 1891 pass, 0 fail** — so that
claim is confirmed still unpinned, first-hand.

## Closed in the final pass

| finding | what changed |
|---|---|
| `usage.mjs:53/:75/:104`, `cli.mjs:3021` — no `printable()` | Every value read from disk is neutralised. `fit` pads by `String.length`, so a literal newline counted as one character and forged a row with no escape sequence at all; that is pinned by comparing line counts against a benign render, not by matching a substring. |
| `usage.mjs:70` — numeric cells truncated | Numeric columns now **widen** to their widest value; only text columns are capped. `1,000,000,000` no longer renders as `1,000,000,…`. |
| `tests/usage.test.mjs:91` — truncation test could not fail | Fixture is now wider than its column, so the truncation branch actually runs. The old one was 30 chars against a 32-wide column. |
| `tests/usage-store.test.mjs:63` — empty store untested | An existing-but-empty `subagents/` now **throws** instead of rendering zeros at exit 0 — the second route to the forbidden empty report. A store whose transcripts are all *unreadable* still reports, because naming what it could not read is the opposite failure. |
| `tests/cli.test.mjs:11007` — `samePlanNotes` text unpinned | Drift is now tested at an **unchanged count** — a reworded question. Both prior tests changed the list length, so the length check alone satisfied them. |
| `tests/finish.test.mjs:287` — singular branch | `1 unreadable entry` is pinned; every prior fixture dropped four. |
| `tests/quiet-reporter.test.mjs:94` — `cancelled`/`todo` | Both branches pinned in each direction, plus the `FAILED` marker, the missing-root-summary path, and the per-file-summary-alone case. |
| `docs/specs/2026-08-24-quiet-test-reporter-design.md:119` — spec named a test that did not exist | The `load failure` test is written rather than the spec weakened: a file throwing at import emits no root summary, so a naive reporter prints nothing and the run reads as clean. |
| `CHANGELOG.md:50`, `HANDOFF.md:16` — "seven tools" | Corrected to **six**. `tm-implementer` declares Read, Write, Edit, Bash, Grep, Glob. |
| `cli.mjs:2955` — staleness advisory looped | The remedy has a direction. `init-run` records from the working tree; the anchor is the plan at `merge-base(base, run)`. When plan.json is **ahead**, re-running `init-run` rewrote the identical file and the advisory fired forever. Both cases are now named. |
| the `gate`/`fix` gap | A `--no-fleet` verdict carries `phaseName` with no integer `phase`, so `fix` refused it as a **missing argument** — a typo's error for a real boundary. It now states that tasks and fix rounds are *keyed* by numeric phase, so a non-numeric value addresses none of them. (An earlier wording said "a named phase has no task set to adjudicate"; that was false — `tasksOfPhase` returns every task of the run for a non-integer name — and the suite now forbids the CLI from printing it.) |

### `quiet-reporter.mjs:54` — test output could smuggle an escape sequence (low)

First recorded here as *accepted, not fixed*, on the reasoning that closing it meant degrading
failure output — the one thing the reporter exists to protect. **That reasoning was wrong, and the
finding is now fixed.** `renderFailure` reads the stack from the `test:fail` event, never from the
`test:stdout`/`test:stderr` passthrough, so neutralising those two streams costs no failure detail
at all.

`printableBlock` was already in the repo for exactly this shape: it keeps the content's own
newlines and tabs, so a multi-line `console.log` still reads as written, and neutralises every
other control byte. A test can no longer erase the summary line and redraw it.

The limit is stated in the code and pinned by a test rather than left implied: this cannot stop a
test printing a line that merely *looks* like the summary. The exit code remains the authority,
and `scripts/gate-runner.mjs:26` reads that, never this text.

## Second review pass — the fixes reviewed (2026-08-25)

The verdict recorded above judged a tree that no longer existed once the fixes landed, so four
fresh lenses were dispatched over `6a9edff..08574f5` — the fix branch itself — each told that the
author's own mutation claims were not to be taken on trust. It found seven more, six of them
defects in the fixes. Recorded because a fix pass that reviews itself and finds nothing is the
outcome to distrust.

| sev | site | finding | resolution |
|---|---|---|---|
| high → **low** | `usage-store.mjs` recursive `readdir` follows directory symlinks | A link planted in the store made `usage` read transcripts anywhere on disk, and a self-referential link multiplied every total until ELOOP. | **Refuted down to low, and fixed anyway — but only half of it was pre-existing.** The refuter ran the BASE commit and got the identical foreign row (`readFile` follows symlinks and the base filter had no `agent-` prefix, so the base accepted a symlinked transcript under any name). It also disproved the `fixed prefix = N%` claim — that ratio is scale-invariant under uniform duplication. **The row multiplication and the unbounded walk were genuinely new to the recursive-readdir commit**, which the refutation file says in those words and an earlier version of this row dropped: measured, base gives 2 rows and no duplication where that commit gave 82 rows and a 41x TOTAL. Recorded because summarising a refutation as more favourable than it was is the same defect as an overstated fix. |
| medium | `usage-store.mjs` — nested `readdir` failure fatal | One unreadable subdirectory aborted the whole report, and the catch relabelled it "no transcripts found", dropping a readable transcript in the directory that message names. A directory removed mid-walk does the same, during exactly the live run an operator reports on. | Fixed by the same walk. |
| medium | `cli.mjs` — `--json` never neutralised | That branch does not pass through `renderUsage`, and `JSON.stringify` escapes C0 while leaving C1 and U+2028/U+2029 raw. One branch of a ternary was neutralised and a comment claimed the command was covered. | Fixed with `printableBlock` — `printable` would destroy the pretty-printer's own newlines and leave a document that no longer parses. |
| medium | `quiet-reporter.mjs` — `renderFailure` unwrapped | A test's NAME and its error stack are attacker-authored too. SGR 8 in a stack renders the summary line invisible; U+2028 in a name draws a standalone line reading like a green summary. | Fixed. **The comment justifying the earlier fix was wrong** and is retracted in place: it argued the fix was complete *because* `renderFailure` reads from the `test:fail` event — but a different source is not a safer one. |
| low | `cli.mjs` — named-phase refusal swallowed other missing args | `workflow --phase default` reported only the phase, never the missing `--run`, bouncing the operator twice. | Fixed; both are said at once. |
| low | `usage-store.mjs` — empty transcript vanished | A transcript parsing to zero records with zero errors got no row and no `unreadable` entry — the ordinary state between a dispatch creating the file and the first turn being appended. Alone in a store it tripped the empty-report throw and blamed the layout. | Fixed. |
| low | `usage-store.mjs` — `'.. '` passes the validator | Windows strips trailing spaces and dots from a path component, so `'.. '` resolves to `..`. **Unverified on Windows**, and `reviewFileName` has the identical gap. | **Open.** Recorded rather than fixed: single component, fixed last segment, and fixing it in one place while its model keeps the gap would be worse than fixing neither. |

The correctness lens also fuzzed `renderUsage` over 4,000 random reports asserting header, rows,
separator and TOTAL all share one width — zero mismatches — and confirmed the `agent-` filter and
the per-line parse against the real store.

One thing it declined to file, correctly: the `model` column renders `(unknown)` as `(unknow…`.
The base does the same, so the branch did not introduce it — though it is the same argument the
numeric-width fix rests on, applied to a value this codebase generates itself.

### The claims and tests lenses of the second pass

Thirteen more, no highs — and almost all of them defects in the *first* round of fixes, or in the
prose written to describe them. The tests lens ran 30 mutations of its own rather than trusting the
author's; most new tests bit, and these did not:

| sev | finding | resolution |
|---|---|---|
| medium | `tests/skill-config.test.mjs:46` — the polarity rewrite **narrowed the hole, it did not close it**. `unaffected` need not be about caveman, and the verb list missed `given`. The reviewer rewrote the skill to say reviewers *are given* the level and the full suite stayed green. | Both terms now required in one statement; verb list widened. The reviewer's exact rewrite now fails it. |
| medium | `tests/usage-cli.test.mjs:104` — the `--session` test was **flaky**: the fixture built `sess-other` second, so it was usually already the newest, and with the flag ignored it still passed in **2 of 8 runs**, decided by an mtime tie. | The second session is stamped a day older. Mutant killed 8/8. |
| medium | `scripts/usage.mjs:94` — the numeric-widening block was **dead weight to the suite**: `return width` was green. `padStart` alone keeps every digit, so pinning the number pins neither the widening nor the alignment. | Pinned by column alignment across two agents of different magnitudes. |
| medium | `scripts/quiet-reporter.mjs:15` — the module header still said "stderr is passed through untouched" after the code stopped doing that: the same sentence the spec was amended twice to correct, left stale one file over. | Corrected, with a note that it was stale. |
| medium | `scripts/cli.mjs` — the new refusal claimed "a named phase has no task set to adjudicate". **False**: `tasksOfPhase` returns every task of the run for a non-integer name. It also prints for `workflow`, `record-fix-round` and a plain typo, where the sentence about `--no-fleet` is meaningless. | Reworded to the accurate claim — tasks and rounds are *keyed* numerically — with the `--no-fleet` case made conditional. A test now refuses the old wording. |
| medium | `skills/phase-gate/SKILL.md:193` — the "On FAIL" procedure is unfollowable for the `--no-fleet` gate the same skill documents, and its list of what makes `fix` exit 2 was incomplete. | The skill now states the boundary: fix the findings directly and re-run the gate; `retry`/`escalate`/the round budget presume task branches. |
| low | `renderPlanNotes` plural branch **still unfalsifiable** — always-`entry` was green. The mirror of the bug the new singular test was written for. | Both branches pinned. |
| low | the load-failure test's alternation was satisfied by **node's own crash dump**, so it survived the very `renderSummary` silencing its comment describes. | Asserts the reporter's own line. |
| low | the win32 skip was a **blanket predicate** resting on a claim that contradicts the Win32 filename rule (which forbids bytes below 0x20, not U+2028/U+0085). | Now a real capability probe: it attempts the mkdir and skips only if the filesystem refuses, naming the errno. |
| low | `HANDOFF.md` — the correction written "so it is auditable" cited `cli.mjs:2017`/`:2153`; at the tip those are a `})` and a blank line. | Line numbers dropped for subcommand names, which do not drift. |
| low | the followups doc claimed the level count "cannot drift apart again in either direction" — **only the skill was bound**; README and CHANGELOG were unpinned and mutating either back to "four" was green. | Both now bound to `CAVEMAN_LEVELS`. |
| low | `cli.mjs` — "neutralised like every other print site in this file" overstates: four sites still interpolate repo- and fs-derived values raw. | Comment corrected to name it as a gap rather than a convention. |
| low | `docs/followups/…` — "Every value read from disk is neutralised" was false: `usage --json` still emitted U+2028 raw. | Fixed with `printableBlock` on the JSON branch. This row was omitted from an earlier version of this table while the `'.. '` row above was counted twice — the reconciliation error a per-finding record exists to prevent. |

The claims lens verified the 22-finding tally directly against the first pass's findings files
(5+4+5+8, reconciling to 1/11/10 post-refutation) and left **7 claims unprobed**, including the
`31,394,783` figure and the HANDOFF token measurements, which depend on stores not present in a
scratch worktree.

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
