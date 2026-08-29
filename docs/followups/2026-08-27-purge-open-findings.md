# Purge open findings — 2026-08-27

Run `purge` implemented `docs/plans/2026-08-26-purge-and-teardown.md` across four phases and ten
tasks, and is fully integrated: `run/purge` at `cb83c44`, 51 commits off `922ac91`, `npm test`
**2047 | 2044 pass | 0 fail | 3 skipped**. Every phase passed its gate **twice, at two different
tips**. Nothing is pushed; `origin/master` is still `922ac91`.

**2026-08-28 — run `purgefix` closed most of this document.** It implemented
`docs/plans/2026-08-27-purge-followups.md` across five phases and eleven tasks (Task 1 was
absorbed into Task 7 mid-run), integrated on `run/purge-followups` at `f99483e`, 98 commits past
`cb83c44`, `npm test` **2190 | 2187 pass | 0 fail | 3 skipped**. The three skips, enumerated by
name from the TAP output on Linux rather than assumed: `findTaskByWorktree on win32 matches across
drive-letter case and separator style` (win32 only), `normaliseWorktree maps a Windows 8.3 short
name onto its long spelling` (win32 only), and `writeLocation refuses a worktree whose resolved form
the reader would reject` (`no UNC target on this host resolves to a non-local path`). The
Linux-only bind-mount boundary test below is **not** among them — it runs here. Every phase gated
PASS, but not on a first pass:

| phase | tasks | gate | integrated |
|---|---|---|---|
| 1 | T2–T6 | PASS | `5053758` |
| 2 | T7 | PASS | `aaafaae` |
| 3 | T8, T10 | PASS after **nine review rounds** | `935cd5a`, `b0c46c2` |
| 4 | T9 | PASS after **five review rounds** | `f99483e` |
| 5 | T11 | this document | — |

Nine rounds and five rounds are a fact about the run's shape, not a footnote. Several findings
below are **carried, not fixed**, one medium is a defect class that is only **half** closed, and
the two behavioural hazards took **three attempts each reported as closed at the time**. This is
not a clean sweep, and a record that read like one would be false. Nothing is pushed;
`origin/master` is still `922ac91`.

Everything below the closure sections is what the run did **not** close. Each finding keeps its
reviewer's own reproduction — those live in `.teammates/purge/reviews/` and
`.teammates/purgefix/reviews/` and are the authority; this file is the index. Severity is the
reviewers' own, after refutation. Items marked **(orchestrator)** exist because of an instruction
I gave a teammate, not because a teammate erred.

**Line numbers in the closure sections are as at `f99483e`**, re-read in a worktree at that tip
rather than carried from the plan. Where a fix landed somewhere other than the line the original
finding named, both numbers are given.

## Needs a task of its own

All four closed. Each was verified by reading the file at the line it now occupies, not by
trusting the task's own report.

### `scripts/git.mjs` — `currentBranchRef()` over `git symbolic-ref --quiet HEAD` (medium) — CLOSED by T7

Closed, and **not the way the plan predicted**. `currentBranchRef()` is at `scripts/git.mjs:270`
over `git symbolic-ref --quiet HEAD`, as specified. But `currentBranch()` (`:321`) is now
`(await this.headBranch()).name`, and `headBranch()` (`:330`) is
`classifyHeadRef(await this.currentBranchRef())` — a shared, exported, pure classifier that did
not exist in the plan.

The plan (Task 7, Step 0) prescribed *preserving the literal string `HEAD` on a detached HEAD* as
the old contract. The tree refuses that and returns `null`, and the comment at
`scripts/git.mjs:297-307` records why with the reproduction: `git update-ref refs/heads/HEAD <sha>`
exits 0 (only `git branch HEAD` refuses the name), so every caller prefixing `refs/heads/` onto the
sentinel resolved a ref any teammate can write — the abbreviation hazard back under a different
spelling. Executed end to end against that revision: with the main worktree detached and
`refs/heads/HEAD` planted, `prune-run --yes` exited 0 and deleted an **unmerged** task branch.

The closure took **three attempts, and each earlier one was reported as closed**. The record is in
code at `scripts/cli.mjs:3769-3800`: attempt one resolved symbolically and left the `HEAD`
sentinel; attempt two returned null but still trusted `symbolic-ref`'s target to be a branch, and
`git symbolic-ref HEAD refs/tags/x` is accepted (git refuses only targets outside `refs/`), which
made `ownership` go from FAIL naming a rogue commit to PASS; attempt three added a round trip that
proves less than it looks, because `refs/heads/${runBranch}` reconstructs HEAD's own ref byte for
byte. What closes it is `derive` **refusing** three states outright — HEAD detached, HEAD pointing
outside `refs/heads/`, and a stripped name that is itself a ref path — at `scripts/cli.mjs:2280`.
Closed by refusal, not by resolution.

Regression tests: `tests/cli.test.mjs:5013` (`the three-ref plant no longer redirects the run
branch`) and `:5060` (`the refs/heads/HEAD plant does not make a detached HEAD look like a run
branch`).

**One residual is still open** and is listed under `Still open` below: `gate-runner.mjs:1703` takes
the run branch's **name** rather than `ctx.runBranchRef`.

### `scripts/cli.mjs:1458` — the owner marker is read unvetted (medium) — CLOSED by T6

**The hazard, restored here because this document is the only record of it.** The sibling claim
path got `lstat` + `isFile()` + a uid comparison; the marker got none. Any local user who can see
the temp prefix can plant an entry at the marker's exact path, which is derived from the preview
directory name and nothing secret. A **fifo** there makes the marker read block forever:
`process.exit()` cannot interrupt it because the libuv thread is parked in `open(2)`, and only
SIGINT recovers the shell. A junk file, a symlink or a directory makes the preview **unreapable
forever**, because a marker that cannot be read is `unknown` and `unknown` means live. One detail
of the original write-up does not survive checking and is corrected rather than repeated: the
`await` does **not** precede every print — `prune-run` announces its command checks and runs the
phases before it reaches `livePreviewPaths` — but it does precede the prune plan and every removal,
so the command is stranded after that announcement with no plan, no verdict and nothing removed.

That reproduction is prior and cannot be re-taken by the suite: staging a fifo whose read never
returns would hang the suite that staged it, which is why `read` and `stat` are injectable and why
the tests pin this branch through doubles instead. `scripts/cli.mjs:1882-1894` names **this
document** as its record. An earlier revision of this file deleted that reproduction while
rewriting the section, which left the only in-tree citation of this document pointing at nothing; a
maintainer following it would reasonably read the hazard as retracted and the vetting block as
deletable. It is restored for that reason.

