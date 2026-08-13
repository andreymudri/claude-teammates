# Follow-ups from run `followups2`

Every item here is a finding the run `followups2` review passes produced and did not block on, plus
three structural items the run surfaced by costing time rather than by being reviewed. Nothing here
is a defect in shipped behaviour: the tree at `master` `fff2307` is 1511 pass / 0 fail. These are
claims that outrun their code, tests that pin nothing, and two operational traps.

One item that was on this list has been removed rather than done: the "reviewer contract defect".
`agents/tm-reviewer.md` was believed to say the return value is a bare array of findings. It does
not, and it did not at any point in run `followups2` — commits `ae0e6ad` and `3856481` were already
on `master` before the run began. The reviewers that wrote the wrong shape departed from a correct
contract, and the hand-written dispatches that omitted the stamp were the real deviation. Do not
"fix" that file.

## Global Constraints

- Node >= 24.2.0
- Zero runtime dependencies and zero dev dependencies; tests use the built-in `node:test` runner
- git >= 2.24; every git invocation passes `--end-of-options`, and a trailing `--` wherever the
  command accepts a pathspec. One tested exception exists in `scripts/git.mjs`'s `ignoredPaths`;
  measure before adding a second.
- Commit messages: single-line, commitlint style, English. Never mention or attribute Claude or any
  AI in a commit message.
- New commits only; never `git commit --amend`
- No check may read anything under `.teammates/`
- Run the suite from a Git Bash shell, in the FOREGROUND. Never background a command: two
  implementers in run `followups2` stalled forever waiting on a notification a backgrounded command
  never sends, and Task 5 exists because of it.
- A comment states what the code does, never a guarantee it does not deliver. Run `followups2`
  shipped an overstated sentence in ten consecutive rounds of one file; four of the tasks below
  exist to remove the survivors. Do not add an eleventh.
- Verify by mutation: break what a claim protects, run the suite, and record which named test
  fails. A claim whose mutation leaves the suite green is not pinned.

### Task 1: close the swallow-wrapper route and correct the marker comment's history

**Files:**
- Modify: `tests/hook.test.mjs`

- [ ] **Step 1:** The source-text leg at the mechanism test compares `body.toString()`. That is an
  own property the substitute controls, so a swallow wrapper carrying its own `toString` satisfies
  it. Verified at `a28c250`: substituting at the `registerHookCase` call site

      register(name, Object.assign(function (...a) { try { return fn(...a) } catch {} }, { toString: () => fn.toString() }))

  runs 48 pass / 0 fail / 0 skipped in 13.5s against an 11-13s healthy baseline — no timing tell.

  Replace the comparison with `Function.prototype.toString.call(body)`, which reads the function's
  real source and ignores an own `toString`. The tests lens verified this exact change turns the
  attack red and leaves a clean tree green.

- [ ] **Step 2:** Add a test that pins it: register a case through a wrapper carrying an own
  `toString` returning the real body's source, and assert the mechanism test fails. Confirm the new
  test FAILS with Step 1 reverted.

- [ ] **Step 3:** The comment above `hookBodyRuns` says "Ten consecutive rounds of this comment have
  each named a price for forging these markers". That overstates its own history — the comment
  existed in four rounds, not ten. Correct the count, or drop the count and keep the claim that
  every previous attempt to state a price was falsified, which is true.

- [ ] **Step 4:** Re-read every sentence in the marker and mechanism comment blocks against the code
  as it stands after Step 1. The source-text leg's residue changes: an own `toString` no longer
  defeats it, so any sentence describing that as an open route must be corrected too. State the
  residue that remains — a stub whose real source text matches the case's own slice.

### Task 2: pin the bounded-note total and neutralise the two remaining reviews.mjs values

**Files:**
- Modify: `scripts/reviews.mjs`
- Test: `tests/reviews.test.mjs`

- [ ] **Step 1:** `boundedNote`'s total is unpinned across more than one lens. The only fixture has
  one lens with one unprobed count, so `bounded.reduce((n, u) => n + u.count, 0)` can be replaced by
  `bounded[0].count` or `bounded.length` and the whole 1511-test suite stays green. Add a fixture
  with TWO bounded lenses carrying different counts and assert the rendered total is their sum.
  Confirm both mutations fail it.

