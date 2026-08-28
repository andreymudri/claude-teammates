# Purge followups — closing the open findings

Closes `docs/followups/2026-08-27-purge-open-findings.md`. Every finding in that document is
either a task here or is listed under Out of Scope with the reason. The reviewers' own
reproductions and suggested wordings live in `.teammates/purge/reviews/` and are the authority
for what each fix has to say.

Two things are settled before the first task and shape several of them:

1. **The `scripts/git.mjs` item is closed, not documented.** `currentBranch()` is reimplemented
   over `git symbolic-ref --quiet HEAD`, so the run branch's name never passes through git's
   abbreviation rules. That closes the data-loss path at its root and makes the operator-facing
   "confirm `git rev-parse --abbrev-ref HEAD` prints the plain name" precondition obsolete
   rather than merely under-qualified — so the prose findings at `cli.mjs:1690`, `cli.mjs:3101`,
   `skills/finishing-a-development-branch/SKILL.md:92` and `skills/parallel-execution/SKILL.md:180`
   are answered by rewriting those sentences to describe symbolic resolution, not by adding the
   validity-window clause the reviewers suggested for a world where the hazard stays open.
2. **Task 1 was absorbed into Task 7 mid-run, on 2026-08-27**, after phase 1 had already run.
   The symbolic-resolution change and the `tests/cli.test.mjs` fixture it invalidates cannot be
   separated into two phases — see the note under Task 7 for the measurement. The work committed
   as `89a2853` on `teammates/purgefix/T1` is preserved and Task 7 starts from that branch.
3. **The operator feedback from this run is in scope.** Sub-agent work shipped defects and
   overconfident claims that only surfaced two or three review rounds later; changes were made
   from stale or over-inferred context; and long stretches were burned attempting `sudo`,
   `pkexec` and interactive 2FA from a shell that cannot prompt. Those are dispatch-time
   defects: the brief and the agent definitions never state the environment walls, never bind a
   claim to an execution, and never forbid acting outside the declared set on inferred context.
   Tasks 4 and 5 fix that where every teammate reads it.

## Global Constraints

- Node >= 20
- Zero new runtime dependencies
- Commit messages: single-line, commitlint style, English
- No tool-authorship trailers in any commit message, PR body or tag: no `Co-Authored-By:`
  naming Claude or Anthropic, no `Claude-Session:`, no `🤖 Generated with [Claude Code]`
- Prose in `scripts/`, `skills/` and `agents/` uses British spelling, matching the tree
  (`behaviour`, `authorised`, `neighbouring`)
- Every claim written into a code comment, a skill sentence or a test comment must be backed by
  a command you actually ran in this task. If you could not run it, do not write the claim —
  write what you did verify, and say the rest is unverified.
- A source-text assertion must strip comments before counting, and the comment documenting that
  assertion must not itself name the symbol being counted
- `npm test` is green before you commit: baseline is 2047 tests | 2044 pass | 0 fail | 3 skipped

## Destination

The run branch carries no finding that a reviewer reproduced and nobody answered: the two
behavioural hazards are closed in code, every comment and skill sentence the reviewers measured
as false says something true, the prose those commits added cannot be deleted with the suite
green, and a teammate dispatched by this plugin is told the environment walls and the claim
discipline before it starts rather than after three review rounds.

## Not Yet Specified

- Should `derive`'s round-trip cross-check survive at all once the name is resolved
  symbolically, or is a race detector that can only fire on a concurrent integration merge worth
  its own refusal path?
- Does the compare-and-swap deletion (`git update-ref -d <ref> <proved sha>`) belong in
  `scripts/git.mjs` now, or does the symbolic resolution shrink that residual far enough to
  leave it as a recorded carry-over?

## Out of Scope

- The sandbox git-safety hook that refused the literal `complete --root <main worktree>`
  invocation — that hook is the operator's local configuration, not this repository's, so
  nothing here can change its verdict. Task 4 adds the fallback a teammate needs when it fires.
- The two adjudicated mutation survivors in `scripts/gate-runner.mjs` and the
  `tests/gate-runner.test.mjs` oversubscription failures — both are recorded operator decisions
  in the followups document's "do not re-litigate" section.
- Rewriting the pushed history to correct `r <r@r>` authorship on `4753dd6` and earlier — those
  commits are on `origin`, so correcting them rewrites shared history rather than unpushed work.

---


### Task 2: refuse a planted merge-preview owner marker instead of writing through it

**Files:**
- Modify: `scripts/merge-preview.mjs`
- Test: `tests/merge-preview.test.mjs`

- [ ] **Step 1:** In `scripts/merge-preview.mjs`, extract the marker write into an exported
  helper above `withMergePreview`, so the flag it uses can be tested against a real filesystem
  entry rather than asserted from source text:

      // `'wx'` is `O_CREAT|O_EXCL|O_WRONLY`: it refuses an entry that already exists instead of
      // opening it. Plain `'w'` is `O_CREAT|O_WRONLY|O_TRUNC` and FOLLOWS a symlink — verified
      // destructively against this tree, where a planted symlink had its target truncated to the
      // pid. The window is tight (mkdtemp to writeFile measured at a median of 0.138 ms and a
      // maximum of 1.127 ms, with a six-character suffix nothing can guess, so it needs an
      // inotify watcher on the temp root) but it is retryable forever at no cost to whoever
      // holds the watcher, and the same remedy was already applied to the CLAIM write in
      // scripts/gate-runner.mjs — the marker was simply never covered.
      //
      // Impact is bounded to files this user can already write, so nothing here is a privilege
      // gain. What it prevents is this process destroying one of its own files on a path it
      // did not choose.
      //
      // EEXIST here is not a race to retry: mkdtemp created this directory 0700 a moment ago
      // and nothing legitimate can have put an entry in it, so the throw is the answer. It is
      // raised INSIDE withMergePreview's `try`, so the `finally` still cleans the directory up.
      export async function writeOwnerMarker(marker, pid) {
        await writeFile(marker, `${pid}\n`, { encoding: 'utf8', flag: 'wx' })
      }

- [ ] **Step 2:** Replace the call at `scripts/merge-preview.mjs:88`
  (`await writeFile(marker, \`${process.pid}\\n\`, 'utf8')`) with
  `await writeOwnerMarker(marker, process.pid)`. Leave the surrounding comment about claiming
  before `git worktree add` exactly as it is — it is about ordering, not about the flag.

