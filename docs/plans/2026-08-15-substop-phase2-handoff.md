# Handoff — run `substop`, phase 2 (mid-review)

Written 2026-08-15. Supersedes `2026-08-14-substop-phase2-handoff.md`; read that one only for
phase-1 history. Phase 1 is merged and done. **Phase 2 is in review, round 7 → 8.**

## FIRST ACTION — round 8

Round 7's fixes have **landed and been verified**. T5 is at , T4 at . The gate
was re-run at those tips: **merge, test, fileset, ownership all pass; review pending.** Fix rounds
recorded. Nothing is outstanding.

Start by dispatching **round 8** — four unnamed  lenses at /opus
(, , , ), stamps from . What round 7
fixed, and therefore what round 8 must judge:

- **** —  () now gates every
  decision taken from , including the merge-conflict skip. A malformed kind is a
  **non-optional fail**, never a pending or a skip. Both exploits measured dead: the command no
  longer executes, and the forged optional  now yields  rather than .
  The  filter in  is **deliberately unchanged**.
- ** is the only writer of ** — the universal that failed four rounds running
  is now structural, with a source test counting call sites and asserting the one is inside
  . Verified: one real call at , the other match is a comment.
  **A poisoned record is deliberately unrepairable by any automatic writer** — that is the price of
  never replacing a good value.  now prints the recorded branch when it differs from the
  checkout, so it announces itself.
- **The corpus claim was corrected downward** —  already pin
  both caps with absolute literals in both directions, so the previously-stated gap was false.

Merged suite at these tips: **1701 on T5's branch alone**; re-measure the merged tree (expect ~1740).

**Two items T5 handed back, both outside its file set:**

1. The false-PASS bound in  was falsified for
   the manifest. That spec is T1's, merged and frozen. Decide whether to correct it.
2. The skill-order residual — assigned to phase 3's T8.

## State

- Plan: `docs/plans/2026-08-13-subagent-stop-enforcement.md`, amended six times (see below)
- Base: `master` @ `fbe2150` · Run branch: `run/substop` @ `d925599` · **Anchor: `fbe2150`**
- Phases: **P1 `T1 T2 T3` (merged) · P2 `T4 T5` · P3 `T6 T7 T8`**

Tips:

| Task | Tip | Files |
|---|---|---|
| T1 | `e507ac0` | merged; frozen |
| T2 | `9e8be2d` | merged; frozen |
| T3 | `8696d33` | merged; frozen |
| T4 | `ba630e3` | `scripts/subagent-stop.mjs`, `tests/subagent-stop.test.mjs` |
| T5 | `f3f786e` **or newer** | `cli.mjs`, `brief.mjs`, `gate-runner.mjs` + the 4 tests |

Fix rounds: P1 `T1:12 T2:7 T3:18` · P2 `T4:5 T5:5`.
Merged-tree suite at round 7: **1726 / 1724 pass / 2 skip** (win32 node 24), **1723 / 3 skip** (WSL node 24).

## The bar (operator-set, unchanged)

**Green gate, zero high, zero medium.** Lows documented and carried.

## Round 7's findings — what T5 was asked to fix

1. **HIGH `gate-runner.mjs`** — a check `kind` spelled as a JSON **array** executes.
   `['command'] !== 'command'` survives `cli.mjs`'s `--enforcement-only` filter, then
   `RUNNERS[['command']]` and `Object.hasOwn(RUNNERS, ['command'])` both coerce and select the
   runner. Arbitrary shell command through the stop hook, `cwd` = main worktree, exit 3 — the code
   the handler blocks on. Reproduced end to end.
2. **MEDIUM, same root cause** — `{"kind":["fileset"],"optional":true}` runs the real check and
   then does not block, because `ALWAYS_ENFORCED_KINDS.has` does **not** coerce.
   Measured `{"verdict":"PASS","failed":[],"optionalFailed":["fileset"]}`.
   **This falsifies the phase-1 bound "no forgery reaches a false gate PASS."** It holds for
   `.teammates/` records; it does not hold for `teammates.gate.json`, a different file with the
   same writability. Fix at the **runner lookup**, not the filter — a filter-only fix leaves the
   false PASS. See plan **Step 3d**.
