# Run `fog` — open findings carried past integration

Every item below was reported by a phase reviewer, rated below the gate's `blockOn`
threshold (`high`), and knowingly integrated. Each names the reproduction the reviewer
ran, so none of them needs re-deriving from scratch.

## Decided, not yet implemented

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

## Unpinned claims — the code is right, nothing holds it there

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

## Prose that overstates what the code does

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

## Behaviour worth a decision

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

## Phase 2 items still open

- **`scripts/finish.mjs:157`** — `renderPlanNotes` has no input-shape defense: `null` throws,
  and a string `notYetSpecified` renders `  - undefined` rows.
- **`tests/finish.test.mjs:236`** — the forged-`Destination` assertion is vacuous;
  `split('\n')` never splits on U+2028. The test still goes red under the mutation, but via
  its sibling assertions.
- **`tests/phases.test.mjs:246`** — the phase-level assertion is implied by the absolute
  expectations above it; gutting `assignPhases` leaves it green.

## Documentation debt, no owner

The plan (`docs/plans/2026-08-20-plan-fog-and-scope.md`, Step 6) and the design spec
(`docs/specs/2026-08-20-plan-fog-and-scope-design.md`) both still say an `## Out of Scope`
section requires only that a `## Destination` heading be *present*. The implemented rule is
stricter and deliberate: the heading must have prose under it, and an empty one is refused
exactly like an absent one (`reason: "missing-destination"`, `line: null`, `entry: null`).
The divergence was raised by the correctness lens in phase 1 and decided by the user. The
reason is recorded in a comment above the check in `scripts/plan-sections.mjs`. No task owns
correcting the two documents.
