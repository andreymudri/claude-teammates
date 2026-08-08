# Codebase map for target projects

A fleet works on someone else's repository. Each implementer starts in a fresh worktree, holds
three or four declared files, and knows nothing about what depends on them. It may not edit
outside its file set — the gate enforces that — but it can freely *break* things outside it, and
the first anyone hears of it is a red suite at integration.

This adds a map of the **target** project, not of this plugin, in two layers:

1. **Git-derived, computed on demand.** File inventory, directory rollups, and co-change coupling
   from `git log --name-only`: which files historically change together. Language-agnostic, no
   parser, no index, nothing stored. A NestJS repo, a C++ repo and a monorepo all work on day one.
2. **Agent-written notes, one file per run.** `.teammates/<runId>/map.md`, produced by an Explore
   agent, stamped with the commit sha it was written at. Prose about what modules are *for* —
   the part no git statistic can supply.

Layer 1 is injected into every implementer brief automatically as a **blast radius** section: the
files most coupled to the task's declared set, which the teammate may not edit and must not break.

## What this is explicitly not

- **Not a parsed import graph.** Per-language regex import scanning is wrong often and silently,
  and it is per-language maintenance forever in a zero-dependency codebase.
- **Not an enforcement input.** No check, gate, or verdict reads the map. A map that can fail a
  gate is a map worth gaming, and coupling is a statistic about history, not a rule about
  correctness.
- **Not persisted, for layer 1.** Every consumer recomputes from git, the same way the anchor and
  the plan hash are recomputed rather than trusted. Layer 2 is stored because an agent wrote it,
  and it carries the sha it was written at so a reader can tell when it has rotted.

## Global Constraints

- Node >= 24.2.0
- Zero new runtime dependencies
- Commit messages: single-line, commitlint style, English
- Pure modules (`scripts/codemap.mjs`, `scripts/mapnotes.mjs`) take data and return data: no
  filesystem access, no git access, no imports beyond other pure modules
- Every new behaviour is pinned by a test in `tests/`, run with `node --test tests/*.test.mjs`
- No enforcement check may read map data — the map informs briefs and operators only
- A teammate never writes `.teammates/<runId>/map.md`; the orchestrator does

### Task 1: git primitives for the map

**Files:**
- Modify: `scripts/git.mjs`
- Test: `tests/git.test.mjs`

- [ ] **Step 1:** Add `listFiles()` to the object returned by `createGit`, next to `tracks`. It
      returns every tracked path, NUL-delimited so a path with a space or a non-ASCII character
      round-trips intact:

```js
    // Every tracked path, for the inventory half of the map. `-z` with core.quotePath=false so a
    // path containing a space, a quote or a non-ASCII character comes back as written rather than
    // as git's escaped display form.
    async listFiles() {
      const out = await run(['-c', 'core.quotePath=false', 'ls-files', '-z'])
      return out.split('\0').filter(Boolean)
    },
```

- [ ] **Step 2:** Add `commitFileSets({ limit = 500 })`, which returns one array of paths per
      commit — the raw input the coupling calculation consumes. Place it after `listFiles`:

```js
    // One entry per commit, each the list of paths that commit touched, newest first. The record
    // separator is an explicit marker rather than a blank line: a commit that touched no file at
    // all (an empty commit, a pure merge) would otherwise be indistinguishable from the gap
    // between two commits, and dropping it silently changes every support count derived from it.
    //
    // --no-renames for the same reason changedFiles uses it: with rename detection on, git reports
    // only the post-image, so the pre-image path looks untouched in the commit that removed it.
    async commitFileSets({ limit = 500 } = {}) {
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new GitError(`commitFileSets requires a positive integer limit, got ${JSON.stringify(limit)}`)
      }
      const out = await run([
        '-c', 'core.quotePath=false', 'log', `--max-count=${limit}`,
        '--no-renames', '--name-only', '--format=%x00commit%x00', '-z', 'HEAD', '--',
      ])
      const sets = []
      let current = null
      for (const token of out.split('\0')) {
        if (token === 'commit') { if (current) sets.push(current); current = []; continue }
        const path = token.replace(/^\n+|\n+$/g, '')
        if (current && path !== '') current.push(path)
      }
      if (current) sets.push(current)
      return sets
    },
```

- [ ] **Step 3:** Add these tests to `tests/git.test.mjs`, using the existing `recorder` helper:

