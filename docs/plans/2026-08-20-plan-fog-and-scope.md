# Fog of war and out-of-scope in plans

Implements `docs/specs/2026-08-20-plan-fog-and-scope-design.md`.

Three optional header sections — `## Destination`, `## Not Yet Specified`, `## Out of Scope` —
parsed by a new module, compiled into `plan.json`, and reported by `finish`. Nothing enforced reads
them, no verdict depends on them, and no teammate is handed them.

## Destination

`init-run` compiles a plan's fog and scope sections into `plan.json`, refusing a malformed one by
exit code, and `finish` reports them to the operator — with the task list provably unchanged.

## Global Constraints

- Node >= 24.2.0
- Zero new runtime dependencies
- ESM only, `.mjs` for scripts, no TypeScript
- Commit messages: single-line, commitlint style, English
- Every new module gets a `tests/<name>.test.mjs` run by `npm test`
- No `console.log` in `scripts/` — output goes through the `io.out` seam that `cli.mjs` already uses
- Existing `parseConstraints` tests must pass untouched; needing to edit one means behaviour changed

## Out of Scope

- Reducing the plugin's token usage — measured 2026-08-20 and worth its own spec, but a different
  destination from what a plan records
- Enforcing fog at the gate — a verdict must recompute from git, and free-text prose cannot
- A decision record for resolved fog entries — undesigned, and it would change the graduation steps

## Not Yet Specified

- Where does a resolved fog entry go once someone decides it?
- Should `status` show open fog too, or is fog only a landing-time concern for `finish`?

---

### Task 1: the plan-sections module

**Files:**
- Create: `scripts/plan-sections.mjs`
- Test: `tests/plan-sections.test.mjs`

- [ ] **Step 1:** Create `scripts/plan-sections.mjs` exporting `bulletSection(markdown, heading)`,
      `proseSection(markdown, heading)`, `parsePlanSections(markdown)` and `class PlanSectionError`.

- [ ] **Step 2:** Write `bulletSection` by moving the body of `parseConstraints`
      (`scripts/cli.mjs:589`) and generalizing its heading. Preserve all three of its hard-won
      behaviours verbatim, each of which has its own test in `tests/cli.test.mjs` today:
      the section terminates at the next heading of **any** level (`/^#{1,6}\s/m`), not just `##`;
      an indented non-blank line directly under an item joins that item, while a blank line closes
      it; and both patterns use `[^\n]` rather than `.`, because `.` does not match U+2028/U+2029
      while `\s` does. Return `[{ text, line }]` where `line` is the 1-based line number of the
      bullet's first line. Carry the explanatory comments across with the code — they record why
      each rule exists.

- [ ] **Step 3:** Write `proseSection(markdown, heading)`: same heading match and same
      terminate-at-any-heading rule, returning the section's text with surrounding whitespace
      trimmed, or `null` when the heading is absent. Collapse internal runs of whitespace to single
      spaces so a wrapped destination is one line when reported.

- [ ] **Step 4:** Write `PlanSectionError` as a subclass of `Error` carrying `line`, `entry` and
      `reason` as own properties, so a caller can format without re-parsing the message.

- [ ] **Step 5:** Write `parsePlanSections(markdown)` returning
      `{ destination, notYetSpecified, outOfScope }` — `destination` a string or `null`, the other
      two arrays of `{ text, line }`. All three sections are optional; a markdown document with
      none of them returns `{ destination: null, notYetSpecified: [], outOfScope: [] }`.

- [ ] **Step 6:** Enforce the three rules in `parsePlanSections`, each throwing `PlanSectionError`:

      A reason clause is required on every `## Out of Scope` entry. Defined by shape: the entry
      contains an em dash `—`, an en dash `–`, a spaced hyphen ` - `, or a spaced double hyphen
      ` -- `, with at least one non-whitespace character after it. Nothing checks that the text
      after the separator is a *good* reason; that is not decidable.

      A `## Out of Scope` section requires a `## Destination` in the same document. This refusal
      names the missing section rather than an entry, because there is no offending line to quote —
      set `line` to `null` and `entry` to `null` on that error.

      Every `## Not Yet Specified` entry must **contain** a `?`. Containment, not "ends with": a fog
      entry worth reading is a question plus the context that makes it one, and requiring the final
      character to be `?` forbids that context.

- [ ] **Step 7:** Write `tests/plan-sections.test.mjs` covering: all three sections parsed from one
      document; each section absent independently; the empty-document case from Step 5; each of the
      four reason-clause separator forms accepted; a bare noun refused; a fog entry with a `?` mid
      sentence accepted; a fog entry with no `?` refused; out-of-scope with no destination refused;
      and that `line` in each thrown error is the 1-based line of the offending bullet.

- [ ] **Step 8:** For each refusal test, assert the anchor as well as the refusal — the malformed
      entry must actually be present in the fixture the test parses. A refusal that silently stops
      firing reads exactly like a passing test otherwise.

### Task 2: rewire parseConstraints onto the shared extractor

**Files:**
- Modify: `scripts/cli.mjs`