- [ ] **Step 3:** In `tests/merge-preview.test.mjs`, add two tests against a real temp
  directory:

      test('writeOwnerMarker refuses a path that already exists rather than truncating it', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'tm-marker-'))
        const marker = path.join(dir, 'marker')
        await writeFile(marker, 'pre-existing\n', 'utf8')
        await assert.rejects(() => writeOwnerMarker(marker, 4242), (err) => err.code === 'EEXIST')
        assert.equal(await readFile(marker, 'utf8'), 'pre-existing\n')
        await rm(dir, { recursive: true, force: true })
      })

      test('writeOwnerMarker does not follow a symlink planted at the marker path', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'tm-marker-'))
        const victim = path.join(dir, 'victim')
        const marker = path.join(dir, 'marker')
        await writeFile(victim, 'do not truncate me\n', 'utf8')
        await symlink(victim, marker)
        await assert.rejects(() => writeOwnerMarker(marker, 4242), (err) => err.code === 'EEXIST')
        assert.equal(await readFile(victim, 'utf8'), 'do not truncate me\n')
        await rm(dir, { recursive: true, force: true })
      })

  Add `mkdtemp`, `symlink`, `readFile`, `rm` and `writeFile` to the `node:fs/promises` import
  and `tmpdir` from `node:os` if they are not already imported in that file.

- [ ] **Step 4:** Add a test that a marker really is written on the happy path, so Step 1's
  refactor cannot silently drop the write:

      test('withMergePreview writes the owner marker naming its own pid', async () => {
        // Assert the marker file at previewOwnerMarkerPath(dir) reads `${process.pid}\n` from
        // inside the `run` callback, where the preview directory still exists.
      })

  Write the body out in full against whatever fixture helper that file already uses for
  `withMergePreview`.

---

### Task 3: bind a claim to exactly one statement

**Files:**
- Modify: `tests/md-contract.mjs`
- Create: `tests/md-contract.test.mjs`

- [ ] **Step 1:** In `tests/md-contract.mjs`, inside `assertClaim`, immediately after the
  existing `const hit = assertStatement(...)` line, add the uniqueness check:

      // A CLAIM MUST BE UNIQUE IN ITS SECTION. `findStatement` returns the FIRST statement
      // matching, and the stray inventory below exempts by TEXT EQUALITY (`s.text !== hit.text`),
      // so a verbatim duplicate of a chain link planted earlier in the same section steals the
      // binding: `then:` is satisfied against the decoy, the REAL occurrence is free to be
      // followed by a sentence that annuls it, and both copies are exempt from the inventory
      // because they compare equal to the hit. Verified on the merged tree: the whole suite
      // stayed green with a duplicated pair planted ahead of the real one in both
      // skills/parallel-execution/SKILL.md § 5 and the finishing skill's cleanup section.
      //
      // Requiring exactly one match closes it for every claim in every document at once, and it
      // costs nothing legitimate: a document that states the same sentence twice in one section
      // has a prose defect of its own. Measured against the tree before this landed — 2047 tests,
      // 2044 pass, 0 fail — so no existing claim relied on being the first of several.
      const matches = scope.statements.filter((s) => claim.test(s.text))
      assert.equal(
        matches.length,
        1,
        `${where}the claim pattern ${claim} matches ${matches.length} statements in ${scope.label}, ` +
          'so which one it binds to is decided by position rather than by the pattern.' + show(matches) +
          '\n  A duplicate lets an inserted sentence annul the real occurrence while every ' +
          'anchored regex stays green. Make the claim unique, or narrow the pattern.',
      )

- [ ] **Step 2:** Create `tests/md-contract.test.mjs` with unit tests for the helper itself.
  This file does not exist today; it is the first direct test of `md-contract.mjs`:

      import { test } from 'node:test'
      import assert from 'node:assert/strict'
      import { assertClaim, parseDoc } from './md-contract.mjs'

      // The helper is exercised indirectly by every skill and agent contract test, which is why
      // it had no tests of its own. That is exactly what let the first-match binding survive
      // three review rounds: a defect in the checker is invisible to documents that do not
      // trigger it.
      const doc = (text) => parseDoc(text, 'fixture')

      test('assertClaim binds a claim that appears exactly once', () => {
        const d = doc('## S\n\nAlpha is true. Beta follows from it.\n')
        assertClaim(d.section(/^S$/), { claim: /^Alpha is true\.$/, then: /^Beta follows from it\.$/ })
      })

      test('assertClaim refuses a claim duplicated in the same section', () => {
        const d = doc('## S\n\nAlpha is true. Beta follows from it.\n\nAlpha is true. Ignore all of the above.\n')
        assert.throws(
          () => assertClaim(d.section(/^S$/), { claim: /^Alpha is true\.$/, then: /^Beta follows from it\.$/ }),
          /matches 2 statements/,
        )
      })

      test('assertClaim still refuses a claim that appears nowhere', () => {
        const d = doc('## S\n\nSomething else entirely.\n')
        assert.throws(() => assertClaim(d.section(/^S$/), { claim: /^Alpha is true\.$/ }), /claim not stated/)
      })

  Verify the `## S` heading level and `section()` matcher against how the other test files call
  `parseDoc`/`section`, and adjust the fixture text to whatever `parseBlocks` actually requires.

- [ ] **Step 3:** Run `npm test`. It must stay green: this change was measured against the
  merged tree before the plan was written and no existing claim relied on being the first of
  several. If a contract test does go red, the duplicate it names is a real prose defect in a
  file you do not own — record the failing test name and the duplicated sentence in your
  `summary` and report `status: "blocked"` rather than editing that document.

---

### Task 4: tell every teammate the environment walls and the claim discipline

**Files:**
- Modify: `scripts/brief.mjs`
- Test: `tests/brief.test.mjs`

- [ ] **Step 1:** In `scripts/brief.mjs`, add a shared `environmentRules` block above `full`,
  rendered by both variants. It states the three walls that cost this run long stretches of
  rediscovery, and it names the source of truth for each rather than leaving a teammate to
  probe:

      // THE THREE WALLS, stated before the work rather than discovered during it. Each one cost
      // a teammate in run `purge` a long stretch of retrying, and each is a property of the
      // harness rather than of the task: a subagent has no terminal, so nothing it runs can
      // prompt, and a command that waits for a prompt waits forever rather than failing.
      //
      // Named as a REPORT, not as a prohibition alone: "do not run sudo" without "report blocked
      // naming the command" leaves a teammate that genuinely needs privilege with no move.
      const environmentRules = () => [
        'ENVIRONMENT. Your shell cannot prompt: there is no terminal attached to it and no human',
        'watching it. Three consequences, and none of them is worth retrying:',
        '1. Do not run sudo, pkexec, doas, or anything else that asks for a password. They do not',
        '   fail fast — they wait for input that can never arrive.',
        '2. Do not start an interactive login, a device-code flow, or any 2FA prompt. A CLI that',
        '   opens a browser or waits for a code is the same wall in a different shape.',
        '3. Do not run a command that pages, opens an editor, or waits on a confirmation. Pass the',
        '   non-interactive flag the tool provides, or do not run it.',
        'If the task genuinely needs any of those, report status "blocked" and name the exact',
        'command and what it asked for. That is a finished answer, not a failure.',
        '',
      ]