```js
test('listFiles returns every tracked path, NUL-delimited and unquoted', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'src/a.ts\0src/b b.ts\0', stderr: '' })
  const files = await createGit({ exec }).listFiles()
  assert.deepEqual(calls[0], ['-c', 'core.quotePath=false', 'ls-files', '-z'])
  assert.deepEqual(files, ['src/a.ts', 'src/b b.ts'])
})

test('commitFileSets returns one path list per commit, newest first', async () => {
  const stdout = '\0commit\0src/a.ts\nsrc/b.ts\0\0commit\0src/a.ts\0'
  const { calls, exec } = recorder({ code: 0, stdout, stderr: '' })
  const sets = await createGit({ exec }).commitFileSets({ limit: 10 })
  assert.deepEqual(calls[0], [
    '-c', 'core.quotePath=false', 'log', '--max-count=10',
    '--no-renames', '--name-only', '--format=%x00commit%x00', '-z', 'HEAD', '--',
  ])
  assert.deepEqual(sets, [['src/a.ts', 'src/b.ts'], ['src/a.ts']])
})

// A commit that touched nothing is a real commit and must keep its slot: dropping it would
// shift every support count computed from the list.
test('commitFileSets keeps an empty commit as an empty set', async () => {
  const { exec } = recorder({ code: 0, stdout: '\0commit\0\0commit\0src/a.ts\0', stderr: '' })
  const sets = await createGit({ exec }).commitFileSets({ limit: 5 })
  assert.deepEqual(sets, [[], ['src/a.ts']])
})

test('commitFileSets rejects a non-positive limit rather than asking git for every commit', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).commitFileSets({ limit: 0 }), GitError)
  assert.deepEqual(calls, [])
})
```

### Task 2: the pure coupling and inventory module

**Files:**
- Create: `scripts/codemap.mjs`
- Test: `tests/codemap.test.mjs`

- [ ] **Step 1:** Create `scripts/codemap.mjs` with a header stating what the numbers mean and
      what they do not, then the two calculations:

```js
// Coupling and inventory for a target project, computed from git history alone.
//
// The question an implementer needs answered is "what will my change break", and the cheapest
// honest answer is which files have historically changed alongside the ones it holds. No parser,
// no language support, no index: `git log --name-only` says it for every language at once.
//
// What this measures is CORRELATION IN HISTORY, not a dependency. Two files that always change
// together may be caller and callee, or a source and its test, or two things one person happened
// to keep tidy. That is why nothing here decides anything — it is injected into briefs as context
// and read by operators, and no gate consults it.
//
// Pure: it takes commit file-sets and returns numbers. Reading git belongs to the caller.

// Commits touching enormous numbers of files — a mass rename, a vendored drop, a formatting
// sweep — couple everything to everything and drown the real signal. They are excluded by size
// rather than by message, because a message is a convention and a size is a fact.
const DEFAULT_MAX_COMMIT_FILES = 40
// A file seen in one or two commits produces 100%-confidence pairs that mean nothing. The floor
// is what stops a brand-new file from looking maximally coupled to whatever it arrived with.
const DEFAULT_MIN_SUPPORT = 3

export function buildCoupling(commitFileSets = [], { maxCommitFiles = DEFAULT_MAX_COMMIT_FILES } = {}) {
  const support = new Map()
  const pairs = new Map()
  let usedCommits = 0

  for (const files of commitFileSets) {
    const unique = [...new Set(files ?? [])]
    if (unique.length === 0 || unique.length > maxCommitFiles) continue
    usedCommits += 1
    for (const file of unique) support.set(file, (support.get(file) ?? 0) + 1)
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        // Sorted key so (a,b) and (b,a) are one entry; the direction lives in the confidence
        // calculation, which divides by the support of the file being asked about.
        const key = unique[i] < unique[j] ? `${unique[i]}\0${unique[j]}` : `${unique[j]}\0${unique[i]}`
        pairs.set(key, (pairs.get(key) ?? 0) + 1)
      }
    }
  }

  return { support, pairs, usedCommits }
}

// How often `other` appeared in a commit that touched `file`, as a fraction of the commits that
// touched `file`. Asymmetric on purpose: a test that always accompanies its source is highly
// confident from the source's side and may be far less so from the other direction.
export function confidence(coupling, file, other) {
  const base = coupling.support.get(file) ?? 0
  if (base === 0) return 0
  const key = file < other ? `${file}\0${other}` : `${other}\0${file}`
  return (coupling.pairs.get(key) ?? 0) / base
}

// The blast radius of a declared file set: the files most likely to move when these do, with the
// set's own members removed — a teammate is already told about those, and it may edit them.
export function neighboursOf(coupling, files = [], { top = 5, minSupport = DEFAULT_MIN_SUPPORT } = {}) {
  const own = new Set(files)
  const scored = new Map()
  for (const file of own) {
    if ((coupling.support.get(file) ?? 0) < minSupport) continue
    for (const key of coupling.pairs.keys()) {
      const [a, b] = key.split('\0')
      if (a !== file && b !== file) continue
      const other = a === file ? b : a
      if (own.has(other)) continue
      const score = confidence(coupling, file, other)
      // A file coupled to two members of the set keeps its strongest association rather than a
      // sum: the number is a probability about one relationship, and adding two of them produces
      // a figure above 1 that means nothing.
      if (score > (scored.get(other) ?? 0)) scored.set(other, score)
    }
  }
  return [...scored.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, top)
    .map(([path, score]) => ({ path, confidence: score }))
}

// Directory rollup, deepest-first by file count. Deliberately counts every tracked path rather
// than guessing at source extensions: what counts as source is a per-project question, and a
// wrong guess hides exactly the directory an operator is looking for.
export function inventory(paths = [], { top = 20 } = {}) {
  const dirs = new Map()
  for (const p of paths) {
    const norm = String(p).replace(/\\/g, '/')
    const slash = norm.lastIndexOf('/')
    const dir = slash === -1 ? '.' : norm.slice(0, slash)
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
  }
  const rows = [...dirs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([dir, files]) => ({ dir, files }))
  return { totalFiles: paths.length, directories: dirs.size, rows }
}

export function renderMap({ inventory: inv, hotPairs = [], usedCommits = 0 }) {
  const lines = [`${inv.totalFiles} tracked files across ${inv.directories} directories, coupling from ${usedCommits} commits`]
  lines.push('largest directories:')
  for (const row of inv.rows) lines.push(`  ${String(row.files).padStart(5)}  ${row.dir}`)
  if (hotPairs.length) {
    lines.push('most coupled pairs:')
    for (const p of hotPairs) lines.push(`  ${Math.round(p.confidence * 100)}%  ${p.file} -> ${p.other}`)
  }
  return lines.join('\n')
}

// The strongest associations in the repository, for an operator reading the map directly rather
// than for a brief. Same floors as neighboursOf, so the two never disagree about what counts.
export function hotPairs(coupling, { top = 15, minSupport = DEFAULT_MIN_SUPPORT } = {}) {
  const out = []
  for (const key of coupling.pairs.keys()) {
    const [a, b] = key.split('\0')
    if ((coupling.support.get(a) ?? 0) < minSupport && (coupling.support.get(b) ?? 0) < minSupport) continue
    const ab = confidence(coupling, a, b)
    const ba = confidence(coupling, b, a)
    const [file, other, score] = ab >= ba ? [a, b, ab] : [b, a, ba]
    out.push({ file, other, confidence: score })
  }
  return out.sort((x, y) => y.confidence - x.confidence || x.file.localeCompare(y.file)).slice(0, top)
}
```