**The fix, and it is not the `lstat` an earlier revision of this section described.** Production
vets the **descriptor**. `holderAt` (`scripts/cli.mjs:1830`) calls `openHolderEntry` (`:1741`),
which opens once with `fusedHolderOpenFlags()` — `O_RDONLY|O_NONBLOCK|O_NOFOLLOW` — and `fstat`s
the handle it holds, so `isFile()` is asked of an object rather than of a name. The code records
the by-path shape as the **measured hazard**, not the fix, at `:1929-1935`: while the vetting was an
`lstat` by path, a regular file approved by the lstat could be swapped for a fifo before the read
resolved the name again. `lstat` survives as the default binding of the injectable `stat`
parameter (`:1769`), which is reached from four sites: `vetWithoutOpening` (`:1823`), the
fallback taken when the open fails for any reason but ENOENT, which reads nothing and so
reopens no race; the hoisted owner lookup `stat(dir)` (`:1868`); and the two by-path holders
(`:1785`, `:1787`), which are the flagless-platform shape and the test stand-in rather than
production.

The predicate is `(info) => info.isFile() && (ownerGone || info.uid === ownerUid)` (`:1957-1959`),
with the owner uid hoisted so one `stat(dir)` serves both the marker and the claims. The uid half is
**not** unconditional: `ownerGone` is set when that `stat(dir)` answers ENOENT (`:1875`) and waives
it, deliberately, to restore the base branch's answer rather than invent a third — argued at
`:1934-1942`, including that on the by-path shape this waiver was itself the hazard. A candidate
failing vetting is **ignored**, not `unknown`, so a forged entry cannot force `live` in either
direction merely by existing. On the fallback path ENOENT still means "no marker" and any other
error still leaves the preview unknown.

Verified by reading the vetting block and its four-answer rule (`:1790-1793`) at that line, and by
running the fixtures rather than trusting them: both arms are pinned separately in
`tests/cli.test.mjs` — `a real regular-file marker naming a live pid is still read through the
fused open` (`:11237`) and `a marker whose lstat fails for a reason other than ENOENT leaves the
preview live` (`:10896`) — the happy path included, so the vetting cannot be satisfied by rejecting
everything.

### `scripts/merge-preview.mjs:88` — `writeFile(marker, pid)` follows symlinks (medium) — CLOSED by T2

`writeOwnerMarker` is exported at `scripts/merge-preview.mjs:89` and uses
`{ encoding: 'utf8', flag: 'wx' }` — `O_CREAT|O_EXCL|O_WRONLY`, which refuses an existing entry
rather than opening it. The one call site is `:129`, and `:124` records that `markerHeld` is set
only once the write actually happened, so an EEXIST does not make the `finally` release a marker it
never took.

Verified by reading the flag word at `:90` and the call at `:129`. Pinned against a real
filesystem, not by source text: the tests plant a pre-existing file and a symlink at the marker
path and assert EEXIST with the victim's bytes intact.

### `scripts/cli.mjs` — the reap-while-live freshness window (low, newly reachable) — CLOSED by T6

`ONE LISTING PER PREVIEW, not one per sweep` at `scripts/cli.mjs:1964`; `list(parent)` is called
inside the loop for each preview directory. The `listings` memo and `listingFor` are gone —
`command grep -n 'listingFor\|const listings' scripts/cli.mjs` returns nothing.

The window **narrows rather than closes**, and the comment says so at `:1980-1983`: a claim written
after *this* preview's listing is still unseen for it. One readdir wide instead of one sweep wide,
which is the bound the claim vetting already lives with. A listing that fails is recorded as `null`
and makes the preview live, which is not the same as an empty listing.

## Prose and test-tightening on the branch

### `scripts/cli.mjs:1690` — the guard's residual value is understated (medium) — CLOSED by T7, differently

The reviewer's replacement wording was **deliberately not carried across**. It corrected a sentence
about the old guard's residual value, and that residual no longer exists: the whole
park-at-HEAD / symref / create-at-the-victim-tip analysis was deleted because it described a
resolution this file no longer uses. What stands at `scripts/cli.mjs:2292-2302` says the round trip
catches the honest two-subprocess race and nothing else, and adds the sentence that makes it
un-relitigable: *"Reverting this to resolve `head.ref` directly changes nothing measurable, which is
exactly why it must not be described as defence."*

### `scripts/cli.mjs:3101` — the symref form never reached the operator-facing list (medium) — CLOSED by T7

`WHAT REMAINS OPEN` is now at `scripts/cli.mjs:3764` and leads with
`WHICH REF IS THE RUN BRANCH. Closed at derive, by REFUSAL rather than by resolution`, kept
precisely so a reader can tell "closed" from "never considered". It states all three attempts and
what each left open, and it names its own remaining residual rather than declaring itself finished.

### `scripts/cli.mjs:3133` — the worktree-removal residual names the wrong side **(orchestrator)** (low) — CLOSED by T7

Now `scripts/cli.mjs:3825-3843`. It says what two lenses measured: `runFilesetCheck` and
`runOwnershipCheck` re-resolve `refs/heads/<task branch>` **live**, so a task branch moved mid-run
is judged at its new sha (measured: the fileset check read the moved sha, flipped to `contributes
no file changes past its fork point`, the phase failed, the worktree survived); what is snapshotted
is `ctx.anchorSha`/`ctx.runSha`, so a commit added to the **run branch** mid-run is never examined
by ownership (measured on the same repository: the branch advanced, `ctx.runSha` did not, ownership
passed without naming the new commit) and `mergedParentFiles` walks that stale range.

This was the third consecutive wrong version of this bullet, and the last two were mine. The fourth
is the first written from a reproduction of both halves.

### `skills/finishing-a-development-branch/SKILL.md:121` — "reads it **only** to refuse" **(orchestrator)** (medium) — CLOSED by T10

Now `:123`: *"`rebuild-state` reads it twice: once to refuse when it exists, since it exists for the
case where the directory is already gone, and once to keep the run branch it recorded — delete the
directory and a later `rebuild-state` run from any other checkout records that checkout as the run
branch, permanently, and `complete --enforcement-only` can no longer verify completion for the rest
of the run."*

Verified by reading the sentence in place. This sentence had been wrong three ways before this.

### `skills/finishing-a-development-branch/SKILL.md:92` — the precondition has no validity window **(orchestrator)** (medium) — CLOSED by T10, differently

