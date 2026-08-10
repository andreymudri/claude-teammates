# Closing eight tooling gaps found by run `codemap`

Every gap below was found by using the tools, not by reading them. Run `codemap` executed three
phases, ten agent dispatches and eight review lenses against this plugin's own CLI, and each of
these is a place where a command answered a question wrongly, refused to answer one it should
have, or told an agent to do something it cannot do.

Two are correctness defects an operator would act on. Four are commands that cannot see evidence
that exists. Two are contracts stated in prose that nothing enforces.

## What the gaps are

1. **`finish` can never report a run complete.** It recomputes every phase but has no way to
   accept `agent`/`mcp` results, so on any manifest with a `review` check every phase comes back
   `pending: review`. Verified on run `codemap`: three phases with recorded CLI-computed PASSes,
   `finish` reported "not finished" for all three.
2. **`prune-run` cannot see a recorded PASS either**, for the same reason, so nothing is ever
   prunable on such a manifest. Its refusal says "phase 1 has no passing gate yet" while
   `status.gates` holds a PASS for that phase — a message that states as fact something false.
3. **Both run full `command` checks to answer a cheap question.** `prune-run` exceeded a 120s
   timeout deciding whether a directory could be deleted; `finish` needs three full test suites.
4. **`map-notes` tells an Explore agent to write a file Explore cannot write.** Explore is the
   harness's read-only type: no Write or Edit, Bash retained. The agent either produces nothing —
   and the next `map-notes` exits 4, looping — or complies through a Bash heredoc, normalising
   exactly the escape the read-only designation exists to prevent.
5. **`workflow` silently swallows unknown flags.** `parseFlags` does not reject them, so
   `workflow --commits 5000` exits 0 having changed nothing while the operator believes the
   coupling window widened.
6. **`doctor` reports a merged branch as `NO CHANGES`.** A landed branch's fork point is its own
   tip, so its diff is empty for a reason unrelated to whether work was done. `runFilesetCheck`
   was taught this distinction during run `codemap`; `doctor` never was.
7. **Reviewer findings files carry no provenance.** `collect-reviews` cannot tell a previous
   round's `<phase>-<lens>.json` from the current round's, and would merge stale findings into a
   fresh verdict. Worked around by hand three times during run `codemap` by deleting the files
   between rounds.
8. **A killed gate leaks its merge-preview worktrees.** `withMergePreview` does clean up in a
   `finally`, but a hard kill of the node process never runs it, and nothing reaps the entries
   afterwards. Observed: two `tm-preview-*` worktrees left registered after `finish` was killed.

## Global Constraints

- Node >= 24.2.0
- Zero new runtime dependencies
- Commit messages: single-line, commitlint style, English
- Pure modules (`scripts/finish.mjs`, `scripts/prune.mjs`, `scripts/reviews.mjs`,
  `scripts/mapnotes.mjs`, `scripts/doctor.mjs`) take data and return data: no filesystem access,
  no git access, no imports beyond other pure modules and `scripts/git.mjs`'s `GitError`
- Every new behaviour is pinned by a test in `tests/`, run with `node --test tests/*.test.mjs`
- A skipped check is reported as skipped, every time — never silently omitted
- No enforcement check may read map data, and nothing enforced reads `.teammates/<runId>/map.md`
- Run `npm test` in the FOREGROUND; a backgrounded suite never notifies a subagent

### Task 1: teach doctor that a landed branch is not an empty one

**Files:**
- Modify: `scripts/doctor.mjs`
- Test: `tests/doctor.test.mjs`

- [ ] **Step 1:** In `collectDoctorReport`, the emptiness complaint currently fires whenever
      `entry.changed.length === 0`. Give it the same two-part landed test `runFilesetCheck` uses:
      on the run branch AND past the anchor. Replace the block inside the `if (runSha)` branch
      that pushes the "no file changes past its fork point" problem with:

```js
        // A landed branch's fork point IS its tip, so its diff is empty however much work it
        // carried — reporting that as a problem makes every re-inspection of an integrated
        // phase look broken. "On the run branch" alone is not enough: the anchor and everything
        // before it are ancestors too, so a branch parked at the anchor — a teammate that
        // committed elsewhere and left the conventional ref where it started — would read as
        // landed and escape the very check this is.
        entry.landed = anchorSha
          ? (await git.isAncestor(sha, runSha)) && !(await git.isAncestor(sha, anchorSha))
          : false
        if (entry.changed.length === 0 && !entry.landed) {
          problems.push(`${task.id}: branch ${branch} has no file changes past its fork point — the work landed on another ref and this task would merge as a no-op`)
        }
```

- [ ] **Step 2:** Add `anchorSha = null` to `collectDoctorReport`'s destructured parameters, and
      initialise `landed: false` alongside the other fields in `entry`.

- [ ] **Step 3:** In `renderDoctor`, a landed task must not print `NO CHANGES`. Replace the
      per-task line construction with:

```js
      const files = t.landed
        ? 'integrated'
        : (t.changed.length === 0 ? 'NO CHANGES' : `${t.changed.length} file(s)`)
```

- [ ] **Step 4:** Add these tests to `tests/doctor.test.mjs`:

```js
test('a branch that landed on the run branch is reported integrated, not as contributing nothing', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({
      changedFiles: async () => [],
      // On the run branch and past the anchor: landed.
      isAncestor: async (_sha, target) => target === 'runSha1',
    }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
    runSha: 'runSha1', anchorSha: 'anchorSha1',
  })
  assert.equal(report.tasks[0].landed, true)
  assert.deepEqual(report.problems, [])
})

// The distinction the landed test exists for: a branch sitting AT the anchor is an ancestor of
// the run branch too, and it is exactly the stale-base shape.
test('a branch parked at the anchor is still reported as contributing nothing', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({ changedFiles: async () => [], isAncestor: async () => true }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
    runSha: 'runSha1', anchorSha: 'anchorSha1',
  })
  assert.equal(report.tasks[0].landed, false)
  assert.match(report.problems.join('\n'), /no file changes/)
})

test('renderDoctor prints integrated rather than NO CHANGES for a landed task', () => {
  const out = renderDoctor({
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, mainBranch: RUN_BRANCH,
    dirty: [], worktrees: [],
    tasks: [{ id: 'T1', branch: 'teammates/r1/T1', exists: true, tip: 'abc work', changed: [], sideDoor: false, landed: true }],
    problems: [],
  })
  assert.match(out, /integrated/)
  assert.doesNotMatch(out, /NO CHANGES/)
})
```

      The existing `fakeGit` helper in that file needs `isAncestor: async () => false` in its
      defaults if it does not already have one; add it rather than changing existing tests.

### Task 2: stop telling a read-only agent to write a file

**Files:**
- Modify: `scripts/mapnotes.mjs`
- Test: `tests/mapnotes.test.mjs`

- [ ] **Step 1:** The prompt currently instructs the agent to write `notesPath` itself. Explore
      has no Write tool, so the only way to comply is a Bash heredoc. Invert the contract: the
      agent RETURNS the map and the orchestrator writes it. Replace `mapNotesPrompt`'s body with:

```js
export function mapNotesPrompt({ runId, sha, notesPath, topDirectories = [] }) {
  return [
    'Map this repository for a fleet about to work on it. Return the map as your final output —',
    'do NOT write it to a file. You are dispatched read-only on purpose: the orchestrator writes',
    `it to ${notesPath}, because nothing a teammate writes is trusted by this design.`,
    '',
    `Begin your output with exactly this line, unchanged: ${mapNotesHeader({ runId, sha })}`,
    '',
    'Then, for each significant area of the codebase: what it is for, what depends on it, and the',
    'one thing a newcomer would get wrong about it. Prefer naming the module that owns a concept',
    'over listing files. Say "unclear" where the code does not tell you — a guess dressed as a',
    'fact is worse here than a gap, because implementers will act on it.',
    '',
    topDirectories.length ? `The largest directories by file count are: ${topDirectories.join(', ')}.` : '',
    '',
    'Read the code. Do not infer the architecture from README claims alone, and do not modify any',
    'file in this repository — you are reading it, not changing it.',
  ].filter((line) => line !== '').join('\n')
}
```

