# Changelog

## Unreleased

All four follow-ups recorded for v1.0.1 below. They are documentation or test
changes; no runtime behaviour moved.

- **A scan over statements now reaches headings too.** `claimSites` in `tests/md-contract.mjs`
  returns every place a claim can be written in a scope — statements built from prose, the scope's
  own heading, and every heading nested in it. The SubagentStop refusal scan reads it instead of
  `doc.statements`. Measured against the real tree before and after: a heading carrying the denied
  promise scored 0 hits under the old scan and 1 under the new one. The locked
  `The SubagentStop backstop` section additionally pins that it holds no nested heading.
- **Two documents no longer gloss the missing-branch refusal as "the branch to create".** The
  handler names the missing branch and sends the teammate to its brief for the step that creates
  it, deliberately declining to present a ref derived from a teammate-writable record as an
  instruction. `agents/tm-implementer.md` and `skills/fleet-supervision/SKILL.md` now say that, and
  both locked inventories were updated with them.
- **`skills/parallel-execution` no longer uses "block" in two senses one clause apart.** The
  gate-verdict sense now reads "fails the gate verdict"; the stop sense reads "refuses the stop".

And the fourth, **a region lock binds one block or one section**, which was recorded as needing a
corpus-wide scan rather than a patch:

- **`assertCorpusInventory` locks a mechanism across every document at once.** Every claim site in
  every skill and agent contract naming the SubagentStop mechanism must be one of the sentences
  listed in `tests/skill-contracts.test.mjs`, attributed to the document it appears in. A sentence
  added anywhere fails, and one moved between documents fails as surely as one reworded.
  Demonstrated by appending a contradicting sentence to `skills/phase-gate/SKILL.md` — a document
  no lock covered: the corpus lock failed and the cross-document denylist scan did not, which is
  the escape this closes. It buys location, not meaning: the subject pattern is a lexicon, so a
  sentence discussing the hook without naming it still passes, exactly as under a section lock.
- **A document's statements were counted once per enclosing heading.** `parseDoc` built
  `doc.statements` by concatenating overlapping sections, so a sentence under `### x` inside `## y`
  inside `# z` appeared three times — 316 entries for 154 sentences in `parallel-execution`. Scans
  survived it by checking the same sentence twice; a corpus inventory would have encoded nesting
  depth as content. Now built from the block list once, in document order.

## v1.0.0

First stable release. The plugin orchestrates a fleet of worktree-isolated teammates against a
written plan, and gates each phase on checks that recompute from git rather than from anything an
agent wrote.

### Enforcement

- **`SubagentStop` hook** (`scripts/subagent-stop.mjs`). A teammate that stops without a task branch
  is blocked once and told which branch its brief names; the always-enforced checks then run through
  `complete --enforcement-only`. Both are best effort by construction — the hook allows the stop on
  anything it cannot establish, so an unreadable record never costs a teammate a turn. The phase
  gate remains the enforcement.
- **Ownership** refuses any commit on the run branch that no task branch explains, with a
  base-ancestry allowance for mid-run plan amendments. It asks git about refs that exist now and
  reads no run state.
- **Fileset** enforces each task's declared file set per phase.
- **Merge preview** builds a scratch worktree, so a phase's `test` check is evidence about the merge
  rather than about one branch.

### Review

- **`claims` reviewer lens** with a mutation method: break what a claim protects, run the suite,
  report the claims that survive. Emits `unprobed` and `unableToVerify` so a bounded review cannot
  read as an exhaustive one.
- **Findings are stamped** with the branch tips they judged. `collect-reviews` refuses a file whose
  stamp names different tips, naming the lens and the reason rather than failing downstream.

### Supervision

- **`liveness`** heartbeat for stalled and parked teammates.
- **`map` / `map-notes`** coupling analysis, with blast radius rendered into implementer briefs.
- **`prune-run`** reports and reaps leaked merge-preview worktrees, unlinking Windows junctions
  before removal.

