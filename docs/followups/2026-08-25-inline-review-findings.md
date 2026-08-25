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
| low | `usage-store.mjs` — `'.. '` passes the validator | Windows strips trailing spaces and dots from a path component, so `'.. '` resolves to `..`. **Unverified on Windows**, and `reviewFileName` has the identical gap. | **Closed in v1.1.5**, one release later and deliberately: the two checks became one exported `isUnsafePathComponent`, so the gap could not be fixed in one place and left in the other. Carried as open for exactly one release, which is recorded here rather than backdated. |

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
| low | the followups doc claimed the level count "cannot drift apart again in either direction" — **only the skill was bound**; README and CHANGELOG were unpinned and mutating either back to "four" was green. | README bound to `CAVEMAN_LEVELS`. The CHANGELOG is checked against a fixed spelling instead: binding a released entry to the live constant would make a future level change fail a test about a shipped version, which is history rewritten to keep a test green. |
| low | `cli.mjs` — "neutralised like every other print site in this file" overstates: four sites still interpolate repo- and fs-derived values raw. | Comment corrected to name it as a gap rather than a convention. |
| medium | `docs/followups/…` — "Every value read from disk is neutralised" was false: `usage --json` still emitted U+2028 raw. | Fixed with `printableBlock` on the JSON branch. This row was omitted from an earlier version of this table while the `'.. '` row above was counted twice — the reconciliation error a per-finding record exists to prevent. Severity corrected from `low` to `medium` to match `reviews2/default-claims.json`, the file that filed it — a mismatch the fifth pass filed and the fifth pass's own findings then went unrecorded, which is the same error one level further down. |

The claims lens verified the 22-finding tally directly against the first pass's findings files
(5+4+5+8, reconciling to 1/11/10 post-refutation) and left **7 claims unprobed**, including the
`31,394,783` figure and the HANDOFF token measurements, which depend on stores not present in a
scratch worktree.

## Third and fourth review passes (2026-08-25)

Recorded because they happened and the earlier version of this document did not mention them —
an omission the fourth-pass claims lens caught, and the same class of gap as the two findings this
document dropped from its own first draft.

**Pass three** reviewed the round-two fixes (`08574f5..62dfa9f`) and filed **19** — 7 claims,
5 correctness, 7 tests — including one `high` that no refutation was dispatched against; it was
re-filed at `high` by pass four and closed only later. **Pass four** reviewed the round-three fixes
(`62dfa9f..c5c8f6a`) and filed **18**: 6 claims, 4 correctness, 8 tests, of which **2 were `high`**,
both in the tests lens.

*(Corrected. An earlier version of this paragraph said pass four filed "10" — claims plus
correctness, omitting the tests file entirely, which is the file carrying both highs. So the record
said pass four had no highs. This section exists **because** the fourth-pass claims lens found no
record of pass three at all; writing it and dropping a lens file is the same omission one level
down. The counts above are taken from `.teammates/inline-review/reviews3/` and `reviews4/`, which
are **gitignored** (`.gitignore:2`) and therefore exist only on the machine that ran the passes —
so on any other clone they cannot be recounted at all, and this document is the only surviving
record. An earlier version of this parenthesis said they "are in the repo and can be recounted",
which is the same class of unchecked claim the paragraph above it exists to correct.)*

Almost every finding was a defect in the preceding round of fixes or in the prose describing it.
Not all: pass four's `tests/md-contract.mjs` finding names blind spots in shared test
infrastructure that predate this branch by three weeks, so the branch inherited that one rather
than introducing it. What they found, in the order it
matters:

- **The caveman polarity assertion was defeated EIGHT ways across six rounds, and every fix opened
  the next hole.** Co-occurrence matching; one sentence satisfying the claim while stating its
  inverse; the inverse appended to the claim sentence, which `assertClaim` exempts by construction;
  a heading, which `parseDoc` never turns into a statement; the inverse appended to an allow-listed
  sentence; an inversion in another section, opened by scoping the claim to its own; a sentence
  naming neither "reviewer" nor "caveman" ("the grading lenses ... do receive the level in full");
  and — the round-four instrument defeating itself — an aside spliced *inside* the claim sentence
  through the `[^.]*` in its own exact-shape regex, which both inventory screens then skip because
  it **is** the claim. A duplicate-titled decoy section, a code block, and the frontmatter were
  also reachable.

  **The lesson is structural, not a better regex.** A word-matcher over prose can only forbid the
  phrasings its author imagined, and prose has unbounded ways to say the opposite. The section is
  now pinned **exactly**, as a snapshot, with a hand-maintained inventory of every other mention of
  `caveman` in the skill — headings, code blocks and frontmatter included, none of which `parseDoc`
  reaches. Any edit fails the test, which is the intent: this measurement is load-bearing, and
  changing it should be a deliberate act that updates the fixture in the same commit.

  **This paragraph was wrong, and a sixth pass proved it.** It claimed all eight escapes were
  re-run against the section snapshot and all eight fail. Two of them did not: escape #7, re-run
  verbatim, passed, and the heading escape stopped being caught at all — because the same commit
  deleted the doc-wide heading screen that had covered it. See the sixth pass below.

