# Handoff — run `substop`, phase 1

Written 2026-08-14, mid-run. Pick up from "What to do next".

## State

- Plan: `docs/plans/2026-08-13-subagent-stop-enforcement.md` (committed, `2e6db29`)
- Evidence: `docs/specs/2026-08-13-agent-teams-probe-findings.md`
- Base: `master` @ `2e6db29` · Run branch: `run/substop`, checked out in the main worktree
- Phases: `P1 T1 T2 T3` · `P2 T4 T5` · `P3 T6 T7 T8`

Phase 1 branches (all forked from `2e6db29`, one file set each, `fileset`/`ownership` clean):

| Task | Tip | Files | Status |
|---|---|---|---|
| T1 | `00c6096` | `docs/specs/2026-08-10-agent-teams-adoption-design.md` | clean 9 rounds |
| T2 | `9e8be2d` | `scripts/brief.mjs`, `tests/brief.test.mjs` | clean 9 rounds |
| T3 | `f654d63` | `scripts/state.mjs`, `tests/state.test.mjs` | round-17 fix landed |

Suite on the merged tree: **1608 pass / 2 skip** (win32), **1607 pass / 3 skip** (WSL node 24).
Skips are platform-legitimate: POSIX-only FIFO test skips on win32; two win32-only path tests
skip on POSIX; the UNC-symlink test skips where no UNC target resolves.

## The bar (operator-set)

**Green gate, zero high, zero medium. Lows are documented and carried into phase 2.**

The session goal hook still reads "no low, no med, no high" and will keep flagging incomplete
while lows remain. The operator amended this deliberately; treat the amended bar as authoritative
and say so when the hook fires.

## Round history

```
r1 13 · r2 9 · r3 12(3h) · r4 11 · r5 9 · r6 8 · r7 9(1h) · r8 6
r9 11(2h) · r10 8 · r11 9 · r12 8 · r13 9 · r14 14 · r15 8(1h) · r16 15(2h) · r17 16(0h)
```

Two structural changes drove the big drops. **Round 9**: replaced a directory scan with a keyed
lookup (`.teammates/index/<sha256 of normalised worktree>.json`) after the scan's resource bounds
failed three different ways. **Round 14**: deleted the ref-legality machinery entirely — ids no
longer build the record path, so git answers ref questions at the point of use.

## What to do next

1. **Round 17's fix has LANDED at `f654d63`** — all four mediums closed: non-NFC ids are now
   *refused* rather than folded; the record bound has a fixture that passes a code-unit bound and
   fails a byte bound; the stale variation-selector header is deleted; and every alternative in
   `UNPRINTABLE` now has an input only it covers (the explicit `  ` was removed so `Zl`
   and `Zp` are each the sole cover and therefore killable). Lows done too: `;` pinned,
   `allowSeparator` deleted, the worktree rule reduced to C0 with DEL/C1 asserted as *accepted*,
   normalised-vs-raw pinned by a POSIX symlink. Cross-script confusables documented as a limit.
   **Round 18 review has NOT been run.**
2. **Gate from scratch**, then **round 18 review** — all four lenses, dispatch pattern below.
   If it returns 0 high + 0 medium, phase 1 clears the bar.
3. **If 0 high + 0 medium:** phase 1 is done.
   - `doctor --run substop --plan <plan> --root .` (expect 5 MISSING for T4-T8; that is normal)
   - `git checkout --detach` — the integrator cannot check out a branch the main worktree holds
   - dispatch `tm-integrator` at `mid`/sonnet, merging T1, T2, T3 with `--no-ff` in dependency order
   - `git checkout run/substop` to re-attach
4. **Apply the plan amendments before dispatching phase 2** (below).

## Plan amendments — REQUIRED before phase 2

Seven items, two validated by running `init-run` against a scratch copy:

```
T5   init-run must apply the same id rule as the location record (they currently diverge on ';',
     space, ':', '*', leading '-', emoji, ZWNJ, tab — store is authoritative)
T5   add --enforcement-only to complete's KNOWN_FLAGS + a rejection-only exit code;
     update tests/cli.test.mjs:3040, which pins "complete exits 4 when the recomputed gate fails"
T5   step 11 asserts the pre-redesign record path .teammates/<runId>/worktrees/<taskId>.json;
     writeLocation returns the record path, so assert on that
T6   Depends: T2 → T2, T5   ✓ validated: moves T6 to phase 3, layout stays P1(3) P2(2) P3(3)
T4   block on the new exit code, not on 2 or 4
T4   remediation text must not shell-interpolate `branch` — plan lines 505-513 tell a teammate to
     run `git checkout -B ${branch} <base>` in a shell
hdr  the decisions bullet still says "exit 2 blocks, exit 4 fails open" — inverted
+    the record path appears at plan lines 23, 339, 366, 393; and every cli.mjs citation in T1's
     spec is measured against the pre-T5 tree, so re-measure after T5 lands (ten citations)
```