- [ ] **Step 2:** In the same file, add a `claimRules` block above `full`, rendered by both
  variants. This is the discipline whose absence produced three successive wrong versions of one
  comment in run `purge`:

      // WHY THIS IS IN THE BRIEF AND NOT ONLY IN THE AGENT DEFINITION: the defect it addresses
      // was not a teammate ignoring a rule, it was a teammate writing a sentence about code it
      // had not run and no step asking it to. In run `purge` one residual bullet was rewritten
      // wrongly three times in a row, each version reproduced-and-refuted a round later, because
      // the claim read plausibly and nothing in the dispatch bound it to an execution.
      const claimRules = () => [
        'CLAIMS. Every sentence you write into a code comment, a skill, a test comment or your',
        'summary that says what the code DOES must be backed by a command you actually ran in',
        'this task, in this worktree. Not by reading, not by inference from a nearby comment.',
        'If you could not run it, write what you did verify and say the rest is unverified —',
        'an unverified sentence marked as such costs a reader nothing; one stated as fact costs',
        'a review round.',
        'Correcting an existing comment is the case that goes wrong most: reproduce the old claim',
        'FAILING before you write the new one, so you know which half was wrong.',
        '',
      ]

- [ ] **Step 3:** In the same file, add a `scopeRules` block above `full`, rendered by both
  variants, immediately after the `FILES.` lines in each. It closes the second operator report —
  sweeping changes made from stale or over-inferred context:

      // The FILES line says which paths may change. This says what may not be INFERRED, which is
      // a different failure: a teammate that decides a project is dormant, a file is dead, or a
      // record is stale, and acts on it. Nothing in the file set stops that, because archiving
      // or deleting inside your own declared paths is inside the set.
      const scopeRules = () => [
        'SCOPE. Do not delete, archive, rename, or empty anything on the strength of what you',
        'inferred about it. Being inside your declared file set is permission to edit those',
        'paths for THIS task, not a judgement that whatever they contain is stale.',
        'If the plan and the tree disagree — a step that describes code that is not there, a file',
        'the plan says is unused — report status "blocked" quoting both. Do not reconcile them by',
        'guessing which one is out of date.',
        '',
      ]

- [ ] **Step 4:** Render all three in `full`, between the `FILES.`/blast-radius block and
  `GLOBAL CONSTRAINTS:`, in this order: `...scopeRules(), ...environmentRules(), ...claimRules(),`.
  Render the same three, in the same order and at the same position, in `terse`. Per this
  module's own rule that a brief is a specification and compressing a specification drops the
  wording the gate then enforces, the caveman variant carries them **unchanged** — do not write
  a compressed second copy.

- [ ] **Step 5:** In `verifyStep`, add the script-file fallback immediately after the two-line
  `complete` invocation and before the `'ROOT must be the MAIN worktree'` line:

      'If your shell refuses that invocation — some sandboxes reject a multi-line command or a',
      'string containing an absolute path they did not authorise — write the two lines to a file',
      'and run that file. The refusal is your shell\'s, not the gate\'s, and working around it',
      'that way is expected; reporting "blocked" over it is not.',
      '',

- [ ] **Step 6:** In `tests/brief.test.mjs`, add tests pinning that each of the three blocks and
  the fallback line appears in **both** variants. Follow the file's existing convention for
  calling `composeBrief` with and without `caveman`:

      test('the brief states the three environment walls in both variants', async () => {
        // for each of full and terse: assert /Your shell cannot prompt/, /Do not run sudo/,
        // /device-code flow/, and that the blocked-report sentence naming the exact command is
        // present.
      })

      test('the brief binds every claim to a command actually run, in both variants', async () => {
        // assert /must be backed by a command you actually ran/ and the reproduce-the-old-claim-
        // failing sentence in both.
      })

      test('the brief forbids acting on inferred staleness, in both variants', async () => {
        // assert /Do not delete, archive, rename, or empty anything on the strength of what you/
        // and the plan-and-tree-disagree sentence in both.
      })

      test('the brief names the script-file fallback for a shell that refuses the complete invocation', async () => {
        // assert the fallback sentence is present in both variants and sits after the complete
        // command lines, by index comparison rather than by a whole-body regex.
      })

  Write each body out in full.

- [ ] **Step 7:** `scripts/workflow-gen.mjs` substitutes `composeBrief`'s output into generated
  workflow scripts, and a cross-file test pins the embedded brief byte-identical to
  `composeBrief` called directly. Run `npm test` and confirm that test is green. If it is red,
  it means a copy of the brief exists somewhere this task does not own — record the failing test
  name and the file it names in your `summary` and report `status: "blocked"`.

---

### Task 5: hold the implementer and the reviewer to the same three rules

**Files:**
- Modify: `agents/tm-implementer.md`
- Modify: `agents/tm-reviewer.md`
- Test: `tests/agents.test.mjs`

- [ ] **Step 1:** In `agents/tm-implementer.md`, add three bullets to `## Hard rules`,
  immediately before the final `If you are resumed with gate findings` bullet:

      - Your shell cannot prompt — no terminal is attached and no human is watching. Do not run
        `sudo`, `pkexec` or `doas`; do not start an interactive login, a device-code flow or any
        2FA prompt; do not run a command that pages, opens an editor, or waits on a confirmation.
        None of those fail fast: they wait for input that can never arrive. If the task genuinely
        needs one, return `status: "blocked"` naming the exact command and what it asked for.
      - Every sentence you write that says what the code **does** — in a comment, a skill, a test
        comment, or your `summary` — must be backed by a command you ran in this worktree. Not by
        reading, and not by inference from a neighbouring comment. If you could not run it, write
        what you did verify and mark the rest unverified. When you are correcting an existing
        claim, reproduce the old one **failing** first: that is how you learn which half of it
        was wrong, and a correction written without it is how the same sentence comes back wrong
        a third time.
      - Do not delete, archive, rename or empty anything on the strength of what you inferred
        about it. Being inside your declared file set is permission to edit those paths for this
        task, not a judgement that what they hold is stale. Where the plan and the tree disagree,
        return `status: "blocked"` quoting both rather than reconciling them by guessing.

