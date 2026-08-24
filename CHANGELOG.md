# Changelog

## v1.1.1

Token-usage work. `npm test` stops emitting ~40,000 tokens of pass lines, a `usage` command makes
per-run token cost measurable, and the two agents that inherited every tool now declare the six
they need. No behaviour a plan or a gate depends on has moved.

### `npm test` costs ~126 tokens of output instead of ~40,372

- **A quiet test reporter** (`scripts/quiet-reporter.mjs`) prints failures and one summary line:
  161,489 chars down to 504, a **99.7% reduction** on a green run. `npm run test:verbose` keeps
  the full per-test output.
- Failures keep their full stack and diff, `test:stderr`/`test:stdout` pass through, the summary
  prints on red as well as green, and exit codes are unchanged. The whole saving comes from the
  success path, which is where the noise was.
- Counts come from the root `test:summary` event, never from tallying `test:pass` — a parent
  suite emits its own, which measured 5 where the truth was 4.

### `usage` — per-run token reporting

- **New subcommand:** `cli.mjs usage [--session <id>] [--json] [--root <path>]` reads the
  harness's transcript store and reports, per agent role, the turns, the fixed prefix, the prefix
  paid across all turns, cache reads and output.
- It reports the **fixed prefix** separately because totals hide the thing worth knowing: on run
  `fog` the integrator looked *cheapest* by cache reads while carrying a 5× larger prefix than a
  reviewer whose prompt was longer. Fixed prefix was 40% of all cache reads.
- An unparseable transcript is named and counted rather than skipped, a missing store fails
  naming the path rather than rendering zeros, and a transcript with no metadata keeps its row.
  Each of those would otherwise let the tool understate a total, which is how an optimization
  appears to prove a saving nobody made.
- Honours `CLAUDE_CONFIG_DIR`.

### Agents declare their tool sets

- `tm-implementer` and `tm-integrator` declared no `tools:` and so inherited every tool, including
  whatever MCP servers a session happens to have connected. Both now declare
  `Read, Write, Edit, Bash, Grep, Glob`. `tm-reviewer` already declared its own.
- Measured, with an identical probe prompt and model in one session: an agent whose declaration
  was active carried a **7,867**-token prefix against **27,499** for one without — **19,632
  tokens per turn**, of which agent-definition size explains only ~604. The prefix is re-read on
  every turn.
- **The saving is not yet confirmed for these two agents.** Claude Code loads agent definitions at
  session start, so the declarations added here could not take effect in the session that measured
  them; `HANDOFF.md` records the one probe that closes it. Least privilege stands on its own
  merits meanwhile: a teammate implementing one task in one worktree has no business holding the
  tool that sends email.

### Fixes

- **`projectSlug` stripped of the drive colon.** Every absolute Windows path carries a drive
  letter and a colon cannot appear in a Windows filename, so the slug named a directory that could
  never exist and `usage` could only ever miss there. Whether the harness itself substitutes the
  same character is unverified against a real Windows install.
- **Three test-only Windows failures**, each an assumption that POSIX semantics hold everywhere: a
  file mode asserted on a filesystem with no exec bit, a reporter path passed as a native path
  where the ESM loader reads `D:` as a URL scheme, and the slug above.

## v1.1.0

Plans gain three optional header sections, `finish` reports them, `rebuild-state` stops refusing
a defect it cannot let anyone fix, and the test suite stops spending ~40,000 tokens of context
per run. One CLI surface is new (`init-run` now refuses a malformed header section); the rest is
behaviour that was already promised.

### Plans can now state a destination, its fog, and its boundaries

- **`## Destination`, `## Not Yet Specified` and `## Out of Scope`** are parsed by
  `scripts/plan-sections.mjs`, compiled into `plan.json` by `init-run`, and reported by `finish`.
  All three are optional. An `## Out of Scope` section requires a `## Destination` **with prose
  under it** — an empty heading is refused exactly like an absent one, because "out of scope"
  means beyond the destination and a bare heading leaves that unjudgeable.