- [ ] **Step 2:** Create `tests/codemap.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCoupling, confidence, neighboursOf, inventory, hotPairs, renderMap } from '../scripts/codemap.mjs'

const HISTORY = [
  ['src/order.ts', 'src/order.controller.ts', 'test/order.spec.ts'],
  ['src/order.ts', 'src/order.controller.ts'],
  ['src/order.ts', 'test/order.spec.ts'],
  ['src/billing.ts'],
]

test('support counts the commits that touched each file', () => {
  const c = buildCoupling(HISTORY)
  assert.equal(c.support.get('src/order.ts'), 3)
  assert.equal(c.support.get('src/billing.ts'), 1)
  assert.equal(c.usedCommits, 4)
})

test('confidence is the share of a file’s commits that also touched the other', () => {
  const c = buildCoupling(HISTORY)
  assert.equal(confidence(c, 'src/order.ts', 'src/order.controller.ts'), 2 / 3)
})

// Asymmetry is the point: the controller never moves without the service, but the service moves
// without the controller a third of the time.
test('confidence is asymmetric', () => {
  const c = buildCoupling(HISTORY)
  assert.equal(confidence(c, 'src/order.controller.ts', 'src/order.ts'), 1)
})

test('a file nobody has touched has zero confidence rather than a division by zero', () => {
  assert.equal(confidence(buildCoupling(HISTORY), 'src/nothing.ts', 'src/order.ts'), 0)
})

// A mass rename or a formatting sweep couples everything to everything. Excluded by size,
// because a commit message is a convention and a file count is a fact.
test('a commit touching more files than the cap is excluded entirely', () => {
  const big = Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`)
  const c = buildCoupling([...HISTORY, big], { maxCommitFiles: 40 })
  assert.equal(c.usedCommits, 4)
  assert.equal(c.support.get('src/f0.ts'), undefined)
})

test('neighbours exclude the task’s own files', () => {
  const c = buildCoupling(HISTORY)
  const out = neighboursOf(c, ['src/order.ts', 'src/order.controller.ts'], { minSupport: 1 })
  assert.deepEqual(out.map((n) => n.path), ['test/order.spec.ts'])
})

