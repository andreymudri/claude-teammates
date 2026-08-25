# Handoff — 2026-08-25, end of session

`v1.1.6` is tagged at `master` and released. Nothing is unreleased.

It closes a live escape in `usage`, and it shipped only after the three-platform matrix ran green
on the exact tree that was tagged — see "What to do first" for why that sentence is not decoration.

## Read this first

**Two review passes found that the release commits had been reviewed by nobody, and then that the
fixes for those findings were worse than what they fixed.** Pass six filed 28 findings (6 `high`)
against `be9f093..master` — code that shipped tagged. Pass seven filed **29 findings, 11 `high`**
against the commit that repaired them. That is seven consecutive rounds in which a repair contained
the next defect, and the seventh was the worst.

The live escape that started it: `readdir` and `stat` both follow symlinks, so a session directory
whose `subagents/` was a symlink out of the transcript store was **auto-selected with no flag**,
and `usage` read and reported transcripts from anywhere on disk as this project's spend. The first
fix for it was defeated by a single symlink one level up. Both are closed now, with the
containment anchored on the one path in the function nobody can plant.

**The standing rule still applies.** Editing `agents/`, `skills/`, `hooks/` or `scripts/` in this
repo changes nothing about a running session: it loads a pinned snapshot from
`~/.claude/plugins/cache/claude-teammates/claude-teammates/<version>/`. Before measuring any such
change, check `claude plugin list` against `.claude-plugin/plugin.json`, then:

    claude plugin update claude-teammates@claude-teammates   # bare name fails; @marketplace is required

and restart. An unbumped version makes the update a no-op.

## What to do first

**The CI workflow triggers on `push: branches: [master]` and `pull_request` — nothing else.**
Pushing a feature branch runs NO checks at all. A review pass caught this handoff about to tag a
release on a green tick that belonged to another commit; pushing the branch did not fix it, and
opening a PR was what actually ran the matrix. If you are about to ship from a branch, open the PR
and read `gh pr checks <n>`.

    npm test                                     # expect 1962 / 1959 / 0 fail / 3 skipped
    gh run list --branch <this branch> --limit 1 # NOT `--limit 1` on its own

**`gh run list --limit 1` is the wrong command, and an earlier version of this file printed it.**
Unfiltered it returns the newest run in the REPO — which was `master`'s v1.1.5 run, three commits
back, from before a single test on this branch existed. A branch that has never been pushed has no
runs at all, and the unfiltered command hides that behind another commit's green tick.

**Do not trust a green local suite as evidence that Windows is green.** Three tests on this branch
would have taken Windows CI red — they build symlinks, and without
`{ skip: process.platform === 'win32' }` they throw EPERM *inside the fixture builder* and FAIL
rather than skip. That is fixed, but the class is the point: the matrix is ubuntu/macos/windows,
and a local run proves one of the three.

## The numbers, recounted from JSON

Ground truth is `.teammates/inline-review/reviews{,2,3,4,5,6,7}/*.json`. **Those directories are
gitignored, so they exist only on this machine** — `docs/followups/2026-08-25-inline-review-findings.md`
is the only record that survives a clone.

| pass | reviewed | findings | high |
|---|---|---|---|
| 1 | the unreviewed inline work | 22 | 3 |
| 2 | pass 1's fixes | 20 | 1 |
| 3 | pass 2's fixes | 19 | 1 |
| 4 | pass 3's fixes | 18 | 2 |
| 5 | pass 4's fixes | 18 | 4 |
| 6 | **the release commits — never reviewed** | 28 | 6 |
| 7 | pass 6's fixes | 29 | 11 |
| 8 | `be9f093` (the gap) + release readiness | 18 | 5 |

Passes 1–5 total **97 findings, 11 `high` pre-refutation, 8 `high` post-refutation**. Say which of
those you mean. Two of the four `refute-*.json` files RE-FILE the finding they adjudicate rather
than adding a new site; the other two carry `findings: []` and record their verdict in a
`correctedSeverity` field instead. Between them they downgraded three severities — so "97 findings, 11 high, filed by five
passes and four refutations" is three different tallies in one sentence, and an earlier version of
this document shipped exactly that.

**The declining-returns story from the earlier handoff was wrong in both directions.** It said only
pass 1 found a user-facing bug and later passes only found self-inflicted damage. Pass 2 filed the
`'.. '` path-traversal against code that predated the repair work entirely; passes 6 and 7 each
found a live security escape. Budget on the real shape: **a pass over genuinely unreviewed code is
worth a great deal, and a pass over your own repairs is worth more than it feels like** — 11 highs
in pass 7 against 6 in the pass it repaired.

## Three things worth inheriting

