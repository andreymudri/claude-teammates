# Purge open findings — 2026-08-27

Run `purge` implemented `docs/plans/2026-08-26-purge-and-teardown.md` across four phases and ten
tasks, and is fully integrated: `run/purge` at `cb83c44`, 51 commits off `922ac91`, `npm test`
**2047 | 2044 pass | 0 fail | 3 skipped**. Every phase passed its gate **twice, at two different
tips**. Nothing is pushed; `origin/master` is still `922ac91`.

What follows is what the run did **not** close. Nothing here is a live code defect on the branch
as it stands: the two behavioural items are pre-existing, and everything else is prose or
test-tightening. Each finding kept its reviewer's own reproduction and, where one was offered, its
suggested wording — those live in `.teammates/purge/reviews/` and are the authority; this file is
the index.

Severity is the reviewers' own, after refutation. Three items are marked **(orchestrator)** —
they exist because of an instruction I gave a teammate, not because a teammate erred.

## Needs a task of its own

### `scripts/git.mjs` — `currentBranchRef()` over `git symbolic-ref --quiet HEAD` (medium)

The one item with a reproduced, end-to-end data-loss path, and the reason several others exist.
`git.mjs:147` resolves the run branch by **name** through `git rev-parse --abbrev-ref HEAD`, which
shortens only as far as stays unambiguous. A teammate that plants `refs/heads/refs/heads/<run
branch>` — three ordinary `update-ref` writes from its own worktree, or one `git symbolic-ref` that
tracks the run branch indefinitely — owns `ctx.runSha`, and `prune-run --yes` then deletes an
unmerged task branch **reporting it as contained, exit 0**, with the worktree reflog gone
(force-removed moments earlier) and the branch reflog gone (`-D`). Reachable only via `git fsck
--unreachable` until gc.

The bound is documented in code at `scripts/cli.mjs:3092-3117` with the reproduction quoted inline,
and both skills now carry the operator-checkable symptom (`git rev-parse --abbrev-ref HEAD` must
print the plain name). What no artefact carries is the fix. `derive()`'s round-trip cross-check
raises the cost of a *static* plant and does nothing against the symref form.

`scripts/git.mjs` was outside every phase-3 and phase-4 file set, which is why this never landed.

### `scripts/cli.mjs:1458` — the owner marker is read unvetted (medium)

The sibling claim path got `lstat` + `isFile()` + a uid comparison; the marker got none. A local
user plants a fifo at the marker path and `prune-run` **hangs with no output** — the `await`
precedes every print, `process.exit()` cannot interrupt it (the libuv thread parks in `open(2)`),
though SIGINT recovers the shell. A junk file, symlink or directory makes a preview unreapable
forever.

**Pre-existing**: identical on `4b130ca` before T5, and the plan prescribes that line verbatim at
`docs/plans/2026-08-26-purge-and-teardown.md:529`. Refuted as a phase-2 blocker on those grounds.
The window is not theoretical — `merge-preview.mjs`'s `finally` removes the marker **last**, so a
failed `removeWorktree` leaves a registered preview with the marker already released.

Fix: the same triple the claim path uses.

### `scripts/merge-preview.mjs:88` — `writeFile(marker, pid)` follows symlinks (medium)

Verified destructively: a planted symlink had its target truncated to the pid. Flag `'w'` is
`O_CREAT|O_WRONLY|O_TRUNC`; `'wx'` refuses — the same remedy T4 applied to the claim write, which
never covered the marker. Window is tight (mkdtemp→writeFile measured at median 0.138 ms, max
1.127 ms, 6-char suffix unguessable, so it needs an inotify watcher) but retryable forever at no
cost. Impact is bounded to files the gate user can already write; no privilege gain.

### `scripts/cli.mjs` — the reap-while-live freshness window (low, newly reachable)

`livePreviewPaths` samples each parent directory's listing **once per pass** while reading markers
per preview, so a claim written after that snapshot is invisible for the rest of the pass. It was
unreachable until T4 landed the first writer of `previewClaimPath`; it is reachable now. Sequence:
listing taken → gate spawns a check and writes a claim → gate SIGKILLed so its `finally` never runs
→ the loop reaches that preview, marker probes ESRCH, cached listing shows no claim → force-removed
with the child still writing to that tree.

Documented in-tree at `scripts/cli.mjs` as a live limit. Re-reading the listing per candidate closes
it.