Not closed by adding the validity-window clause the reviewer suggested — that clause was for a
world where the hazard stays open. The precondition was **deleted** and replaced with the
resolution. The shipped sentence at `:100-105` is also **stronger than the text the plan
prescribed**: the plan's replacement named only symbolic resolution, and the tree names the three
refusals as well — *"That proof is against the ref `derive` takes directly off `git symbolic-ref
--quiet HEAD`, not off an abbreviated name, and `derive` refuses to produce a run branch at all
when HEAD is detached, when HEAD points outside `refs/heads/`, or when the name that ref strips to
is itself a ref path — so nothing a teammate can plant under `refs/heads/` changes which ref this
proof or the deletion it authorises runs against."*

The same window applied at `skills/parallel-execution/SKILL.md:180`, and the precondition is gone
from there too: `abbrev-ref` appears in no skill on this branch, where `cb83c44` had it at
`skills/parallel-execution/SKILL.md:181`. **But that document carries only the symbolic-resolution
half**, at `:179-181` — *"the run branch it proves against is the ref HEAD symbolically points at,
so no tag or same-named branch can redirect that proof"* — and none of the three refusals just
quoted. Searching both files for `refuses to produce a
run branch`, `itself a ref path` and `HEAD is detached` hits `finishing-a-development-branch` at
`:102` and `:103`, and hits `parallel-execution` nowhere. An earlier revision of this bullet said
the window "is closed the same way there", which reads, straight after the "stronger than the plan
prescribed" contrast, as though both documents carry the stronger wording. Closed the same way;
stated less fully.

### `skills/parallel-execution/SKILL.md:196` — an instruction with neither a check nor a remedy (low) — CLOSED by T9, with different commands

Both sites now carry a check and a safe removal (`skills/parallel-execution/SKILL.md:195` in § 5
and `:418` in `Worktree mechanics`). The commands are **not the ones the plan prescribed**: the
plan said `dir /AL` and `rmdir <link>`; the tree says *"check the worktree for one first with `dir
/AL /S` and remove the link itself with `rd <link>` — both from cmd.exe, not PowerShell, where `rd`
and `rmdir` are aliases for `Remove-Item`; never a recursive delete, which follows it"*. The
PowerShell aliasing note is the reason: `rmdir` in PowerShell is `Remove-Item`, which is the
recursive delete the sentence exists to forbid.

Windows behaviour here is **documented, not tested** — no reviewer on this run could execute it.

### `tests/skill-contracts.test.mjs:891` — the new safety prose is deletable (medium) — CLOSED by T9, after two failed attempts

Closed at the third shape, and the two failures are the useful part of the record.

Attempt one promoted the three sentences from `allow` entries to `assertStatement` calls, as the
plan said — but anchored on an **eight-word prefix**. Round 2 measured that gutting the sentence to
`This is irreversible on every prunable worktree:` — dropping the junction hazard and the
post-merge-edits warning — left the suite at 2189 | 2186 | 0. The two sibling sentences survived the
same truncation **only by accident**, each in a different test (one via the hand-sweep corpus
losing its `by hand` site, one via the `assertClaim` subject inventory catching `removes`).

What stands is `CLEANUP_IRREVERSIBLE`, `CLEANUP_EXCEPTION` and `CLEANUP_DRY_RUN` at
`tests/skill-contracts.test.mjs:1062-1064`: each anchored `^…$` end to end, **defined once and used
twice** — as the `assertStatement` that requires it and as the `allow` entry that permits it — so
the pin and the permission are the same regex object and cannot drift. That also closes the
dead-`allow`-entry class T10 hit in phase 3. Verified by truncation at twelve depths in round 3,
each dying at its own assertion.

### Remaining lows — all closed

- `tests/skill-contracts.test.mjs:851`, `tests/skill-finishing-branch.test.mjs:69` —
  `code.length === 1` being section-scoped is closed by **T9** with a corpus inventory that removes
  the *location* dimension: `HAND_SWEEP_LEXICON` at `tests/skill-contracts.test.mjs:1639` and the
  `assertCorpusInventory` over both cleanup skills at `:1657`. Every sentence about sweeping by
  hand, in either document, must now be in one list regardless of which heading it sits under.
- `tests/skill-finishing-branch.test.mjs:98` — `assertClaim` binding to the **first** match is
  closed by **T3** at `tests/md-contract.mjs:417-437`: the claim pattern must match exactly one
  statement in its scope. `tests/md-contract.test.mjs` was created as the first direct test of the
  helper — a defect in the checker is invisible to documents that do not trigger it, which is why
  the first-match binding survived three rounds.
- `tests/cli.test.mjs:3452` — the detached-HEAD fixture is closed by **T7**. It is now
  `tests/cli.test.mjs:4991`, and the comment above it says the discrimination is the message regex
  alone. Two new fixtures carry the behaviour instead (`:5013`, `:5060`).
- `skills/finishing-a-development-branch/SKILL.md:90` — closed by **T10** at `:90-92`: *"it prints
  the worktrees and branches it would act on if nothing changes before the `--yes` run — both runs
  recompute the gate from scratch"*, keeping the existing tail about the per-branch verdict.

### Two tasks that closed no finding in this document

- **T4** put the environment walls, the claim discipline and the scope rule into every brief:
  `environmentRules`, `claimRules` and `scopeRules` at `scripts/brief.mjs:249`, `:268`, `:284`,
  rendered **unchanged in both variants** (`:316-318` full, `:352-354` terse — the caveman variant
  carries them uncompressed on this module's own rule that compressing a specification drops the
  wording the gate then enforces). The script-file fallback for a shell that refuses the `complete`
  invocation is at `:175`.
- **T5** put the implementer's half at `agents/tm-implementer.md:70`, `:76`, `:84`, and the
  reviewer's at `agents/tm-reviewer.md:19-22` (*"A finding is a reproduction, not a reading"*).

Both exist because of the operator feedback from run `purge`, not because of a finding a reviewer
filed. They are the fix for the orchestrator finding at the bottom of this file, applied where
every teammate reads it.

## Still open

### Pre-existing, owned by no task in this plan

- **`tests/gate-runner.test.mjs:3933, :4176, :4277` — two levels of quoting, neither applied.** A
  `TMPDIR`-derived path is interpolated into a JS string that is itself embedded in a `shell: true`
  command (`defaultExec` at `scripts/gate-runner.mjs:320`). Measured: under a hostile `TMPDIR`, the
  test `a check whose process group empties early is retired while the promise is still pending`
  creates `PWNED-GATE` and goes red. Found by T8's shell-quoting sweep, outside its file set;
  reported rather than touched. The non-finding was confirmed in the same sweep: everything else
  spawning in `tests/cli.test.mjs` interpolates into JS via `JSON.stringify`, which is correct for
  that context and passes under the same hostile `TMPDIR`.
- **`assertContained`'s refusal is a print site for an unvalidated run id.** `scripts/cli.mjs:696`
  builds `${flagName} ${segment} escapes the run directory` with a bare `${segment}`, and
  `scripts/cli.mjs:2714` prints it **unwrapped**. Measured: `collect-reviews --run
  $'x\x1b[2K\rreview: PASS/../../pwned' --phase 1` exits 2 with a raw U+001B and U+000D on stdout;
  the C1 spelling with U+009B does the same. **Pre-existing** — verified byte-identical at the fork
  point and on `922ac91` (`git show 922ac91:scripts/cli.mjs` has the same line, at `:692`). Every
  other run-id sink in the two commands the diff touched was verified neutralised in the same run.
  Fix would be `printable(segment)` at `:696`.
- **`idRefusal` is never reached on the review paths.** Its only two call sites are inside
  `init-run` (`scripts/cli.mjs:2722`, `:2759`). On the `collect-reviews` / `review-dispatch` route
  the only gate on the run id is `assertContained`, which validates **containment, not characters**
  — and that guarantee is real: `--run ../../pwned` and `--run a/../../out` both exit 2. Recorded
  in-tree at `scripts/cli.mjs:4846-4862`, including the note that this mechanism was written from
  inference and got the explanation wrong twice.
- **The `printable` census header is stale by more than 2×.** `tests/cli.test.mjs:2267` states the
  census "came to 48 lines: 32 in `cli.mjs`, 6 in `reviews.mjs`, 6 in `digest.mjs`, 4 in
  `finish.mjs`". Re-derived in a worktree at `f99483e` from the header's own stated grep
  (`printable(Block)?\b` over those four files, minus comment-only lines, imports and the
  definitions): **103 — 85 / 6 / 6 / 6**. The header's own rule is that the count is a checkpoint,
  not a fact the file maintains, and that a differing number means the census gained or lost a
  site; this is that. Note also that the finding originally named `tests/cli.test.mjs:898` and the
  header is now at `:2267` — this diff's own growth moved it, which is the same drift the header
  spends a paragraph warning about.
- **`gate-runner.mjs:1703` takes the run branch's name, not `ctx.runBranchRef`.** Declared by T7 in
  its own comment at `scripts/cli.mjs:3802-3807` before any reviewer went looking. Nothing reaches
  it with a hostile value now — every path goes through `classifyHeadRef` first — but the guarantee
  rests on the refusal rather than on the consumer being unable to misread what it is given. The
  structural fix is to pass the ref; `scripts/gate-runner.mjs` was outside T7's declared file set.

### Boundary — pinned rather than closed

- **A bind mount over the reviews directory is not seen by the containment walk.** `lstat` and
  `realpath` both see through it — a bind mount is not a link, and `realpath` resolves to the path
  it is mounted at, not to its source. Closing it would mean reading `/proc/self/mountinfo`, which
  exists on **one of the three target platforms**. Proved real under `unshare -Urm`, and now pinned
  as a **stated boundary** rather than left implicit: `tests/cli.test.mjs:1267`, `a bind mount over
  the reviews directory is not seen by the containment walk`, skipped where user namespaces are
  unavailable or off Linux. One correction to the review record while carrying it: the phase-3
  claims lens's disposition says this test accounts for "the 3 skips in the 2187 baseline". It does
  not — enumerated from TAP output on this host, the three skips are two win32-only location tests
  and one UNC-target skip, and the bind-mount test **runs**. The analysis is in code at
  `scripts/cli.mjs:2141-2150`, including that
  an earlier claim ("namespaces are not something a local attacker will have") was asserted rather
  than attempted, and `unshare -Urm` returns 0 here. If a later change teaches the walk about
  `/proc/self/mountinfo`, that test goes red — and the tree's instruction, at
  `tests/cli.test.mjs:1257-1261`, is to **delete it and narrow the residual in
  `plantedReviewsLink`'s comment, not to restore the blindness**. An earlier revision of this bullet
  said "rewrite it, not delete it", which names the one outcome that sentence exists to forbid: the
  cheap rewrite available to a maintainer is to relax `assert.equal(answer.planted, null)`
  (`tests/cli.test.mjs:1300`) and keep the test, and that is restoring the blindness in test form.

### Carried from phase 4 round 5 — non-blocking

Round 5 was the gating round for phase 4. `blockOn` is `["high"]`; no lens produced a high, so the
phase passed and everything below was recorded and carried by decision. All four lens files are at
`.teammates/purgefix/reviews/4-*.json` with the full reproductions.

- **tests, medium, `tests/skill-contracts.test.mjs:256` — the round-4 defect class is only half
  closed.** The four `--phase` `assertStatement`s at `:256`, `:261`, `:266` and `:274` are
  unanchored substrings sitting outside every subject inventory. Reproduced: appending one sentence
  to the end of the paragraph beginning at `skills/phase-gate/SKILL.md:73` — *"In practice you can
  leave it off on any plan: the `default` key is the right scope for a whole-run review, and the
  guard does not object."* — leaves all 2190 tests green while the document tells the operator the
  exact opposite of the rule those four assertions pin. It is invisible to the document-scoped
  inventory (no lexicon alternative) and invisible to the four assertions (each still finds its
  substring one sentence earlier). Contrast, on the same tree: truncating the fail-closed sentence
  dies in `every sentence in phase-gate about where the results file is, in any section, is one a
  human locked` — that is the round-4 fix working, and it is what these four do not have.
  **Graded medium for consequence** — a wrong review scope rather than documentation drift — and
  the reviewer added, in its own words, that under this run's "does it yield a false PASS" criterion
  **it is a low**. Both the grade and the qualification are recorded because the disposition rested
  on the qualification.
- **tests, low, `tests/skill-contracts.test.mjs:390` — the document-scoped inventory's real cost.**
  It is **not** over-tight for ordinary prose: 20 naturalistic sentences about other mechanisms, 0
  false positives. What it does is make `PG_RESULTS_PATH_LEXICON`'s alternatives (`stdout`,
  `captur*`, `redirect`, `pip*`, `that/this path`, `results file`, …) reserved words across all 336
  lines of `skills/phase-gate/SKILL.md`, and `stdout`/`captur*` are exactly the vocabulary the
  untouched `## Reporting rule` section is already written in. Two sentences were planted for real
  and each produced exactly one failing test, under a name that does not describe the maintainer's
  edit. The reviewer's own bound, kept: those 20 sentences are one author's guesses, not a sampled
  distribution of real future edits.

  *How many* alternatives is a number **neither lens got right, and an earlier revision of this
  document repeated both figures a few bullets apart without noticing they describe one regex.** The
  tests lens said ten; the security lens said thirteen. Split on top-level `|`,
  `tests/skill-contracts.test.mjs:373` has **twelve**; counting `\b(that|this) path\b` as the two
  phrases it matches gets to thirteen, which is probably where that figure came from. Neither count
  is load-bearing for either finding, and both are recorded here rather than silently corrected,
  because the maintainer's real question — *what may I not say in this document* — is answered by
  reading the regex and not by any of the three numbers.

  **The stated cost is also narrower than the measured one, because a second lock covers the same
  section and is not on the results path at all.** `tests/skill-contracts.test.mjs:873` carries a
  **section-scoped** subject inventory `/\b(name|named|unnamed)\b/i` over
  § `Finish the pending checks`. Reproduced here on a pristine copy: one ordinary paragraph planted
  after `reported and ignored, never merged.` (`skills/phase-gate/SKILL.md:123`), worded *"When a
  collection stops early, take the location it named on its last line and hand it straight to the
  gate; the verdict it prints there is the one to record for the round."* — naming no lexicon
  alternative — takes `tests/skill-contracts.test.mjs` to 58 | 57 pass | 1 fail, dying in
  `phase-gate states reviewers are dispatched without a name and a named one loses its result` with
  `unnamed reviewers: unreviewed statement(s) about /\b(name|named|unnamed)\b/i in
  phase-gate/SKILL.md § Finish the pending checks`. Changing `it named` to `it printed` returns that
  file to 58 | 58 | 0 with the paragraph still in place, and the plant was reverted from the
  pristine copy afterwards. This is coverage the record **under**-states rather than over-states —
  no live hole is retired — but the `:390` bullet is not the whole edit budget for that section.