- [ ] **Step 2:** In `agents/tm-reviewer.md`, add the reviewer's half of the same discipline.
  Read the file first and place it under whatever heading holds its finding rules; the sentence
  to add is:

      A finding is a reproduction, not a reading. Before you report one, run the thing that makes
      it fail and paste what you ran and what came back into the finding's own reproduction field.
      A finding you could not reproduce is reported as unreproduced, with what you tried — it is
      still worth reporting, and mislabelling it as reproduced is what turns one review round
      into three.

  Match the file's existing voice and heading structure; do not restructure the document.

- [ ] **Step 3:** In `tests/agents.test.mjs`, add contract tests for each. Use `assertStatement`
  against the parsed doc, the way the existing implementer tests do:

      test('the implementer is told its shell cannot prompt and what to do instead', async () => {
        const { doc } = await agent('tm-implementer.md')
        assertStatement(doc, /Your shell cannot prompt/, 'the implementer must be told the wall exists')
        assertStatement(doc, /wait for input that can never arrive/, 'the reason must be stated, not just the rule')
        assertStatement(doc, /naming the exact command and what it asked for/, 'the implementer must be given the move, not only the prohibition')
      })

      test('the implementer must back every behavioural claim with a command it ran', async () => {
        const { doc } = await agent('tm-implementer.md')
        assertStatement(doc, /must be backed by a command you ran in this worktree/, 'a claim must be bound to an execution')
        assertStatement(doc, /reproduce the old one \*\*failing\*\* first/, 'the correction case must be named, since it is the one that goes wrong')
      })

      test('the implementer may not act on inferred staleness inside its own file set', async () => {
        const { doc } = await agent('tm-implementer.md')
        assertStatement(doc, /not a judgement that what they hold is stale/, 'the file set must not read as permission to archive')
      })

      test('the reviewer reports a finding it could not reproduce as unreproduced', async () => {
        const { doc } = await agent('tm-reviewer.md')
        assertStatement(doc, /A finding is a reproduction, not a reading/, 'the reviewer must be bound to reproduction')
        assertStatement(doc, /reported as unreproduced, with what you tried/, 'the reviewer needs a truthful way to report what it could not reproduce')
      })

  Adjust each regex to whatever text you actually wrote — the assertion must match the file, and
  `normalize()` strips backticks before matching, so write the patterns without them.

---

### Task 6: vet the preview owner marker, and stop reading a stale directory listing

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

- [ ] **Step 1:** In `livePreviewPaths` in `scripts/cli.mjs`, hoist the preview directory's
  `lstat` above the marker read so one owner uid serves both the marker and the claims. Replace
  the loop body's opening — the `holders.push(await read(previewOwnerMarkerPath(dir)))` block
  and the `ownerUid` block currently nested inside the claim branch — with a single resolution
  at the top of each iteration, keeping the existing five-branch unknown rule intact.

- [ ] **Step 2:** Vet the marker with the same triple the claim path already uses — `lstat`,
  `isFile()`, uid equal to the preview directory's — before reading it:

      // THE MARKER IS VETTED THE SAME WAY A CLAIM IS. It was not, and the asymmetry had teeth:
      // any local user who can see this prefix can plant an entry at the marker's exact path,
      // which is derived from the preview directory name and nothing secret. A FIFO there makes
      // `read` block forever — the `await` precedes every print in this command, so `prune-run`
      // hangs with NO output, and `process.exit()` cannot interrupt it because the libuv thread
      // is parked in open(2); only SIGINT recovers the shell. A junk file, a symlink or a
      // directory makes the preview unreapable forever, because a marker that cannot be read is
      // `unknown` and `unknown` means live.
      //
      // A candidate that fails vetting is IGNORED, not `unknown` — the same distinction the
      // claim path makes, and for the same reason: a forged entry must not be able to force
      // `live` in either direction merely by existing. Only a marker that is a regular file
      // owned by the preview directory's own uid is read at all.
      //
      // PRE-EXISTING, not introduced by the claim work: the same line stood before any of it,
      // and the plan prescribed it verbatim. The window is not theoretical — merge-preview.mjs
      // releases the marker LAST in its `finally`, so a `removeWorktree` that fails leaves a
      // registered preview with its marker already gone and its path free to plant.

  A marker whose `lstat` is ENOENT stays exactly what it is today: the only "no marker", not an
  unknown. Any other `lstat` error leaves the preview unknown, matching the unreadable-marker
  rule.

- [ ] **Step 3:** Replace the per-parent listing memo with a fresh listing per preview
  directory. Delete the `listings` map and `listingFor`, and call `list(parent)` inside the loop
  for each `dir`:

      // ONE LISTING PER PREVIEW, not one per sweep. The memo took each parent directory's
      // listing once and reused it for every candidate underneath, so a claim written after that
      // snapshot was invisible for the remainder of the pass — including to previews the pass
      // had not reached yet. In production every preview is a direct child of the temp root, so
      // that was a single readdir of the temp directory covering every preview in the run.
      //
      // It was unreachable while nothing wrote claims. `runCommandCheck` in
      // scripts/gate-runner.mjs writes one per spawned pid, so it is reachable now, and it fails
      // in the destructive direction: listing taken, gate spawns a check and writes its claim,
      // gate is SIGKILLed so its `finally` never releases anything, the loop reaches that preview,
      // the marker probes ESRCH, the cached listing shows no claim — and `git worktree remove
      // --force` follows the preview's junctions into the repository's real node_modules with the
      // child still writing to that tree.
      //
      // The cost is one readdir per preview instead of one per sweep. A sweep examines the
      // previews in one temp directory, so that is a small multiple of a cheap syscall against an
      // irreversible removal. The window does not close — vetting and reading are still two
      // syscalls, and the TOCTOU note above still applies — it narrows from one sweep wide to one
      // readdir wide, which is the same bound the claim vetting already lives with.

- [ ] **Step 4:** Update the long comment block above `livePreviewPaths` so it describes what the
  function now does. Two specific paragraphs are now false and must be rewritten rather than
  left standing: the sentence beginning `Stated in the same breath, because the same writer makes
  it reachable:` (the once-per-pass listing) and any wording that implies the marker is read
  without vetting. The five-branch unknown rule and the sticky-bit analysis are unchanged — do
  not touch them.

