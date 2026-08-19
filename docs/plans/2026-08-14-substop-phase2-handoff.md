# Handoff — run `substop`, phase 2

Written 2026-08-14, after phase 1 landed. Supersedes `2026-08-14-substop-phase1-handoff.md`,
which is now history: read this one, and read that one only for the round-1-to-17 method notes.

## State

- Plan: `docs/plans/2026-08-13-subagent-stop-enforcement.md`, **amended** at `08393ba`
- Evidence: `docs/specs/2026-08-13-agent-teams-probe-findings.md`
- Base: `master` @ `08393ba` · Run branch: `run/substop` @ `e26ffe2` · **Anchor: `08393ba`**
- Phases, after the T6 amendment: **P1 `T1 T2 T3` · P2 `T4 T5` · P3 `T6 T7 T8`**

**Phase 1 is done, gated and integrated.** Gate PASS on all five checks with zero high and zero
medium; merged `--no-ff` in dependency order as `d0e91d5` (T1), `0397492` (T2), `080926f` (T3);
then `e26ffe2` merged the amended base in. Every integrated blob was verified byte-identical to
its reviewed task tip. Task branches are frozen at T1 `e507ac0`, T2 `9e8be2d`, T3 `8696d33`.

Suite: **1636 tests / 1634 pass / 0 fail / 2 skip** on win32 node 24, **1633 pass / 3 skip** on
WSL node 24. Stable across six consecutive rounds.

## The bar (operator-set, unchanged)

**Green gate, zero high, zero medium. Lows are documented and carried forward.**

The session goal hook may still say "no low" — the amended bar wins, and say so when it fires.

## What to do next

1. Dispatch phase 2: **T4 and T5 only**. T6 is now phase 3 — do not dispatch it with T5.
2. `isolation: "worktree"` on every implementer dispatch, as a parameter. A brief saying so is not
   enforcement.
3. Gate, then review rounds with four unnamed `tm-reviewer` lenses at `capable`/opus:
   `correctness`, `security`, `tests`, `claims`. Generate stamps with `review-dispatch`.
4. When phase 2 clears: `git checkout --detach`, dispatch `tm-integrator` at `mid`/sonnet, then
   `git checkout run/substop` to re-attach.

## Pinned before dispatch: the rejection exit code is **3**

T4 and T5 share an interface and run in the same phase, so neither sees the other's work. T4's
handler blocks on the rejection-specific exit code; T5 is the task that adds that code to
`complete`. **The number is fixed by the dispatch, not chosen by either teammate:**

```
complete --enforcement-only exits 3, and only 3, when the recomputed enforcement checks reject.
The handler blocks on 3 and on nothing else. Every other code allows.
```

3 is free: `complete` uses 0 pass / 1 bookkeeping / 2 malformed-manifest-or-argv / 4
gate-rejected-or-cannot-verify today.

**Why this had to be pinned centrally.** If T4 writes `REJECTED = 3` and T5 returns `5`, both
tasks pass their own tests, both pass `fileset` and `ownership`, the phase gates green — and the
merged handler never blocks. Enforcement would be inert and indistinguishable from a clean pass,
which is the precise failure this whole design exists to prevent. No check in the gate compares a
constant in one task's file against a return value in another's.

Do not confuse this with the handler's **own** exit status to the harness: `ALLOW = 0`,
`BLOCK = 2`. Two vocabularies that share small integers; the plan says so at Task 4 step 5.

## Owed before phase 3, and easy to lose

**Re-measure the spec's `cli.mjs` citations after T5 lands.** `docs/specs/2026-08-10-agent-teams-adoption-design.md`
cites `scripts/cli.mjs` at ~10 places, all verified correct against the pre-T5 tree. T5 edits
`cli.mjs`, so they will drift — and the spec is **not** in T5's file set, so T5 cannot fix them and
must not try. This is recorded in the plan under `## Follow-up owed after Task 5 lands`.

This is not hypothetical: phase 1 produced a medium where six added comment lines moved a clamp
from `state.mjs:482` to `:488` and left the spec citing prose. **That defect existed only in the
merge and was invisible on either branch alone.** Check cross-branch citation drift at every gate.

## Amendments already applied — do not re-apply

All nine are in `08393ba`. Summary, so you can recognise them rather than redo them:

```
hdr   record path -> .teammates/index/<sha256 worktree>.json, plus locate's root-derivation trap
T1    "blocks on exit 2, allows on 4" -> block only on the new rejection code (both were wrong,
      in opposite directions)
T3    steps 6 and 8 corrected to the shipped store (task already merged; corrected for accuracy)
T4    step 4 remediation no longer says `git checkout -B ${branch}` — forbidden by the design
T4    step 5 exit-code comment rewritten; REJECTED vs BLOCK named as two vocabularies
T5    step 3  verified note: enforcement-only is the whole gap, `root` is a UNIVERSAL_FLAG
T5    step 3b NEW — rejection-specific exit code; tests/cli.test.mjs:3040 must change with it
T5    step 7b NEW — init-run must apply the store's id rule (8 diverging characters listed)
T5    step 11 assert on the path writeLocation returns, not the composed one
T6    Depends: T2 -> T2, T5   (this is what moved T6 to phase 3)
+     Verification checklist updated to the new phase split
```