- **The `MAX_ENTRIES` cap reintroduced the bug the walk was written to remove.** It stopped the
  walk silently, so a store past it under-reported at exit 0 — reason 2 of the walk's own header,
  reintroduced by the bound added for reason 3. Then the fix for that had an **off-by-one**:
  `budget--` post-decrements, so a walk that consumed exactly `maxEntries` and saw everything was
  declared incomplete. Truncation is now a flag set where the walk actually stops short.
- **`kept: 0` was overloaded** to mean read failure, empty-but-readable, and unreadable directory,
  and `renderUsage` called all three "transcript(s) unreadable". Then the `kind` split that fixed
  it mis-tagged a transcript whose every line failed as `partial` — asserting it was in the table
  minus a few lines when it was absent entirely, the same misstatement inverted.
- **`printableBlock` was wrong for the test name**, which is a one-line splice: it preserves LF by
  design, so a plain newline still forged a summary line while the comment claimed that forgery
  closed. Only its U+2028 spelling had been.
- **The macOS EMFILE break**: the cap test built 20,050 files. The bound is injectable now, and
  the shipped default is exported and pinned separately — injecting a cap verifies the notice, not
  the bound, and `MAX_ENTRIES = Number.MAX_SAFE_INTEGER` was green.
- **`maxEntries` was unvalidated**: `0`, negative and `NaN` reproduced the "layout may have
  changed" throw for a perfectly readable store; `null` crashed. Refused by name now.
- **`assertClaim` was handed the whole document**, so its back-reference screen ran document-wide
  and an unrelated paragraph failed the caveman test. Scoped to its own section, with a test
  pinning that scoping.
- **A refutation summarised more favourably than it read** — see the symlink row above, corrected.

## Fifth review pass (2026-08-25)

Recorded here because the earlier version of this document stopped at the fourth pass — the same
omission the fourth-pass claims lens had already caught one level up, repeated. Pass five reviewed
the round-four fixes and filed **18**: 7 claims, 11 tests, **4 of them `high`**. It is the pass with
the most highs of the five, and it had no record at all.

Its two claims highs were both about *this document*: that "each escape was re-run against the fix
and fails" was false (the heading escape was still green), and that "pass four filed **10**"
undercounted by 8 by dropping the tests-lens file — the file carrying both of pass four's highs.
Both are corrected above.

Its two tests highs were the fifth and sixth defeats of the caveman polarity lock: the inverse
stated in ordinary prose using a *synonym* for "reviewer", and the exact-shape regex's unbounded
`[^.]*` letting the claim sentence assert its own inverse and still match.

Its mediums named structural blind spots in the test file rather than single escapes — `doc()`
discarding the frontmatter, so the `description` an agent actually loads the skill from was
unscreened; `Array.find` instead of `doc.section()`, so a duplicate-titled decoy was reachable;
the pairing screen skipping code blocks; `kind === 'partial'` unpinned; `DEFAULT_MAX_ENTRIES`
asserted as a value but never observed being applied.

Two of its findings were carried unresolved into the sixth pass. One is closed now: the `| low |`
severity row corrected above. **The other is still open:** `skills/phase-gate/SKILL.md:207`, whose
rewritten solo-gate paragraph — the two rules it says "still bind", and its `--run` persistence
claim — is bound by no assertion, so its exact negation would pass the suite. It is carried, not
closed, and nothing below addresses it. (An earlier version of this paragraph declared both closed
and then, one clause later, declared this one open, and pointed at a "below" that did not exist.)

## Sixth review pass — the release commits (2026-08-25)

**The five passes above covered `95a4b03..f1626e3`. FIVE commits landed after them and were
reviewed by nobody:** `be9f093`, `f38e868`, the merge `21f0a88`, and the two release commits
`c0c9666` (v1.1.4) and `c2d0398` (v1.1.5).