- [ ] **Step 5:** In `tests/cli.test.mjs`, add tests using `livePreviewPaths`' injectable
  `read`, `list`, `stat` and `probe`. Follow the file's existing convention for calling it:

      test('a marker that is not a regular file is ignored rather than making the preview unknown', async () => {
        // stat: preview dir -> {uid: 1000}; marker -> {isFile: () => false, uid: 1000}
        // list: no claims. Expect the preview NOT in the live set, and `read` never called on
        // the marker path.
      })

      test('a marker owned by a different uid than the preview directory is ignored', async () => {
        // stat: preview dir -> {uid: 1000}; marker -> {isFile: () => true, uid: 1001}
        // Expect the preview NOT live, and `read` never called on the marker path.
      })

      test('a marker whose lstat fails for a reason other than ENOENT leaves the preview live', async () => {
        // stat on the marker throws {code: 'EACCES'}. Expect the preview IS live.
      })

      test('a vetted marker naming a live pid still holds the preview', async () => {
        // The happy path, so the vetting cannot be satisfied by rejecting everything.
      })

      test('a claim written after the first preview was examined is still seen for the next one', async () => {
        // Two previews under one parent. `list` returns no claims on its first call and one
        // claim for preview two on its second. Expect preview two IS live — under the memo it
        // was not.
      })

  Write each body out in full against the file's existing helpers.

- [ ] **Step 6:** Run `npm test`. Two fixtures in this file assert on the run branch's name
  resolution and belong to Task 7 — if they are red, they were red before you started; confirm
  that by checking whether your diff touches `derive`, and say so in your `summary`.

---

### Task 7: resolve the run branch symbolically, and say what that now guarantees

**Files:**
- Modify: `scripts/git.mjs`
- Test: `tests/git.test.mjs`
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T6

This task absorbed what was Task 1. The two are one unit of work and could not be split: the
change to `scripts/git.mjs` turns `tests/cli.test.mjs:3476` red by construction, and only a tree
that already carries that change can correct the fixture — so a separate earlier task could never
recompute to PASS, and a separate later task could never see the change until the earlier one had
integrated. Circular either way. The measured proof is on `teammates/purgefix/T1`: with
`89a2853` alone the suite is 2051 tests | 2047 pass | **1 fail** | 3 skipped, failing only
`prune-run refuses to act when the branch name git abbreviates HEAD to does not resolve back to
HEAD`.

- [ ] **Step 0:** START FROM THE EXISTING BRANCH. The `scripts/git.mjs` and `tests/git.test.mjs`
  half of this task is already implemented, verified and committed as `89a2853` on
  `teammates/purgefix/T1`. Do not redo it and do not branch from the run branch:

      git checkout -B teammates/purgefix/T7 teammates/purgefix/T1
      git log --oneline -2

  The log must show `89a2853 fix(git): resolve the run branch name via symbolic-ref, not
  abbreviation` on top of the base. Read `scripts/git.mjs`'s `currentBranchRef` and
  `currentBranch` before doing anything else — every step below rests on what they now do. Run
  `npm test` and confirm you see exactly the one failure named above; that failure is your
  starting point, and Step 5 is what fixes it.

  What `89a2853` did, for reference rather than for redoing: added `currentBranchRef()` over
  `git symbolic-ref --quiet HEAD`, returning the full ref, `null` on a detached HEAD (exit 1 with
  empty stdout AND empty stderr) and throwing on any other failure; and reimplemented
  `currentBranch()` over it, stripping `refs/heads/`, preserving the literal string `HEAD` as the
  detached-HEAD contract that `derive` and two other call sites already handle.

- [ ] **Step 1:** Rewrite the `THE NAME HAS TO ROUND-TRIP` comment block in `derive`
  (`scripts/cli.mjs:1660-1696`). Step 0's commit made `currentBranch()` resolve HEAD symbolically, so the
  paragraph's entire premise — that the name is attacker-choosable — is gone, and every
  measurement in it is about the old resolution. The guard itself stays; what it is for changes:

      // The name and `refs/heads/<name>` round-trip BY CONSTRUCTION now. `currentBranch` reads
      // `git symbolic-ref --quiet HEAD` (scripts/git.mjs) and strips the prefix, so the name is
      // taken off the ref HEAD literally points at rather than abbreviated toward it: no tag, no
      // `heads/<name>` branch and no `refs/heads/refs/heads/<name>` changes what this resolves.
      // Under the old `--abbrev-ref` form all three did, and the last one handed an unprivileged
      // teammate the sha this whole run treats as the run branch.
      //
      // SO WHAT THIS CHECK IS FOR NOW is narrower and worth keeping: `headSha` and `resolveRef`
      // are two subprocesses, and an integrator merging concurrently moves the branch between
      // them. That disagreement is an honest race, not an attack, and the message below already
      // says so first. A detached HEAD reaches it too, by way of `currentBranch` answering the
      // literal string `HEAD` — its preserved contract — and `refs/heads/HEAD` not being a ref.

  Delete the paragraphs measuring the park-at-HEAD plant, the symref plant and the
  create-at-the-victim-tip form: they described a resolution this file no longer uses. Do not
  carry the reviewer's suggested wording for `:1690` across — it corrected a sentence about the
  old guard's residual value, and that residual no longer exists.

- [ ] **Step 2:** Rewrite the `WHAT REMAINS OPEN` list at `scripts/cli.mjs:3088-3134`. The first
  bullet — `THE NAME IS ATTACKER-CHOOSABLE, AND FRESHNESS DOES NOT HELP AGAINST IT` — is closed.
  Replace it with a statement of what closed it, because the list declares itself complete and an
  operator reads it where the irreversible `git branch -D` happens:

      //   - THE NAME. Closed, and recorded here because this list is read as complete.
      //     `ctx.runBranch` comes from `git symbolic-ref --quiet HEAD` by way of
      //     scripts/git.mjs's `currentBranch`, so the `refs/heads/` prefix this file adds lands
      //     back on the ref HEAD points at. The plant this bullet used to describe — a tag, a
      //     `heads/<name>` branch and `refs/heads/refs/heads/<name>`, three ordinary ref writes
      //     an unprivileged teammate can make in its own worktree — no longer changes what any
      //     of this resolves, in either the park-at-HEAD form or the `git symbolic-ref` form that
      //     tracked the run branch indefinitely. tests/cli.test.mjs stages that plant and asserts
      //     the run proceeds against the real run branch.