- **tests, low, `tests/skill-contracts.test.mjs:372` — the lexicon gap is two-thirds closed.**
  `PG_RESULTS_PATH_LEXICON` now names `stdout` and `pip(e|es|ing|ed)`, but not `>` as a redirect
  operator. Reproduced inside the locked section itself: *"Send the collected bytes to a file with
  `> out.json` and give the gate that file."* is green. Narrower and cheaper to close than the
  lexicon-free residual below — two alternatives (`>\s*\S+\.json` and `\b(that|this) file\b`) —
  which is why it is recorded separately rather than folded in.
- **tests, low, `tests/skill-contracts.test.mjs:230` — the optionality check is a literal substring
  over raw code lines.** Three single-line edits to the invocation at `skills/phase-gate/SKILL.md:71`
  each leave the whole suite green: `[ --phase <name> ]` with spaces (the most ordinary reflow a
  maintainer would make), `{--phase <name>}`, and a **commented-out** copy of the whole line — which
  also satisfies `documented.add('collect-reviews')`, so a command counts as documented from a line
  the section tells nobody to run. The Set is the right shape; its input is raw code-block text with
  no notion of what is presented as runnable.
- **tests, low, `tests/skill-contracts.test.mjs:730` — the reviewer's own weakest finding, recorded
  as such.** The commit hoists two copies of a 500-character regex into constants citing drift
  hazard while leaving four byte-identical inline copies of a 900-character one it had to edit in
  lockstep in the same diff (`:730`, `:1014`, `:1042`, and `:1649` as a corpus string). What is lost
  is maintenance cost and the consistency of the commit's own stated principle, not coverage: drift
  between an `allow` copy and the sentence fails loudly as a stray.
