# Run `fog` — open findings carried past integration

Every item below was reported by a phase reviewer, rated below the gate's `blockOn`
threshold (`high`), and knowingly integrated. Each names the reproduction the reviewer
ran, so none of them needs re-deriving from scratch.

## Decided and now implemented

**`rebuild-state` must recover, not refuse, on a section defect in the plan at the anchor.**
`scripts/cli.mjs` (the `rebuild-state` catch, ~:2513). Today it prints `init-run`'s refusal
verbatim and returns 2, so a run whose committed plan carries a fog defect cannot be
recovered at all, and the message names neither `rebuild-state`, nor the anchor sha, nor
the fact that the plan was read from git rather than the working tree — a corrected on-disk
plan does not clear it. Reproduced: commit a plan whose `## Destination` heading has no prose
while `## Out of Scope` exists; fix the working-tree copy without committing; `init-run`
succeeds; delete `.teammates/`; `rebuild-state` then exits 2 and rebuilds nothing.
**Decision (user, 2026-08-22): rebuild what git can vouch for, print a warning naming the
defect, and write `null` / `[]` / `[]` for the three fields.** `rebuild-state` exists to
restore state after `.teammates/` is lost; a defect in a historical committed plan must not
block that.

**Implemented.** `rebuild-state` now degrades the three section fields to `null` / `[]` / `[]`,
prints a warning naming the command, the anchor sha, and the fact that the plan was read from
git at that anchor rather than the working tree, and returns 0 having rebuilt everything git
can vouch for. `init-run` still refuses, because it reads the working tree, where a defect is
fixable and refusing is how a bad plan is caught before a run starts. Pinned by
`rebuild-state recovers from a section defect in the plan at the anchor instead of refusing`
in `tests/cli.test.mjs`; three mutations of the recovery (degrade to non-empty, refuse anyway,
strip the command name and anchor from the warning) were each confirmed to turn it red.

## Unpinned claims — NOW PINNED

All four below were confirmed still unpinned (each mutation left the full suite green), then
pinned, then each mutation was re-run and confirmed to turn the suite red. The `* * *`
thematic-break entry that was in this section is gone: that was a real defect, fixed separately.


- **`scripts/cli.mjs:615` — `printable` on the missing-reason branch.** Reverting it to
  `JSON.stringify(err.entry)` leaves the suite green. The missing-question sibling IS pinned.
  Payload that reaches it: an Out of Scope entry `- Deploy<ESC>[2A<ESC>[0Jrollout` (no
  separator, so the missing-reason branch fires) erases the refusal drawn above it.
- **`scripts/cli.mjs` rebuild-state refusal branch (~:2517).** Replacing the catch body with
  a silent default leaves `tests/cli.test.mjs` at 486/486. The new rebuild-state test only
  covers the success path. Whatever that branch becomes under the decision above, it needs
  its own test.
- **`scripts/plan-sections.mjs:95` — the continuation lookahead's `[-*+]` widening.**
  Reverting the lookahead alone to `-`-only stays green. Only the bullet pattern's class is
  pinned. The two tests named for continuation joining detect the bullet marker, nothing else.
- **`scripts/cli.mjs` init-run ordering.** Moving `assignPhases(parsePlan(...))` above the
  section try/catch stays green. A plan malformed in both ways then reports the task failure
  instead of the promised section refusal.

## Prose that overstated what the code does — CORRECTED

Each claim was checked against the code before rewriting, not just reworded. Four of the five
were wrong and are fixed; the fifth was already accurate.


- **`scripts/plan-sections.mjs:79-81`** — the rationale for widening the lookahead describes a
  failure mode the code cannot produce ("would split a multi-line entry in two"). An indented
  `  * and b` is matched by the bullet pattern first, under both lookaheads. The only real
  change is a bare `  *` / `  +` line, which goes from appended to dropped — the opposite
  direction.
- **`tests/plan-sections.test.mjs:290`** — claims "both halves are pinned here"; the two
  continuation tests pass unchanged under the narrow lookahead.