// Without a support floor, a file that has existed for one commit reads as maximally coupled to
// whatever arrived with it — the loudest possible signal from the least possible evidence.
test('a file below the support floor contributes no neighbours', () => {
  const c = buildCoupling(HISTORY)
  assert.deepEqual(neighboursOf(c, ['src/billing.ts'], { minSupport: 3 }), [])
})

test('a neighbour coupled to two declared files keeps its strongest score, never a sum', () => {
  const c = buildCoupling(HISTORY)
  const out = neighboursOf(c, ['src/order.ts', 'test/order.spec.ts'], { minSupport: 1 })
  const controller = out.find((n) => n.path === 'src/order.controller.ts')
  assert.ok(controller.confidence <= 1)
})

test('neighbours are ranked by confidence and capped by top', () => {
  const c = buildCoupling(HISTORY)
  assert.equal(neighboursOf(c, ['src/order.ts'], { top: 1, minSupport: 1 }).length, 1)
})

test('inventory rolls files up by directory, largest first', () => {
  const inv = inventory(['src/a.ts', 'src/b.ts', 'test/c.spec.ts', 'README.md'])
  assert.equal(inv.totalFiles, 4)
  assert.deepEqual(inv.rows[0], { dir: 'src', files: 2 })
  assert.ok(inv.rows.some((r) => r.dir === '.'))
})

test('inventory normalizes windows separators so one directory is not counted twice', () => {
  const inv = inventory(['src\\a.ts', 'src/b.ts'])
  assert.deepEqual(inv.rows, [{ dir: 'src', files: 2 }])
})

test('hotPairs reports the strongest direction of each pair', () => {
  const pairs = hotPairs(buildCoupling(HISTORY), { minSupport: 1, top: 1 })
  assert.equal(pairs[0].confidence, 1)
})

test('renderMap prints the totals, the directory rollup and the coupled pairs', () => {
  const out = renderMap({
    inventory: inventory(['src/a.ts', 'src/b.ts']),
    hotPairs: [{ file: 'src/a.ts', other: 'src/b.ts', confidence: 0.5 }],
    usedCommits: 12,
  })
  assert.match(out, /2 tracked files/)
  assert.match(out, /12 commits/)
  assert.match(out, /50%/)
  assert.match(out, /src\/a\.ts -> src\/b\.ts/)
})
```

### Task 3: the pure map-notes module

**Files:**
- Create: `scripts/mapnotes.mjs`
- Test: `tests/mapnotes.test.mjs`

- [ ] **Step 1:** Create `scripts/mapnotes.mjs`:

```js
// The agent-written half of the map: prose about what a target project's modules are FOR, which
// no statistic over git history can supply.
//
// It is stored, unlike the coupling half, because an agent wrote it and rewriting it costs a
// model call. So it carries the commit it was written at, and a reader that finds the repository
// has moved treats it as stale rather than as fact. That is the same bargain the gate strikes
// with the anchor: derived state is allowed to exist as long as it names what it was derived
// from and anything reading it can check.
//
// Advisory only. No check reads it, and nothing in it can fail a phase.

const HEADER = /^<!--\s*teammates-map\s+run=(\S+)\s+sha=([0-9a-f]+)\s*-->/

export function mapNotesHeader({ runId, sha }) {
  if (!runId || !sha) throw new Error(`map notes need a run id and a sha, got ${JSON.stringify({ runId, sha })}`)
  return `<!-- teammates-map run=${runId} sha=${sha} -->`
}

export function readMapNotesHeader(text) {
  const match = HEADER.exec(String(text ?? '').trimStart())
  return match ? { runId: match[1], sha: match[2] } : null
}

// Returns a reason string when the notes must not be used as-is, or null when they are current.
// A missing or unreadable header is stale, never "probably fine": notes with no provenance are
// exactly the artefact this design refuses to trust elsewhere.
export function mapNotesStale(text, { runId, sha }) {
  if (!text || String(text).trim() === '') return 'no map notes have been written for this run'
  const header = readMapNotesHeader(text)
  if (!header) return 'the map notes carry no teammates-map header, so nothing says which commit they describe'
  if (header.sha !== sha) return `the map notes describe commit ${header.sha}, but the repository is at ${sha}`
  if (header.runId !== runId) return `the map notes were written for run ${header.runId}, not ${runId}`
  return null
}