- **claims, medium, `tests/skill-contracts.test.mjs:1165` — a corrected citation set containing one
  wrong pointer.** It cites "the sibling lock at `:813`", which **this diff's own line growth**
  moved to `:1029`; `:813` is now the `then:` of an unrelated claim about anchored plan reads,
  containing no remove/delete vocabulary at all. Commit `dc1216d` re-resolved **seven** cross-file
  citations in that same comment block and left the only one this diff itself had moved. The other
  nineteen citations in the block all re-resolve exactly, which is what makes the one wrong pointer
  worth a medium: a maintainer has no way to tell whether it describes a lock that moved or one
  that was deleted.
- **claims, low, `tests/skill-contracts.test.mjs:360` — the decision stands; the cost estimate
  justifying it does not.** The comment states the rejected `\bpaths?\b` lexicon "drags in two
  unrelated statements" and names them. Measured at the document scope the lock actually uses: the
  chosen lexicon selects 10 sites, `\bpaths?\b` selects **14**, and only two of the four extras are
  the ones named. Under the other candidate scope (section) it drags in exactly two — but a
  *different* two. False under either reading, and `\bpaths?\b` is more expensive than stated, not
  less, so rejecting it is still right.
- **claims, low, `tests/skill-contracts.test.mjs:187` — "for all five" holds for four.**
  `PG_RESIDUAL_CLASSES` matches no lexicon alternative and is therefore absent from the ten-entry
  corpus. Measured: deleting the `PG_WRITES_FILE` sentence from the skill fails two tests; deleting
  the `PG_RESIDUAL_CLASSES` sentence fails one — and with the `assertStatement` at `:310-314` also
  removed, which is the edit the header's own wording invites, deleting it leaves the suite at
  2190 | 2187 | 0.
- **correctness, low, `tests/skill-contracts.test.mjs:360` — the same defect, found independently by
  a second lens.** Recorded as a convergence rather than collapsed as a duplicate: two lenses
  arriving at the same measurement from different starting points is evidence about the finding.
  The correctness lens added the half the claims lens did not: under a section scope `\bpaths?\b`
  does drag in exactly two, but they are the two the comment does **not** name.