## Decisions settled — do not re-litigate

- **`complete`'s exit codes today:** 0 pass / 1 bookkeeping / 2 malformed manifest **or** argv
  error / 4 gate-rejected **or** cannot-verify. T5 adds a rejection-only code because 4 conflates
  two cases and 2 conflates two others.
- **Ref legality lives with git, not `state.mjs`.** `.T1`/`T1.`/`T1.lock` producing refs
  `check-ref-format` rejects was declined deliberately.
- **Ids use an allowlist**: `/^[\p{L}\p{M}\p{N}._-]+$/u`, no component `.` or `..`, no `..`
  anywhere, no leading `-`; runId may nest, taskId is one component. Blocklists over Unicode
  proved unbounded.
- **ZWJ/ZWNJ are refused deliberately** (UAX #31). It breaks a Persian run id; the trade was made
  knowingly. Cross-script confusables are an accepted, documented limit.
- **The UNC query cost is accepted, not guarded** — the query is the harness-supplied cwd.
- **The key-agreement check buys exactly one thing**: a record cannot be filed under key A while
  naming directory B. It does **not** stop a record being planted to answer for someone else's
  directory. Both the spec and `state.mjs` now say this; keep them agreeing.
- **The design does not predict what happens after a forged record causes harm.** That depends on
  dispatch configuration it does not fix. Five rewrites tried to state the ordering and all five
  were falsified by probing; the sixth deleted the taxonomy. Do not restore it.
- **Comments state what a guard is FOR, never what a mutation run showed.**

## Carried lows — documented, not fixed

```
scripts/brief.mjs:180        the `!== ''` filter eats literal spacer lines
scripts/state.mjs:105        index not run-scoped, never pruned, worktree path reuse
scripts/state.mjs:184        defunct reason given for a live guard
scripts/state.mjs:~481       planting harm stated unconditionally (T3 frozen deliberately)
tests/state.test.mjs:1066    exhaustiveness claim false for one alternative
tests/state.test.mjs:1078    the C0 row covers nothing — JSON.stringify escapes it first
tests/state.test.mjs:1566    anti-drift import claim has no pinning test
tests/brief.test.mjs:194     Math.round mutant survives; both fixture confidences are exact
```

## Method notes earned in rounds 18-24

- **Never move a branch tip while reviewers are running** — stamps go stale and `collect-reviews`
  rejects the whole round.
- **Findings files are ONE object with `stamp` and `findings`.** An array, or a nested stamp,
  collects as unreadable and costs a respawn.
- **State the invocation, not the platform.** `wsl -e bash -lc` resolves `/usr/bin/node` = v18.19.1
  (out of support, 4 failures); an interactive shell or an absolute nvm path gives v24.18.0. Two
  rounds "disagreed" about the default until one measured how it was invoked. Corrects the phase-1
  handoff, which recorded v18 as the default.
- **`node --test tests/` is not the suite** — the directory form fails MODULE_NOT_FOUND. Use the
  `package.json` script, `node --test tests/*.test.mjs`.
- **Anything you assert about git, run it.** Two mediums came from asserting git behaviour without
  running it. `git checkout -B <branch>` **exits 128** when another worktree holds that branch, and
  a failed checkout leaves HEAD untouched — which is why a "blocked owner" harm did not exist.
- **Verify each mutant compiles AND removes the behaviour.** Sweep for JOINT redundancies.
- **Re-measure every citation you relay**, including one a reviewer gave you. A teammate corrected
  `workflow-gen.mjs:58` to `:60` and was right.
- **Tell each lens what changed and what it previously found**, and give it the accepted-lows list
  so it returns signal instead of the same eight lows. Remove a low from that list the moment it
  is fixed, or it stays suppressed after it stops being true.
- **Reviewing a deletion needs inverted instructions**: list what was cut on purpose and say
  brevity is not a defect, or a diligent lens re-raises exactly what you removed.
- **The named implementer went idle without reporting on all five of its rounds.** The work was
  always committed correctly; recover by reading the diff yourself rather than waiting.
- Reviewers share the scratchpad — tell each to write probes only inside its own worktree.

## Housekeeping

- `.claude/settings.local.json` is `{}` — the harness probe is disarmed. `.claude/` is gitignored.
- `status.gates` has **no reader**; `verdictCoversTree` has no production caller. The recorded
  phase-1 PASS carries the pre-amendment `anchorSha` and that is harmless — every verdict is
  recomputed from git.
- Re-running `init-run` mid-run is supported and preserves `gates` and `fixRounds`; it resets task
  states to `pending`, which nothing reads for a verdict.
- Merge subjects for the phase-1 integration say "add" for two files that were **modified**
  (`scripts/state.mjs`, the spec). Inaccurate but not rewritten — fixing three merge commits risks
  the verified integration for a verb.
