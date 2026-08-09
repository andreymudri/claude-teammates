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

**Depends:** T7

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