- **security, 2 lows — both residuals T9 declared in its own comment at
  `tests/skill-contracts.test.mjs:368-371` before anyone went looking.** (a) An **indented code
  block** instructing the gate to reuse the path a refusal printed leaves the suite at
  2190 | 2187 | 0 — measured twice, once under `## On FAIL` and once inside the locked section —
  because `claimSites` (`tests/md-contract.mjs:317`) never yields code, and `phase-gate` carries no
  per-section code-block count of the kind that makes the same plant red in `parallel-execution`
  § 5. (b) A **lexicon-free prose** paragraph saying the same thing, naming none of the thirteen
  alternatives, is likewise green.

  **Decision: carry both, do not fix.** The security lens's own closing judgement is what decided
  it. Its **actual** words, read out of `.teammates/purgefix/reviews/4-security.json` rather than
  out of the dispatch that handed them to me inside quotation marks, are attached to the `:388`
  residual **alone** — the code-block route, (a) above: *"the residual is named honestly at
  tests/skill-contracts.test.mjs:368-371 and the prose immediately above it
  (skills/phase-gate/SKILL.md:105-107) tells the operator the opposite, so a reader of the document
  is not misled today; what is missing is the lock that would
  keep it that way."* The `:372` residual is graded in that file on a different reason —
  *"Inherent to a lexicon lock and stated as such in the comment"* — and says nothing about a reader
  being misled. An earlier revision of this bullet printed a **paraphrase** in quotation marks and
  attached it to both lows; the paraphrase came from my own dispatch, which is why it is corrected
  here and recorded under the orchestrator finding below rather than absorbed. The prose route is
  structurally unclosable — any lexicon is evadable by synonym — and closing the code-block route
  needs new machinery whose
  over-tightness risk nobody has assessed. That a residual was **named with a measured reproduction
  before review**, and then confirmed real and honestly stated by an adversarial lens, is a good
  outcome and not a failure.

### Carried from phase 3 round 9

- **`scripts/cli.mjs:2242` — `ambiguousPhaseRefusal` counts INTEGER phases only** (correctness,
  low). `.filter((p) => Number.isInteger(p))` drops non-integer phases from the set it counts, so a
  `plan.json` mixing phase `1` with phase `"2"` or `2.5` leaves one countable phase, nothing is
  refused, and the unfiltered `default` route reviews every branch under one stamp. Measured on the
  merged tree: with `{"tasks":[{"id":"T1","phase":1},{"id":"T2","phase":"2"}]}` and `--phase`
  omitted, `review-dispatch` exited 0 and dispatched **both** branches; with `--phase 1` it
  dispatched one; with both phases written as integers it exited 2. `assignPhases`
  (`scripts/phases.mjs:63`) never writes such a plan, but `plan.json` is agent-writable and this CLI
  says so repeatedly. Pre-existing in the unfiltered arm (identical on `master` and the fork point);
  what is new is the partial guard.

  **This one was also routed into T9's documentation, and that half landed.**
  `skills/phase-gate/SKILL.md:76-80` now states the bound beside the refusal, with the reproduction:
  *"The guard counts INTEGER phases only, so a `plan.json` mixing phase `1` with phase `"2"` leaves
  it one countable phase, nothing is refused, and the omitted flag reviews both branches under one
  `default` stamp."* It is pinned by an `assertStatement` at `tests/skill-contracts.test.mjs:274`.
  So the **documentation is closed and the code limitation is not** — and the pin on that sentence
  is one of the four unanchored ones the phase-4 medium above is about.
- **Three claims lows, all record hygiene, none behavioural** — all three re-verified as still
  present at `f99483e`:
  - `scripts/cli.mjs:1688` says the plan "is read through `nonBlockingReadFlags` **below**", but
    after `692617d` relocated the block that function is **above** it (`nonBlockingReadFlags` at
    `:1665`, the comment at `:1688`). The directional word is exactly the staleness the paragraph
    three lines down warns about. Fix: `above`, or drop the direction word.
  - `scripts/cli.mjs:1691` says "so for one commit it sat on `readRunPlan`". Measured by walking
    every commit in `aaafaae..teammates/purgefix/T8`: it sat there for **three** (`3779c62`,
    `f17c16c`, `963bb9d`), including the tip a reviewer read and flagged. That is the difference
    between "caught inside one commit" and "survived a review round", which is the point the
    paragraph is making.
  - `tests/cli.test.mjs:888` cites a test name in emphasis caps — "the run id AND THE PLAN BYTES in
    the unreadable-plan refusal …" — which matches no test. Verified here, and the count an earlier
    revision of this bullet gave was wrong: `command grep -ac 'the run id AND THE PLAN BYTES'`
    returns **1** — line 888's own citation, the only occurrence of the caps form in that file —
    while the lowercase form returns **2**, the correct citation at `:917` and the real table row at
    `:2609`. What matches no test is the *name*, not the string, and that is the half worth
    executing: `node --test --test-name-pattern='the run id AND THE PLAN BYTES in the
    unreadable-plan refusal' tests/cli.test.mjs` reports `tests 1 | pass 1` — the file, with no
    named test selected — and exits 0, while the lowercase pattern runs `cli.mjs collect-reviews —
    the run id and the plan bytes in the unreadable-plan refusal cannot be made to draw a forged
    terminal write`. The kill list itself is right; only the transcription is not. A maintainer
    pasting the cited name into `--test-name-pattern` matches nothing, node exits 0 having run no
    named test — `skipped 0`, because nothing was selected to skip — and the row
    reads as verified — which the record's own header (*"a name is only self-checking if something
    re-runs it"*) forbids.

### Open design questions

Both carried from `docs/plans/2026-08-27-purge-followups.md:54-62`, as questions. Each now has an
in-tree partial answer that the question should be read against.

- **Should `derive`'s round-trip cross-check survive at all once the name is resolved symbolically,
  or is a race detector that can only fire on a concurrent integration merge worth its own refusal
  path?** The tree's current answer is *keep it, and describe it as nothing more*
  (`scripts/cli.mjs:2292-2302`, `:3799-3800`). The argument against removing it is not that it
  defends anything: it is that reverting to resolve `head.ref` directly *changes nothing
  measurable*, which is precisely why the comment forbids describing it as defence. The question of
  whether a detector
  that can only fire on an honest race earns a refusal path is unanswered.
- **Does the compare-and-swap deletion (`git update-ref -d <ref> <proved sha>`) belong in
  `scripts/git.mjs` now, or does the symbolic resolution shrink that residual far enough to leave it
  as a recorded carry-over?** Currently a recorded carry-over, at `scripts/cli.mjs:3815-3819`: *"The
  sha is proved and then deleted BY NAME, so a write to `refs/heads/<branch>` in between is deleted
  unproved. … There is no tracking issue for that helper: this comment is the record."* The
  neighbouring bullet notes what the resolution did buy — the redirected-name case this used to be
  paired with is closed, so a move inside the window is now something that moved the real run
  branch.

## Tooling defects found while running, unrelated to the plan