*(Corrected, and the correction is itself an error worth keeping. An earlier version of this
paragraph said the passes covered `95a4b03..be9f093` — pass five's stamp actually ends at
`f1626e3` — and then took `be9f093` as the sixth pass's BASE. Since `A..B` excludes `A`, that
choice left `be9f093` reviewed by nobody, and it changes shipped source: `scripts/usage-store.mjs
+21/-4`. **It is still unreviewed.** Fixing an off-by-one range by introducing another one, in the
same paragraph, is the sharpest illustration in this document of why the counts get recomputed
from the JSON rather than read from prose.)* The recorded gate PASS is stamped 19:20:18 UTC; the v1.1.4 and
v1.1.5 commits are timed 19:43 and 19:58 UTC — 16:20, 16:43 and 16:58 as `git log` renders them
here at -0300, and they are commit times, not push times. The gate predates both releases by 23
and 38 minutes and cannot speak to either. `c2d0398` shipped **`isUnsafePathComponent`** —
the sole path-component gate for two `path.join` sites — tagged and released with no adversarial
review, while the handoff's "Still open" named only the test-only commit.

Four lenses over `be9f093..master` filed **28 findings, 6 `high`** — 14 claims, 6 tests,
4 security, 4 correctness. The count went **up** against the 22/20/19/18/18 of the earlier passes,
because this range was genuinely unreviewed production code rather than a round of repairs.

### The symlink escape at the walk's own entry point (high, security; fixed)

`readdir` and `stat` both FOLLOW symlinks. The hand-written walk closed the symlink hole for links
found *inside* it — `withFileTypes` + `isDirectory()` is false for a link — and left the one at its
root, under a comment asserting the hole was shut. `newestSession` used `stat`, so a session whose
`subagents` was a symlink answered `isDirectory()` with true, won on mtime, and was **auto-selected
with no `--session` given**; the walk then read transcripts from anywhere on disk and attributed
them to this project. Reproduced live on Linux, no flag required.

Validating the component's *name* can never validate its *target*. Fixed with `lstat` in
`newestSession` plus a `realpath` containment check on the store path, compared against the
resolved project directory — so a link the operator put higher up the path still works (a macOS
temp dir is `/var` → `/private/var`) and a link that leaves the store does not.

### The caveman claim was defeated a NINTH way, by the fix for the eighth (high ×1 + medium ×1; fixed)

`f38e868` pinned the caveman section as an exact snapshot and replaced the doc-wide heading screen
with a line filter for the literal token `caveman`. Two lenses found the consequences independently:

- **Escape #7, re-run verbatim, passed.** Any sentence contradicting the claim while avoiding the
  token `caveman` is unscreened anywhere outside the pinned section. So "all eight escapes fail
  against it" was false when it was written.
- **The commit was a net loss of coverage.** The deleted screen tested
  `/reviewer/i && /caveman|level/i` over every heading; the replacement keys on `caveman` alone, so
  a heading pairing "reviewer" with "level" is no longer caught. Measured both ways: green at
  `master`, and red (`1940 | 1 fail`) with only the pre-`f38e868` test file restored.

**The lesson repeats one level up: any boundary drawn inside the file leaves the rest of the file
to be a word-matching problem again.** The whole file is now pinned byte-for-byte against
`tests/fixtures/teammates-config.SKILL.md`, with two further layers a snapshot alone cannot
provide: a semantic guard asserting the claim sentence survives verbatim (a fixture updated by
`cp` would otherwise carry an inversion into both files and go green), and an exact-sentence pin on
the README, which carried the same claim bound by nothing. All ten escapes — the nine plus a
trailing space inside the pinned section — were re-run and every one is red; the `cp`-the-fixture
path and a README-only inversion were each verified to fail their own layer.

The cost is deliberate: every edit to that skill now fails a test until the fixture is updated in
the same commit. That is a visible line in a diff a reviewer can question.

### Three surviving mutations in the v1.1.5 validator (high ×1, medium ×1, low ×1; fixed)

`isUnsafePathComponent` had **no direct test** — `grep -rn isUnsafePathComponent tests/` returned
nothing. It was exercised only through two call sites that both pre-filter their input, so:

| mutation | before | after |
|---|---|---|
| `/[\\/]/` → `/[/]/` — deletes the **Windows separator** | survived, suite green | killed |
| `typeof value !== 'string'` guard deleted | survived, suite green | killed |
| `resolved === '.' \|\| resolved === '..'` deleted | survived — **equivalent mutant** | removed as dead code |