// The prompt handed to an Explore agent. Written here rather than in the skill so the file path,
// the header line and the instruction not to guess stay in one place with the parser above.
export function mapNotesPrompt({ runId, sha, notesPath, topDirectories = [] }) {
  return [
    `Write a map of this repository for a fleet working on it, to ${notesPath}.`,
    '',
    `Start the file with exactly this line, unchanged: ${mapNotesHeader({ runId, sha })}`,
    '',
    'Then, for each significant area of the codebase: what it is for, what depends on it, and the',
    'one thing a newcomer would get wrong about it. Prefer naming the module that owns a concept',
    'over listing files. Say "unclear" where the code does not tell you — a guess dressed as a',
    'fact is worse here than a gap, because implementers will act on it.',
    '',
    topDirectories.length ? `The largest directories by file count are: ${topDirectories.join(', ')}.` : '',
    '',
    'Read the code. Do not infer the architecture from README claims alone, and do not modify any',
    'file other than the map you are writing.',
  ].filter((line) => line !== '').join('\n')
}
```

- [ ] **Step 2:** Create `tests/mapnotes.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapNotesHeader, readMapNotesHeader, mapNotesStale, mapNotesPrompt } from '../scripts/mapnotes.mjs'

test('the header names the run and the commit the notes describe', () => {
  assert.equal(mapNotesHeader({ runId: 'r1', sha: 'abc123' }), '<!-- teammates-map run=r1 sha=abc123 -->')
})

test('a header with no run or no sha is refused rather than written incomplete', () => {
  assert.throws(() => mapNotesHeader({ runId: 'r1' }), /sha/)
  assert.throws(() => mapNotesHeader({ sha: 'abc123' }), /run/)
})

test('the header round-trips through the reader', () => {
  const text = `${mapNotesHeader({ runId: 'r1', sha: 'abc123' })}\n\n# Map\n`
  assert.deepEqual(readMapNotesHeader(text), { runId: 'r1', sha: 'abc123' })
})

test('notes written at the current commit are not stale', () => {
  const text = `${mapNotesHeader({ runId: 'r1', sha: 'abc123' })}\nbody\n`
  assert.equal(mapNotesStale(text, { runId: 'r1', sha: 'abc123' }), null)
})

test('notes written at another commit are stale and say which', () => {
  const text = `${mapNotesHeader({ runId: 'r1', sha: 'old111' })}\nbody\n`
  assert.match(mapNotesStale(text, { runId: 'r1', sha: 'new222' }), /old111.*new222/)
})

// Notes with no provenance are the artefact this design refuses to trust everywhere else.
test('notes with no header are stale whatever they contain', () => {
  assert.match(mapNotesStale('# Map\nlots of prose\n', { runId: 'r1', sha: 'abc123' }), /no teammates-map header/)
})

test('missing or empty notes are stale', () => {
  assert.match(mapNotesStale('', { runId: 'r1', sha: 'abc' }), /no map notes/)
  assert.match(mapNotesStale(null, { runId: 'r1', sha: 'abc' }), /no map notes/)
})

test('notes from another run are stale', () => {
  const text = `${mapNotesHeader({ runId: 'other', sha: 'abc123' })}\nbody\n`
  assert.match(mapNotesStale(text, { runId: 'r1', sha: 'abc123' }), /run other/)
})

test('the prompt carries the exact header line, the target path and the refusal to guess', () => {
  const prompt = mapNotesPrompt({ runId: 'r1', sha: 'abc123', notesPath: '.teammates/r1/map.md', topDirectories: ['src', 'test'] })
  assert.match(prompt, /<!-- teammates-map run=r1 sha=abc123 -->/)
  assert.match(prompt, /\.teammates\/r1\/map\.md/)
  assert.match(prompt, /src, test/)
  assert.match(prompt, /Say "unclear"/)
})

test('the prompt omits the directory sentence when there are none', () => {
  assert.doesNotMatch(mapNotesPrompt({ runId: 'r1', sha: 'a', notesPath: 'p' }), /largest directories/)
})
```

### Task 4: blast radius in the implementer brief

**Files:**
- Modify: `scripts/workflow-gen.mjs`
- Modify: `templates/phase-workflow.js`
- Test: `tests/workflow-gen.test.mjs`

- [ ] **Step 1:** In `scripts/workflow-gen.mjs`, accept a `neighbours` option — a map of task id to
      an array of `{ path, confidence }` — and thread it onto each task in the generated `slim`
      list. Add `neighbours = {}` to the destructured parameters, and inside the `slim` map, after
      `const base = ...`, attach the entry only when it is non-empty so a task with no history
      renders no section at all:

```js
    const near = neighbours?.[id]
    const withNear = Array.isArray(near) && near.length > 0 ? { ...base, neighbours: near } : base
    return model ? { ...withNear, model } : withNear