- **`tests/plan-sections.test.mjs:350`** — still names the lookahead as `-\s|-$`, a pattern the
  widening removed, and its "both mutations" enumeration omits the `*`/`+` half.
- **`tests/plan-sections.test.mjs:286`** — asserts `*` and `+` bullets are "both used in this
  project's own plans". Zero `*` bullets exist; the two `+` lines are inside quoted diff hunks.
- **`scripts/plan-sections.mjs` header** — see the integrator's correction; the "wherever
  cli.mjs writes plan.json" clause was false for the retier write and `rememberRunBranch`.

**Outcome.** The header item needed no change — it already states the bound as "called only
where cli.mjs (re)derives the three fields", and that is accurate: `parsePlanSections` has
exactly two call sites (`init-run`, `rebuild-state`), both derivations, while `writePlan` has
four, the retier and run-branch writes among them. The other four were corrected:
the lookahead rationale described a split the code cannot produce (an indented `  * and b`
parses identically under either lookahead — the bullet pattern claims it first; the real
difference is a BARE marker line, appended when narrow and dropped when wide, the opposite
direction); the "`*` and `+` both used in this project's own plans" claim is false (zero `*`
bullets in docs/plans and docs/specs, every line-start `+` inside a code fence or a JS string);
"both halves are pinned here" named a test that pins only the bullet pattern's class; and the
lookahead was still described as `-\s|-$`, a pattern the widening replaced. Cross-references
now name the tests they mean rather than saying "above"/"below", which had already drifted.

## Behaviour worth a decision — RESOLVED

The `* * *` bullet-injection recorded here was a real defect, not a decision: a spaced thematic
break satisfied the bullet pattern, so `parseConstraints` put `* *` into every teammate brief
and `parsePlanSections` refused a plan whose only defect was a horizontal rule. Fixed — thematic
breaks now outrank list items, per CommonMark. `+ + +` deliberately still parses as a list item,
because `+` is not a thematic-break character.


- **`* * *` parses as a bullet entry** (`scripts/plan-sections.mjs:91`, after the `[-*+]`
  widening). `parsePlanSections` on a plan whose only defect is a spaced horizontal rule
  throws missing-reason with entry `"* *"`, so `init-run` exits 2. Worse, the same shared
  `bulletSection` reaches `parseConstraints`: a `## Global Constraints` section with a
  `* * *` rule between two bullets now yields `["a", "* *", "b"]`, injecting `* *` as a
  constraint into **every teammate brief**. Only the spaced form is affected; `***` and `---`
  do not match, and `- - -` was already broken the same way before the widening. Untested for
  both consumers.

## Accepted, documented exposure

- **Bidi controls at the refusal site** (`scripts/cli.mjs:615`/`:621`) and at
  `scripts/finish.mjs:160`. `printable` passes U+202E through by decision
  (`scripts/reviews.mjs:26-31`) and `JSON.stringify` does not escape it, so in a UAX#9
  renderer the override run can swallow the closing quote. Everything else was defeated: ESC
  CSI, the 8-bit C1 `0x9B`, bare CR, U+2028/U+2029 all render as tokens, and a multi-line
  refusal is unreachable because `bulletSection`'s `[^\n]*` bars a newline from entering the
  entry. The CLI's literal `  - ` indent stays leftmost and `init-run` still exits 2.

## Phase 2 items — CLOSED

- **`scripts/finish.mjs:157`** — `renderPlanNotes` has no input-shape defense: `null` throws,
  and a string `notYetSpecified` renders `  - undefined` rows.
- **`tests/finish.test.mjs:236`** — the forged-`Destination` assertion is vacuous;
  `split('\n')` never splits on U+2028. The test still goes red under the mutation, but via
  its sibling assertions.
- **`tests/phases.test.mjs:246`** — the phase-level assertion is implied by the absolute
  expectations above it; gutting `assignPhases` leaves it green.

## Phase 4 items — CLOSED

All eight were reported against `teammates/fog/T6@380532f`, rated `low`, and knowingly
integrated at merge `2c39ce8`. Line numbers are as of that tip.

Three of them are the same defect seen from different angles — the `if (notes)` guard is
unpinned — and two lenses reached it independently:

- **`scripts/cli.mjs:2882`** (tests, claims) — removing the `if (notes)` guard leaves the
  suite green. `renderPlanNotes` returns `''` for a plan with neither section (the common
  case), so `finish` then prints a stray blank line after the summary for every such run.
  The test that exists to catch this (`tests/cli.test.mjs:2504`, "prints nothing extra when
  plan.json carries no destination or fog") asserts only `doesNotMatch(/Destination:/)` and
  `doesNotMatch(/Not yet specified/)`, never that the output is unchanged. Fix: assert
  `lines.length`, or compare the captured output to the summary alone.

- **`scripts/cli.mjs:2877`** (claims) — the comment justifying `plan ?? {}` claims
  `renderPlanNotes` has no input-shape defense of its own. Deleting `?? {}` leaves the suite
  green: with no `plan.json`, `readState` returns null, the render throws a TypeError, and
  the surrounding try swallows it, so output is byte-identical. The guard is real defense
  that nothing pins; a later author removing it as dead code gets a green suite.

- **`scripts/cli.mjs:2881`** (correctness) — `plan ?? {}` guards only null. A `notYetSpecified`
  that is wrong-shaped but still iterable misrenders rather than being suppressed, and a try
  cannot catch a misrender. `"notYetSpecified": ["a fog item"]` (strings, not `{text, line}`)
  prints `Not yet specified (1 open):` then `  - undefined`; `"notYetSpecified": "ab"` prints
  two `  - undefined` bullets; a non-string `destination` prints `Destination: "[object Object]"`.
  Verified by calling `renderPlanNotes` directly at 380532f. Exit code unaffected — the wrong
  result is the fog count an operator reads. The comment at `:2876-2878` lists "misrenders"
  among what the try handles, which it does not.

- **`scripts/cli.mjs:2880`** (correctness) — notes come from `.teammates/<run>/plan.json`
  while the verdict above them is computed from the plan at the git anchor, so one report's
  two halves can describe different plan versions with nothing marking which. Repro: `init-run`
  on a plan with one fog entry, amend and commit the plan to resolve it, run `finish` without
  re-running `init-run` — the summary still prints `Not yet specified (1 open):` for an entry
  the current plan no longer has. This is the reader the task specified, so it is a
  reporting-freshness limit rather than a wiring error, but no output distinguishes the sources.

- **`scripts/cli.mjs:2882`** (security) — fog lines are uncapped and print *after* the verdict.
  Reproduced against the real `finish` path at 380532f: a `plan.json` with 50,000
  `notYetSpecified` entries printed 50,005 lines (3.1 MB), the last 50,001 attacker-chosen,
  pushing the "do not land" lines to the 3rd and 4th line of output, far above any viewport.
  Entries were `<U+202E>dnal ot ydaer si hcnarb nur eht :sessap esahp yreve N`, which renders
  right-to-left as prose reading like a passing summary. `plan.json` is teammate-writable and
  gitignored, so nothing gates it. The exit code stays 4, so a scripted caller cannot be fooled;
  only a human reading the tail of the terminal can. Mitigation: cap the lines with an "N more"
  tail, or print notes before the summary.

- **`tests/cli.test.mjs:2455`** (claims) — the claim that `finish` reads and prints notes
  *after* the run summary is unpinned. Moving the whole try block above
  `io.out(renderRunSummary(...))` leaves the suite green, because every assertion in the new
  tests uses `lines.join('\n')` with `assert.match` and nothing constrains relative order.

- **`tests/cli.test.mjs:2570`** (claims) — the comment calls the exit-code test's check a
  "never-run check", but the manifest it writes uses `fileset`, which `finish` *does* execute
  and which is precisely what makes both arms exit 0. Swapping in the section's actual
  never-run agent check makes the test fail (`actual: 4, expected: 0`). A maintainer trusting
  the comment and "restoring" the agent check would turn it into a comparison of two 4s,
  no longer exercising the `summary.complete` path the claim is about. The comment also
  contradicts the section preamble at `:2457` ("every case here exits 4").

### Claims the phase 4 review enumerated but never reached

The `claims` lens is bounded by a mutation cap of 8. It probed 8 and left these 6 unprobed —
they are not clean, they are unexamined:

- `tests/cli.test.mjs:2457` — "the checks in these tests never run ... so every case here exits 4"
- `tests/cli.test.mjs:2458` — "a later test pins that the verdict itself never moves"
- `tests/cli.test.mjs:2523` — "`readState` throws on unparseable JSON"
- `tests/cli.test.mjs:2547` — "a `notYetSpecified` entry that is `null` throws reading `entry.text`"
- `scripts/cli.mjs:2874` — "same rule `writePlan` states about its own read"
- `scripts/cli.mjs:2884` — "Swallow and print nothing — see the comment above."

Across all four phases the reviews left **49** enumerated claims unprobed (21 / 11 / 11 / 6).

## Documentation debt — CORRECTED

The plan (`docs/plans/2026-08-20-plan-fog-and-scope.md`, Step 6) and the design spec
(`docs/specs/2026-08-20-plan-fog-and-scope-design.md`) both still say an `## Out of Scope`
section requires only that a `## Destination` heading be *present*. The implemented rule is
stricter and deliberate: the heading must have prose under it, and an empty one is refused
exactly like an absent one (`reason: "missing-destination"`, `line: null`, `entry: null`).
The divergence was raised by the correctness lens in phase 1 and decided by the user. The
reason is recorded in a comment above the check in `scripts/plan-sections.mjs`.

**Corrected.** Both documents now state the implemented rule: an `## Out of Scope` section
requires a `## Destination` **with prose under it**, and a heading with nothing beneath it is
refused exactly like an absent one (verified: `missing-destination` for both). Plan Step 6, the
spec's §2 prose, its dependency sentence and its rules table were each updated, and the code
comment no longer claims the documents disagree with it. The plan's task list and phase
breakdown are unchanged by the edit — T1(p1) T2/T4/T5/T7(p2) T3(p3) T6(p4), exactly what run
`fog` executed.


## Closing summary (autonomous pass)

Everything above that named a defect or a gap is now addressed. What was done, and how each was
verified:

- **`renderPlanNotes` input-shape defense** (phase 2 `finish.mjs:157`, phase 4 `cli.mjs:2881`,
  `cli.mjs:2877` — one root cause, three findings). Each field is checked for its documented
  shape. Unreadable entries are dropped and named when readable fog remains beside them; with
  nothing readable the block is omitted, preserving the contract that a corrupt `plan.json` does
  not perturb the verdict report. The call site passes the plan verbatim and two comments
  claiming the function has no defense are corrected.
- **Fog list capped at 20** (phase 4 security, `cli.mjs:2882`). The 50,000-entry attack now
  renders 22 lines / 1.3 KB instead of 50,005 lines / 3.1 MB. The heading keeps the true total
  and the tail names what was withheld.
- **Staleness advisory** (phase 4 `cli.mjs:2880`). The notes come from `plan.json` and the
  verdict from the plan at the anchor; when the two disagree the report now says so and points
  at `init-run`. Silent when they agree. Four mutations killed, one of which (ignoring
  destination drift) survived the first two tests and required a third.
- **Report ordering pinned** (phase 4 `tests/cli.test.mjs:2455`). Relocating the notes block
  above `renderRunSummary` now fails with a named assertion.
- **Two vacuous assertions repaired** (phase 2). `tests/phases.test.mjs` compared phases between
  two fixtures without an absolute expectation — gutting `assignPhases` left it green; it now
  asserts `[1, 2]`. `tests/finish.test.mjs` split on `\n` to look for a U+2028-forged
  `Destination` line, which that split can never produce; it now splits on every separator a
  renderer may break on.
- **The "never-run check" comment** (phase 4 `tests/cli.test.mjs:2570`) named a `fileset` check
  that `finish` does run, and whose passing is what makes both arms exit 0.

Still open by design: the bidi exposure under **Accepted, documented exposure**, which is a
recorded decision rather than a gap, and the fog/scope entries in the plan's own
`## Not Yet Specified`, which are questions for the operator, not defects.