- [ ] **Step 2:** `boundedNote` splices `u.lens` into its sentence unwrapped, while the sibling site
  in `reviewStale` wraps a lens at the same trust level with `printable`. Wrap it, and add a byte
  assertion — `Buffer.includes(0x1b) === false` — that fails without the wrapper.

- [ ] **Step 3:** `reviewFileName` validates `lens` as a filename component (no separators, no
  traversal, non-empty) and joins `phase` with no validation at all. Apply the same validation to
  `phase`, or state at the site exactly what constrains it upstream and name the test that pins that
  constraint. Do not write that it is safe without naming what makes it safe.

### Task 3: correct three overstated test comments and wrap the run id

**Files:**
- Modify: `scripts/cli.mjs`
- Modify: `scripts/finish.mjs`
- Test: `tests/cli.test.mjs`

- [ ] **Step 1:** `scripts/finish.mjs`'s summary header splices `runId` raw while every neighbouring
  value is wrapped. `runId` is operator-supplied rather than teammate-controlled, so this is not the
  same hazard — but the asymmetry reads as an oversight. Wrap it with `printable` for consistency,
  and say in the comment which values on that line are teammate-controlled and which are not.

- [ ] **Step 2:** `scripts/cli.mjs`'s `--phase` comment says "Only whitespace can arrive that way,
  never attacker-chosen text". `Number.isInteger(Number(x))` also admits `0x1`, `1.0`, `1e0`, `+1`,
  and the whitespace-class characters ` `, ` `, `﻿`. None carries a control byte, so
  the wrapper's justification is unharmed — but "never attacker-chosen text" is false for `0x1`.
  Restate the bound as what it is: the value reaches the printed line as a non-integer spelling of an
  integer, and every consumer downstream is `Number(flags.phase)`.

- [ ] **Step 3:** `tests/cli.test.mjs`'s derivation says it subtracts "the four `import` lines";
  there are three matching the grep. Correct the number, and re-derive the count mechanically rather
  than editing the digit — the header has been wrong three rewrites running because it was written
  from a summary rather than from the grep.

- [ ] **Step 4:** The same file says "no fixture in this suite can force that" for the
  `preview-check` GitError branch. A POSIX-only fixture can: a `preview.link` entry of `:(bogus)docs`
  passes every `validateLinkPaths` rule, and `git ls-files --error-unmatch -z -- ':(bogus)docs'`
  exits 128 with `fatal: Invalid pathspec magic 'bogus'`. The name is illegal on Windows, so no
  cross-platform fixture exists. Restate it as "no fixture that runs on every platform this suite
  targets", which is what was measured.

- [ ] **Step 5:** The same file's `map-notes --near` limit is honestly framed and explicitly not
  vouched for, but its reason clause says the paths are "not read out of an agent-written file",
  which understates the hazard: the paths are agent-AUTHORED — a teammate chooses one by committing
  a file with that name. Correct the reason without changing the scope decision.

### Task 4: make the phases invariant comment true, or make it tested

**Files:**
- Test: `tests/phases.test.mjs`

- [ ] **Step 1:** The "Key invariant" comment claims the test proves a relationship between
  `normalizeDeclarePath` and `enforce.mjs`'s `normalizePath`. The file imports only `assignPhases`
  and never calls `normalizePath`, so the stated implication is checked nowhere in it: appending
  `.toLowerCase()` to `normalizePath` leaves all phases tests green while `filesetViolations` starts
  treating `A.mjs` and `a.mjs` as one file. The mutation IS caught — by `tests/enforce.test.mjs`, a
  different file than the one claiming to enforce it.

  Choose ONE and do it fully:
  (a) import `normalizePath` and assert the implication directly, so the comment becomes true here; or
  (b) rewrite the comment to state only what this file tests — that the four spellings collapse to
      one declared path — and point at `tests/enforce.test.mjs` as the file that pins the
      relationship to `normalizePath`.

  Option (b) is preferred unless (a) is genuinely cheap: the honest fix for a comment that claims
  more than its file does is usually the comment.