- [ ] **Step 3:** Fix the fourth bullet at `scripts/cli.mjs:3133`, which names the wrong side as
  snapshotted. Two lenses reproduced this independently: `runFilesetCheck` and
  `runOwnershipCheck` re-resolve `refs/heads/<task branch>` **live** at check time, and what is
  snapshotted is `ctx.anchorSha`/`ctx.runSha`:

      //   - The WORKTREE REMOVAL a few lines up is authorised by a verdict computed over
      //     SNAPSHOT ENDPOINTS. Not by a stale verdict: `passedPhases` is built by actually
      //     running this command's checks above, and the worktree list is re-read after them — a
      //     check that exits non-zero makes the phase FAIL and its worktree is not removed at
      //     all. What is snapshotted is the RANGE those checks measure, and it is the run-branch
      //     side, not the task-branch side. `runFilesetCheck` and `runOwnershipCheck` re-resolve
      //     `refs/heads/<task branch>` at check time, so a task branch that moved since `derive`
      //     is judged at its NEW sha — measured, by moving one mid-run: the fileset check read
      //     the moved sha, the phase failed and the worktree survived. `ctx.anchorSha` and
      //     `ctx.runSha` are the derive-time values, so a commit added to the RUN BRANCH mid-run
      //     is never examined by ownership and `mergedParentFiles` walks a stale range — and the
      //     existing fixture at tests/cli.test.mjs:3389 already demonstrates it, by moving the
      //     run branch backward past the integration merge and watching the phase still pass and
      //     the worktree still go. `git worktree remove --force` discards whatever is uncommitted
      //     in that worktree regardless. Irreversible, and not re-proved the way the deletion
      //     below now is.

  Reproduce both halves before writing this — the followups document records that this is the
  third consecutive wrong version of this bullet, and the last two were written without running
  anything.

- [ ] **Step 4:** Update the cross-reference at `scripts/cli.mjs:1696` (`See the residual list at
  the branch deletion in prune-run for the same statement where the damage happens`) so it points
  at what the list now says. If the reference no longer carries meaning once the name item is
  closed, delete it rather than leaving a pointer to a bullet about a different subject.

- [ ] **Step 5:** Rewrite the fixture at `tests/cli.test.mjs:3469` (`prune-run refuses to act when
  the branch name git abbreviates HEAD to does not resolve back to HEAD`). Its plant no longer
  redirects anything, so the test must assert that — it becomes the regression test for the
  closure, and it is the strongest one in the suite:

      test('the three-ref plant no longer redirects the run branch: prune-run resolves the real one', async () => {
        // Same three ref writes as before: git tag run-branch main; git branch heads/run-branch
        // main; git update-ref refs/heads/refs/heads/run-branch <T1 tip>.
        // Assert `git rev-parse --abbrev-ref HEAD` STILL answers `refs/heads/run-branch` — the
        // plant is real and still defeats the old resolution.
        // Then assert prune-run --yes proceeds against the REAL run branch: with
        // stagePrunableRun(ctx, { merged: false }) the task branch is not contained, so
        // `left teammates/r1/T1 in place` is printed, the branch survives, and the planted ref
        // is never consulted. Assert the planted ref still holds the tip it was given, so the
        // run demonstrably did not read it.
      })

  Write the body out in full. Keep the old test's staging helpers; only the plant's consequence
  changes.

- [ ] **Step 6:** Correct the comment above the detached-HEAD fixture at `tests/cli.test.mjs:3447`.
  Its claim that without this fixture `failing closed on an unresolvable name could be deleted
  with the whole suite green` overstates what the fixture pins: mutating `.catch(() => null)` to
  `.catch(() => headSha)` leaves all three behavioural assertions passing and fails only the
  message regex. Say that the discrimination is the message regex alone, and that relaxing it to
  `/cannot decide what is prunable/` would leave a test that passes with the null arm gone. Do
  not weaken the regex.

- [ ] **Step 7:** Run `npm test` and confirm it is green, including the fixture Step 0's commit left
  red. Paste the final counts into your `summary`.

---

### Task 8: make collect-reviews persist, and refuse an ambiguous phase

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T7

- [ ] **Step 1:** Make `collect-reviews` write its results as well as print them. At the success
  path (`io.out(JSON.stringify({ results: collected.results }, null, 2))` near
  `scripts/cli.mjs:3918`), write the same JSON to
  `.teammates/<runId>/reviews/results-<phaseName>.json` before printing, and print the path it
  wrote on the line after the JSON:

      // PRINTED AND PERSISTED, because printing alone is a trap this run fell into. `gate
      // --results <path>` needs a FILE, and this command's only output was stdout — so an
      // operator who ran it without redirecting had the review check sit `pending` forever while
      // the gate reported FAIL with an empty `failed: []`, naming nothing to fix. Writing the
      // file makes the next command's argument something that exists rather than something the
      // operator had to know to create.
      //
      // stdout keeps the JSON and nothing else before it, so an existing `> results.json`
      // redirect still produces the same file it always did. The path line goes after.

  Use the run directory the rest of this command already resolves (`runDir(root, runId)` +
  `'reviews'`), and derive the filename from `phaseName` through the same sanitisation
  `reviewFileName` applies, so a phase name that is not a safe filename is refused rather than
  escaping the directory.

- [ ] **Step 2:** Make an omitted `--phase` a refusal for `review-dispatch` and `collect-reviews`
  whenever the run's plan has more than one phase. Both currently default to the manifest key
  `default`, and `tasksOfPhase` reads a non-integer phase name as "every task branch in the run",
  which silently scopes a review to already-integrated branches:

      // `--phase` defaults to the manifest key `default`, and `tasksOfPhase` reads a non-integer
      // name as EVERY task branch in the run — the honest reading of "this manifest phase's
      // diff" when the manifest has one phase, and a silent widening when the plan has several:
      // a phase-3 review then judges phase 1 and 2 branches that were integrated rounds ago.
      // Refused rather than warned, because the widening produces a review that reads as complete.
      // A single-phase plan is unaffected: there is nothing for the flag to disambiguate.

  Print the plan's phase numbers in the refusal and return 2, matching how this CLI reports a
  rejected invocation. Reading the plan may fail — a run with no `plan.json` — in which case fall
  through to today's behaviour rather than refusing on a missing file.

- [ ] **Step 3:** In `tests/cli.test.mjs`, add tests for both:

      test('collect-reviews writes its results file as well as printing them', async () => {
        // Stage a run whose lenses all have findings files, run collect-reviews, assert exit 0,
        // assert .teammates/<run>/reviews/results-<phase>.json exists and parses to the same
        // object stdout carried, and assert the printed path names that file.
      })

      test('collect-reviews still prints the JSON first, so an existing redirect is unchanged', async () => {
        // Assert the first line of stdout starts the JSON object and the path line comes after
        // the closing brace.
      })

      test('collect-reviews refuses an omitted --phase when the plan has more than one phase', async () => {
        // Assert exit 2 and that the message names the available phase numbers.
      })

      test('review-dispatch refuses an omitted --phase when the plan has more than one phase', async () => {
        // Same shape.
      })

      test('an omitted --phase is still accepted on a single-phase plan', async () => {
        // Assert the command proceeds, so the refusal cannot be satisfied by refusing always.
      })

  Write each body out in full against the file's existing run-staging helpers.

