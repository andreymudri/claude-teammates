# Handoff — run `substop`, phase 3

Written 2026-08-16. Supersedes `2026-08-15-substop-phase2-handoff.md`; read that one only for
phase-2 review history. **Phases 1 and 2 are merged, gated and integrated. Phase 3 has not started.**

## State

- Plan: `docs/plans/2026-08-13-subagent-stop-enforcement.md`, amended six times
- Evidence: `docs/specs/2026-08-13-agent-teams-probe-findings.md`
- Base: `master` @ `32c6a47` · Run branch: `run/substop` @ `272bd75` · merge-base: `fbe2150`
- Phases: **P1 `T1 T2 T3` (merged) · P2 `T4 T5` (merged) · P3 `T6 T7 T8`**

Phase 2 integrated as:

```
272bd75  docs: re-measure spec citations of cli.mjs against the integrated tree
9131715  docs: re-measure state.mjs citations of cli.mjs against the integrated tree
3af2fbc  merge: wire the SubagentStop hook into cli, brief and gate-runner from T5
e14566b  merge: add SubagentStop hook script and its test suite from T4
```

Recorded gate PASS for phase 2, all five checks (merge, test, fileset, ownership, review), pinned at
T4 `998d90b` / T5 `b13ee41`. All nine integrated blobs verified byte-identical to their reviewed
tips. Suite on the integrated run branch: **1746 tests / 1744 pass / 0 fail / 2 skip**, win32 node
v24.14.0, ~308s.

Frozen task tips: T1 `e507ac0` · T2 `9e8be2d` · T3 `8696d33` · T4 `998d90b` · T5 `b13ee41`.
Fix rounds: P1 `T1:12 T2:7 T3:18` · P2 `T4:6 T5:6`.

Phase 3 dependencies, all satisfied: **T6** → T2, T5 · **T7** → T4 · **T8** → T4, T5.

## FIRST — check this before dispatching phase 3

**Two commits on the run branch belong to no task branch**: `9131715` and `272bd75`, the citation
re-measurements. They are original content, not merges from master.

Phase 2's `ownership` check printed *"accepted 3 commits by ancestry of base branch master rather
than any task branch of this run"* for `d925599`, `d3358d5`, `e83c9da` — all merges that carried
master's content. **The two citation commits have no such ancestry**, and phase 3's anchor may place
them inside `anchor..run`. Whether `ownership` accepts them is **unverified**.

Check it before dispatching, not at the gate:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" gate --run substop --plan docs/plans/2026-08-13-subagent-stop-enforcement.md --root <root>

If `ownership` fails on them, the fix is to get them into `master` (making them base-ancestors)
rather than to widen any file set. **Do not add further non-task commits to `run/substop`** — this
handoff is on `master` for exactly that reason.

Note also `gate --run X` gates whatever is checked out, and fails confidently rather than erroring if
HEAD is elsewhere. Confirm the main worktree is on `run/substop` first.

## The bar (operator-set, unchanged)

**Green gate, zero high, zero medium. Lows are documented and carried.** If a session hook says
"no low", the amended bar wins.

## Owed before or during phase 3 — four spec corrections, all prose

`docs/specs/2026-08-10-agent-teams-adoption-design.md` is **T1's file, merged and frozen**, so no
task branch can fix it. The operator's decision on 2026-08-16 was **record as follow-up, do not fix
yet**. All four are claims T5 made false — not stale numbers. Correcting the numbers without the
prose would make false statements look freshly verified.

1. **Spec lines 167-169, the exit-4 bullet.** Says a recomputed gate rejection exits **4**. T5 added
   `const COMPLETE_REJECTED = 3` (`scripts/cli.mjs:900`); a rejection now exits **3**, and 4 is
   `COMPLETE_CANNOT_VERIFY` only. The cited test no longer exists — it is now
   `tests/cli.test.mjs:3208`, *"complete exits 3 when the recomputed gate rejects the task"*.
2. **Spec line 178.** Says `complete` does not carry `--enforcement-only` in its known-flag table, so
   the invocation "is refused as a bad argv". It **does** now: `scripts/cli.mjs:250`. The paragraph
   and its conclusion — *"This design therefore requires a new exit code"* — describe a pre-T5 tree
   and the design has since shipped.
3. **Spec line 158, the exit-0 bullet.** Now true of one of two exit-0 paths. T5 added an earlier
   `return 0` at `scripts/cli.mjs:3663` for `--enforcement-only` that deliberately does not write
   `status.json`. Incomplete rather than wrong.
4. **The false-PASS bound**, open since round 7. The spec says no forgery under `.teammates/` reaches
   a false gate PASS. True of `.teammates/`; **false of `teammates.gate.json`**, a different file with
   the same writability. Fixed in code (Step 3d) but the spec's bound was never restated.

**Pre-existing, untouched by this phase, out of scope:** the spec at ~line 302 cites
`docs/plans/2026-08-13-subagent-stop-enforcement.md:502-513` for a precheck emitting
`git checkout -B ${branch} <base>`. That range holds no such text; the passage is at **line 535**,
and it reads as the plan *forbidding* the instruction, not prescribing it — so the contradiction the
spec asks to reconcile may already be resolved. Verify before acting.