- **Two entry rules, checked for shape and not for truth.** Every Out of Scope entry needs a
  reason clause (a separator followed by non-whitespace); every Not Yet Specified entry must
  contain a `?`. A malformed section now fails `init-run` with the offending line quoted, its
  control bytes neutralised so a crafted entry cannot redraw the refusal above it.
- **`finish` prints the destination and the open fog** after the run summary, and says when those
  notes no longer match the plan at the anchor — the notes come from `plan.json` while the verdict
  is computed from git, and one report could previously describe two versions with nothing marking
  it.

### The test suite stopped costing 40,000 tokens a run

- **`npm test` prints failures and one summary line**, down from 161,489 chars (~40,372 tokens) to
  504 (~126), a 99.7% reduction on a green run. `npm run test:verbose` keeps the full output.
  This was measured, not guessed: across three real agent transcripts, fresh input was 212 tokens
  and cache reads were 2,190,488. Cache reads scale with turns × context, so anything sitting in
  an agent's context is paid for again on every later turn — and every agent in a fleet is told to
  run this command, some of them repeatedly.
- Failures keep their full stack and diff, stderr passes through, the summary prints on red as
  well as green, and exit codes are unchanged.

### Fixes

- **`ownership` no longer false-FAILs on a mode-only change.** `contentAt` compared blob bytes and
  never the tree mode, so a chmod was invisible in both directions: an honest merge carrying one
  could never be explained, and a tampered permission bit was waved through. The second half was a
  recorded limitation; one change closes both.
- **`rebuild-state` recovers from a section defect in the plan at the anchor** instead of printing
  `init-run`'s refusal and returning 2. That plan is a historical commit the operator cannot fix,
  and correcting the working-tree copy did not clear it. It now warns — naming the command, the
  anchor, and where the plan was read from — writes `null`/`[]`/`[]` for the three fields, and
  rebuilds everything git can vouch for. `init-run` still refuses, because it reads the working
  tree, where a defect is fixable.
- **A spaced thematic break no longer parses as a bullet.** `* * *` satisfied the bullet pattern,
  so `parseConstraints` injected `* *` as a constraint into **every teammate brief**, and a plan
  whose only defect was a horizontal rule was refused. Thematic breaks now outrank list items, per
  CommonMark. `+ + +` still parses as a list item, because `+` is not a thematic-break character.
- **`renderPlanNotes` defends its own input shape.** `plan.json` is teammate-writable and
  gitignored: a null plan and a null entry threw, a string `notYetSpecified` iterated per
  character into `  - undefined` rows, and a non-string destination rendered
  `Destination: "[object Object]"`. The fog list is also capped at 20 entries — it prints after
  the verdict, and 50,000 entries pushed the "do not land" lines off screen (50,005 lines / 3.1 MB,
  now 22 lines / 1.3 KB). The heading still reports the true total.
- **SessionStart hooks run on Unix again.** `hooks/run-hook.cmd` was committed 100644, so every
  Unix install died at exit 126, and the hook matched three of five SessionStart sources.
- **Windows CI is green again.** Two tests asserted a POSIX exec bit on a filesystem that has
  none; the index mode was correct throughout, and remains the assertion that matters.

### Tests

- Four claims the phase reviews found unpinned are now pinned, each confirmed unpinned first and
  re-checked by mutation afterwards: the `printable` call on the missing-reason refusal branch, the
  continuation lookahead's marker class, `init-run`'s section-before-task ordering, and the
  `if (notes)` guard in `finish`.
- Two vacuous assertions repaired: a phase comparison with no absolute expectation (gutting
  `assignPhases` left it green) and a U+2028 forgery check that split on `\n`, which that split
  can never produce.
- Prose corrected in four places where a comment claimed more than the code delivered.

## v1.0.1

All four follow-ups recorded under v1.0.0 below, closed. They are documentation or test
changes; no runtime behaviour moved, and no CLI, hook or gate surface changed.

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
rather than fixed after the gate ran. **All four are closed in v1.0.1 above**; the list is kept as
written so the record of what shipped in v1.0.0 stays accurate.

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