- **`collect-reviews` does not persist — CLOSED by T8, and larger than specified.** It now writes
  `.teammates/<runId>/reviews/results-<phase>.json` and prints `results written to <path> — pass
  that path to gate --results` on the line **after** the JSON (`scripts/cli.mjs:4634`, `:5017`).
  What shipped beyond the plan's two steps: the previous round's file is removed before this round
  reads anything, so the file's **existence is itself the claim**; every component of the reviews
  path is vetted and a symlinked `reviews` directory is refused before the clear is attempted; the
  write is `wx` to a pid-and-microsecond temp name then renamed; a write failure exits **4**, not 0,
  with the complete results still on stdout above the error.
  - **The plan's own compatibility promise was broken by the implementation.**
    `docs/plans/2026-08-27-purge-followups.md:694-695` explicitly promised that "an existing `>
    results.json` redirect still produces the same file it always did". Measured across the fork
    point by two lenses: the fork-point gate exits 0 on such a file, the T8 gate exits 2 on
    `--results must be a readable JSON file`, because a plain redirect now also captures the
    trailing path line. The trade fails closed and is defensible; the resolution was to **document
    it** (T9), not to restore the round trip — `skills/phase-gate/SKILL.md:104-120` now says to hand
    `gate --results` only a path printed on a `results written to …` line, and that no refusal
    prints one. Integrating phase 3 without phase 4 would have left the repo documenting a
    composition that fails.
- **`review-dispatch` and `collect-reviews` without `--phase` — CLOSED by T8.**
  `ambiguousPhaseRefusal` (`scripts/cli.mjs:2211`) refuses the omission on a plan with more than one
  phase and returns **2**, printing `<command> needs --phase: the plan for this run has N phases
  (…), and an omitted --phase reviews every task branch of the run — including branches integrated
  in earlier phases`. Applied at both call sites (`:4379` for `review-dispatch`, `:4754` for
  `collect-reviews`). A single-phase plan is unaffected, and an unreadable plan falls through rather
  than refusing on a missing file. **Its bound is still open** — see the integer-phase item above.
- **The sandbox git-safety hook — STILL OPEN, and it will stay open.** It is the operator's local
  configuration, not this repository's, so nothing in this repo can change its verdict. It refused
  a `node -e` one-liner during the writing of this document with *"this command is too complex to
  verify that it stays inside the worktree"*. T4 added the fallback a teammate needs instead
  (`scripts/brief.mjs:175`): write the two lines to a file and run that file; the refusal is the
  shell's, not the gate's, and reporting `blocked` over it is not expected.
- **`brief` cannot be used verbatim for a fix round.** Its MANDATORY FIRST STEP is `git checkout -B
  <branch> <base>`, which on a fix round **resets the task branch and destroys the work being
  fixed**. Compounding it: a fresh isolation worktree cannot check out a branch that a dead
  worktree still holds, so the naive retry is blocked-then-destructive. Wants a `--fix-round` flag
  that emits the same brief without the reset.
- **The `SubagentStop` / worktree guard blocks a teammate from inspecting or removing another
  worktree**, so freeing a branch held by a reaped agent is necessarily the orchestrator's job.
- **`npm install` generates an untracked `package-lock.json`** — the project has no dependencies —
  which dirties a teammate's worktree and can fail the ownership check. Do not run it; `npm test`
  works directly.
- **The gate reports a toolchain failure and a red suite in the same verdict cell** (new,
  2026-08-28). `~/.config/mise/config.toml` pinned `claude` and `gh` but carried **no `node`
  entry**, so the `node` shim resolved by fallback while the `npm` shim refused outright with `No
  version is set for shim: npm` — and the gate's `test` check shells out to `npm test`. The first
  phase-4 gate attempt therefore returned `verdict: FAIL, failed: ["test"]` on an **environment**
  error. Reviewers never hit it, because they invoke `node --test` directly. The wall itself is
  closed (`mise use -g node@26.7.0`; `npm -v` is 11.19.0 and plain `npm test` works with no PATH
  override), **but the class survives the fix and is the part worth recording**: a missing
  interpreter and a genuinely red suite land in the same cell, and only reading the check's own
  `output` by hand told them apart.

## Review methodology — what nine rounds and five rounds bought

The most transferable output of this run. These are properties of *how* to review, not of this
repository, and they are why the round counts were worth their cost.

- **A text-matched mutation can land on the wrong site, and it fails in both directions.**
  `scripts/cli.mjs` holds byte-identical three-clause guards roughly **1,470** lines apart
  (`assertContained` at `:695`, `plantedReviewsLink` — which opens at `:2163` — at `:2166`; those
  are the only two hits in the file). An earlier revision of this bullet cited `:2033`, a one-clause
  `ESRCH` guard inside `livePreviewPaths` 130 lines above the function it names, and derived
  "1,300" from it — the bullet teaching this rule had landed its own pointer on the wrong function.
  Unanchored, one mutation produced a **false green** (the target ran untouched and the reviewer
  reported "the test did not catch it"); the same edit anchored produced a **false red credited to
  the wrong test** — a reviewer's own words: *"Same
  edit, opposite conclusion."* A third instance was a 25-test misfire when a `replace` landed on
  the wrong `phaseName` first. Every claims and tests lens in this plugin mutates by text match.
  **Anchor every mutation inside the intended function and verify it landed**; better still,
  exercise the exported function directly. The anchor rule changed a result on its first use — the
  round that adopted it would otherwise have certified a pin that does not exist.
- **Take one pristine backup before the first substitution and never refresh it** — this saved
  three agents, from a SIGPIPE, from the harness's 10-minute command cap, and from a retry that
  copied an already-mutated file over its own backup. **With the refinement T9 paid for in round
  5:** the rule holds *within* a mutation session and is **wrong across rounds**. T9 re-ran a
  round-1 plant script that read a round-1 backup, which silently reverted the current round's
  prose and produced five meaningless failures. Its own words: *"THE STALE-BACKUP RULE CUTS BOTH
  WAYS, AND I HAD IT POINTED THE WRONG WAY."* **Take the backup from the current tip each round.**
- **Record which tests die, not how many pass.** Counts go stale as the suite grows; names do not.
  Two lenses disagreeing on an absolute statement count this run — 150 versus 151, both reporting
  byte-identical lists — is a small demonstration of the same thing. **The rule proved itself on
  this run's own record.** A phase-3 disposition held that the bind-mount test accounts for the 3
  skips in the 2187 baseline; enumerating them by name showed it does not, and that it runs here.
  The **count was 3 under both accounts** — only the names separated them, and only the names would
  have told a reader that a boundary test they believed was skipped had in fact been executing all
  along.
- **A seam-based test can pin only the seam.** Where a dependency is injectable
  (`deps.lstat ?? lstat`), mutate the **fallback** — the branch every injected test survives by
  construction — to prove production is pinned too. On this run that was checked by comparing the
  seamed implementation against the pre-seam body across five real trees.
- **You cannot pin "works at any depth" with a deeper literal.** Assert that the number of
  components examined **equals the path's depth** — count the `lstat` calls. Three rounds were lost
  to planting one level deeper than the last guess, with two comments in the same file disagreeing
  about the same test's true bound.
- **Verify "comments and fixtures only" mechanically.** Strip comments and blank lines with a
  **string-aware tokeniser** and diff. Inspection is not the same claim.
- **Verify by truncation at several points, not by deletion.** Deletion already goes red for other
  reasons and therefore says nothing about a prefix hole — which is exactly how a prefix pin
  anchored on eight words survived a round on T9, with its two sibling sentences surviving the same
  truncation only by accident, each in a different test.
- **Reviewers get the diff, not the plan.** A code comment that justifies a choice by a plan-level
  constraint is unverifiable to a reviewer by construction. Put the justification in the comment or
  do not rest on it.
- **A declared residual with a measured reproduction is a good outcome, not a failure.** T9 named
  both of its bounds in a comment before any reviewer went looking, and the security lens confirmed
  both were real and honestly stated. The two carried security lows above are that.
- **Adversarial lenses are worth keeping separate.** Correctness proved a site safe on a premise
  (`runBranch === runBranchRef.replace(/^refs\/heads\//)`, a provable round trip *given* the ref
  starts with `refs/heads/`); security broke exactly that premise. Neither lens was wrong — the
  **composition** of their assumptions was, and only the lens that attacked the premise found it.