1. **A presence check is not a negative, and a fixture is not an anchor.** The claim that `caveman`
   never reaches reviewer dispatches has been defeated **ten times across seven rounds**. Round six
   pinned the section as an exact snapshot and shipped `includes()` as the guard — which asserts
   the claim is still *there*, never that nothing contradicts it. That is the same shape as escape
   #3, re-shipped as the fix for escape #9. And any fixture beside the file it pins can be updated
   with one `cp`, defeating the snapshot and the presence check in one motion.

   The anchor is now a **SHA-256 constant in the test file**, which no copy from the skill can
   reach. The heading and caveman-line inventories live there too, for the same reason. Eight
   escape routes were re-run against the finished instrument and all eight are red.

   **None of the prose layers is a proof, and the test says so.** An author who edits the digest
   and the inventories can make the skill say anything; what the layers buy is that every route
   needs a deliberate edit to a test file. The layer that IS a proof is the runtime one — no
   caveman path in `review-gen.mjs`, `agents/tm-reviewer.md` or `agents/tm-integrator.md` — because
   that is mechanically decidable. Six rounds of calling a change detector a proof is what cost the
   most here.

2. **My prose about reviewer output is still the least reliable artifact in the loop.** Pass 7
   filed three `high` findings against this document's predecessor and the commit message beside
   it: a claim that work was "corrected in the rewritten handoff" when that file was untouched; a
   reviewed range off by one commit; and an assertion that a release note was false when it was
   true. **Recount from the JSON, re-run the mutation, re-read the file — including for anything
   in this document.**

3. **A fix is where the next bug comes from — and the fix for a security bug most of all.** The
   containment check went through three shapes before it held. Anchoring on a derived path let one
   symlink defeat it. Prefix arithmetic (`rel.startsWith('..')`) refused a legitimate session named
   `..foo` while accepting a sibling session's store. Both classes vanished when the test became an
   exact match against the one path the store is allowed to be.

## Still open

- **The final commit is not lens-reviewed, and this is the regress that never fully closes.**
  Pass 8 covered `be9f093` (the gap pass 5 and 6 left) and the release artifacts, and its findings
  were fixed — in a commit no pass has read. Every round has this property: the commit that closes
  a pass is written after it. What that commit's changes DO have is per-fix verification by
  execution and mutation, done by the author and recorded in the gate output. **That is weaker
  than a lens pass and is stated as such rather than papered over.** If you take one more pass,
  take it here.
- **One mutation is deliberately alive.** Reverting the walk to read from the unresolved name
  instead of `resolvedStore` survives the whole suite. The difference is observable only under a
  race, and the containment check forces the two paths equal in every state a test can construct.
  The TOCTOU window is narrowed, not closed — Node cannot close it without fd-relative opens.
- ~~`skills/phase-gate/SKILL.md:207`~~ — **closed.** Filed by pass 5 and carried unclosed through
  passes 6 and 7; pass 8 verified the negation still passed. Now bound in
  `tests/skill-contracts.test.mjs`, with the three sentences pinned as change detectors and the
  one mechanically decidable claim (no `--run`, no persisted verdict) asserted against the code
  that implements it. The negation was re-run and fails.
- **The three `mutation | killed by` tables** in the followups doc have not been re-run since they
  were written. Only the v1.1.5 validator table was re-verified.
- **`docs/followups/2026-08-22-fog-open-findings.md`** — the accepted bidi exposure (a recorded
  decision) and **49 enumerated-but-unprobed claims** across run `fog`'s four phases. Carried.
- **The gate's persisted record carries no coverage caveat, and cannot.** `.teammates/usage/status.json`
  stores `{verdict, failed, optionalFailed, skipped, pending, branchShas, phaseName, recordedAt}` —
  there is no `results` key, so the `review` check's `output` is not in it. The six-item caveat lives
  in `.teammates/inline-review/gate-pass7.txt` and `results-pass7.json`, both gitignored. It is NOT
  in `results-final.json` / `verdict-final.json`, which an earlier version of this bullet named:
  those hold the PRE-RELEASE verdict, whose review output claims "5 lens passes over
  6a9edff..be9f093 ... all closed" — asserting coverage THROUGH `be9f093`, the exact opposite of
  the first bullet in this list, and predating this branch entirely.
  An earlier handoff claimed the persisted gate records the caveat. It does not.

## What `usage` does and does not demonstrate

`node scripts/cli.mjs usage --root .` runs and exits 0, but **in this project it cannot exercise
the recursion fix v1.1.4 shipped**: no session under this repo's projects directory has a
`subagents/workflows/` directory, so the recursive walk finds nothing a flat read would have
missed. The store that reproduced the original bug — 5 transcripts, 31,394,783 cache reads —
belongs to a different project on this machine, and both figures are machine-local.