- [ ] **Step 2:** Add an exported helper the orchestrator uses to validate what came back before
      writing it, so prose with no header or a forged one never lands as provenance:

```js
// The orchestrator writes the notes, so it needs one place to decide whether what an agent
// returned is writable. A returned map missing its header is not "close enough": the header is
// the only thing that lets a later reader tell which tree the prose describes, and inventing one
// on the agent's behalf would manufacture exactly the provenance this design refuses to fake.
export function mapNotesWritable(text, { runId, sha }) {
  const body = String(text ?? '')
  if (body.trim() === '') return 'the agent returned nothing to write'
  const header = readMapNotesHeader(body)
  if (!header) return 'the returned map does not begin with the teammates-map header it was given'
  if (header.sha !== sha) return `the returned map claims commit ${header.sha}, but the dispatch named ${sha}`
  if (header.runId !== runId) return `the returned map claims run ${header.runId}, but the dispatch named ${runId}`
  return null
}
```

- [ ] **Step 3:** Update the module header comment: the second paragraph currently says the notes
      are "written by a dispatched Explore agent". Replace that clause with "returned by a
      dispatched read-only agent and written by the orchestrator".

- [ ] **Step 4:** Replace the prompt test in `tests/mapnotes.test.mjs` and add the writability
      tests:

```js
test('the prompt tells the agent to return the map and not to write it', () => {
  const prompt = mapNotesPrompt({ runId: 'r1', sha: 'abc123', notesPath: '.teammates/r1/map.md', topDirectories: ['src', 'test'] })
  assert.match(prompt, /<!-- teammates-map run=r1 sha=abc123 -->/)
  assert.match(prompt, /do NOT write it to a file/)
  assert.match(prompt, /the orchestrator writes/)
  assert.match(prompt, /src, test/)
  assert.match(prompt, /Say "unclear"/)
})

// The instruction that made this necessary: an agent told to write is an agent that will shell
// out to do it when it has no Write tool.
test('the prompt never instructs the agent to write the notes file', () => {
  const prompt = mapNotesPrompt({ runId: 'r1', sha: 'abc', notesPath: 'p' })
  assert.doesNotMatch(prompt, /Write a map/i)
})

test('a returned map carrying the right header is writable', () => {
  const text = `${mapNotesHeader({ runId: 'r1', sha: 'abc123' })}\n\n# Map\n`
  assert.equal(mapNotesWritable(text, { runId: 'r1', sha: 'abc123' }), null)
})

test('a returned map with no header is refused rather than written', () => {
  assert.match(mapNotesWritable('# Map\nprose\n', { runId: 'r1', sha: 'abc123' }), /does not begin with/)
})

test('a returned map claiming another commit or run is refused', () => {
  const wrongSha = `${mapNotesHeader({ runId: 'r1', sha: 'old111' })}\nbody\n`
  assert.match(mapNotesWritable(wrongSha, { runId: 'r1', sha: 'new222' }), /old111.*new222/)
  const wrongRun = `${mapNotesHeader({ runId: 'other', sha: 'abc' })}\nbody\n`
  assert.match(mapNotesWritable(wrongRun, { runId: 'r1', sha: 'abc' }), /run other/)
})

test('an empty return is refused', () => {
  assert.match(mapNotesWritable('', { runId: 'r1', sha: 'abc' }), /returned nothing/)
})
```

### Task 3: stamp reviewer findings with the tree they describe

**Files:**
- Modify: `scripts/reviews.mjs`
- Test: `tests/reviews.test.mjs`

- [ ] **Step 1:** A findings file must say which tree it judged, so a later round cannot inherit
      an earlier one's verdict. Add to `scripts/reviews.mjs`:

```js
// Reviewer findings describe a diff, and a diff is only identified by the branch tips it was
// taken from. Without that, a second review round's collect-reviews reads the first round's
// files and reports findings about code that no longer exists — worked around by hand three
// times during run `codemap` by deleting the files between rounds, which is exactly the kind of
// manual step this design removes everywhere else.
export function reviewStamp({ phase, lens, branchShas = {} }) {
  const names = Object.keys(branchShas).sort()
  return { phase: String(phase), lens, branches: names.map((n) => `${n}@${branchShas[n]}`) }
}

// Returns a reason string when the file describes a different tree, or null when it matches.
// A file with no stamp at all is stale, never "probably current": an unstamped file is the
// artefact this design refuses to trust everywhere else.
export function reviewStale(file, expected) {
  if (!file || typeof file !== 'object') return 'the findings file is not an object'
  const stamp = file.stamp
  if (!stamp) return 'the findings file carries no stamp, so nothing says which diff it judged'
  if (String(stamp.phase) !== String(expected.phase)) {
    return `the findings describe phase ${stamp.phase}, not phase ${expected.phase}`
  }
  if (stamp.lens !== expected.lens) return `the findings are for lens ${stamp.lens}, not ${expected.lens}`
  const a = (stamp.branches ?? []).join(' ')
  const b = (expected.branches ?? []).join(' ')
  if (a !== b) return `the findings judged ${a || '(nothing)'}, but this phase is at ${b || '(nothing)'}`
  return null
}
```

- [ ] **Step 2:** `collectReviewResults` must refuse a stale file rather than merge it. Change its
      signature to accept the expected stamp and add the check. Replace the loop over `files` with:

```js
  for (const file of files) {
    if (!lenses.includes(file.lens)) { unexpected.push(file.lens); continue }
    if (expected) {
      const why = reviewStale(file, { ...expected, lens: file.lens })
      if (why) { stale.push({ lens: file.lens, reason: why }); continue }
    }
    byLens.set(file.lens, Array.isArray(file.findings) ? file.findings : [])
  }
```

      Add `expected = null` to the destructured parameters, declare `const stale = []` beside
      `unexpected`, and return `stale` in both the early-return object and the final one. A lens
      whose file is stale must fall into `missing`, which the existing code already computes from
      `byLens`, so a stale round cannot produce a pass.

- [ ] **Step 3:** Add to `tests/reviews.test.mjs`:

```js
import { reviewStamp, reviewStale } from '../scripts/reviews.mjs'

const STAMP = { phase: '1', branches: ['teammates/r1/T1@aaa', 'teammates/r1/T2@bbb'] }

test('a stamp names the phase, the lens and every branch tip it judged', () => {
  const s = reviewStamp({ phase: 1, lens: 'tests', branchShas: { 'teammates/r1/T2': 'bbb', 'teammates/r1/T1': 'aaa' } })
  assert.equal(s.phase, '1')
  assert.equal(s.lens, 'tests')
  // Sorted, so two runs over the same tips produce the same stamp.
  assert.deepEqual(s.branches, ['teammates/r1/T1@aaa', 'teammates/r1/T2@bbb'])
})

test('a stamp matching the current tips is not stale', () => {
  assert.equal(reviewStale({ stamp: { ...STAMP, lens: 'tests' } }, { ...STAMP, lens: 'tests' }), null)
})

// The exact failure this closes: a fix round moves a branch, the old findings file stays on disk.
test('findings describing an older branch tip are stale and say which', () => {
  const why = reviewStale(
    { stamp: { phase: '1', lens: 'tests', branches: ['teammates/r1/T1@aaa'] } },
    { phase: '1', lens: 'tests', branches: ['teammates/r1/T1@ccc'] },
  )
  assert.match(why, /aaa/)
  assert.match(why, /ccc/)
})

test('an unstamped findings file is stale whatever it contains', () => {
  assert.match(reviewStale({ findings: [] }, { ...STAMP, lens: 'tests' }), /no stamp/)
})