```

- [ ] **Step 2:** In `templates/phase-workflow.js`, add a `blastRadius` builder above `const brief`,
      and insert its lines into both `brief` and `briefTerse` immediately after the FILES section:

```js
// Files that have historically changed alongside this task's declared set. They are OUTSIDE the
// set, so the teammate may not edit them — the point is the opposite: they are what its change
// is most likely to break without touching. Rendered only when the generator supplied any, so a
// repository with no history, or a task whose files are new, shows no section rather than an
// empty one.
const blastRadius = (t) => (t.neighbours && t.neighbours.length ? [
  'BLAST RADIUS. These files are not yours and you may not edit them. They have changed together',
  'with your files in the past, so they are where your change is most likely to break something:',
  ...t.neighbours.map((n) => '  ' + Math.round(n.confidence * 100) + '%  ' + n.path),
  'This is a statistic about history, not a dependency list: it can be wrong in both directions.',
  'Read the ones that look relevant. If your task cannot be done without editing one, that is a',
  'file-set problem — report status "blocked" naming it rather than editing it.',
  '',
] : [])
```

      In `brief`, after the two FILES lines, insert `...blastRadius(t),`. In `briefTerse`, insert
      the same call at the same position — the blast radius is part of the specification a
      teammate is judged against, so it is not compressed away, exactly as the FILES list is not.

- [ ] **Step 3:** Add to `tests/workflow-gen.test.mjs`:

```js
test('a task with neighbours renders a blast radius naming each file and its percentage', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2,
    tasks: [{ id: 'T1', title: 'a', files: ['src/a.ts'] }],
    neighbours: { T1: [{ path: 'src/b.ts', confidence: 0.82 }] },
  })
  assert.match(src, /BLAST RADIUS/)
  assert.match(src, /82%/)
  assert.match(src, /src\/b\.ts/)
})

test('a task with no neighbours renders no blast radius section', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2,
    tasks: [{ id: 'T1', title: 'a', files: ['src/a.ts'] }],
    neighbours: { T1: [] },
  })
  assert.doesNotMatch(src, /BLAST RADIUS/)
})

test('omitting neighbours entirely renders no blast radius and no undefined', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2,
    tasks: [{ id: 'T1', title: 'a', files: ['src/a.ts'] }],
  })
  assert.doesNotMatch(src, /BLAST RADIUS/)
  assert.doesNotMatch(src, /undefined/)
})

// The brief is the specification the gate then enforces, so the caveman variant keeps it for the
// same reason it keeps the FILES list.
test('the caveman brief keeps the blast radius', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2, caveman: 'full',
    tasks: [{ id: 'T1', title: 'a', files: ['src/a.ts'] }],
    neighbours: { T1: [{ path: 'src/b.ts', confidence: 0.5 }] },
  })
  assert.match(src, /BLAST RADIUS/)
})

test('the blast radius tells a teammate to report blocked rather than edit a neighbour', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1', phase: 1, maxParallel: 2,
    tasks: [{ id: 'T1', title: 'a', files: ['src/a.ts'] }],
    neighbours: { T1: [{ path: 'src/b.ts', confidence: 0.5 }] },
  })
  assert.match(src, /report status "blocked" naming it rather than editing it/)
})
```

### Task 5: the CLI commands and the workflow wiring

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T1, T2, T3, T4

**Model:** capable

- [ ] **Step 1:** Import the new modules at the top of `scripts/cli.mjs`:

```js
import { buildCoupling, neighboursOf, inventory, hotPairs, renderMap } from './codemap.mjs'
import { mapNotesStale, mapNotesPrompt } from './mapnotes.mjs'
```

- [ ] **Step 2:** Add a `map` subcommand, before `if (command === 'preview-check')`. With
      `--files` it answers the blast-radius question for one set; without, it prints the
      repository overview:

```js
  if (command === 'map') {
    const git = createGit({ cwd: root })
    const limit = flags.commits === undefined ? 500 : Number(flags.commits)
    if (!Number.isInteger(limit) || limit <= 0) {
      io.out('--commits takes a positive whole number of commits to read')
      return 2
    }
    let sets
    let paths
    try {
      sets = await git.commitFileSets({ limit })
      paths = await git.listFiles()
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`cannot read the repository: ${err.message}`)
      return 2
    }
    const coupling = buildCoupling(sets)

    // A file set turns this from an overview into the one question an implementer has: what does
    // my change put at risk. Answered for the whole set at once, because that is what a task holds.
    if (typeof flags.files === 'string' && flags.files.trim() !== '') {
      const files = flags.files.split(',').map((f) => f.trim()).filter(Boolean)
      const near = neighboursOf(coupling, files, { top: flags.top ? Number(flags.top) : 5 })
      if (near.length === 0) {
        io.out(`no coupled files found for ${files.join(', ')} in the last ${limit} commits — new files, or a shallow history`)
        return 0
      }
      for (const n of near) io.out(`${String(Math.round(n.confidence * 100)).padStart(3)}%  ${n.path}`)
      return 0
    }

    io.out(renderMap({ inventory: inventory(paths), hotPairs: hotPairs(coupling), usedCommits: coupling.usedCommits }))
    return 0
  }