---

### Task 9: correct the parallel-execution and phase-gate skills

**Files:**
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/phase-gate/SKILL.md`
- Test: `tests/skill-contracts.test.mjs`

**Depends:** T3, T8

- [ ] **Step 1:** In `skills/parallel-execution/SKILL.md` § 5, replace the ancestor-proof bound
  inside the long `then:` sentence. The clause reading `— that proof holds only while the run
  branch's name is unambiguous, so before --yes confirm git rev-parse --abbrev-ref HEAD prints
  the run branch's plain name and not heads/<name> or refs/heads/<name> —` describes an operator
  check that is no longer needed. Replace it with what now holds:

      — the run branch it proves against is the ref HEAD symbolically points at, so no tag or
      same-named branch can redirect that proof —

  Keep the rest of the sentence, including its opening and its closing `and names every worktree
  it leaves alone with the reason.`, exactly as it stands.

- [ ] **Step 2:** In the same section, give the junction instruction a check and a safe removal.
  The clause `so check the worktree for one before forcing it` currently names neither, and this
  repository records at `scripts/cli.mjs:1326` that `rm -rf` follows a junction the same way — so
  an operator who finds one and reaches for a recursive delete repeats the exact loss. Replace
  that clause with:

      so check the worktree for one first (`dir /AL` in the worktree, or `Get-Item <path> |
      Select-Object LinkType`) and remove the link itself with `rmdir <link>` — never a recursive
      delete, which follows it — before forcing

  Make the identical change at the second site in `Worktree mechanics`, where the same clause
  appears in the fresh-implementer exception.

- [ ] **Step 3:** In the same section, correct the dry-run sentence. `Without --yes it removes
  nothing and prints the same prunable and leaked-preview lists` promises an equality the design
  cannot keep: both invocations recompute the gate from scratch, so a phase that failed a flaky
  check during the dry run and passes during the `--yes` run has worktrees force-removed that
  never appeared in the list the operator approved. Replace the opening clause with:

      Without `--yes` it removes nothing and prints the prunable and leaked-preview lists it would
      act on if nothing changes before the `--yes` run — both runs recompute the gate from
      scratch, so a phase that fails a check in one and passes in the other differs between them

  Keep the existing tail about the per-branch ancestor verdict unchanged.

- [ ] **Step 4:** In `skills/phase-gate/SKILL.md`, update the `collect-reviews` documentation for
  Task 8. Two changes. First, after the sentence `It prints a --results file with source: "file",
  applying the manifest's own blockOn.`, add:

      It also writes that file to `.teammates/<runId>/reviews/results-<phase>.json` and prints the
      path, so the `gate --results <path>` that follows names a file that exists — run without a
      redirect and without this, the review check stays `pending` forever while the gate reports
      FAIL with an empty `failed` list, naming nothing to fix.

  Second, change the two invocation lines so `--phase <name>` is shown as required rather than
  bracketed, and add after the second one:

      `--phase` is not optional on a plan with more than one phase: omitted, it names the manifest
      key `default`, which scopes the review to every task branch in the run — including ones
      integrated rounds ago. The CLI refuses that rather than reviewing it.

- [ ] **Step 5:** In `tests/skill-contracts.test.mjs`, promote the three deletable sentences in
  the parallel-execution cleanup test from `allow` entries to required ones. An `allow` entry
  grants permission and never imposes existence, which is why deleting the irreversibility
  paragraph, the fresh-implementer exception and the dry-run sentence all leave the suite green
  today. Bind each with `assertStatement`, above the existing `assertClaim` call:

      // `allow` GRANTS PERMISSION AND NEVER IMPOSES EXISTENCE. Measured on this tree: editing any
      // of the three sentences below is RED — the anchored allow regex stops matching and the
      // sentence becomes a stray — but deleting all three outright is GREEN, so the safety prose
      // two commits exist to add could be reverted with no test noticing. `assertStatement` is
      // what makes a sentence required; the allow entries stay, because they are what keeps a
      // FOURTH sentence about the same subject from appearing unreviewed.
      assertStatement(cleanup, /^This is irreversible on every prunable worktree/, '...')
      assertStatement(cleanup, /^The one exception is a task going to a fresh implementer/, '...')
      assertStatement(cleanup, /^Without --yes it removes nothing and prints the prunable/, '...')

  Write a real message for each in place of `'...'`, naming what deleting that sentence would
  cost. Update the three corresponding `allow` regexes to match the text as Steps 1-3 leave it.

- [ ] **Step 6:** Close the one-heading-wide gap that `cleanup.code.length === 1` leaves. A
  hand-sweep code block placed in the neighbouring `Worktree mechanics` section — the section
  § 5 itself tells the operator to read — passes today, because every subject lock is
  section-scoped and code blocks never become statements. Add a corpus inventory over both skill
  documents for the hand-sweep lexicon, using `assertCorpusInventory` the way the SubagentStop
  lexicon already does:

      // A section lock binds one section, so the cheapest escape was never to reword a locked
      // sentence but to add a contradicting one under the next heading. Measured: a
      // `Clear leftovers by hand when you are in a hurry:` bullet plus an `rm -rf
      // .claude/worktrees/agent-* && git branch -D $(git branch --list 'teammates/*')` block,
      // placed in Worktree mechanics, left the whole suite green — the document then carried an
      // unsupported hand sweep two sections below the claim that prune-run is the only supported
      // way to clean up. The corpus inventory removes the LOCATION dimension: every sentence
      // about sweeping by hand, in either document, has to be in this list.

  Build the `docs` array from `skills/parallel-execution/SKILL.md` and
  `skills/finishing-a-development-branch/SKILL.md`, use a subject of
  `/rm -rf|rm -fr|by hand|hand-run|hand sweep/i`, and populate `expected` from what
  `corpusSites` actually returns on the tree as you leave it. Do not hand-write the list from
  memory — run it, read the failure, and paste the real list in.

- [ ] **Step 7:** Add a test pinning the two phase-gate changes from Step 4, following that
  file's existing phase-gate test convention.

- [ ] **Step 8:** Run `npm test`. Task 3 made a claim pattern that matches more than one
  statement a failure; if one of your edited sentences now collides with another in its section,
  that collision is the defect, not the check.

---

### Task 10: correct the finishing-a-development-branch skill

**Files:**
- Modify: `skills/finishing-a-development-branch/SKILL.md`
- Test: `tests/skill-finishing-branch.test.mjs`