## T8 owns a live enforcement window

**The skill-order residual.** A phase dispatched directly (fewer than three tasks) before any
lifecycle command runs on the run branch has no recorded `runBranch`, so the guard **fails open**.
The fix is `skills/parallel-execution/SKILL.md` checking out the run branch before step 1. Assigned
to T8, which owns skills. This is the one phase-3 item that closes a real hole rather than
documenting one.

## Carried lows — 13, documented, not fixed

```
scripts/brief.mjs:180           the `!== ''` filter eats literal spacer lines
scripts/state.mjs:105           index not run-scoped, never pruned, worktree path reuse
scripts/state.mjs:184           defunct reason given for a live guard
scripts/state.mjs:~481          planting harm stated unconditionally (T3 frozen deliberately)
scripts/state.mjs:225-228       says the id rule refuses `;` "which init-run currently accepts" — now false
tests/state.test.mjs:1066       exhaustiveness claim false for one alternative
tests/state.test.mjs:1078       the C0 row covers nothing — JSON.stringify escapes it first
tests/state.test.mjs:1566       anti-drift import claim has no pinning test
tests/brief.test.mjs:194        Math.round mutant survives; both fixture confidences are exact
scripts/cli.mjs:2495            the '(none)' arm of rebuild-state's report line is unpinned
scripts/cli.mjs:973             the runBranch destructure claim is unpinned (benign divergence)
cli.mjs + cli.test.mjs          the plan.json writer pin is incomplete: a space or newline before the
                                paren, and a `//` inside a string literal, all walk past it