3. **MEDIUM `cli.mjs:914`** — the "no command can change a present value" universal is false for
   the fourth consecutive round, through a fourth writer: `init-run` at `cli.mjs:1825`. Asked for a
   fix **by construction** (one enforcing writer), not a fifth wording.
4. **MEDIUM `tests/cli.test.mjs:9883`** — the stated corpus gap is itself false. Raising both caps
   fails five tests, because `tests/state.test.mjs:343/:355/:405` already pin both caps with
   absolute literals in both directions.
5. Lows: `rebuild-state`'s new `try/catch` unpinned; only the positive arm of its report line
   pinned; `cli.mjs:958` still says "`rebuild-state` still rewrites the field outright", which T5's
   own last commit made false.

**A regression I created and must be closed with (3):** round 5 removed the base-valued exception
*because* `rebuild-state` was the remedy; round 6 constrained `rebuild-state`. A base-valued record
is now **permanent**, recoverable only by deleting `.teammates/<runId>` (destroying gate history) or
hand-editing. Each fix was correct alone.

## Accepted residuals — do not re-litigate

- **The fabricated-repository plant.** A `.git` file naming a second, attacker-built repo satisfies
  containment. Accepted with **no code change** after T4 built and measured both candidate
  discriminators: the parent-enclosing check is defeated by one more `.git` file, and walking all
  the way up refuses the legitimate B-inside-A configuration. Security audited and upheld both
  rejections. Ceiling: one forced retry, no false gate PASS, branch clamped, no command named.
  T4's residual test asserts **bounds, not the verdict**, deliberately — so a future fix does not
  have to edit a test to stay green.
- **The skill-order window.** A phase dispatched directly (fewer than three tasks) before any
  lifecycle command runs on the run branch has no recorded `runBranch`, so the guard fails open.
  Fix is `skills/parallel-execution/SKILL.md` checking out the run branch before step 1 — **assigned
  to phase 3's T8**, which owns skills.
- **`scripts/state.mjs:225-228`** says the id rule refuses `;` "which `init-run` currently accepts".
  Now **false**; T3 is frozen and merged. Carried deliberately.
- **T4's `commonDir === gitDir`** is redundant-but-documented: containment already excludes the main
  worktree, deletion changes no verdict, kept as the explicit statement of that case.

## Settled decisions — do not re-open

- `complete --enforcement-only` returns **3** only for a **task-scoped** check (`fileset`, `merge`);
  run-wide failures and anything that could not run return **4**, which the handler allows. A
  failing `command` check returns 4 deliberately (the suite tests the merged tree).
- `REJECTED = 3` is pinned across files: `tests/brief.test.mjs` and `tests/subagent-stop.test.mjs`
  both read the constant out of `cli.mjs` source.
- `rememberRunBranch` is **fill-if-absent, absolute**. `complete` never refreshes — a consumer that
  records what it compares against approves itself.
- The two files **deliberately normalise differently** (`path.resolve` vs `normaliseWorktree`);
  incidental, because git canonicalises both operands. Only the classification **expression** matches.
  `worktreeKey` at `classifyWorktree` **is** load-bearing.
- Ref legality lives with git; the id allowlist `/^[\p{L}\p{M}\p{N}._-]+$/u`; ZWJ/ZWNJ refused per
  UAX #31; cross-script confusables an accepted limit; the UNC query cost accepted.

## Plan amendments applied (six)

`08393ba` store/exit-codes/T6 phasing · `2ac4cb9` rejection code pinned at 3 · `7f86a90` adversarial
suite into T5's set · `5716c4a` exit 3 narrowed + brief into T5's set · `fbe2150` gate-runner into
T5's set + **Step 3d** · plus `a483c10` `jsconfig.json` (see below).

## Host quirks — these cost several reviewers real time

- **Run the suite strictly sequentially**, output to a file, read the exit status **directly**.
  Concurrent runs produce `fatal: Out of memory` from `git checkout`. **Piping through `tail` masks
  the exit code** — a reported "exit 0" may be `tail`'s.