test('a stale lens is reported and never contributes a pass', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['correctness'],
    files: [{ lens: 'correctness', findings: [], stamp: { phase: '1', lens: 'correctness', branches: ['teammates/r1/T1@old'] } }],
    expected: { phase: '1', branches: ['teammates/r1/T1@new'] },
    blockOn: ['high'],
  })
  assert.deepEqual(out.results, [])
  assert.deepEqual(out.missing, ['correctness'])
  assert.equal(out.stale.length, 1)
  assert.match(out.stale[0].reason, /old/)
})

test('with no expected stamp supplied, a file without one is still accepted', () => {
  const out = collectReviewResults({
    checkName: 'review', lenses: ['correctness'],
    files: [{ lens: 'correctness', findings: [] }], blockOn: ['high'],
  })
  assert.equal(out.results.length, 1)
  assert.deepEqual(out.stale, [])
})
```

### Task 4: reap leaked merge-preview worktrees

**Files:**
- Modify: `scripts/prune.mjs`
- Test: `tests/prune.test.mjs`

- [ ] **Step 1:** `withMergePreview` removes its worktree in a `finally`, but a hard kill of the
      node process never runs it — two `tm-preview-*` entries survived a killed `finish` during
      run `codemap`. Nothing reaps them afterwards. Add to `scripts/prune.mjs`:

```js
// A merge preview is a detached worktree under the system temp directory, named tm-preview-*.
// Its own cleanup runs in a `finally`, which a SIGKILL skips — so these accumulate, and every
// one of them shows up in `doctor` as a worktree the operator never created. They belong to no
// run and hold no branch, which is exactly what makes them safe to reap: there is no task
// context to lose and no ref to strand.
const PREVIEW_DIR = /[\\/]tm-preview-[^\\/]+$/

export function leakedPreviews(worktrees = []) {
  return worktrees
    .filter((w) => w && w.detached && !w.branch && PREVIEW_DIR.test(String(w.path)))
    .map((w) => ({ path: w.path, head: w.head ?? null }))
}
```

- [ ] **Step 2:** Report them in the prune plan rather than silently removing them, so the same
      dry-run rule covers both. In `selectPrunableWorktrees`, after the existing loop, add
      `previews: leakedPreviews(worktrees)` to the returned object, and in `renderPrunePlan` add
      before the `skipped` block:

```js
  if (plan.previews?.length) {
    lines.push(`leaked merge previews (${plan.previews.length}), safe to remove — a killed gate skips its own cleanup:`)
    for (const p of plan.previews) lines.push(`  ${p.path}`)
  }
```

      A preview worktree matched here must NOT also appear in `skipped`: add
      `if (PREVIEW_DIR.test(String(wt.path)) && wt.detached && !wt.branch) continue` immediately
      after the `isMain` check, so each entry is reported exactly once.

- [ ] **Step 3:** Add to `tests/prune.test.mjs`:

```js
import { leakedPreviews } from '../scripts/prune.mjs'

const preview = (path) => ({ path, branch: null, head: 'ccc', detached: true })

test('a detached tm-preview worktree under temp is identified as leaked', () => {
  const out = leakedPreviews([preview('C:/Users/x/AppData/Local/Temp/tm-preview-AbCdEf')])
  assert.deepEqual(out, [{ path: 'C:/Users/x/AppData/Local/Temp/tm-preview-AbCdEf', head: 'ccc' }])
})

// Named like a preview but holding a branch: not ours to reap. Something is checked out there.
test('a worktree holding a branch is never treated as a leaked preview', () => {
  assert.deepEqual(leakedPreviews([{ path: '/tmp/tm-preview-x', branch: 'teammates/r1/T1', head: 'a', detached: false }]), [])
})

test('an ordinary detached worktree is not a leaked preview', () => {
  assert.deepEqual(leakedPreviews([preview('/tmp/scratch-thing')]), [])
})

test('the prune plan lists leaked previews separately from what it left alone', () => {
  const plan = selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo', 'run/r1'), preview('/tmp/tm-preview-zz')],
    mainWorktree: '/repo',
  })
  assert.deepEqual(plan.previews.map((p) => p.path), ['/tmp/tm-preview-zz'])
  assert.equal(plan.skipped.some((s) => s.path === '/tmp/tm-preview-zz'), false)
  assert.match(renderPrunePlan(plan), /leaked merge previews/)
})
```

### Task 5: let finish accept the results it cannot compute

**Files:**
- Modify: `scripts/finish.mjs`
- Test: `tests/finish.test.mjs`

- [ ] **Step 1:** `finish` reports every phase as `pending: review` on any manifest with an
      `agent` check, because agent checks have no runner. It needs the same escape `gate` has.
      Add to `scripts/finish.mjs`:

```js
// The per-phase counterpart of `gate --results`. `finish` recomputes every phase, and every
// phase with an `agent` check comes back pending, because nothing runs an agent check — so on
// this repository's own manifest `finish` could never report a run complete, which it proved on
// run `codemap` against three phases that each held a CLI-computed PASS.
//
// Keyed by phase, because a run's phases are reviewed separately and a single flat list could
// silently satisfy phase 3 with phase 1's review. Same rule as gate's: only `agent` and `mcp`
// results may be supplied, and the verdict is still computed, never taken.
export function suppliedForPhase(supplied, phase) {
  if (!supplied || typeof supplied !== 'object') return []
  const byPhase = supplied.phases ?? {}
  const entry = byPhase[String(phase)]
  return Array.isArray(entry?.results) ? entry.results : []
}

export function validateSuppliedPhases(supplied) {
  if (supplied === null || supplied === undefined) return null
  if (typeof supplied !== 'object' || Array.isArray(supplied)) {
    return '--results must be a JSON object shaped { "phases": { "<n>": { "results": [...] } } }'
  }
  const byPhase = supplied.phases
  if (byPhase === undefined) return '--results names no phases: expected { "phases": { "<n>": { "results": [...] } } }'
  if (byPhase === null || typeof byPhase !== 'object' || Array.isArray(byPhase)) {
    return '--results "phases" must be an object keyed by phase number'
  }
  for (const [phase, entry] of Object.entries(byPhase)) {
    if (!Number.isInteger(Number(phase))) return `--results names a non-numeric phase: ${JSON.stringify(phase)}`
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.results)) {
      return `--results phase ${phase} must be an object with a results array`
    }
  }
  return null
}
```

- [ ] **Step 2:** `renderRunSummary` must say when a phase passed only because results were
      supplied, so a reader can tell a recomputed pass from a reported one. Add a `supplied` flag
      per entry and render it. In `renderRunSummary`, change the per-phase line to:

```js
    lines.push(`  phase ${entry.phase}   ${verdict.verdict ?? 'FAIL'}${entry.supplied ? ' (review supplied)' : ''}${blocking.length ? `   ${blocking.join(', ')}` : ''}`)
```

- [ ] **Step 3:** Add to `tests/finish.test.mjs`:

```js
import { suppliedForPhase, validateSuppliedPhases } from '../scripts/finish.mjs'

test('results are selected by phase, never shared between phases', () => {
  const supplied = { phases: { 1: { results: [{ name: 'review', status: 'pass' }] }, 2: { results: [] } } }
  assert.equal(suppliedForPhase(supplied, 1).length, 1)
  assert.deepEqual(suppliedForPhase(supplied, 2), [])
  assert.deepEqual(suppliedForPhase(supplied, 3), [])
})

test('a missing or malformed results file yields nothing rather than throwing', () => {
  assert.deepEqual(suppliedForPhase(null, 1), [])
  assert.deepEqual(suppliedForPhase({ phases: null }, 1), [])
})

test('a results file shaped as a flat list is refused, naming the shape expected', () => {
  assert.match(validateSuppliedPhases([{ name: 'review' }]), /phases/)
  assert.match(validateSuppliedPhases({ results: [] }), /names no phases/)
})

test('a non-numeric phase key is refused', () => {
  assert.match(validateSuppliedPhases({ phases: { default: { results: [] } } }), /non-numeric phase/)
})

test('a phase entry without a results array is refused', () => {
  assert.match(validateSuppliedPhases({ phases: { 1: {} } }), /results array/)
})