```

- [ ] **Step 3:** Add a `map-notes` subcommand directly after `map`. It never writes the notes
      itself — it reports whether the stored ones are usable and prints the prompt for the agent
      that would write them:

```js
  if (command === 'map-notes') {
    const git = createGit({ cwd: root })
    const notesPath = path.join(runDir(root, runId), 'map.md')
    let sha
    try {
      sha = await git.headSha()
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`cannot read the repository: ${err.message}`)
      return 2
    }

    let text = null
    try {
      text = await readFile(notesPath, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }

    const stale = mapNotesStale(text, { runId, sha })
    if (!stale) { io.out(`current map notes: ${notesPath}`); return 0 }

    // 4, matching `complete` and `collect-reviews`: this cannot verify what it was asked about.
    // The prompt is printed so the caller dispatches an Explore agent rather than writing prose
    // itself — and a teammate never writes this file.
    io.out(stale)
    io.out('')
    io.out('dispatch an Explore agent with exactly this prompt:')
    io.out('')
    io.out(mapNotesPrompt({
      runId,
      sha,
      notesPath,
      topDirectories: inventory(await git.listFiles(), { top: 8 }).rows.map((r) => r.dir),
    }))
    return 4
  }
```

- [ ] **Step 4:** In the `workflow` command, compute each task's neighbours and pass them to
      `generatePhaseWorkflow`. Insert this immediately before the `const src = await
      generatePhaseWorkflow({` call:

```js
    // Coupling is recomputed here rather than read from anywhere: it is a statistic about the
    // repository as it stands, and a stored one would be a second source of truth about a number
    // nobody can check. A failure to read history is not a failure to dispatch — a brief without
    // a blast radius is the brief this command emitted until now, so it degrades to that and says so.
    const neighbours = {}
    try {
      const coupling = buildCoupling(await createGit({ cwd: root }).commitFileSets({ limit: 500 }))
      for (const task of phaseTasks) {
        const near = neighboursOf(coupling, task.files ?? [], { top: 5 })
        if (near.length > 0) neighbours[task.id] = near
      }
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`could not compute the blast radius (${err.message}); briefs will carry no coupling section`)
    }
```

      Then add `neighbours,` to the object passed to `generatePhaseWorkflow`.

- [ ] **Step 5:** Register both commands. Add to the usage block, in the first line's pipe list
      after `rebuild-state`, and as their own lines:

```
  map      [--files <a,b>] [--commits <n>] [--top <n>] [--root <path>]
  map-notes --run <id> [--root <path>]
```

      Add to `REQUIRED`: `map: [],` and `'map-notes': ['run'],`.

- [ ] **Step 6:** Add to `tests/cli.test.mjs`:

```js
test('map prints the inventory and the coupled pairs of the repository', async () => {
  await withRepo(async ({ root, io, lines, git: g }) => {
    await writeFile(path.join(root, 'x.mjs'), 'export const x = 1\n', 'utf8')
    await writeFile(path.join(root, 'x.test.mjs'), 'export const t = 1\n', 'utf8')
    g(['add', '.'])
    g(['commit', '--quiet', '-m', 'pair'])
    lines.length = 0
    const code = await runCli(['map', '--root', root], io)
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /tracked files/)
    assert.equal(code, 0)
  })
})

test('map --files answers the blast radius question for one file set', async () => {
  await withRepo(async ({ root, io, lines, git: g }) => {
    for (let i = 0; i < 4; i += 1) {
      await writeFile(path.join(root, 'x.mjs'), `export const x = ${i}\n`, 'utf8')
      await writeFile(path.join(root, 'x.test.mjs'), `export const t = ${i}\n`, 'utf8')
      g(['add', '.'])
      g(['commit', '--quiet', '-m', `round ${i}`])
    }
    lines.length = 0
    const code = await runCli(['map', '--files', 'x.mjs', '--root', root], io)
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /x\.test\.mjs/)
    assert.doesNotMatch(lines.join('\n'), /^\s*\d+%\s+x\.mjs$/m)
  })
})

test('map --files says so plainly when a file has no coupling history', async () => {
  await withRepo(async ({ root, io, lines }) => {
    lines.length = 0
    const code = await runCli(['map', '--files', 'nothing.mjs', '--root', root], io)
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /no coupled files/)
  })
})