## Decisions already settled — do not re-litigate

- **`complete`'s exit codes are 0 pass / 1 bookkeeping / 2 malformed manifest **or** argv error /
  4 gate-rejected **or** cannot-verify.** Verified at `cli.mjs:2760/2761/2803/2811/2815/2817/2819/2821`
  and `1242/1256/1269/1276/1290`. The hook needs a rejection-only code because 4 conflates two cases.
- **Ref legality lives with git, not in `state.mjs`.** A finding that `.T1`/`T1.`/`T1.lock` produce
  refs `check-ref-format` rejects was **declined** in round 17 — that is the design.
- **Ids use an allowlist**, not a blocklist: `/^[\p{L}\p{M}\p{N}._-]+$/u`, no component `.` or `..`,
  no leading `-`, no `..` anywhere, runId may nest, taskId is one component. Blocklists over Unicode
  proved unbounded — `Default_Ignorable` alone missed 29 `Cf` points *and* wrongly excluded functional
  joiners.
- **ZWJ/ZWNJ are refused deliberately** (UAX #31 restricted profile) — breaks a Persian run id, and
  that trade was made knowingly because these strings become refs and terminal output.
- **The UNC query cost is accepted, not guarded** — the query is the harness-supplied cwd, and
  refusing it would make a network-share worktree permanently unfindable.
- **Comments state what a guard is FOR, never what a mutation run showed.** Measurement claims rot;
  properties belong in tests. Four wrong versions of one "unreachable" note preceded this rule.

## Method notes that earned their place

- **Never move a branch tip while reviewers are running** — stamps go stale and `collect-reviews`
  rejects every findings file, losing the whole round.
- **Findings files must be a single object with `stamp` and `findings` keys.** An array, or the stamp
  nested inside the list, collects as unreadable and costs a respawn.
- **node 18 results are invalid here** (engines `>=24.2.0`, CI node 24). One contradiction between
  lenses resolved entirely on this.
- **Run POSIX before committing.** A win32-only path literal shipped a red CI build in round 15.
- **Verify each mutant compiles AND removes the behaviour.** Three false conclusions this run: a
  shell-escaped mutation that was inert, one that broke the parse (red for the wrong reason), and one
  that replaced half a chained expression.
- **Sweep for JOINT redundancies** — pairs where neither clause dies alone but removing both is fatal.
  Found three times in three different parts of this file; single mutation structurally cannot see it.
- **Verify a survivor's justification independently.** Three separate rounds had a plausible-sounding
  survivor note that was false.
- Reviewers share the scratchpad directory; tell each to write probes only inside its own worktree.

## Reviewer dispatch pattern

Four lenses per round — `correctness`, `security`, `tests`, `claims` — as `tm-reviewer`, **unnamed**
(a named reviewer goes idle without emitting its result), at `capable`/opus. Generate stamps with
`review-dispatch`, or hand-build with the current tips. Tell each lens what changed since its last
round and what it previously found, and aim it at the *fixes* rather than the original code — from
round 4 onward, most findings were defects in the previous round's fix.

`claims` has been the highest-yield lens: it found the false subsumer, all three joint redundancies,
and four successive wrong versions of one note. `tests` running on **both** win32 and WSL node 24 has
been decisive six rounds running.

## Housekeeping

- `.claude/settings.local.json` is `{}` — the harness probe is disarmed. `.claude/` is gitignored.
- `refs/rescue/*` were deleted after verifying all 58 blobs existed in master's history; the shas are
  recorded in `docs/specs/2026-08-13-agent-teams-probe-findings.md` §7.
- One transient gate FAIL was observed and never reproduced across two subsequent full runs; the
  failing check was not captured. Capture full gate output, not just the verdict.
- Memory files worth reading first: `subagentstop-is-the-reachable-enforcement-point`,
  `worktree-isolation-survives-teams-mode`, `teammate-idle-cannot-see-a-do-nothing-teammate`.