**Depends:** T1

**Model:** mid

- [ ] **Step 1:** Import `bulletSection` from `./plan-sections.mjs` in `scripts/cli.mjs`.

- [ ] **Step 2:** Replace the body of `parseConstraints` (`scripts/cli.mjs:589`) with a call to
      `bulletSection(markdown, 'Global Constraints')`, mapping the result to the bare strings its
      callers expect:

      ```js
      export function parseConstraints(markdown) {
        return bulletSection(markdown, 'Global Constraints').map((item) => item.text)
      }
      ```

- [ ] **Step 3:** Leave a comment above it recording that the extraction rules and the reasons for
      them now live in `scripts/plan-sections.mjs`, so the next reader does not go looking for them
      here.

- [ ] **Step 4:** Run `node --test tests/cli.test.mjs` and confirm every existing constraint test
      passes **without editing any of them**. Do not adjust a test to make it green: an existing
      test that needs changing means the generalization altered behaviour, and that is a Step 2
      defect to fix in `plan-sections.mjs`. Paste the pass count in your result.

### Task 3: compile the sections into plan.json

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`
- Modify: `scripts/plan-sections.mjs`
- Test: `tests/plan-sections.test.mjs`

**Depends:** T1, T2

**Model:** mid

- [ ] **Step 1:** Import `parsePlanSections` and `PlanSectionError` from `./plan-sections.mjs`.

- [ ] **Step 2:** In the `init-run` handler (`scripts/cli.mjs:1775`), after the plan file is read
      into memory and before `assignPhases(parsePlan(...))` runs, call `parsePlanSections` on the
      same markdown inside a `try`. Read the file once and pass the text to both parsers; do not
      read it twice.

- [ ] **Step 3:** Catch `PlanSectionError` and print a refusal through `io.out`, then `return 2` so
      the run is not created. Format for an entry-level error:

      ```
      plan defect: Out of Scope entry 2 (line 34) has no reason.
      An entry without a reason is not a scope boundary — it is a word.
      Write what it is, and why it is beyond the destination.

        - Caching
      ```

      and for the missing-destination error, which has no offending line:

      ```
      plan defect: this plan has an Out of Scope section but no Destination.
      Out of scope means beyond the destination, so without one there is
      nothing to judge an entry against.
      ```

      Re-throw anything that is not a `PlanSectionError` — a read error is not a plan defect and
      must not be reported as one.

- [ ] **Step 4:** Add `destination`, `notYetSpecified` and `outOfScope` to the object `init-run`
      hands to `writePlan`, so they land in `plan.json`. `writePlan` is the only writer of that file
      and spreads `...rest`, so no change is needed inside it.

- [ ] **Step 5:** Add to `tests/cli.test.mjs`: an `init-run` over a plan carrying all three sections
      writes them into `plan.json` with the same shapes Task 1 produces; an `init-run` over a plan
      with none of them writes `destination: null` and two empty arrays; and a plan whose fog entry
      lacks a `?` exits 2 with the run directory not created.

- [ ] **Step 6:** Assert the exact refusal text for one entry-level case, including the line number
      and the quoted entry, so a message that degrades into something unactionable fails here.

- [ ] **Step 7:** Accept every CommonMark bullet marker, not just the hyphen. `bulletSection`
      in `scripts/plan-sections.mjs` matches `-` only, so a section written with `*` or `+` yields no
      entries at all and every refusal Step 3 adds is skipped: a reasonless Out of Scope entry and a
      questionless fog entry both pass `init-run` with exit 0, and `plan.json` then disagrees with the
      plan a reader sees. Widen the marker to a `[-*+]` class in BOTH the bullet pattern and the
      continuation lookahead — widening one without the other splits a multi-line entry. Pin it in
      `tests/plan-sections.test.mjs` with all three markers, including a continuation line, and pin
      that an entry-level refusal still fires for a `*` bullet.

### Task 4: the leak regression

**Files:**
- Test: `tests/phases.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Add a test to `tests/phases.test.mjs` building two plan markdown strings that are
      identical except that one carries `## Destination`, `## Not Yet Specified` with three entries,
      and `## Out of Scope` with two, while the other has none of the three sections.

- [ ] **Step 2:** Assert `parsePlan` returns the same task list for both — same ids, same titles,
      same declared files, same deps — by deep-equality on the parsed arrays.

- [ ] **Step 3:** Assert `assignPhases` gives both the same phase assignment.

- [ ] **Step 4:** Write the comment that says why this test is worth more than it looks:
      `scripts/phases.mjs` reads an empty file list as "conflicts with nothing", so every task with
      no declared files lands in phase 1. If a fog or out-of-scope entry ever leaked into the task
      list, each note would become a phase-1 teammate with no declared files, dispatched against a
      question. This test is the thing standing between that and a green run.

### Task 5: finish reports fog and destination