The first is the serious one: the backslash half was uncovered in the release whose entire subject
is Windows path-component semantics, and neither test file contained a single backslash. With it
gone `reviewFileName(1, '..\..\..\etc')` stops throwing.

The third is not a test gap but dead code. The strip removes the whole trailing run of `[. \t]`, so
`.` and `..` are nothing but dots and collapse to `''` before any second comparison — exhaustive
enumeration found zero inputs reaching either arm and zero where the three-arm and one-arm
predicates disagree. Two thirds of the predicate that read as the substance of the rule was
unkillable by construction. It now has one arm, and the comment says why.

CHANGELOG.md and HANDOFF.md both claim "one mutation of it fails tests at both call sites".

**That claim was TRUE when written, and an earlier version of this section said it was false.** At
`c2d0398`, replacing the whole body of `isUnsafePathComponent` with `return false` — one mutation —
fails 10 tests across both call-site files. The existential claim the release note actually makes
was correct. What the sixth pass found is narrower and still worth fixing: three SPECIFIC mutations
survived, including deletion of the Windows separator. That is a coverage gap, not a false release
note, and stating the stronger version was the same overreach this document keeps recording.

### What the claims lens found in the handoff itself

`HANDOFF.md` was essentially rewritten in this range and carried three highs and four mediums —
the reviewed range stated as `95a4b03..master` when the passes ended at `f1626e3`; "Still open"
omitting `c2d0398`; "all eight escapes fail"; the gate-caveat sentence pointing at a persisted
record that carries no `results` key at all; "only pass 1 found a user-facing bug", falsified by
the `'.. '` traversal that pass 2 filed against code predating the repair work; the 97/11 tally
naming the refutations as co-filers of a total they did not contribute to, using a high count they
had themselves invalidated; and — the seventh, dropped from an earlier version of this very
enumeration, which said "three highs and four mediums" and then listed six — `HANDOFF.md:38`'s
"All are closed or accepted with the reasoning recorded", which was false while pass five had no
record at all.

They were corrected in the handoff rewrite, which happened in the commit AFTER the one this
section describes. An earlier version of this sentence said "All are corrected in the rewritten
handoff" while `HANDOFF.md` was untouched by the commit carrying that sentence — a claim about
work that had not been done yet, filed as a `high` by the seventh pass.

**The refutation files re-file the finding they adjudicate; they do not add new sites.** The honest
tally of the first five passes is therefore **97 lens findings, 11 `high` pre-refutation, 8 `high`
post-refutation**. Any of those three numbers is defensible; stating one without saying which is
the error.


## Seventh review pass — the sixth pass's own repairs (2026-08-25)

Four lenses over the repair commit filed **29 findings, 11 `high`** — 8 tests, 9 claims,
7 correctness, 5 security. **More findings, and nearly twice the highs, than the pass it was
repairing.** Seven consecutive rounds have now found defects in the previous round's fixes, and
this was the worst of them.

### What the repairs got wrong

- **The containment fix was defeated by one symlink.** It anchored on `realpath(projectDir)` —
  and `projectDir` is `<projectsDir>/<slug>`, a DERIVED name whoever writes the store can replace
  with a link. Reproduced end-to-end through the CLI at exit 0. Now anchored on `projectsDir`, the
  only path in the function nobody plants, and compared by EXACT MATCH rather than prefix
  arithmetic — which also removes the `..foo` false positive (a legitimate session the module's own
  name check accepts, refused by `rel.startsWith('..')`) and the sibling-session misattribution
  (`rel` = `sess-other/subagents` has no `..` and passed).
- **It was TOCTOU and did not use its own result.** `resolvedStore` was computed and never read;
  the walk re-opened the unresolved name. Measured at **16.5% of invocations** returning an
  attacker-chosen report against a concurrent `rename()`. The walk now reads from the resolved
  path.
- **`lstat` → `stat` was a surviving mutation.** The test named for it asserted only that the call
  *rejects*, which the containment check does alone — so it passed with the half of the fix it was
  named for reverted. Now pinned by observing WHICH session is selected, against a decoy that wins
  on mtime.
- **Three new tests would have taken Windows CI red.** They build symlinks with no
  `{ skip: process.platform === 'win32' }`, against this file's own convention three lines away —
  EPERM inside the fixture builder, so they FAIL rather than skip.