### Install-time behaviour

Installing registers a `SubagentStop` hook with no matcher and `async: false`: every subagent stop
on the machine synchronously spawns `node scripts/subagent-stop.mjs`, in any project, including one
with no teammates run. The handler resolves the stopping agent through a worktree location record
and returns immediately when it finds none, and any error is an allow. README.md states this under
"What installing registers".

### Compatibility

- Requires git 2.24 or newer (`--end-of-options`), declared and detected.
- Requires Node 24.2 or newer.

### Documented boundaries

These are properties of the design, not open defects. Each was measured during the release run and
each is stated where an operator will meet it — in `SECURITY.md` and in
`skills/parallel-execution/SKILL.md` — not only here.

- **`.teammates/` is teammate-writable and invisible to git.** The checks that recompute —
  `fileset`, `ownership`, `merge` — read git and never that directory. But an `agent`-kind check
  such as `review` has no result of its own: `collect-reviews` builds one from files under
  `.teammates/<runId>/reviews/`, which the enforced teammate can write. A planted set of
  empty-findings files reaches `PASS` with no reviewer having run. Treat a recorded `agent` verdict
  as evidence only about a reviewer you know ran.
- **The gate's check list is teammate-writable.** Which checks run comes from `teammates.gate.json`
  in the working tree. The computed results cannot be forged; the list deciding what runs is not
  itself protected.
- **A planted `runBranch` disarms stop-time enforcement** for a whole run and persists until an
  operator removes the field by hand. A planted worktree location record can block a victim teammate
  once.
- **The recorded branch name cannot be compared by eye.** The check is byte-wise and zero-width and
  homoglyph characters render identically in a terminal.
- **`init-run` records no run branch on a detached HEAD** (it records the literal string `HEAD`), and
  none at all in a repository holding both `main` and `master`, where it cannot resolve the base and
  accepts no `--base`.
- **An allowed stop is not a verdict.** Stop-time enforcement is a fast signal on the common honest
  mistake, not a barrier against a determined teammate.

## Known follow-ups for v1.0.1

Found by the release-gate review at the tagged tree, below the blocking threshold, recorded here
rather than fixed after the gate ran.

- **The region locks in `tests/skill-contracts.test.mjs` ignore the heading of the region they lock.**
  `parseDoc` slices a section past its own heading and `statementsOf` builds statements only from
  paragraphs and list items, so a reversed claim placed in the heading of the SubagentStop backstop
  section, or of the block the contract lock binds, passes. The equivalent hole in the two prose
  sections is closed — those scan headings explicitly — so this is a consistency gap, not an unknown.
- **A region lock binds one block or one section.** Prose written outside it that avoids both the
  `refuse|reject|block` prefilter and the denied phrasings can still carry the claim. This is the
  documented scope bound of `tests/md-contract.mjs`, which states that a contradiction placed under
  another heading is out of scope by construction.
- **Two documents summarise the missing-branch refusal as naming "the branch to create"** —
  `agents/tm-implementer.md` and `skills/fleet-supervision/SKILL.md`. Two lenses raised this
  independently, which is why five findings are recorded here as four bullets. The
  branch in that message is derived from a location record under `.teammates/index/`, which any
  teammate can write, and `scripts/subagent-stop.mjs` deliberately declines to present it as an
  instruction — it sends the teammate to its brief, whose branch name comes from the dispatch rather
  than from a file a teammate can plant. The contract should describe the message the way the handler
  does.
- **Section 2 of `skills/parallel-execution` uses "block" in two senses one clause apart.** In "lands
  as a blocking `pending`" it means blocks the gate verdict; in "only a task-scoped failure blocks" it
  means refuses the stop. Both are true and the section is about the second, so the first should be
  disambiguated. Found independently of, and consistent with, the contract-gloss follow-up above,
  which two lenses raised separately.
