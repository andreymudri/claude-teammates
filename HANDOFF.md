# Handoff — 2026-08-25, end of session

Everything is on `master` and pushed. `v1.1.5` is tagged at `master`; nothing is unreleased.

## Read this first

**`usage` was reporting an entire run as costing nothing, and a green test suite could never have
caught it.** `readdir` on `subagents/` did not recurse, and a workflow-dispatched run keeps its
transcripts under `subagents/workflows/<wf-id>/` — so the command printed `(0 subagents)`, a table
of zeros, and **exit 0**. Against the real store on this machine that concealed **31,394,783 cache
reads**. Fixed, released in `v1.1.4`.

**The standing rule still applies, and applies to this release.** Editing `agents/`, `skills/`,
`hooks/` or `scripts/` in this repo changes nothing about a running session: it loads a pinned
snapshot from `~/.claude/plugins/cache/claude-teammates/claude-teammates/<version>/`. Before
measuring any such change, check `claude plugin list` against `.claude-plugin/plugin.json`, then:

    claude plugin update claude-teammates@claude-teammates   # bare name fails; @marketplace is required

and restart. An unbumped version makes the update a no-op — which is why `v1.1.4` and `v1.1.5`
exist rather than leaving the fixes on `master` untagged.

## What this session did

The previous handoff's third open item was: run `fog` and every inline change since landed on a
verified fresh test pass, **not** a recorded gate PASS, with no reviewer lenses ever dispatched.
That was closed by actually dispatching them.

    verdict PASS — test pass, review pass, CLI-computed
    recorded in .teammates/usage/status.json under `solo:default`

The reviewed range was `95a4b03..master`: everything after the fog merge, which included the two
runs `quiet` and `usage` — both `init-run`'d with real plans and then never executed as fleets, so
`scripts/usage.mjs`, `scripts/usage-store.mjs` and `scripts/quiet-reporter.mjs` had reached
`master` unread by anyone.

**Five lens passes and four refutations filed 97 findings, 11 of them `high`.** All are closed or
accepted with the reasoning recorded. The full per-finding record, including what each pass found
in the previous pass's fixes, is `docs/followups/2026-08-25-inline-review-findings.md`.

## The number that matters for planning

| pass | reviewed | findings |
|---|---|---|
| 1 | the unreviewed inline work | 22 |
| 2 | pass 1's fixes | 20 |
| 3 | pass 2's fixes | 19 |
| 4 | pass 3's fixes | 18 |
| 5 | pass 4's fixes | 18 |

**Only pass 1 found a user-facing bug.** Passes 2–5 found defects in the fixes, in test quality,
and in the record — 75 findings that existed only because of the repair work. Budget accordingly:
one adversarial pass over genuinely unreviewed code is worth a great deal; the fourth pass over
your own patches is worth much less, and the count does not fall off as fast as it feels like it
should.

## Three things worth inheriting

1. **A word-matcher over prose cannot pin a claim.** The claim that `caveman` never reaches
   reviewer dispatches was defeated **eight distinct ways across six rounds**, and every fix opened
   the next hole — including the round-four instrument defeating itself, when an aside spliced
   inside the claim sentence matched its own `[^.]*` anchor while both inventory screens skipped it
   because it *was* the claim. Also reachable: a heading (`parseDoc` never makes those statements),
   the frontmatter, a code block, a duplicate-titled decoy section, and a sentence naming neither
   "reviewer" nor "caveman". A pattern can only forbid the phrasings its author imagined.

   The section is now pinned as an **exact snapshot** (`tests/skill-config.test.mjs`), with a
   hand-maintained inventory of every other `caveman` mention in the skill. All eight escapes fail
   against it. **Editing that section fails the test until you update the fixture** — deliberate,
   because the measurement is load-bearing. If you need a looser instrument, that is a decision to
   take knowingly, against six rounds of evidence.

2. **My summaries of reviewer output were the least reliable artifact in the loop.** The findings
   files were correct every time; my prose about them was wrong four times — a refutation
   summarised as more favourable than it read, and three separate miscounts of a pass taken from a
   reviewer's prose rather than its JSON. **Recount from
   `.teammates/inline-review/reviews{,2,3,4,5}/` rather than trusting a summary, including one in
   this document.** Those directories are gitignored, so they are local to this machine only.

3. **A fix is where the next bug comes from.** A cap added to bound the walk reintroduced, one
   comment below, the exact "layout may have changed" lie the walk had been written to eliminate.
   A `kind` field added to stop three gaps being conflated then mis-tagged a fourth. A test written
   to pin a cap broke macOS CI with EMFILE by creating 20,050 files. None of these were caught by
   the suite; all were caught by dispatching a lens at the fix.

## Verify before trusting anything above

    npm test                              # expect 1941 tests, 1938 pass, 0 fail, 3 skipped
    gh run list --limit 1                 # green on Linux, macOS and Windows
    node scripts/cli.mjs usage --root .   # the command this release fixes

CI was green on all three platforms at `f38e868`, the tip merged as `21f0a88`.

## Closed in v1.1.5

- **`'.. '` passed both path-component validators.** Windows strips trailing spaces and dots, so
  `'.. '` reached the filesystem as `..` — the value both checks existed to refuse, wearing a
  suffix that `=== '..'` could not see. It was carried across a release **by decision**, because
  `usage-store.mjs` and `reviewFileName` were separate implementations of one rule and fixing
  either alone would have left the other. They are now the same exported function
  (`isUnsafePathComponent`), which tests on what a component *resolves* to rather than its
  literal — so `v1.2.3` still works — and one mutation of it fails tests at both call sites.

## Still open

- **The final commit of the branch (`f38e868`) is self-verified by mutation but not lens-reviewed.**
  Every unreviewed commit on that branch turned out to contain something. The gate's `review` check
  records this in its `output` rather than implying full coverage.
- `docs/followups/2026-08-22-fog-open-findings.md` — the accepted bidi exposure (a recorded
  decision, not a gap) and the **49 enumerated-but-unprobed claims** across run `fog`'s four
  phases. Those are carried, not closed; the document now says so in both places it previously
  implied otherwise.