- [ ] **Step 2:** Whichever you choose, confirm by mutation. For (a), the `.toLowerCase()` mutation
  must fail a test in THIS file. For (b), verify the named test in `tests/enforce.test.mjs` really
  does catch it, and quote its name in the comment.

### Task 5: make a stalled teammate's liveness row say what to do about it

**Files:**
- Modify: `scripts/liveness.mjs`
- Test: `tests/liveness.test.mjs`

- [ ] **Step 1:** `livenessRows` already computes `stalled` from the git tip and worktree mtime, so
  detection exists and needs no change. What is missing is that the row does not tell the operator
  the most common cause. Twice in run `followups2` an implementer backgrounded its test command and
  then waited for a notification that a backgrounded command never sends; each was recovered by
  resuming the same agent with an instruction to run in the foreground, which preserves its context,
  where a respawn would have discarded it.

  Have `renderLiveness` print, for each `stalled` row and only for those rows, one additional line
  naming that cause and that recovery. Keep it to one line per row.

- [ ] **Step 2:** Pin it: a fixture with one stalled row and one working row must produce the hint
  exactly once, attached to the stalled row. Assert the working row does NOT carry it. Confirm the
  test fails with the hint removed.

- [ ] **Step 3:** Do not change `hasStall`, `hasUnknown`, the exit codes, or what any row's `state`
  is computed from. This task adds a line of output and nothing else. Say so in the comment, and do
  not write that liveness detects backgrounded commands — it detects an absence of progress, and the
  hint names the most common cause of that absence, which is not the same claim.

### Task 6: record the two operational traps this run paid for

**Files:**
- Modify: `docs/specs/2026-08-05-tamper-evident-enforcement-design.md`
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/fleet-supervision/SKILL.md`
- Test: `tests/skill-contracts.test.mjs`
- Test: `tests/skills.test.mjs`

**Depends:** T5

- [ ] **Step 1:** Add the stacked-run limit to the tamper-evident spec's out-of-scope list. Run
  `followups2` used `run/claims` as its base branch, which is another run's deliverable branch. The
  documented amendment procedure says commit an amendment on the BASE branch, so three plan
  amendments landed on `run/claims` — and `ownership`, evaluated for run `claims`, correctly reports
  them as reachable from no task branch of that run and from no ancestor of ITS base. The result is
  permanent: `run/claims` can never pass its own gate again. Nothing was rewritten to hide it.

  State the rule plainly in `skills/parallel-execution/SKILL.md`'s amendment section: branch a run's
  base from the default branch, not from another run's branch. If work genuinely stacks, land the
  first run before starting the second.

  Do NOT add an ownership exception for this. Every exception is a way to launder an unowned commit,
  and one that accepts anything on a parent run's branch would accept exactly what the check exists
  to catch.

- [ ] **Step 2:** Record the import-coupling trap in the same skill, in the integration section: a
  task whose file set imports a symbol another task introduces cannot build on its own branch, and
  merging it first produces a commit whose tree cannot load. In run `followups2`, T2's `doctor.mjs`
  imported `printable` from T3's `reviews.mjs`; merging T2 first would have left `cli.mjs --help`
  dying at import. The integrator must merge in dependency order, and a revert of the providing task
  breaks every consumer — not only the feature that motivated it.

- [ ] **Step 3:** Add the stall recovery to `skills/fleet-supervision/SKILL.md`, pointing at the
  `liveness` hint Task 5 adds: a teammate that returns a status with no tip sha and no evidence, or
  that reports it is waiting on something, has stalled. Resume THAT agent with an instruction to run
  in the foreground rather than respawning it; a respawn discards the task's whole context, and a
  returned teammate's worktree keeps its branch checked out, so a fresh dispatch fails with "already
  used by worktree" until that worktree is pruned.

- [ ] **Step 4:** If `tests/skill-contracts.test.mjs` or `tests/skills.test.mjs` pins any sentence
  you rewrite, update the pin in the same commit and make its name state what it now pins. Do not
  weaken a pin to make an edit fit.