gate-runner.mjs:107 +           the getter clause is falsified three ways; nothing pins the behaviour
tests/gate-runner.test.mjs:1220 either way. **Delete the clause if ever touched — never restate it.**
```

Give this list to every reviewer. A lens that re-reports a carried low spends budget on noise.
**Remove an entry the moment it is fixed**, or it stays suppressed after it stops being true.

## Accepted residuals — do not re-litigate

- **The fabricated-repository plant.** A `.git` file naming a second, attacker-built repo satisfies
  containment. Accepted with no code change after both candidate discriminators were built and
  measured: the parent-enclosing check is defeated by one more `.git` file, and walking all the way
  up refuses the legitimate B-inside-A configuration. Ceiling: one forced retry, no false gate PASS,
  branch clamped, no command named.
- **The plan.json writer pin's incompleteness.** Operator-decided 2026-08-15: **delete enumerations,
  do not widen the scanner.** Three rounds of prose listing what it catches and misses were each
  found incomplete by the next reviewer.
- **T4's `commonDir === gitDir`** is redundant-but-documented: containment already excludes the main
  worktree; deletion changes no verdict; kept as the explicit statement of that case.
- **The key-agreement check buys exactly one thing**: a record cannot be filed under key A while
  naming directory B. It does not stop a record being planted for someone else's directory.
- **The design does not predict what happens after a forged record causes harm.** Five rewrites tried
  to state the ordering; all five were falsified by probing; the sixth deleted the taxonomy. Do not
  restore it.
- **Enforcement is tamper-EVIDENT, not tamper-proof.** A teammate runs its own tests, which is
  arbitrary execution. Findings reducing to "a determined teammate could subvert this" are out of scope.

## Settled decisions — do not re-open

- **`complete --enforcement-only` returns 3 only for a task-scoped check** (`fileset`, `merge`).
  Run-wide failures and anything that could not run return **4**, which the handler allows. A failing
  `command` check returns 4 deliberately — the suite tests the merged tree.
- `COMPLETE_REJECTED = 3` is pinned across files: `tests/brief.test.mjs` and
  `tests/subagent-stop.test.mjs` both read the constant out of `cli.mjs` source. The handler's own
  status to the harness is a different vocabulary: `ALLOW = 0`, `BLOCK = 2`.
- `rememberRunBranch` is **fill-if-absent, absolute**; `complete` never refreshes. A poisoned record
  is deliberately unrepairable by any automatic writer — the price of never replacing a good value.
  `init-run` prints the recorded branch whenever it differs from the checkout, so it announces itself.
- **A check `kind` must be a string before anything is decided from it** (`hasUsableKind`,
  `gate-runner.mjs`). Enforced at the runner lookup, not at any caller's filter — a filter-only fix
  closes execution and leaves the false PASS.
- `narrowChecks` is the only way to narrow a manifest check list before `runChecks`; it returns the
  list and its manifest positions together. That is a convention, not a guarantee.
- Ids use `/^[\p{L}\p{M}\p{N}._-]+$/u`, no component `.` or `..`, no leading `-`. ZWJ/ZWNJ refused per
  UAX #31; cross-script confusables an accepted limit. Ref legality lives with git, not `state.mjs`.
  The UNC query cost is accepted, not guarded.

## Host quirks — these cost several reviewers real time

- **`npm test` is the suite.** `node --test tests/` (directory form) fails MODULE_NOT_FOUND.
- **The merged-tree suite now runs ~624s and exceeds the 600s foreground cap.** Decide per-file
  failures on the cited file and escalate only a survivor, or split into halves. T5's branch alone is
  ~297s. Do not background a probe run — a mutation harness in this project once outlived its agent
  and committed a disabled guard. Verify the blob, not the tree.
- **Run suites strictly sequentially**, output to a file, read the exit status **directly**.
  Concurrent runs produce `fatal: Out of memory` from `git checkout`, and **piping through `tail`
  masks the exit code** — a reported "exit 0" may be `tail`'s.
- Under the default sandbox every `execFileSync('git', …)` fails with `spawn UNKNOWN` (errno -4094)
  and the whole suite reads red. Use `dangerouslyDisableSandbox`.
- **State the invocation, not the platform.** `wsl -e bash -lc` resolves `/usr/bin/node` = v18.19.1,
  below `engines >=24.2.0`, and produces 4 spurious failures. An absolute nvm path gives v24.18.0.
- Worktree paths must be **all forward slashes**; a mixed path gets mangled and creates the worktree
  *inside* the repo.
- **Verify every mutant landed.** A `perl`/`sed` substitution that silently fails to match produces a
  green run that reads as "mutant survived".
- Orphaned `tm-*` temp repos accumulate from interrupted runs — `withRepo`'s `finally` never runs when
  a harness is killed. Cheap to clear. `jsconfig.json` on master bounds tsserver; keep it.

## Defect classes — phase 2 confirmed all of phase 1's and added these

- **An enumeration is wrong the moment it is written, not only when it goes stale.** A comment said a
  `try` failed to rescue "the two dereferences around it". There were three. It had previously been
  wrong at one. **Never pair an enumeration with a remedy derived from it** — the miscount was
  cosmetic; "closing this would mean wrapping those reads" was harmful, because it is a fix that goes
  green and leaves the hole.
- **Deletion beats rewriting, measurably.** In round 11, three findings dispatched as *delete the
  clause* all came back clean; the one dispatched as *rewrite it* introduced the next round's finding.
  **When briefing a fix to an overstated claim, say "delete it", not "correct it to X"** — specifying
  X makes the next reviewer's finding yours. The wrong count above came from the dispatch, not the
  implementer.
- **A bound true of one path, stated as a property of the whole.** Phase 2's dominant class, and it
  recurred to the last round: one sentence in `gate-runner.mjs` was falsified three different ways by
  two lenses, each correct about what it measured.
- **A claim confirmed twice can still be narrow rather than true.**
- **A check that passes is not evidence until you have shown it can fail.** Round 11's inertness proof
  reported two positive controls; round 12 found both were degenerate — one resolved its site with
  `indexOf` returning `-1`, the other found no site and skipped silently. The conclusion happened to
  be right and the evidence was not there.
- **Merge-only defects.** A file:line correct on every branch and wrong in the merge. Found in both
  phases. Only the lens that builds the merged tree can see them.
- **A defence built against the obvious members of a class.** `gate-runner.test.mjs` pinned
  `'toString'`, `'constructor'`, `'__proto__'` — all strings. The array spelling is what JSON expresses.

## Method that worked

- Four unnamed `tm-reviewer` lenses per round at `capable`/opus: `correctness`, `security`, `tests`,
  `claims`. Stamps from `review-dispatch`. **Never name a reviewer** — a named one goes idle without
  emitting its result.
- **Tell each lens what changed, what it previously found, and which findings are accepted.**
- **Say explicitly that a clean round is a real outcome**, or pressure to produce something distorts
  severity. Three of four lenses returned zero findings in round 11 and it was correct.
- **Aim a lens at auditing an acceptance, not at re-arguing it.** That is what found round 7's high.
- **Give a lens the specific thing you are unsure of, framed as unsettled, and tell it to measure
  rather than accept your reasoning.** In round 12 this produced a correction to the orchestrator's
  own analysis — I claimed a clause was loose but its conclusion sound; a stateful getter falsified
  the conclusion.
- **Pin cross-task constants centrally in the dispatch.** Two parallel halves diverging produced two
  separate highs.
- **Read every implementer diff yourself before re-stamping.** This caught a defect in each of three
  consecutive fix rounds — a mislabelled `gate-computed kind`, a claim that JSON can express
  `undefined`, and a position defect on a filter path the fix had missed. All would have cost a full
  four-lens round otherwise.
- **Re-measure every line number in the tree you are citing.** I handed a teammate `gate-runner.mjs:1088`
  read off a sibling branch where it was `:1029`. The teammate checked and corrected me.
- Named implementers go idle without emitting a result; the work is always committed correctly. Read
  the diff rather than waiting.

## Next actions

1. Confirm the main worktree is on `run/substop`, then run the ownership check named at the top.
2. `init-run` for phase 3 if needed; verify the phase split is `T6 T7 T8`.
3. Dispatch T6, T7, T8 with `isolation: "worktree"` **as a parameter** — a brief saying so is not
   enforcement.
4. Gate, then review rounds as above. T8's brief must carry the skill-order fix and the four spec
   corrections if the operator decides to fold them in.
5. When phase 3 clears: `git checkout --detach`, `tm-integrator`, then `git checkout run/substop`.