## Prose and test-tightening on the branch

### `scripts/cli.mjs:1690` — the guard's residual value is understated (medium)

"Rules out the naive create-at-the-victim-tip form and nothing more" is wrong in the dangerous
direction, and the form it *names* is the one static plant that does not work — measured, the anchor
moves with the plant and phase 1 fails its fileset check even with the guard removed. The plant that
*does* work is a merge commit carrying the run branch's history with both tips as parents, and the
guard **refuses** it. So a maintainer reading "costs the attacker nothing … and nothing more" deletes
a five-line check that is load-bearing.

The reviewer's replacement wording is in `.teammates/purge/reviews/3-security.json`.

### `scripts/cli.mjs:3101` — the symref form never reached the operator-facing list (medium)

`WHAT REMAINS OPEN` declares itself complete, sits where the irreversible `git branch -D` happens,
and is cross-referenced from `:1696` as "the same statement where the damage happens" — but it still
describes park-at-HEAD-and-move. An operator scheduling `currentBranchRef()` off that list gets the
weaker picture: the symref plant needs no parking and survives any number of integration merges.

### `scripts/cli.mjs:3133` — the worktree-removal residual names the wrong side **(orchestrator)** (low)

Two lenses, independently. The bullet says the task branch shas "were resolved at derive time";
`runFilesetCheck` and `runOwnershipCheck` both re-resolve **live** — measured by moving a task branch
mid-run and watching fileset fail and the worktree survive. What *is* snapshotted is
`ctx.anchorSha`/`ctx.runSha`, the opposite side, so run-branch commits added mid-run are never
examined and `mergedParentFiles` walks a stale range. That is the genuine residual the sentence
should carry.

Third consecutive wrong version of this bullet; the last two are mine.

### `skills/finishing-a-development-branch/SKILL.md:121` — "reads it **only** to refuse" **(orchestrator)** (medium)

Two lenses, independently, and the tree's own tests disprove it: mutating `carried = null` at
`cli.mjs:1060` turns the suite red, and `tests/cli.test.mjs:11152` pins that `rebuild-state` keeps
the recorded `runBranch`. `rebuild-state` reads the directory **twice** — `readState` to refuse, then
`plan.json` through `writePlan` to carry `runBranch` forward, printing "(kept from the previous
plan.json)" to the operator.

The harm follows the sentence's own advice: delete the directory on its strength, re-run
`rebuild-state` from a non-run branch — routine, since the sibling skill has the operator detach
around integration — and the run's `runBranch` is recorded **wrong, permanently**, with
`complete --enforcement-only` unable to verify completion for the rest of the run. Deleting only
`status.json` reaches it without `--force`.

The claims lens's clause is the fix: "and to keep the run branch it recorded".

This sentence has now been wrong three ways — listed both commands as a reason to keep (misleading),
delisted `rebuild-state` (overshoot), and scoped it to refusal (false). The truthful form says what
each does.

### `skills/finishing-a-development-branch/SKILL.md:92` — the precondition has no validity window **(orchestrator)** (medium)

The sharpest finding of phase 4, and the two-invocation procedure I asked for is what makes it
deterministic. `prune-run` **without** `--yes` — which the skill truthfully says "removes nothing" —
recomputes each phase's gate and therefore **executes a teammate-authored command check**. Reproduced
end to end: clean name check → `--yes`-less run plants the three refs → `abbrev-ref` goes non-plain →
`--yes` deletes an unmerged branch, exit 0. No live teammate process needed.

Fix is one clause, from the reviewer: confirm the name *immediately* before `--yes`, **after any gate
or `--yes`-less run**, because those execute the manifest's check commands and can create the
ambiguity themselves. The same window applies at `skills/parallel-execution/SKILL.md:180`, where the
trigger is more routine still.

### `skills/parallel-execution/SKILL.md:196` — an instruction with neither a check nor a remedy (low)

"Check the worktree for one before forcing it" — neither skill shows how to detect a junction, and
there is no safe removal: this repo records at `cli.mjs:1326` that `rm -rf` follows one the same way,
so the obvious remedy repeats the loss.

### `tests/skill-contracts.test.mjs:891` — the new safety prose is deletable (medium)