- Under the default sandbox every `execFileSync('git', …)` fails with `spawn UNKNOWN` (errno -4094)
  and the whole suite reads red. Use `dangerouslyDisableSandbox`.
- `wsl -e bash -lc` resolves `/usr/bin/node` = **v18.19.1**, below `engines >=24.2.0`. Use an
  absolute nvm path for v24.18.0. **State the invocation and resolved version, never the platform.**
- `node --test tests/` (directory form) fails MODULE_NOT_FOUND. The suite is `npm test`.
- Worktree paths must be **all forward slashes**; a mixed path gets mangled and creates the worktree
  *inside* the repo.
- **Verify every mutant landed.** A `perl`/`sed` substitution that silently fails to match produces a
  full green run that reads as "mutant survived". T5's harness now refuses a substitution whose match
  count is not exactly 1.

## The memory question (raised and resolved this session)

Not a node leak. A single `tsserver` had run since 09/08 with no `jsconfig`/`tsconfig` to bound it —
695 MB, 460k s CPU (~89% of one core for six days) — indexing 10 git worktrees plus 604 orphaned
`tm-*` temp repos. Resolved: 529 stale temp dirs deleted (119 MB), both tsserver instances killed
(~1 GB reclaimed), and **`jsconfig.json` added on master** excluding `.claude/worktrees`,
`.teammates`, `node_modules`, `docs`. It reached the run branch at `d925599`.

The temp dirs are orphaned by **interrupted** runs — `withRepo`'s `finally` is correct and never
runs when a mutation harness is killed. Expect them to accumulate again; they are cheap to clear.

## Defect classes this phase established

- **A bound true of one path, stated as a property of the whole.** T4's ceiling was wrong twice this
  way; my base-branch approval was the same shape; `--enforcement-only` was *verified* as a barrier
  by two parties and both were right about the string case and blind to the array.
- **A claim confirmed twice can still be narrow rather than true.**
- **Anti-vacuity assertions that are themselves vacuous.** The `tierSource` proof I asked for was
  satisfied by `init-run`'s write, not by the code under test.
- **A fix that closes one direction and claims generality.** The byte-cap corpus, four rounds:
  literals drifted → exported constants tracked → absolute members pinned only raising → the stated
  gap was false.
- **Two individually-correct fixes removing each other's premise**, a round apart.
- **A defence built against the obvious members of a class.** `gate-runner.test.mjs:1067` pins
  `'toString'`, `'constructor'`, `'__proto__'` — all strings. The array spelling is what JSON can
  express.

## Method that worked

- Dispatch four unnamed `tm-reviewer` lenses at `capable`/opus per round: `correctness`, `security`,
  `tests`, `claims`. Generate stamps with `review-dispatch`.
- Tell each lens **what changed, what it previously found, and which findings are accepted** — a
  lens that re-reports a carried low is spending budget on noise. Remove a low from the suppression
  list the moment it is fixed.
- **Aim a lens at auditing an acceptance**, not at re-arguing it. That is what found the round-7
  high: security was asked whether the stated ceiling was complete, not whether the decision was right.
- Say explicitly that **a clean round is a real outcome**, or pressure to produce something distorts
  severity.
- Pin cross-task constants **centrally** in the dispatch. Two parallel halves diverging produced two
  separate highs.
- Named implementers go idle without emitting a result; the work is always committed correctly.
  Read the diff yourself rather than waiting.

## Next actions

1. Check T5's tip (top of this file). Verify the round-7 fixes against the **committed blobs**, not
   the working tree — a mutation harness outlived its agent earlier in this run and committed a live
   `const bad = ''` after a green suite.
2. `record-fix-round`, then `gate --run substop --plan docs/plans/2026-08-13-subagent-stop-enforcement.md --root .`
3. `review-dispatch`, run round 8, `collect-reviews`, `gate --results`.
4. When phase 2 clears: `git checkout --detach`, dispatch `tm-integrator` at `mid`/sonnet to merge
   T4 and T5 `--no-ff`, then `git checkout run/substop`.
5. Phase 3 is `T6 T7 T8`. **T8 owns the skill-order fix** that closes the enforcement window above.