- **`.meta.json` is a derived path and passed no filter at all** — not the walk's `isFile()`, not
  the containment check, because both only see paths the walk listed. A symlinked meta file was a
  constrained arbitrary file read; `mkfifo agent-x.meta.json` hung `usage` forever with no timeout,
  and the pending read kept the process from exiting. Guarded by `lstat` + `isFile()`.

### The caveman claim, defeated a tenth time — and the layer that finally closes it

Escape #10 had three routes, found by two lenses independently: an ADDED section stating the
inverse, carried past the byte-for-byte snapshot by `cp`-ing the fixture in the same commit; the
runtime claim being bound only by `review-gen.mjs`, while `agents/tm-reviewer.md` — the reviewer's
actual dispatch prompt — was bound by nothing; and `CHANGELOG.md` carrying the measurement in more
detail than either pinned file, bound by nothing, byte-for-byte the hole just closed on README.

**A presence check is not a negative.** `includes()` asserts the claim is still THERE, never that
nothing contradicts it — escape #3's shape, re-shipped as the fix for escape #9. Re-running the
battery after adding five layers showed escape #7 STILL green: a contradicting sentence added
inside an EXISTING section, naming neither "reviewer" nor "caveman", with the fixture copied.

The fixture is the weak link in any snapshot, because `cp` updates it in one motion. **The anchor
is now a SHA-256 constant in the test file**, which no copy from the skill can reach, so any byte
change fails there first. Eight escape routes were re-run against the finished instrument and all
eight are red, escape #7 included. The other layers survive because they turn "the digest changed"
into a message naming which kind of change it was, and because the heading and caveman-line
inventories also live in the test file rather than the fixture.

**Stated plainly, because six rounds of not stating it produced this section: none of the prose
layers is a proof.** An author who edits the fixture, the digest and the inventories can make the
skill say anything. What they buy is that every route requires a deliberate edit to a test file —
a line in a diff a reviewer can question. The one layer that IS a proof is the runtime check, now
covering `review-gen.mjs`, `agents/tm-reviewer.md` and `agents/tm-integrator.md`, because that is
mechanically decidable.

### One mutation deliberately left alive

Reverting the walk to read from the unresolved name (`subagentsDir` instead of `resolvedStore`)
**survives the whole suite**, and no test here kills it. The difference is observable only under a
race, and the containment check forces the two paths to be equal in every state a test can
construct. Rather than write a flaky timing test or imply coverage that does not exist, it is
recorded: the resolved-path walk is hardening whose benefit is a narrower TOCTOU window, and the
window is not zero — Node cannot close it without fd-relative opens. An attacker who can write
inside the store does not need to win a race to put a transcript there; the race only buys reaching
files OUTSIDE it.

## Eighth review pass — the gap, and release readiness (2026-08-25)

Three lenses over `f1626e3..be9f093` — the commit that fell between pass 5's tip and pass 6's base
and had been read by nobody — plus a release-readiness sweep. **18 findings, 5 `high`**: 11 claims,
5 tests, 2 correctness.

### It stopped the release

**The branch had never been pushed and had zero CI runs.** The verification block in HANDOFF.md
said `gh run list --limit 1`, which unfiltered returns the newest run in the REPO — `master`'s
v1.1.5 run, three commits back, from before a single test on this branch existed. The same document
warned two paragraphs later that three tests here would have taken Windows CI red and that a local
run proves one platform of three, and then handed over a command that reports another commit's
verdict. The command is now `--branch`-scoped, and the branch is pushed and CI-verified before the
tag.

### The bound the commit existed to pin was still not pinned

`be9f093` moved the `maxEntries` default off the signature and into `maxEntries ?? DEFAULT_MAX_ENTRIES`,
with a comment calling the constant "The ONE definition of the shipped bound". There were still
two sites, each independently mutable with the suite green — and the move pushed the live one AWAY
from production, since `cli.mjs` omits `maxEntries` entirely and therefore takes the signature
default and never reaches the `??`. Setting the signature default to `Number.MAX_SAFE_INTEGER`
shipped an unbounded walk at the exact baseline.

The test named for the bound could not catch it: on a one-file store `if (budget-- <= 0)` cannot
trip for any admissible cap, so "nothing truncated" was **unfalsifiable by construction**. Setting
the shipped default to `1` — every `usage` run reporting at most one transcript, the under-report
at exit 0 this module exists to prevent — left both guard tests green.