test('a well-formed file passes validation', () => {
  assert.equal(validateSuppliedPhases({ phases: { 1: { results: [] } } }), null)
})

test('the summary marks a phase that passed on supplied results', () => {
  const out = renderRunSummary('r1', [
    { phase: 1, supplied: true, verdict: { verdict: 'PASS', failed: [], optionalFailed: [], skipped: [], pending: [] } },
  ])
  assert.match(out, /review supplied/)
})
```

### Task 6: put the foreground-test rule in the contract

**Files:**
- Modify: `agents/tm-implementer.md`
- Modify: `templates/phase-workflow.js`
- Test: `tests/agents.test.mjs`
- Test: `tests/workflow-gen.test.mjs`

- [ ] **Step 1:** Three of four fix-round agents in run `codemap` backgrounded the test suite and
      then parked waiting for a notification a subagent never receives. Each needed a manual nudge.
      The rule belongs in the contract, not in every dispatch written by hand. In
      `agents/tm-implementer.md`, extend the first Hard rule's baseline bullet with:

```markdown
  Run the test command in the FOREGROUND and wait for it. Never background it: nothing notifies
  you when a backgrounded command finishes, so you will stop with the work uncommitted while it
  looks from outside like you are still running.
```

- [ ] **Step 2:** Also in `agents/tm-implementer.md`, tighten the Return value section: two
      teammates in run `codemap` reported `filesChanged` as absolute worktree paths. After the
      `filesChanged` bullet, add: "paths as written in the task's file set, repo-relative, never
      absolute worktree paths".

- [ ] **Step 3:** Add a Hard rule for the case that sent two agents onto refs the gate cannot see,
      after the branch-convention bullet:

```markdown
- If your task's branch is checked out in another worktree, report `status: "blocked"` naming it.
  Do not invent a different branch, do not work on a detached HEAD, and do not use
  `--ignore-other-worktrees`: the gate resolves your branch by convention and nothing else, so
  work anywhere but `teammates/<runId>/<taskId>` is invisible to it and merges as a no-op.
```

- [ ] **Step 4:** Mirror the foreground rule in `templates/phase-workflow.js` so a generated brief
      carries it too. In both `brief` and `briefTerse`, change the BASELINE step 3 line from
      `'3. Run the project\'s test command once and confirm it is green.'` to:

```js
  '3. Run the project\'s test command once, IN THE FOREGROUND, and confirm it is green.',
  '   Never background it: nothing notifies you when a backgrounded command finishes.',
```

- [ ] **Step 5:** Add to `tests/agents.test.mjs`:

```js
test('the implementer must run its tests in the foreground', async () => {
  const { doc } = await agent('tm-implementer.md')
  assertStatement(
    doc,
    /Run the test command in the FOREGROUND and wait for it/,
    'implementer must be told to wait on its own test run',
  )
  assertStatement(
    doc,
    /nothing notifies you when a backgrounded command finishes/,
    'the reason must be stated, not just the rule',
  )
})

test('the implementer reports blocked rather than improvising a branch', async () => {
  const { doc } = await agent('tm-implementer.md')
  assertStatement(
    doc,
    /If your task's branch is checked out in another worktree, report status: "blocked" naming it/,
    'implementer must not invent a branch when its own is held',
  )
  assertStatement(
    doc,
    /work anywhere but teammates\/<runId>\/<taskId> is invisible to it and merges as a no-op/,
    'the consequence of working on the wrong ref must be stated',
  )
})

test('the implementer returns repo-relative paths', async () => {
  const { doc } = await agent('tm-implementer.md')
  assert.match(doc.text, /repo-relative, never absolute worktree paths/)
})
```

### Task 7: wire the CLI, and refuse flags it does not know

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T1, T2, T3, T4, T5

**Model:** capable

- [ ] **Step 1:** Reject unknown flags. `parseFlags` accepts anything, so `workflow --commits 5000`
      exits 0 having done nothing. Add a per-command table beside `REQUIRED`, listing every flag
      each command reads, and check it in `runCli` before dispatching. `--root` is universal:

```js
// Every flag each command actually reads. An unknown flag is refused rather than ignored: a
// swallowed `workflow --commits 5000` exits 0 while the operator believes the coupling window
// widened, which is the silent-wrong-answer class this CLI removes everywhere else.
const UNIVERSAL_FLAGS = new Set(['root'])
const KNOWN_FLAGS = {
  'init-run': ['run'],
  gate: ['run', 'plan', 'base', 'phase', 'no-fleet', 'results'],
  doctor: ['run', 'plan', 'base', 'run-branch'],
  digest: ['run'],
  claim: ['run', 'task', 'by'],
  unclaim: ['run', 'task'],
  workflow: ['run', 'phase', 'models', 'plan', 'base'],
  complete: ['run', 'task', 'plan', 'base'],
  fix: ['run', 'phase', 'verdict'],
  'record-fix-round': ['run', 'phase', 'task'],
  'review-dispatch': ['run', 'phase', 'models'],
  'collect-reviews': ['run', 'phase'],
  'preview-check': [],
  'plan-drift': ['run', 'plan', 'base'],
  finish: ['run', 'plan', 'base', 'results'],
  'prune-run': ['run', 'plan', 'base', 'yes', 'results'],
  'rebuild-state': ['run', 'plan', 'base', 'force'],
  map: ['files', 'commits', 'top'],
  'map-notes': ['run'],
  config: ['local'],
}

function unknownFlags(command, flags) {
  const known = KNOWN_FLAGS[command]
  if (!known) return []
  const allowed = new Set([...known, ...UNIVERSAL_FLAGS])
  return Object.keys(flags).filter((f) => !allowed.has(f))
}
```

      In `runCli`, immediately after the flags are parsed and the command is known, add:

```js
  const strays = unknownFlags(command, flags)
  if (strays.length > 0) {
    io.out(`${command} does not take ${strays.map((f) => `--${f}`).join(', ')}`)
    io.out(USAGE)
    return 2
  }
```

- [ ] **Step 2:** Wire `finish --results`. Read and validate the file with the helpers from
      Task 5, then merge per phase through the existing `mergeSuppliedResults` and
      `validateSuppliedResults`. Inside the phase loop, replace the results line with:

```js
      const forPhase = suppliedForPhase(supplied, phase)
      const invalid = validateSuppliedResults(forPhase, checks)
      if (invalid) { io.out(`phase ${phase}: ${invalid}`); return 2 }
      const results = mergeSuppliedResults(await runChecks(checks, phaseCtx), forPhase)
      phaseResults.push({ phase, supplied: forPhase.length > 0, verdict: aggregateVerdict(results) })
```

      Before the loop, read `flags.results` exactly as `gate` does — a bare `--results` is a
      missing argument, an unreadable or malformed file exits 2 naming it — and run
      `validateSuppliedPhases` over the parsed object.

- [ ] **Step 3:** Give `prune-run` the same `--results` handling, so a phase whose only outstanding
      check is a review can be pruned. It already computes `passedPhases` by recomputing each
      phase; feed the supplied results through the same merge before `aggregateVerdict`.

- [ ] **Step 4:** Wire the preview reaper. In `prune-run`, after the existing removal loop, remove
      each entry in `plan.previews` when `--yes` was given, reporting each path:

```js
    for (const p of plan.previews ?? []) {
      try {
        await git.removeWorktree(p.path)
        io.out(`removed leaked preview ${p.path}`)
      } catch (err) {
        if (!(err instanceof GitError)) throw err
        failed += 1
        io.out(`could not remove ${p.path}: ${err.message}`)
      }
    }