**Depends:** T3, T7

The dependency on T7 was added on 2026-08-27, after this task was dispatched and reported
blocked on it. Steps 1 and 6 assert that `prune-run` resolves the run branch symbolically; that
resolution is T7's work (absorbed from the excised Task 1). When Task 1 was folded into Task 7,
this task's `**Depends:** T1, T3` was rewritten to `T3` by removing the excised id — which was
arithmetic, not a trace of where the content went. Steps 2, 3, 4, 5 and 7 do not depend on T7 and
were completed in the first dispatch.

- [ ] **Step 1:** Replace the run-branch-name precondition at
  `skills/finishing-a-development-branch/SKILL.md:92`. The sentence `That proof is only as good
  as the run branch's name being unambiguous, so before --yes confirm git rev-parse --abbrev-ref
  HEAD prints the run branch's plain name — anything longer means the run branch does not resolve
  the way the proof assumes, whatever produced that, and the deletion would be proved against the
  wrong ref.` asks for a check that no longer buys anything, and — as the phase-4 security lens
  reproduced end to end — carried no validity window: a `--yes`-less `prune-run` executes every
  command check in the manifest, and those checks could create the ambiguity between the check
  and the `--yes`. Both problems go away with the resolution, so state the resolution:

      That proof is against the ref `HEAD` symbolically points at, which is what `prune-run`
      resolves the run branch through — so no tag, and no branch named `heads/<name>`, can make
      the deletion be proved against a different ref than the one you are on, whoever created it
      and whenever.

  Keep the `then:` sentence that follows it (`That proof is not something a bare git branch -D
  makes on its own: …`) unchanged, and keep the new sentence in the same position, so the chain
  the tests bind still runs claim → this → that.

- [ ] **Step 2:** Correct the dry-run sentence at
  `skills/finishing-a-development-branch/SKILL.md:90`. `it prints the same worktree and branch
  list --yes would act on` promises an equality the design cannot keep — both invocations
  recompute the gate independently. Replace that clause with:

      it prints the worktrees and branches it would act on if nothing changes before the `--yes`
      run — both runs recompute the gate from scratch

  Keep the existing tail (`but not which of those branches would actually be deleted — that
  verdict is computed only inside the removal itself`) unchanged.

- [ ] **Step 3:** Correct the `rebuild-state` clause at
  `skills/finishing-a-development-branch/SKILL.md:121`. `rebuild-state reads it only to refuse`
  is false, and the tree's own tests disprove it: `readState` refuses, and then `writePlan` reads
  `.teammates/<runId>/plan.json` and carries its recorded `runBranch` forward, printing `(kept
  from the previous plan.json)`. Mutating `carried = null` at `scripts/cli.mjs:1060` turns the
  suite red, and `tests/cli.test.mjs:11152` pins the behaviour. The harm follows the sentence's
  own advice — delete the directory on its strength, re-run `rebuild-state` from a non-run branch
  (routine, since the sibling skill has the operator detach around integration) and the run's
  `runBranch` is recorded wrong permanently. Replace the clause with:

      while `rebuild-state` reads it twice: once to refuse when it exists, since it exists for the
      case where the directory is already gone, and once to keep the run branch it recorded —
      delete the directory and a later `rebuild-state` run from any other checkout records that
      checkout as the run branch, permanently, and `complete --enforcement-only` can no longer
      verify completion for the rest of the run

- [ ] **Step 4:** Update the test comment at `tests/skill-finishing-branch.test.mjs:129-131`,
  which restates the same false scope (`readState on every invocation, but only to REFUSE when it
  exists`). It accounts for the status read and misses the plan read. Say what each read is for,
  and name `tests/cli.test.mjs:11152` as the test that pins the second one.

- [ ] **Step 5:** Update the three `assertClaim` patterns in
  `tests/skill-finishing-branch.test.mjs` that quote the sentences Steps 1-3 changed — the
  `then:` at line 90, the `claim:` at line 98, the `then:` at the `.teammates` test near line 129,
  and the `then:` quoting the dry-run sentence near line 79. Each is anchored end to end and must
  match the new text exactly.

- [ ] **Step 6:** Delete the comment above the line-88 `then:` that explains why the caveat is
  stated as a symptom rather than as an enumeration of plant shapes. That reasoning was about
  choosing between two ways to describe a live hazard; the hazard is closed, and the sentence no
  longer describes a symptom at all. Replace it with a note saying the resolution is what the
  sentence now rests on, and pointing at `scripts/git.mjs`'s `currentBranchRef`.

- [ ] **Step 7:** Run `npm test`. Task 3 made a claim pattern that matches more than one
  statement in its section a failure; if one of your edited sentences now collides with another,
  that collision is the defect, not the check.

- [ ] **Step 8:** Task 9 builds a corpus inventory over this document and
  `skills/parallel-execution/SKILL.md`, and it runs after you. List in your `summary` every
  sentence you added, changed or removed that matches `/rm -rf|rm -fr|by hand|hand-run|hand
  sweep/i`, so that task can populate its `expected` list from a real record rather than
  rediscovering it from a failure.

---

### Task 11: record what closed and what did not

**Files:**
- Modify: `docs/followups/2026-08-27-purge-open-findings.md`

**Depends:** T2, T3, T4, T5, T6, T7, T8, T9, T10

- [ ] **Step 1:** Rewrite the document as a record of this plan's outcome rather than a list of
  open findings. Keep its structure and its opening paragraph about run `purge`, and add a dated
  line naming this plan and the run that executed it.

- [ ] **Step 2:** For every finding under `Needs a task of its own` and `Prose and test-tightening
  on the branch`, state which task closed it and how it was verified. Verify each one against the
  tree as it actually stands — read the file at the line the finding names — rather than
  assuming the task did what its steps said. A finding whose task reported `blocked`, or whose
  fix landed differently from the plan, is recorded as it really is.

- [ ] **Step 3:** Move anything genuinely still open into a single `Still open` section with the
  reason, and carry the two `Not Yet Specified` questions from this plan's header into it as
  questions. Do not delete a finding that was not fixed.

- [ ] **Step 4:** Keep the `Deliberate, do not re-litigate` and `Before pushing` sections
  unchanged. Both record operator decisions and a verified history rewrite; nothing in this plan
  touched either.

- [ ] **Step 5:** Under `Tooling defects found while running`, mark the `collect-reviews`
  persistence and the `--phase` default as closed by Task 8, naming the new results-file path and
  the refusal. Leave the sandbox git-safety hook item open, noting that it is the operator's local
  configuration and that Task 4 added the script-file fallback to the brief instead.