**Files:**
- Modify: `scripts/finish.mjs`
- Test: `tests/finish.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Add `renderPlanNotes(plan)` to `scripts/finish.mjs`, taking the parsed `plan.json`
      object and returning a string, or `''` when there is nothing to report. Pure — it reads no
      files and takes no `io`.

- [ ] **Step 2:** Render the destination when present, and the open fog entries with their count:

      ```
      Destination: the gate can answer "is this run landable" without an operator
                   reading prose.

      Not yet specified (2 open):
        - How should finish report a phase whose reviewers disagreed?
        - Does the map's coupling data belong in the gate at all?
      ```

      Omit either block when its field is absent or empty, and return `''` when both are.
      `outOfScope` is compiled into `plan.json` but is not reported here: it is a charting-time
      record, not a landing-time one.

- [ ] **Step 3:** Write the comment stating what this function must never become: it reports, and
      the verdict is computed elsewhere and is not affected by anything it returns. A run with open
      fog is exactly as landable as the same run without it. Making a verdict turn on these fields
      would put landability behind free-text prose that the enforced agents can write.

- [ ] **Step 4:** Add tests to `tests/finish.test.mjs`: destination alone renders only that block;
      fog alone renders only that block with the right count; both render both; neither returns `''`;
      and a plan carrying `outOfScope` entries renders nothing for them.

### Task 6: wire the report into the finish command

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T5

- [ ] **Step 1:** Import `renderPlanNotes` alongside the existing `finish.mjs` imports at
      `scripts/cli.mjs:29`.

- [ ] **Step 2:** In the `finish` handler, after `io.out(renderRunSummary(runId, phaseResults))` at
      `scripts/cli.mjs:2823`, read the run's plan with `readState(root, runId, 'plan')` inside a
      `try`, call `renderPlanNotes`, and `io.out` the result when it is non-empty.

- [ ] **Step 3:** Swallow a read failure and print nothing. `plan.json` is teammate-writable and a
      corrupt one must not crash the command that reports the verdict — the same rule `writePlan`
      already states about its own read. Comment it as that rule, not as defensive coding.

- [ ] **Step 4:** Confirm the exit codes are untouched: the value returned by `finish` must be
      identical with and without plan notes present. State in your result which lines you checked.

- [ ] **Step 5:** Pin all four steps above in `tests/cli.test.mjs`: that `finish` prints the
      destination and the open fog entries when `plan.json` carries them; that it prints nothing
      extra when it does not; that a corrupt or unreadable `plan.json` leaves `finish`'s output and
      its exit code unchanged rather than crashing; and that the exit code is byte-identical with
      and without notes present. A wiring step that nothing pins is indistinguishable from one that
      was never wired.

### Task 7: the skills say what the code does and does not do

**Files:**
- Modify: `skills/writing-plans/SKILL.md`
- Modify: `skills/parallel-execution/SKILL.md`

**Depends:** T1

- [ ] **Step 1:** In `skills/writing-plans/SKILL.md`, add a section after `## Global Constraints`
      documenting the three sections with the example from the spec, stating that all three are
      optional and that `## Out of Scope` requires `## Destination`.

- [ ] **Step 2:** State the fog-or-task test in the form the spec settled on, which turns on
      dispatchability rather than sharpness:

      > Can you write it as a task — a declared file set, and acceptance criteria a green suite
      > would satisfy? If yes, it is a task, even when it is blocked and cannot be worked yet. If
      > no, it is Not Yet Specified, however sharply you can phrase the question.

      With the consequence: do not pre-slice fog into task-shaped pieces. One fog entry may graduate
      into three tasks, or into none.

- [ ] **Step 3:** State both entry rules and what each is for — a reason clause makes a boundary
      reviewable, a question mark keeps fog from becoming a dumping ground for unsized work.

- [ ] **Step 4:** State plainly that nothing enforced reads these sections: no check consults them,
      no verdict depends on them, no teammate is handed them, and `init-run`'s shape rules are the
      only enforcement. They check shape, not truth. Do not write a sentence that implies otherwise
      — prose claiming a guarantee the adjacent code does not provide is the most common defect
      this repository's reviews find.

- [ ] **Step 5:** State that an `## Out of Scope` entry does not answer a reviewer's finding. A
      finding relocated there is still a finding, and moving it changes nothing about whether it is
      real. The mechanical rules cannot catch this: a well-formed entry with a plausible reason is
      exactly what silencing a finding would look like to a parser.

- [ ] **Step 6:** In `skills/parallel-execution/SKILL.md`, add one paragraph to
      `## Amending a plan mid-run` stating that graduating a fog entry into a task is that
      operation: edit the plan, commit on the base branch, merge `--no-ff` into the run branch,
      re-run `init-run` so `plan.json` is recompiled, rebase in-flight branches. No new command
      exists for it, and a working-tree edit is inert because the gate reads the plan from git at
      the anchor.

- [ ] **Step 7:** Run `node --test tests/skill-contracts.test.mjs`. If the corpus lock for the
      SubagentStop mechanism fails, a sentence you added or moved names that mechanism — update the
      locked inventory in `tests/skill-contracts.test.mjs` deliberately, in a separate step, and say
      in your result which sentence changed and why. Do not silence the lock by rewording around it.