test('map rejects a non-numeric commit window rather than reading the whole history', async () => {
  await withRepo(async ({ root, io, lines }) => {
    lines.length = 0
    assert.equal(await runCli(['map', '--commits', 'lots', '--root', root], io), 2)
    assert.match(lines.join('\n'), /positive whole number/)
  })
})

test('map-notes exits 4 with the Explore prompt when no notes exist', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(['map-notes', '--run', 'r1', '--root', root], io)
    assert.equal(code, 4)
    assert.match(lines.join('\n'), /no map notes/)
    assert.match(lines.join('\n'), /teammates-map run=r1 sha=[0-9a-f]+/)
  })
})

test('map-notes accepts notes written at the current commit', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const sha = g(['rev-parse', 'HEAD']).trim()
    await writeFile(
      path.join(root, '.teammates', 'r1', 'map.md'),
      `<!-- teammates-map run=r1 sha=${sha} -->\n\n# Map\n`,
      'utf8',
    )
    lines.length = 0
    const code = await runCli(['map-notes', '--run', 'r1', '--root', root], io)
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /current map notes/)
  })
})

test('map-notes reports notes describing an older commit as stale', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeFile(
      path.join(root, '.teammates', 'r1', 'map.md'),
      '<!-- teammates-map run=r1 sha=0000000 -->\n\n# Map\n',
      'utf8',
    )
    lines.length = 0
    const code = await runCli(['map-notes', '--run', 'r1', '--root', root], io)
    assert.equal(code, 4)
    assert.match(lines.join('\n'), /describe commit 0000000/)
  })
})

test('workflow puts a blast radius in the brief when the history supports one', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    for (let i = 0; i < 4; i += 1) {
      await writeFile(path.join(root, 'a.mjs'), `export const a = ${i}\n`, 'utf8')
      await writeFile(path.join(root, 'a.helper.mjs'), `export const h = ${i}\n`, 'utf8')
      g(['add', '.'])
      g(['commit', '--quiet', '-m', `round ${i}`])
    }
    lines.length = 0
    await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.match(lines.join('\n'), /BLAST RADIUS/)
    assert.match(lines.join('\n'), /a\.helper\.mjs/)
  })
})
```

### Task 6: document the map in the skills that dispatch

**Files:**
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/fleet-lifecycle/SKILL.md`
- Test: `tests/skill-contracts.test.mjs`

**Depends:** T5

- [ ] **Step 1:** In `skills/parallel-execution/SKILL.md`, add a `## The map` section immediately
      before `## Worktree mechanics`:

```markdown
## The map

Every generated brief carries a **blast radius**: the files that have historically changed
alongside the task's declared set. They are outside the file set, so the teammate may not edit
them — they are what its change is most likely to break without touching. It is computed from
`git log` at dispatch time and stored nowhere, so it cannot go stale; a repository with no
history simply produces no section.

Ask the same question yourself for any file set:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" map --files <a,b> --root <project root>

Coupling is correlation in history, not a dependency: a source and its test, a caller and its
callee, and two files one person kept tidy all look alike to it. Nothing enforces it and no gate
reads it — a map that could fail a phase would be a map worth gaming.
```

- [ ] **Step 2:** In `skills/fleet-lifecycle/SKILL.md`, add a `## Map notes` section after the
      `## When the run directory is gone` section:

```markdown
## Map notes

For what a target project's modules are *for* — the part git statistics cannot supply — a run may
carry `.teammates/<runId>/map.md`, written by an Explore agent:

    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" map-notes --run <runId> --root <project root>

Exit 0 means the stored notes describe the commit the repository is on. Exit 4 means there are
none, or they describe a different commit, and it prints the exact prompt to dispatch — the notes
name the sha they were written at, so a reader can always tell. Dispatch that agent yourself: a
teammate never writes this file, and nothing enforced ever reads it.
```

- [ ] **Step 3:** Add to `tests/skill-contracts.test.mjs`:

```js
test('parallel-execution states the blast radius is context, not an enforced file set', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('The map')
  assertStatement(
    section,
    /they are outside the file set, so the teammate may not edit them/i,
    'the skill must not let a blast radius read as permission to edit those files',
  )
  assertStatement(
    section,
    /Coupling is correlation in history, not a dependency/i,
    'the skill must state what the number does and does not mean',
  )
  assertStatement(
    section,
    /Nothing enforces it and no gate reads it/i,
    'the skill must state that the map is outside enforcement',
  )
})

test('fleet-lifecycle states who writes the map notes and that nothing enforced reads them', async () => {
  const { doc } = await skill('fleet-lifecycle')
  const section = doc.section('Map notes')
  assertStatement(
    section,
    /a teammate never writes this file, and nothing enforced ever reads it/i,
    'the skill must keep map notes out of both the write path and the enforcement path',
  )
})
```