## The orchestrator finding

My dispatches are unreviewed input to the tree. Four lenses check the implementer's output;
**nothing checks the claims I hand the implementer**, and an implementer transcribes them because
they came from me.

- I put a wrong mechanism into a code comment **twice in the same eight lines** — first that
  `idRefusal` permits control characters, then that nothing validates the run id at all. Both times
  the security-substantive half was right and the *explanation* was wrong. **Over-correction is the
  same defect as the original**, and the tree records it at `scripts/cli.mjs:4860-4862`: *"Twice
  this sentence has been written from an inference about which validator applies, and twice the
  mechanism was wrong while the conclusion happened to hold. Both times one call … settled it in
  seconds."*
- **Six times an agent corrected something I relayed.** The seventh was different in kind: in the
  round-5 tests dispatch I specified `unableToVerify` as an **array**, having never checked it
  against the CLI. The real contract (`scripts/reviews.mjs:210-221`, verified) is that
  `unableToVerify` is a **string** meaning *this lens verified nothing at all*, while `unprobed` is
  the array meaning *enumerated and not reached*. `collect-reviews` refused the phase, exit 4, on
  `unableToVerify is an array`. **That is the first time I put a wrong claim into a schema rather
  than into prose** — and the fail-closed design caught it, which is the system working.
- The fix that has actually worked, and which should be standing in every dispatch rather than
  added after being burned: **"treat a bare assertion from me as a claim to check, not a fact to
  transcribe."** The first time a wrong relay was caught *before landing* was the dispatch that
  carried that sentence. It is now in `agents/tm-implementer.md` and in every brief, via T4 and T5.

**This document was written under that rule, and it caught three things.** Corrections to the
dispatch that produced it, each measured in a worktree at `f99483e`:

1. The dispatch said the census header is at `tests/cli.test.mjs:898` claiming 48 lines. The claim
   is right; the location is `:2267`.
2. The dispatch said **9 commits on the unpushed range carry `Co-Authored-By:` trailers**. Measured
   `922ac91..f99483e`: **zero**. Those nine were run `purge`'s, and the 2026-08-27 rewrite recorded
   below already stripped them.
3. The dispatch said **~100 commits** are authored `Reviewer <r@example.com>`. Measured: **52**, all
   of them in run `purgefix`.

**A fourth was found by the review round that followed, and it is a new kind.** The fix-round brief
handed me the security lens's judgement **inside quotation marks**, and it was a paraphrase. The
claims lens caught it against `.teammates/purgefix/reviews/4-security.json`. This
document names those files as the authority and itself as the index, so a quoted sentence that is
not in the authority is the one defect the arrangement cannot absorb — a maintainer diffing index
against authority cannot tell whether the reviewer wrote it and the file was edited, or the index
invented it. It is corrected above and recorded here rather than quietly fixed, because
**over-correction and absorption are the same defect as the original**: an orchestrator error that
leaves no trace teaches nobody that dispatches need checking. The rule already in every brief covers
it and was simply not applied to a sentence that arrived pre-quoted — *treat a bare assertion from
me as a claim to check*, quotation marks included.

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

### Added by run `purgefix`, 2026-08-28

**The authorship problem came back, in a new spelling, and the sentence above did not hold for this
run.** Measured at `f99483e` in a worktree:

- `922ac91..cb83c44` (run `purge`, 51 commits): **51 authored and committed `Andrey Mudri
  <andreybeckert@gmail.com>`**. The 2026-08-27 rewrite held.
- `cb83c44..f99483e` (run `purgefix`, 98 commits): **46 `Andrey Mudri <andreybeckert@gmail.com>`
  and 52 `Reviewer <r@example.com>`**, author *and* committer, from a repo-local
  `user.name`/`user.email` override shadowing the global identity.
- The boundary is `7054594` (2026-08-28 07:52). The last mis-authored commit is `dba9d0f` (07:12);
  everything from `7054594` onward, on every branch, is correct. The override was unset mid-run:
  `git config --local --get user.name` now exits 1 and the effective identity is `Andrey Mudri
  <andreybeckert@gmail.com>`.

**Tool-authorship trailers: none on the unpushed range.** `git log 922ac91..f99483e --grep` for
`Co-Authored-By`, `Claude-Session` and `Generated with` returns **0** for each. The corresponding
claim in the dispatch that produced this document was stale — it described run `purge`'s nine, which
rewrite 1 above already stripped. **77 commits at or before `922ac91` do carry them** (`4753dd6`
carries both a `Co-Authored-By: Claude Opus 5 … <noreply@anthropic.com>` and a `Claude-Session:`
line). Those are on `origin`; the same shared-history reasoning that left `r <r@r>` alone applies to
them, and they are recorded here so a future reader does not mistake their existence for a fresh
regression.

**So one rewrite remains, not two**: authorship over `cb83c44..f99483e`, 52 commits. Nothing is
pushed, so it is still unpushed work. **This document does not perform it** — it records that it is
outstanding, and that a rewrite over that range must be verified the same way the 2026-08-27 pair
was: every ref's tree byte-identical to its pre-rewrite backup, dates preserved to the second, and
`npm test` unchanged at 2190 | 2187 pass | 0 fail | 3 skipped.