```

- [ ] **Step 5:** Pass the anchor to `doctor` so Task 1's landed test can run: add
      `anchorSha: ctx.anchorSha` and `runSha: ctx.runSha` to the `collectDoctorReport` call, taking
      both from a `derive` call rather than recomputing them.

- [ ] **Step 6:** Stamp reviewer findings. `review-dispatch` must tell each reviewer the stamp to
      include, and `collect-reviews` must check it. In `review-dispatch`, resolve each task
      branch's sha and pass `reviewStamp({ phase: phaseName, lens, branchShas })` into the
      generated spec, rendering it in the prompt as the JSON the reviewer must include under a
      `stamp` key. In `collect-reviews`, build the same expected stamp from the branches as they
      stand now and pass it to `collectReviewResults` as `expected`; report `stale` entries the way
      `missing` is reported, and exit 4 when any lens is stale.

- [ ] **Step 7:** Add these tests to `tests/cli.test.mjs`:

```js
test('an unknown flag is refused rather than silently ignored', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(['workflow', '--run', 'r1', '--phase', '1', '--commits', '5000', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /workflow does not take --commits/)
  })
})

test('every command still accepts the flags it documents', async () => {
  await withRepo(async ({ root, io, lines }) => {
    lines.length = 0
    // --root is universal and must never be refused.
    const code = await runCli(['preview-check', '--root', root], io)
    assert.notEqual(code, 2)
  })
})

test('finish accepts per-phase results and reports which phases used them', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify({
      lens: ['correctness'],
      phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer' }] } },
    }), 'utf8')
    g(['add', 'teammates.gate.json'])
    g(['commit', '--quiet', '-m', 'manifest'])
    const results = path.join(root, 'r.json')
    await writeFile(results, JSON.stringify({
      phases: { 1: { results: [{ name: 'review', kind: 'agent', status: 'pass', findings: [] }] },
                2: { results: [{ name: 'review', kind: 'agent', status: 'pass', findings: [] }] } },
    }), 'utf8')
    lines.length = 0
    const code = await runCli(['finish', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', root, '--results', results], io)
    assert.match(lines.join('\n'), /review supplied/)
    assert.notEqual(code, 4)
  })
})

test('finish refuses a flat results list, naming the shape it expects', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify({
      phases: { default: { checks: [{ name: 'fileset', kind: 'fileset' }] } },
    }), 'utf8')
    const results = path.join(root, 'r.json')
    await writeFile(results, JSON.stringify({ results: [] }), 'utf8')
    lines.length = 0
    const code = await runCli(['finish', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', root, '--results', results], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /phases/)
  })
})

test('collect-reviews refuses findings that judged different branch tips', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify({
      lens: ['correctness'],
      phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer' }] } },
    }), 'utf8')
    g(['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    g(['add', 'a.mjs'])
    g(['commit', '--quiet', '-m', 'T1'])
    g(['checkout', '--quiet', 'run-branch'])
    await mkdir(path.join(root, '.teammates', 'r1', 'reviews'), { recursive: true })
    await writeFile(
      path.join(root, '.teammates', 'r1', 'reviews', '1-correctness.json'),
      JSON.stringify({ stamp: { phase: '1', lens: 'correctness', branches: ['teammates/r1/T1@deadbeef'] }, findings: [] }),
      'utf8',
    )
    lines.length = 0
    const code = await runCli(['collect-reviews', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.equal(code, 4)
    assert.match(lines.join('\n'), /deadbeef/)
  })
})