The applied cap is now **returned on the report** and asserted, which observes the bound without
building the 20,001-file fixture that took macOS CI down with EMFILE. The catastrophic-default
mutation now fails 9 tests; raising either site fails; changing the constant fails.

### The record pointed at the wrong evidence

Three of the claims highs were about where the truth lives, not what it is:

- HANDOFF.md named `results-final.json` / `verdict-final.json` as holding the coverage caveat.
  Those are the **pre-release** verdict, and their review output asserts coverage *through*
  `be9f093` — the exact opposite of the bullet beside them.
- `be9f093`'s diffstat was given as "`scripts/usage-store.mjs` (+21/-4)", a number matching nothing
  in the commit and naming one file and no tests — which would have sent a reviewer past
  `tests/skill-config.test.mjs`, where that commit rewrote the caveman heading screen pass 6 then
  found had stopped catching anything.
- The gate record said "pass 7 over `c2d0398..HEAD`" — HEAD meant `33babfd` when it was written,
  two minutes before `b726cc4` existed. It also said "All highs and mediums closed" while
  `skills/phase-gate/SKILL.md:207` was open, which the lens proved by inverting the paragraph to
  its exact negation and watching the suite stay green. That one is **now closed**: bound in
  `tests/skill-contracts.test.mjs`, negation re-run and failing.

Two corrections to arithmetic this document had asserted: only **two** of the four `refute-*.json`
files re-file the finding they adjudicate — the other two carry `findings: []` and record their
verdict in `correctedSeverity`. And every cell of the seven-pass table was independently recounted
from the JSON and is correct.

### The regress, named

Pass 8's findings were fixed in a commit no pass has read. **Every round has this property: the
commit that closes a pass is written after it.** The honest stopping point is not a claim of full
coverage but a statement of what the last commit has instead — per-fix verification by execution
and mutation, done by the author, which is weaker than a lens pass. That is what the gate output
says, in those words.


## Not reviewed

Three passes recorded claims they enumerated but did not probe. Earlier versions of this section
carried only the first pass's nine, which is the same omission — a lens file dropped from the
record — that this document has now corrected three times at three different levels.

**Pass one** reached its mutation cap with **9 claims enumerated but unprobed**:

- `review-gen.mjs`'s `if (effort) dispatch.effort = effort` — the "unset effort falls back by
  omission" rule (read-verified, not mutated).
- `parallel-execution`'s fixed integrator tier `mid` — skill-only claim, no code path to mutate.
- `HANDOFF.md`'s token measurements (27,499 / 9,610 / 7,867 prefix; 72–76% thinking) and the
  quiet-reporter output-size figures — both depend on transcript stores not present here.
- Five of the six phase-4 "enumerated but never reached" claims; only `cli.mjs:2959` was probed.
- `tests/skill-config.test.mjs`'s "pins each claim twice" — completeness across every sentence.
- `usage --json` payload shape and `CLAUDE_CONFIG_DIR` honouring (read-verified, not mutated).

**Pass five** carried nine of its own, and **pass six** six unprobed plus four it could not verify.
Two of the sixth pass's are load-bearing here and are carried forward explicitly:

- **The three mutation tables in this document** (the `mutation | killed by` tables above) assert
  that specific mutants are killed by specific tests. They have **not been re-run** since they were
  written. Only the v1.1.5 validator table was re-verified, by the seventh pass.
- **`skills/teammates-config/SKILL.md`'s "larger by about 3%"** — the direction is pinned by a
  test; the magnitude is pinned by nothing and has not been measured since it was written.

**Pass seven** carried four unprobed, of which one matters: the nine-escape enumeration in
`tests/skill-config.test.mjs`'s comment is a HISTORY, and no pass has walked the six earlier
rounds' commits to confirm which escape belonged to which round. The escapes were re-run as
BEHAVIOUR against the current tip, which is a different claim.

**And the commit `be9f093` has been reviewed by no pass at all** — see the correction in the sixth
pass section. It changes `scripts/usage-store.mjs`.

## A gap in the gate itself

`fix` could not adjudicate this verdict. It hard-requires `--phase <integer>`, but a named-phase
gate emits `phase: undefined, phaseName: "default"`. Since `gate` accepts `--phase <name>` and
`teammates.gate.json` here defines its phase as `"default"`, **any verdict produced by a named
phase is rejected by `fix` with exit 2, always**. The escalation was therefore done by hand. Found
only by running the two commands end to end; no test covers the pairing.