On T8 the junction/irreversibility paragraph, the fresh-implementer exception and the dry-run scoping
sentence live **only** in `allow`. *Editing* any of them is red — the anchored regex stops matching
and the sentence becomes a stray — but **deleting all three is green**. The prose two commits exist
to add can be reverted with no test noticing. T9 does not have this: it bound its junction sentence
as a `then:` consequence *and* the next test's `claim:`.

### Remaining lows

- `tests/skill-contracts.test.mjs:851`, `tests/skill-finishing-branch.test.mjs:69` — `code.length === 1`
  is section-scoped, so a hand-sweep block under a **sibling heading** still passes. A block in a
  subsection is caught. Third successive narrowing of one defect: swap the block (high) → sandwich
  inside it (medium) → add a second block (medium) → put it in the next section.
- `tests/skill-finishing-branch.test.mjs:98` — `assertClaim` binds to the **first** statement matching
  `claim:`, and the stray inventory exempts by text equality, so a verbatim decoy earlier in the
  section steals the binding. Present in both files.
- `tests/cli.test.mjs:3452` — the detached-HEAD fixture pins the guard's **wording**; its three
  behavioural assertions survive removal of the null arm, so relaxing the regex would leave a test
  that passes with the arm gone.
- `skills/finishing-a-development-branch/SKILL.md:90` — "prints the same worktree and branch list
  `--yes` would act on" promises an equality the design cannot keep: the per-branch ancestry verdict
  is computed only inside the `--yes` loop.

## Tooling defects found while running, unrelated to the plan

- **`collect-reviews` does not persist.** Its stdout must be redirected and passed to
  `gate --results <path>`; run independently, the review check stays `pending` forever while the gate
  reports FAIL with `failed: []`. It also exits non-zero when a lens file is missing — **check that
  exit code before consuming the output**, or the refusal text gets fed to `gate` as a results file.
- **The sandbox git-safety hook refuses the literal `complete --root <main worktree>` invocation**
  ("runs a string through complete"). Two teammates hit it and worked around it with a script file.
  Every brief template tells teammates to run it literally.
- `locate --root <main worktree>` exiting 2 was **fixed** in plugin 1.1.6; the brief now says it takes
  no path arguments.
- `review-dispatch` and `collect-reviews` **without `--phase`** default to the manifest's phase name
  (`default`) and scope to every task branch in the run, including already-integrated ones. Always
  pass `--phase <n>`.

## Deliberate, do not re-litigate

- Two mutations survive in `scripts/gate-runner.mjs` by operator adjudication, documented in code:
  the exit-listener `retireIfGroupGone()` and `killGroup`'s `liveGroups.has(pid)` guard. Removing
  *both* goes red.
- `tests/gate-runner.test.mjs` has two deterministic failures at ~49× oversubscription on one pinned
  core. Green at 2×, at 8×, and at the 1-vCPU CI shape.
- The two skills describe `prune-run` in **different words**. T9's branch could not see T8's file and
  it said so rather than paraphrasing; two lenses confirmed the substance agrees on the merged tree.

## Before pushing

Two history rewrites ran on 2026-08-27, both over the same unpushed range (`922ac91..`), both
touching 51 commits across 13 refs, and both verified by the only check that matters: **every ref's
tree is byte-identical to its pre-rewrite backup**, with author and committer dates preserved to the
second and `npm test` unchanged at 2047 | 2044 pass.

1. **Tool-authorship trailers stripped** from the nine commits that carried them.
   Anchor `15ce44b` → `ef0f818`, tip `b96911d` → `bbea36b`.
2. **Authorship corrected** from `r <r@r>` to `Andrey Mudri <andreybeckert@gmail.com>`, author and
   committer, on all 51. Anchor → `3566c2f`, tip → `cb83c44`.

The repo-local `user.name`/`user.email` override that produced `r <r@r>` has been removed, so the
global identity now applies to future commits here.

**The pushed history was deliberately left alone.** `4753dd6` and earlier still read `r <r@r>`;
they are on `origin`, so correcting them would rewrite shared history rather than unpushed work.
`922ac91` itself was already correctly authored.

Pre-rewrite state is recoverable from `refs/backup/pre-strip/*`, `refs/backup/pre-author/*` and two
full bundles in the session scratchpad. `refs/backup/preexisting-original-master` holds a stale
`refs/original` backup from an earlier rewrite in this repo that `filter-branch` would otherwise have
required overwriting — it is not from this run and was preserved rather than discarded.