test('prune-run reports a leaked merge preview and removes it with --yes', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify({
      phases: { default: { checks: [{ name: 'fileset', kind: 'fileset' }] } },
    }), 'utf8')
    g(['add', 'teammates.gate.json'])
    g(['commit', '--quiet', '-m', 'manifest'])
    const preview = path.join(await mkdtemp(path.join(tmpdir(), 'tm-preview-')), '')
    await rm(preview, { recursive: true, force: true })
    g(['worktree', 'add', '--detach', '--quiet', preview, 'HEAD'])
    lines.length = 0
    await runCli(['prune-run', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', root], io)
    assert.match(lines.join('\n'), /leaked merge previews/)
    lines.length = 0
    await runCli(['prune-run', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', root, '--yes'], io)
    assert.doesNotMatch(g(['worktree', 'list']), /tm-preview-/)
  })
})
```

### Task 8: correct the skills that describe these commands

**Files:**
- Modify: `skills/fleet-lifecycle/SKILL.md`
- Modify: `skills/phase-gate/SKILL.md`
- Test: `tests/skill-contracts.test.mjs`

**Depends:** T7, T12

- [ ] **Step 1:** `skills/fleet-lifecycle/SKILL.md`'s Map notes section says an Explore agent
      writes `map.md`. It does not — it returns the map and the orchestrator writes it. Replace
      that sentence with: "Dispatch a read-only agent with the printed prompt; it RETURNS the map
      and you write it to that path yourself, after checking the header it returned names this run
      and this commit. A teammate never writes this file, and nothing enforced ever reads it."

- [ ] **Step 2:** In the same section, state the reaper: "A killed gate cannot run its own cleanup,
      so `prune-run` also reports leaked `tm-preview-*` worktrees and removes them with `--yes`."

- [ ] **Step 3:** In `skills/phase-gate/SKILL.md`, the `--results` paragraph must describe the
      stamp: "Each findings file carries a `stamp` naming the phase, the lens and the branch tips
      it judged. `collect-reviews` refuses a file whose stamp names different tips — a fix round
      moves a branch, and findings about the old tree are not findings about this one."

- [ ] **Step 4:** Also in `skills/phase-gate/SKILL.md`, document that `finish` takes the same
      evidence: "`finish` recomputes every phase, and every `agent` check comes back pending
      because nothing runs one. Hand it the same results, keyed by phase:
      `{ \"phases\": { \"1\": { \"results\": [...] } } }`. A phase that passed on supplied results
      is marked `(review supplied)` in its output, so a reader can tell a recomputed pass from a
      reported one."

- [ ] **Step 5:** Add to `tests/skill-contracts.test.mjs`:

```js
test('fleet-lifecycle states the orchestrator writes the map, not the agent', async () => {
  const { doc } = await skill('fleet-lifecycle')
  const section = doc.section('Map notes')
  assertStatement(
    section,
    /it RETURNS the map and you write it to that path yourself/,
    'the skill must not tell a read-only agent to write a file',
  )
  assertClaim(section, {
    label: 'map notes writer',
    claim: /A teammate never writes this file, and nothing enforced ever reads it/,
    subject: /writes this file|map\.md/i,
    allow: [
      /it RETURNS the map and you write it to that path yourself/,
      /A killed gate cannot run its own cleanup/,
    ],
  })
})

test('phase-gate states that findings are stamped with the tips they judged', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  assertStatement(
    section,
    /refuses a file whose stamp names different tips/,
    'the skill must state that stale findings are refused',
  )
  assertStatement(
    section,
    /findings about the old tree are not findings about this one/,
    'the reason must be stated, not just the rule',
  )
})

test('phase-gate documents finish taking per-phase results', async () => {
  const { doc } = await skill('phase-gate')
  assert.match(doc.text, /phases.*1.*results/s)
  assertStatement(
    doc,
    /A phase that passed on supplied results is marked \(review supplied\) in its output/,
    'a reader must be able to tell a recomputed pass from a reported one',
  )
})
```

### Task 9: close the same landed blind spot in the enforcing path

**Files:**
- Modify: `scripts/gate-runner.mjs`
- Test: `tests/gate-runner.test.mjs`

**Depends:** T7, T12

**Model:** capable

- [ ] **Step 1:** `runFilesetCheck` computes the same landed test `doctor` did, at
      `scripts/gate-runner.mjs:239`:

```js
        const landed = await git.isAncestor(sha, runSha) && !(await git.isAncestor(sha, anchorSha))
```

      From phase 2 onward the run tip is itself past the anchor, so a branch parked AT THE RUN TIP
      — where `git checkout -B <task> <run branch>` leaves it, and where a teammate that then
      commits on the harness branch abandons it — satisfies both halves. `landed` is true, the
      emptiness complaint is suppressed, and `fileset` PASSES a task that would merge as a no-op.
      This is the enforcing path, not the advisory one: it decides whether a phase may integrate.

      Add the same tip exclusion T1 added to `doctor`:

```js
        const landed = await git.isAncestor(sha, runSha)
          && !(await git.isAncestor(sha, anchorSha))
          && sha !== runSha
```

- [ ] **Step 2:** Extend the comment above it. It currently explains only the anchor-parked case,
      which it already handled. State the tip-parked case it now handles, and state honestly what
      remains open: a branch parked at an intermediate post-anchor commit on the run branch still
      reads as landed, because distinguishing it needs a walk of the run branch's merge commits
      for one whose second parent is this branch. `scripts/doctor.mjs` carries the same residual
      limit and documents it the same way; keep the two descriptions consistent.

- [ ] **Step 3:** Add to `tests/gate-runner.test.mjs`, beside the existing landed test:

```js
// The enforcing counterpart of doctor's run-tip case. From phase 2 onward the run tip is past
// the anchor, so a branch left exactly where `git checkout -B <task> <run branch>` put it
// satisfies both halves of the landed test while carrying no work of its own — and this check
// decides whether the phase may integrate.
test('runFilesetCheck fails a branch parked at the run tip with no contribution', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
    isAncestor: async (_sha, target) => target === 'runSha1',
    resolveRef: async () => 'runSha1',
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /contributes no file changes/)
})
```

      Verify this test fails against the current code before your change and passes after, and
      that the existing "does not report an already-integrated branch as contributing nothing"
      test still passes — a genuinely landed branch is past the anchor and NOT at the tip.

### Task 10: make the verdict commands cheap, and give the orchestrator a way to write map notes

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T7, T12

**Model:** capable

This task closes two gaps this plan described in its preamble but never tasked. Both were found by
re-reading the plan against itself after phase 1 landed.

- [ ] **Step 1:** Gap 3 of the preamble is unaddressed: `finish` and `prune-run` both run every
      `command` check of every phase to answer a question that does not need them. On run `codemap`
      this made `prune-run` exceed a 120-second timeout deciding whether a directory could be
      deleted, and `finish` needs one full test suite per phase — three suites, roughly five
      minutes, to report whether a run is finished.

      Add `--enforcement-only` to both commands. When given, run only the checks whose kind is in
      `ALWAYS_ENFORCED_KINDS` (`fileset`, `ownership`, `merge`) and record every `command` check as
      `skip`, never as `pass`. The skipped checks must appear in the output as skipped — this
      repository's rule is that a skipped check is reported as skipped, every time, and a verdict
      that hides which checks did not run is worse than a slow one.

      Keep the full run as the default for both. When `--enforcement-only` is absent, print one
      line naming how many command checks are about to run, so an operator who is about to wait
      knows why they are waiting.

- [ ] **Step 2:** `scripts/mapnotes.mjs` exports `mapNotesWritable` and nothing calls it. Task 2
      inverted the map-notes contract — the dispatched read-only agent RETURNS the map and the
      orchestrator writes it — but no command accepts that returned text, so the orchestrator must
      write `.teammates/<runId>/map.md` by hand and the validator guarding that write is dead code.

      Add `map-notes --write <path>`: read the file at `<path>` (the agent's returned map, saved by
      the caller), validate it with `mapNotesWritable` against the current run id and the HEAD sha,
      and on success write it to `.teammates/<runId>/map.md`, exiting 0 and naming what was written.
      On a validation failure, exit 4 printing the refusal reason verbatim and write nothing — a map
      that cannot be vouched for must never land, because a later reader treats a stamped file as
      provenance.

      Without `--write`, `map-notes` keeps its current behaviour: report whether stored notes are
      current, and print the Explore prompt when they are not. Add `write` to this command's entry
      in the `KNOWN_FLAGS` table from Task 7.

- [ ] **Step 3:** Add these tests to `tests/cli.test.mjs`:

```js
test('finish --enforcement-only skips command checks and reports them as skipped', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify({
      phases: { default: { checks: [
        { name: 'test', kind: 'command', run: 'node -e "process.exit(1)"' },
        { name: 'fileset', kind: 'fileset' },
      ] } },
    }), 'utf8')
    g(['add', 'teammates.gate.json'])
    g(['commit', '--quiet', '-m', 'manifest'])
    lines.length = 0
    await runCli(['finish', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', root, '--enforcement-only'], io)
    const out = lines.join('\n')
    // The command check would FAIL if it ran; it must be skipped, and said to be skipped.
    assert.match(out, /skipped: test/)
    assert.doesNotMatch(out, /failed: test/)
  })
})

test('prune-run names how many command checks it is about to run when they are not skipped', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify({
      phases: { default: { checks: [{ name: 'test', kind: 'command', run: 'node -e ""' }, { name: 'fileset', kind: 'fileset' }] } },
    }), 'utf8')
    g(['add', 'teammates.gate.json'])
    g(['commit', '--quiet', '-m', 'manifest'])
    lines.length = 0
    await runCli(['prune-run', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', root], io)
    assert.match(lines.join('\n'), /command check/)
  })
})

test('map-notes --write validates the returned map before writing it', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const sha = g(['rev-parse', 'HEAD']).trim()
    const returned = path.join(root, 'returned.md')
    await writeFile(returned, `<!-- teammates-map run=r1 sha=${sha} -->\n\n# Map\n\nsrc owns orders.\n`, 'utf8')
    lines.length = 0
    const code = await runCli(['map-notes', '--run', 'r1', '--root', root, '--write', returned], io)
    assert.equal(code, 0)
    const written = await readFile(path.join(root, '.teammates', 'r1', 'map.md'), 'utf8')
    assert.match(written, /owns orders/)
  })
})

test('map-notes --write refuses a map whose header names another commit and writes nothing', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const returned = path.join(root, 'returned.md')
    await writeFile(returned, '<!-- teammates-map run=r1 sha=0000000 -->\n\n# Map\n\nbody\n', 'utf8')
    lines.length = 0
    const code = await runCli(['map-notes', '--run', 'r1', '--root', root, '--write', returned], io)
    assert.equal(code, 4)
    assert.match(lines.join('\n'), /0000000/)
    await assert.rejects(() => readFile(path.join(root, '.teammates', 'r1', 'map.md'), 'utf8'))
  })
})

test('map-notes --write refuses a header-only map', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const sha = g(['rev-parse', 'HEAD']).trim()
    const returned = path.join(root, 'returned.md')
    await writeFile(returned, `<!-- teammates-map run=r1 sha=${sha} -->\n`, 'utf8')
    lines.length = 0
    assert.equal(await runCli(['map-notes', '--run', 'r1', '--root', root, '--write', returned], io), 4)
    assert.match(lines.join('\n'), /no body beyond the header/)
  })
})
```

### Task 11: decide landed by the merge that carried the branch, not by ancestry

**Files:**
- Modify: `scripts/git.mjs`
- Modify: `scripts/doctor.mjs`
- Modify: `scripts/gate-runner.mjs`
- Test: `tests/git.test.mjs`
- Test: `tests/doctor.test.mjs`
- Test: `tests/gate-runner.test.mjs`

**Depends:** T9

**Model:** capable

T1 and T9 each added a `sha !== runSha` exclusion to the landed test, and each documented the
same residual: a branch parked at an INTERMEDIATE post-anchor commit on the run branch still
reads as landed. That shape is not exotic. A teammate branches with
`git checkout -B <task> <run branch>`, the integrator then merges a sibling and the run tip
moves, and the branch is now parked at a post-anchor commit that is no longer the tip — so the
tip exclusion does not fire, `landed` is true, and the "contributes no file changes" complaint
is suppressed for a task that would merge as a no-op. In `runFilesetCheck` that is an enforcing
check passing work that is not there.

The residual exists because ancestry is the wrong question. "Is this sha reachable from the run
branch" is true of every commit the run branch has ever passed through. The question worth
asking is whether the run branch merged THIS BRANCH: whether some merge commit past the anchor
names this sha as a parent other than its first. That is answerable with one `rev-list`, and it
subsumes both exclusions already added rather than adding a third.

- [ ] **Step 1:** Add a primitive to `scripts/git.mjs`, beside `isAncestor`. It returns the set
      of shas the run branch merged in as secondary parents, past the anchor:

```js
    async mergedBranchTips({ runSha, anchorSha }) {
      if (!isNonEmptyString(runSha) || !isNonEmptyString(anchorSha)) {
        throw new GitError(`mergedBranchTips requires non-empty refs, got runSha=${JSON.stringify(runSha)} anchorSha=${JSON.stringify(anchorSha)}`)
      }
      // --parents prints "<commit> <parent1> <parent2>..."; everything past the first parent is
      // a branch this merge carried in. --min-parents=2 keeps only merges, and --not <anchor>
      // bounds the walk to this run rather than the repository's whole history.
      const args = ['rev-list', '--min-parents=2', '--parents', '--end-of-options', runSha, '--not', anchorSha]
      const out = await run(args)
      const tips = new Set()
      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/).filter(Boolean)
        for (const parent of parts.slice(2)) tips.add(parent)
      }
      return tips
    },
```

      Match the surrounding style for invoking git: use whatever helper the other read-only
      methods in this file use (`run` / `runRaw`) rather than introducing a new one, and follow
      their error handling. Pin it in `tests/git.test.mjs` against a real repository: a `--no-ff`
      merge puts the merged branch's tip in the set; a fast-forward puts nothing in it; a commit
      on the run branch that is not a merge parent is not in the set; an octopus merge
      contributes every parent past the first.

- [ ] **Step 2:** In `scripts/doctor.mjs`, replace the three-clause `landed` expression with a
      lookup in that set. Compute the set once per report, not once per task — it is one
      `rev-list` for the whole run, and calling it per task turns a report over ten tasks into
      ten walks:

```js
        entry.landed = anchorSha ? mergedTips.has(sha) : false
```

      Keep the `anchorSha ? ... : false` shape exactly as it is. An un-wired caller that supplies
      no anchor must keep getting `false` and the old behaviour, which is what makes this change
      safe to land before every caller passes one.

      `scripts/doctor.mjs` is a pure module and must not gain git access: the set is computed by
      the caller and passed in as data, the same way `anchorSha` and `runSha` already are.

- [ ] **Step 3:** Replace the comment block above it. T1 wrote an honest description of a limit
      this task removes, so leaving it in place would be prose overstating the opposite way —
      claiming a hole that is now closed. State what the new test decides, and state what remains
      genuinely open, which is now a different and much narrower list:

      - A branch integrated by FAST-FORWARD leaves no merge commit and so no secondary parent,
        and reads as not landed. That is correct for this check's purpose — a fast-forwarded
        branch with real work has a non-empty diff and never reaches the landed test at all — and
        `scripts/enforce.mjs` already reports fast-forward integration of a task branch as a
        violation in its own right. Say both halves; do not imply this check detects it.
      - A SQUASH merge likewise carries no secondary parent. The plugin's integrator never
        squashes, so this is a statement about a repository someone else merged into, not about a
        run this tool drove.
      - Two branches whose tips are the identical sha are indistinguishable here. Nothing in this
        design can tell them apart, because there is nothing to tell apart.

- [ ] **Step 4:** Apply the same replacement to `runFilesetCheck` in `scripts/gate-runner.mjs`.
      This is the enforcing path, so it is the reason the task exists: compute the set once in
      the check's context and replace the `landed` expression with the same lookup. T9 will have
      just added the `sha !== runSha` exclusion here and a comment describing the intermediate
      residual as accepted; both go, replaced by the set lookup and the Step 3 wording. Keep the
      two files' descriptions of the remaining limits consistent with each other, as T9 required.

- [ ] **Step 5:** Add to `tests/gate-runner.test.mjs`, beside T9's run-tip test, the case neither
      exclusion caught — a branch parked at a post-anchor commit that is NOT the tip:

```js
// The case the tip exclusion cannot see. The integrator merged a sibling after this branch was
// created, so the run tip moved past the commit the branch is parked at: it is past the anchor,
// it is not the tip, and it carries nothing. Only "was this branch merged in" tells it apart.
test('runFilesetCheck fails a branch parked at an intermediate post-anchor commit', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
    isAncestor: async (_sha, target) => target === 'runSha2',
    resolveRef: async () => 'runSha2',
    mergedBranchTips: async () => new Set(['someOtherBranchTip']),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'runSha2', anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /contributes no file changes/)
})
```

      Verify this test fails against T9's code before your change and passes after. Then verify
      that T9's run-tip test and the existing "does not report an already-integrated branch as
      contributing nothing" test both still pass — the latter must have its `fakeGit` return a
      set CONTAINING the branch tip, since that is now what makes a branch integrated. Updating
      that fixture is expected and is not a weakening of the test.

- [ ] **Step 6:** Run the full suite in the FOREGROUND and report the counts.

### Task 12: make the reviewer's findings file one shape, and pin it

**Files:**
- Modify: `agents/tm-reviewer.md`
- Test: `tests/agents.test.mjs`

**Depends:** T7

**Model:** mid

T7 taught `collect-reviews` to refuse a findings file that carries no stamp, and taught
`review-dispatch` to append a `stampInstruction` naming the exact object each reviewer must
write. Those two halves agree with each other. The reviewer's own contract does not:
`agents/tm-reviewer.md` still says the return value is "an array of findings" and describes
writing "that same JSON" to the findings path. A reviewer that follows its card writes a bare
array, `reviewStale` reports "the findings file carries no stamp", and `collect-reviews` exits 4.

This is not theoretical drift. Across two phases of run `gaps`, five reviewers produced four
different file shapes — a bare array, `{stamp, findings}`, and two flat objects with the stamp
fields spread at the top level and no `stamp` key at all. Only one of the five would be
collectable. The recovery path exists precisely for a reviewer that goes idle before returning,
which is the case where nobody is left to reformat the file by hand.

The direction of failure is safe — an unreadable file is never read as an empty review — so this
is a usability and recoverability defect, not a correctness hole. Fix it in the contract, not by
widening what the collector accepts: a collector that guesses at four shapes is how "no findings"
and "no readable findings" stop being distinguishable.

- [ ] **Step 1:** Rewrite the Return value section of `agents/tm-reviewer.md` to state one shape.
      The wrapper is the file's shape AND the response's shape, so there is exactly one thing to
      write and one thing to return:

```json
{
  "stamp": { "phase": "1", "lens": "correctness", "branches": ["teammates/<run>/T1@<sha>"] },
  "findings": [
    { "severity": "high|medium|low", "file": "...", "line": 0, "summary": "...", "failureScenario": "..." }
  ]
}
```

      State that the `stamp` object is supplied verbatim in the dispatch prompt and must be
      copied unchanged — a reviewer must never construct or edit it. Read the real definitions
      before writing this section rather than trusting the sketch above: `reviewStamp` and
      `reviewStale` in `scripts/reviews.mjs`, and `stampInstruction` in `scripts/cli.mjs`.

- [ ] **Step 2:** Keep, and do not soften, what the current section already gets right: write the
      file BEFORE returning, the response stays the interface, and an empty `findings` array is a
      real result written like any other. Add one sentence for the case the run just exercised —
      a dispatch prompt that carries no stamp (a hand-written dispatch, or an older CLI) means
      the file cannot be collected, so say so in the response rather than inventing a stamp.
      A reviewer that fabricates a stamp asserts it judged tips it may never have read.

- [ ] **Step 3:** State honestly in the card what the stamp is worth. `scripts/reviews.mjs:28-36`
      already says it: the reviewer stamps its own file, so a reviewer that judged nothing can
      still emit a well-formed stamp and pass `reviewStale`. It is tamper-evident against drift
      and fix rounds, not proof of review. Do not let the card imply more than the module claims —
      that inversion is the defect class this plan keeps finding.

- [ ] **Step 4:** Pin the contract in `tests/agents.test.mjs`, which already asserts statements in
      the agent cards. Add assertions that `agents/tm-reviewer.md` names the `stamp` key, names
      the `findings` key, tells the reviewer to copy the stamp verbatim rather than build it, and
      does NOT tell the reviewer to write a bare array. The last one is the assertion that would
      have caught this: the card and the collector disagreed for a whole phase with a green suite.

- [ ] **Step 5:** Run the full suite in the FOREGROUND and report the counts.

### Task 13: close the phase-2 findings against the CLI

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T10

**Model:** capable

Phase 2's review returned eleven findings, none blocking. Ten of them land in these two files.
They are collected here rather than folded into T10 so that T10's stated scope keeps describing
what T10 does. The findings themselves are in `.teammates/gaps/reviews/2-*.json`; each step below
names what was reproduced, because a step that only says "fix X" invites a fix that satisfies the
sentence rather than the failure.

- [ ] **Step 1:** The flaky worktree-name match. `tests/cli.test.mjs` matches a worktree name with
      the bare regex `/a1/` against `git worktree list` output, which also matches those two
      characters ANYWHERE in that output. There are at least TWO INDEPENDENT SOURCES, and a fix
      that covers only one leaves the phase still flaky.

      The first is an abbreviated commit sha: measured at roughly 2.5% across 40 isolated runs,
      with an observed failure on sha `3a1b132`.

      The second was found later, when this flake failed a real phase-4 gate run on shas that had
      passed the same check minutes earlier — the `mkdtemp` suffix of the temp root itself:

          'C:/Users/andre/AppData/Local/Temp/tm-cli-a1TUr0 822d690 [run-branch]'

      So the true rate is higher than the sha-only measurement, and the fix proposed in review
      (matching `worktrees[\\/]a1`) would NOT have caught this one, because the match came from the
      temp root rather than from anything under a worktrees directory. Anchor on the worktree’s own
      path segment as it actually appears in `git worktree list`, and verify your fix against BOTH
      shapes: a sha containing the substring, and a temp-root directory name containing it.

      Why it is worth the trouble: it fails a phase on correct behaviour in the `doesNotMatch`
      direction, and in the paired `assert.match` direction it PASSES when the worktree was
      wrongly removed — so it masks a real regression at the same rate that it invents a fake
      one. The three pre-existing occurrences around lines 648, 671 and 693 have the same
      weakness; fix those too, since a flaky gate is worse than a missing check.

- [ ] **Step 2:** The unlink fallback is untested. Replacing the whole
      `catch { failed += 1; io.out('left ... in place ...'); continue }` block around
      `scripts/cli.mjs:1375-1383` with a bare swallow leaves the suite green — so nothing asserts
      the one branch that turns a partial link sweep into a refusal. That branch is the safety
      net for the hazard the canary test proves is real: with it swallowed, a sweep that throws
      falls through to `git worktree remove --force` and destroys the link target's contents.
      Add a test that MAKES THE SWEEP FAIL and asserts the worktree is still listed afterwards
      and the command exits 1. Confirm the new test fails against the swallowed-catch mutant.

- [ ] **Step 3:** The `PREVIEW_LINK_MAX_DEPTH` guard at `scripts/cli.mjs:518` can be turned from
      a `throw` into a silent `return 0` with the suite green, because nothing constructs a tree
      deeper than two levels. The comment states the guard throws specifically because a partial
      sweep followed by a removal is the failure the sweep exists to prevent. Build a tree deeper
      than the limit and assert the throw.

- [ ] **Step 4:** The ENOENT deadlock. `scripts/merge-preview.mjs` calls
      `git.removeWorktree(dir).catch(() => {})` and then removes the directory, so a failed
      removal leaves "worktree still registered, directory gone" — a temp cleaner produces the
      same state. `git worktree list --porcelain` still reports that path, so it enters
      `plan.previews`; `unlinkPreviewLinks` then calls `readdir` on a path that does not exist,
      throws ENOENT, and the catch counts it as a failed sweep. `prune-run --yes` exits 1 on every
      subsequent run and the stale registration can never be cleared. The printed reason is also
      false in that state — there are no links to sweep in a directory that is not there. Let
      ENOENT on the preview root fall through to `removeWorktree`, which is what clears the
      registration, and keep every other error blocking. Pin both halves.

- [ ] **Step 5:** The tripwire does not trip. The KNOWN_FLAGS test hardcodes its twenty commands
      instead of deriving them, so it catches a command REMOVED from the table and not one ADDED
      without an entry — and adding is the direction that happens. Proven by adding a real 21st
      subcommand: the suite stayed green at 269/269 while that command swallowed an unknown flag
      and exited 0. Derive the command list from `REQUIRED`'s keys, or assert
      `Object.keys(REQUIRED)` equals `Object.keys(KNOWN_FLAGS)`. Verify by adding a throwaway 21st
      command locally and confirming the suite now fails.

- [ ] **Step 6:** `complete --base` and `--phase` are declared in KNOWN_FLAGS and really read
      (`checksForPhase(config, flags.phase ?? 'default')`, and `flags.base` via `derive`), but are
      passed by no test in the entire suite — 581 CLI invocations, neither flag among them. So
      dropping `base` from that entry breaks every caller that passes it while the suite stays
      green. Cover both. The existing test named "every command still accepts the flags it
      documents" checks one flag on one command; either make it live up to its name or rename it.

- [ ] **Step 7:** `doctor`'s `--run-branch` mismatch guard at `scripts/cli.mjs:1200` is asserted by
      nothing: changing `if (derived.runBranch === runBranch)` to `if (true)` keeps the suite
      green. With that mutant, `doctor --run r1 --run-branch other` applies an anchor derived from
      a different branch, so `landed` is computed against the wrong anchor and a task branch can
      be reported as integrated on a run branch it was never merged into — with no
      "could not derive the run anchor" note to warn the reader. Both new doctor tests leave
      `--run-branch` unset, so only the equal case is exercised. Cover the mismatch.

- [ ] **Step 8:** A results block keyed to a phase the run does not have is silently dropped.
      `validateSuppliedPhases` checks shape only, and evidence is read with
      `suppliedForPhase(supplied, phase)` for phases taken from the plan, so a key naming no real
      phase is never looked at — including one supplying a `command` result, which under a real
      phase is refused with exit 2. An operator with a typo'd phase key gets a pending report and
      no hint the evidence was discarded. Report an unmatched phase key rather than ignoring it.
      The direction is already safe; this is about not lying by omission.

- [ ] **Step 9:** Two prose corrections, both the class this plan keeps finding — a comment
      claiming more than the code delivers:
      - The comment around `scripts/cli.mjs:1366-1371` reads as though the link sweep closes the
        junction hazard outright. It closes it for a preview whose owner is DEAD. A live preview
        of a running gate is classified as leaked by name and location alone, and a junction its
        owner creates between the sweep and the removal is still followed. Say which case is
        covered.
      - The reaper force-removes any detached, branchless worktree under the temp root whose leaf
        matches the preview name pattern, including one an operator created deliberately,
        discarding uncommitted work in it. The dry run is the default and the plan is printed
        first, so this is a documentation gap rather than a behaviour change: say what the
        pattern will match.

- [ ] **Step 10:** The TOCTOU itself. A live merge preview is indistinguishable from a leaked one
      by name and location, so `prune-run` can sweep a preview whose owner is mid-link-provisioning
      and then remove it through a junction created in that window. `scripts/prune.mjs:30-36`
      already declares "safe to remove only when no gate is running" as the caller's precondition,
      and `prune-run` does not check it — what T7 changed is that violating it is now destructive
      rather than merely noisy. Close it if you can do so within these two files: a preview whose
      worktree was registered very recently, or whose directory mtime is moving, is not safely
      reapable. If closing it needs `scripts/prune.mjs` or `scripts/merge-preview.mjs`, that is a
      file-set problem — report status "blocked" naming the file rather than editing it, and say
      what you would have changed.

- [ ] **Step 11:** Run the full suite in the FOREGROUND and report the counts.
