# Rename to fleetmates and publish on npm — implementation plan

Spec: `docs/specs/2026-09-13-fleetmates-rename-design.md`. Branch: `feat/fleetmates`.

## Global Constraints

- Node >= 24.2.0 (`package.json` `engines`), tests run with `node --test`
- Zero runtime and zero dev dependencies — no `npm install` step exists, and none may be added
- Every behaviour change starts with a failing test, watched failing for the right reason
- Commit messages: `type(scope): subject`, English, and NO `Co-Authored-By:`, `Claude-Session:` or "Generated with" lines — commits are authored by Andrey Mudri alone
- Historical documents are not rewritten: `docs/specs/*` and `docs/followups/*` dated before 2026-09-13, `docs/plans/*` other than this file, past `CHANGELOG.md` entries, `HANDOFF.md`
- The word "teammate(s)" as a ROLE stays (agents `tm-implementer`, `tm-integrator`, `tm-reviewer` are not renamed); only the identifiers in the spec's name map change
- Every legacy spelling in `scripts/` lives in `scripts/names.mjs` (`LEGACY`) and is read only by `scripts/migrate.mjs`; the two exceptions are the update-check opt-out variable and the old-plugin warning in `hooks/session-start`
- Any text printed from a run id, task id, branch name or path goes through `printable` from `scripts/reviews.mjs`
- Windows is a supported platform: paths via `node:path`, git invoked with argument arrays, never a shell string

## Destination

`fleetmates` 2.0.0 is ready for its first manual `npm publish`: `npm pack` produces the plugin under
the new name without tests or docs, every CLI command migrates a `claude-teammates` repository on
first touch or refuses with a reason, and the suite is green on ubuntu, macos and windows.

## Out of Scope

- Publishing, tagging and `gh repo rename` — they are outward-facing steps done by hand after merge, in the order the spec's section 3 gives.
- A `fleetmates` CLI binary — the spec chose plugin distribution only.
- Renaming the local checkout directory — this project's auto-memory path is keyed on it.
- Renaming the `tm-*` agents — "teammate" remains the role name.

### Task 1: names module and the auto-migration

**Files:**
- Create: `scripts/names.mjs`
- Create: `scripts/migrate.mjs`
- Test: `tests/migrate.test.mjs`

**Model:** capable

Nothing imports these two modules yet, so the suite stays green; Task 5 wires them in.

- [ ] **Step 1:** Create `scripts/names.mjs`. It imports nothing, so `scripts/enforce.mjs` can import it without growing the SubagentStop hook's module graph.

```js
// Every spelling this project writes to disk, to git, or into a plugin namespace, in one place.
// `NAMES` is what the code uses. `LEGACY` is what claude-teammates used, and `scripts/migrate.mjs`
// is its only reader: no other module dual-reads, so a legacy spelling found anywhere else is a
// missed rename rather than a compatibility path.
//
// Imports nothing, deliberately: `enforce.mjs` is loaded by the stop-time hook inside every
// teammate, and this module must not grow that graph.

export const NAMES = Object.freeze({
  product: 'fleetmates',
  gateFile: 'fleetmates.gate.json',
  localFile: 'fleetmates.local.json',
  stateDir: '.fleetmates',
  branchPrefix: 'fleetmates',
  refPrefix: 'refs/fleetmates',
  mapHeader: 'fleetmates-map',
  updateCheckEnv: 'FLEETMATES_UPDATE_CHECK',
})

export const LEGACY = Object.freeze({
  product: 'claude-teammates',
  gateFile: 'teammates.gate.json',
  localFile: 'teammates.local.json',
  stateDir: '.teammates',
  branchPrefix: 'teammates',
  refPrefix: 'refs/teammates',
  mapHeader: 'teammates-map',
  updateCheckEnv: 'CLAUDE_TEAMMATES_UPDATE_CHECK',
})
```

- [ ] **Step 2:** Create `tests/migrate.test.mjs` with the fixtures and every case below. Run `node --test tests/migrate.test.mjs` and confirm each fails with `Cannot find module '../scripts/migrate.mjs'` — the only acceptable red before Step 3.

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { migrate, rewriteStoredName, BACKUP_SUFFIX, MIGRATION_STEPS } from '../scripts/migrate.mjs'
import { NAMES, LEGACY } from '../scripts/names.mjs'

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
// A clock a day ahead: every commit and file in a fresh fixture is stale against it, so the
// live-teammate refusal only fires in the test that asks for it.
const LATER = Date.now() + 24 * 60 * 60 * 1000
const quiet = () => {
  const out = []
  const err = []
  return { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, out, err }
}
const staleTouch = async () => ({ at: 0, floored: false })

async function withRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-migrate-'))
  try {
    git(root, ['init', '--quiet', '--initial-branch=main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    await writeFile(path.join(root, 'README'), 'x\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'initial'])
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// A repository the way claude-teammates 1.3.0 left it after a run: task branches, a claim ref,
// run state naming those branches, map notes, a tracked gate manifest, an untracked local config,
// and ignore lines for both.
async function plantLegacy(root) {
  const sha = git(root, ['rev-parse', 'HEAD']).trim()
  git(root, ['branch', 'teammates/r1/T1'])
  git(root, ['branch', 'teammates/r1/T2'])
  git(root, ['update-ref', 'refs/teammates/r1/T1', sha])
  const run = path.join(root, '.teammates', 'r1')
  await mkdir(path.join(run, 'reviews'), { recursive: true })
  await mkdir(path.join(root, '.teammates', 'index'), { recursive: true })
  await writeFile(path.join(run, 'plan.json'), `${JSON.stringify({ runId: 'r1', tasks: [{ id: 'T1', files: ['a'] }, { id: 'T2', files: ['b'] }] }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(run, 'status.json'), `${JSON.stringify({ tasks: { T1: { branch: 'teammates/r1/T1', brief: 'work on teammates/r1/T1 in .teammates/' } } }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(run, 'reviews', 'verdict.json'), `${JSON.stringify({ findingsPath: '.teammates/r1/reviews/1-correctness.json' })}\n`, 'utf8')
  await writeFile(path.join(root, '.teammates', 'index', 'k.json'), `${JSON.stringify({ runId: 'r1', taskId: 'T1', branch: 'teammates/r1/T1', worktree: '/w' })}\n`, 'utf8')
  await writeFile(path.join(run, 'map.md'), '<!-- teammates-map run=r1 sha=abc -->\nnotes\n', 'utf8')
  await writeFile(path.join(root, 'teammates.gate.json'), '{"phases":{}}\n', 'utf8')
  await writeFile(path.join(root, '.gitignore'), '.teammates/\nteammates.local.json\n', 'utf8')
  git(root, ['add', 'teammates.gate.json', '.gitignore'])
  git(root, ['commit', '--quiet', '-m', 'adopt'])
  await writeFile(path.join(root, 'teammates.local.json'), '{}\n', 'utf8')
  return sha
}

async function exists(p) {
  try { await lstat(p); return true } catch { return false }
}

// Every file outside .git with its bytes, plus every ref: a refusal must leave both identical.
async function snapshot(root) {
  const files = []
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else files.push([path.relative(root, full), await readFile(full, 'utf8')])
    }
  }
  await walk(root)
  return { files: files.sort(), refs: git(root, ['for-each-ref', '--format=%(refname) %(objectname)']) }
}

test('a repository with no legacy name is left alone and nothing is printed', async () => {
  await withRepo(async (root) => {
    const { io, out, err } = quiet()
    const before = await snapshot(root)
    assert.deepEqual(await migrate(root, { io, now: LATER, measureTouch: staleTouch }), { code: 0, migrated: false })
    assert.deepEqual(out, [])
    assert.deepEqual(err, [])
    assert.deepEqual(await snapshot(root), before)
  })
})

test('every legacy name is migrated, and the legacy spelling is gone afterwards', async () => {
  await withRepo(async (root) => {
    const sha = await plantLegacy(root)
    const { io, out } = quiet()
    assert.deepEqual(await migrate(root, { io, now: LATER, measureTouch: staleTouch }), { code: 0, migrated: true })
    assert.deepEqual(out, [])

    // Full refnames: a claim ref `refs/fleetmates/r1/T1` shares its short name with the branch, so
    // `%(refname:short)` prints `heads/fleetmates/r1/T1` to disambiguate.
    const branches = git(root, ['branch', '--list', '--format=%(refname)']).split('\n').filter(Boolean).map((r) => r.replace(/^refs\/heads\//, '')).sort()
    assert.deepEqual(branches, ['fleetmates/r1/T1', 'fleetmates/r1/T2', 'main'])
    assert.equal(git(root, ['for-each-ref', '--format=%(objectname)', 'refs/fleetmates/r1/T1']).trim(), sha)
    assert.equal(git(root, ['for-each-ref', 'refs/teammates/']).trim(), '')

    assert.equal(await exists(path.join(root, '.teammates')), false)
    const run = path.join(root, '.fleetmates', 'r1')
    const status = JSON.parse(await readFile(path.join(run, 'status.json'), 'utf8'))
    assert.equal(status.tasks.T1.branch, 'fleetmates/r1/T1')
    assert.equal(status.tasks.T1.brief, 'work on teammates/r1/T1 in .teammates/', 'free text is history and is not rewritten')
    const verdict = JSON.parse(await readFile(path.join(run, 'reviews', 'verdict.json'), 'utf8'))
    assert.equal(verdict.findingsPath, '.fleetmates/r1/reviews/1-correctness.json')
    const record = JSON.parse(await readFile(path.join(root, '.fleetmates', 'index', 'k.json'), 'utf8'))
    assert.equal(record.branch, 'fleetmates/r1/T1')
    assert.match(await readFile(path.join(run, 'map.md'), 'utf8'), /^<!-- fleetmates-map run=r1 sha=abc -->\n/)

    assert.equal(await exists(path.join(root, 'teammates.gate.json')), false)
    assert.equal(await exists(path.join(root, 'fleetmates.gate.json')), true)
    assert.match(git(root, ['status', '--porcelain']), /^R {2}teammates\.gate\.json -> fleetmates\.gate\.json$/m)
    assert.equal(await exists(path.join(root, 'fleetmates.local.json')), true)
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)

    const ignore = (await readFile(path.join(root, '.gitignore'), 'utf8')).split('\n')
    assert.ok(ignore.includes('.fleetmates/'))
    assert.ok(ignore.includes('fleetmates.local.json'))
    assert.ok(ignore.includes('.teammates/'), 'the legacy ignore line stays; removing it is not this step')

    const leftovers = (await readdir(path.join(root, '.fleetmates'), { recursive: true })).filter((f) => f.endsWith(BACKUP_SUFFIX))
    assert.deepEqual(leftovers, [], 'backups are removed once every step succeeded')
  })
})

test('a second run after a successful migration does nothing', async () => {
  await withRepo(async (root) => {
    await plantLegacy(root)
    await migrate(root, { io: quiet().io, now: LATER, measureTouch: staleTouch })
    const before = await snapshot(root)
    const { io, out, err } = quiet()
    assert.deepEqual(await migrate(root, { io, now: LATER, measureTouch: staleTouch }), { code: 0, migrated: false })
    assert.deepEqual([...out, ...err], [])
    assert.deepEqual(await snapshot(root), before)
  })
})

test('a worktree checked out on a legacy task branch follows it to the new name', async () => {
  await withRepo(async (root) => {
    await plantLegacy(root)
    const wt = await mkdtemp(path.join(tmpdir(), 'fm-migrate-wt-'))
    try {
      git(root, ['worktree', 'add', '--quiet', path.join(wt, 'a1'), 'teammates/r1/T1'])
      assert.equal((await migrate(root, { io: quiet().io, now: LATER, measureTouch: staleTouch })).code, 0)
      assert.equal(git(path.join(wt, 'a1'), ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/fleetmates/r1/T1')
    } finally {
      git(root, ['worktree', 'remove', '--force', path.join(wt, 'a1')])
      await rm(wt, { recursive: true, force: true })
    }
  })
})

test('a worktree registered under the legacy state directory is repaired, not left prunable', async () => {
  await withRepo(async (root) => {
    await plantLegacy(root)
    git(root, ['worktree', 'add', '--quiet', path.join(root, '.teammates', 'r1', 'wt'), 'teammates/r1/T2'])
    assert.equal((await migrate(root, { io: quiet().io, now: LATER, measureTouch: staleTouch })).code, 0)
    const listing = git(root, ['worktree', 'list', '--porcelain'])
    assert.doesNotMatch(listing, /^prunable/m)
    assert.match(listing, /\.fleetmates[\\/]r1[\\/]wt/)
    assert.equal(git(path.join(root, '.fleetmates', 'r1', 'wt'), ['symbolic-ref', 'HEAD']).trim(), 'refs/heads/fleetmates/r1/T2')
  })
})

test('.gitignore gains a new line only where the legacy line was', async () => {
  await withRepo(async (root) => {
    await plantLegacy(root)
    await writeFile(path.join(root, '.gitignore'), '/.teammates/\n', 'utf8')
    await migrate(root, { io: quiet().io, now: LATER, measureTouch: staleTouch })
    const lines = (await readFile(path.join(root, '.gitignore'), 'utf8')).split('\n').filter(Boolean)
    assert.deepEqual(lines, ['/.teammates/', '/.fleetmates/'])
  })
})

test('both spellings present is refused with exit 2 and nothing changes', async () => {
  await withRepo(async (root) => {
    await plantLegacy(root)
    await mkdir(path.join(root, '.fleetmates'))
    const before = await snapshot(root)
    const { io, out } = quiet()
    assert.deepEqual(await migrate(root, { io, now: LATER, measureTouch: staleTouch }), { code: 2, migrated: false })
    assert.match(out.join('\n'), /\.teammates and \.fleetmates both exist/)
    assert.deepEqual(await snapshot(root), before)
  })
})

test('a live teammate is refused with exit 2, named, and nothing changes', async () => {
  await withRepo(async (root) => {
    await plantLegacy(root)
    const before = await snapshot(root)
    const { io, out } = quiet()
    // The task branches were committed seconds ago, so against the real clock both tips are fresh.
    assert.deepEqual(await migrate(root, { io, now: Date.now(), measureTouch: staleTouch }), { code: 2, migrated: false })
    assert.match(out.join('\n'), /r1\/T1/)
    assert.match(out.join('\n'), /while teammates are live/)
    assert.deepEqual(await snapshot(root), before)
  })
})

test('a walk that stopped early counts as live, because the teammate may be working', async () => {
  await withRepo(async (root) => {
    await plantLegacy(root)
    git(root, ['worktree', 'add', '--quiet', path.join(root, '.teammates', 'r1', 'wt'), 'teammates/r1/T2'])
    const capped = async () => ({ at: 0, floored: true })
    const { io, out } = quiet()
    assert.equal((await migrate(root, { io, now: LATER, measureTouch: capped })).code, 2)
    assert.match(out.join('\n'), /r1\/T2/)
  })
})

for (const [index, step] of MIGRATION_STEPS.entries()) {
  test(`a failure at step ${step} stops there with exit 4 and says how to reverse what ran`, async () => {
    await withRepo(async (root) => {
      await plantLegacy(root)
      const { io, out } = quiet()
      const beforeStep = async (name) => { if (name === step) throw new Error(`injected at ${name}`) }
      assert.deepEqual(await migrate(root, { io, now: LATER, measureTouch: staleTouch, beforeStep }), { code: 4, migrated: false })
      const text = out.join('\n')
      assert.match(text, new RegExp(`stopped at step ${step}: injected at ${step}`))
      if (index === 0) assert.match(text, /nothing had been changed yet/)
      else assert.match(text, /how to reverse it/)
      // The step after the failed one never ran.
      if (step === 'state-dir') assert.equal(await exists(path.join(root, '.teammates')), true)
    })
  })
}

test('a failure after stored names were rewritten names the backup to restore', async () => {
  await withRepo(async (root) => {
    await plantLegacy(root)
    const { io, out } = quiet()
    const beforeStep = async (name) => { if (name === 'state-dir') throw new Error('injected') }
    await migrate(root, { io, now: LATER, measureTouch: staleTouch, beforeStep })
    const backup = path.join(root, '.teammates', 'r1', `status.json${BACKUP_SUFFIX}`)
    assert.match(await readFile(backup, 'utf8'), /"teammates\/r1\/T1"/)
    assert.match(out.join('\n'), /mv .*status\.json\.pre-fleetmates .*status\.json/)
  })
})

test('a re-run after a mid-way failure completes the migration', async () => {
  await withRepo(async (root) => {
    await plantLegacy(root)
    const beforeStep = async (name) => { if (name === 'manifests') throw new Error('injected') }
    assert.equal((await migrate(root, { io: quiet().io, now: LATER, measureTouch: staleTouch, beforeStep })).code, 4)
    assert.equal((await migrate(root, { io: quiet().io, now: LATER, measureTouch: staleTouch })).code, 0)
    assert.equal(await exists(path.join(root, 'fleetmates.gate.json')), true)
    assert.equal(await exists(path.join(root, '.fleetmates', 'r1', 'status.json')), true)
  })
})

test('a directory that is not a git repository still migrates its files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-migrate-nogit-'))
  try {
    await writeFile(path.join(root, 'teammates.gate.json'), '{}\n', 'utf8')
    assert.equal((await migrate(root, { io: quiet().io, now: LATER })).code, 0)
    assert.equal(await exists(path.join(root, 'fleetmates.gate.json')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('JSON inside a worktree registered under the state directory is project content and is not rewritten', async () => {
  await withRepo(async (root) => {
    await plantLegacy(root)
    const wt = path.join(root, '.teammates', 'r1', 'wt')
    git(root, ['worktree', 'add', '--quiet', wt, 'teammates/r1/T2'])
    await writeFile(path.join(wt, 'fixture.json'), '{"branch":"teammates/r1/T1"}\n', 'utf8')
    assert.equal((await migrate(root, { io: quiet().io, now: LATER, measureTouch: staleTouch })).code, 0)
    const moved = path.join(root, '.fleetmates', 'r1', 'wt', 'fixture.json')
    assert.equal(await readFile(moved, 'utf8'), '{"branch":"teammates/r1/T1"}\n')
  })
})

test('rewriteStoredName maps each legacy prefix and leaves other strings alone', () => {
  assert.equal(rewriteStoredName('teammates/r1/T1'), 'fleetmates/r1/T1')
  assert.equal(rewriteStoredName('refs/teammates/r1/T1'), 'refs/fleetmates/r1/T1')
  assert.equal(rewriteStoredName('.teammates/r1/reviews/x.json'), '.fleetmates/r1/reviews/x.json')
  assert.equal(rewriteStoredName('C:\\repo\\.teammates\\r1\\x.json'), 'C:\\repo\\.fleetmates\\r1\\x.json')
  assert.equal(rewriteStoredName('run/teammates/x'), 'run/teammates/x')
  assert.equal(rewriteStoredName('.teammatesX/y'), '.teammatesX/y')
  assert.equal(rewriteStoredName(7), 7)
})

test('names.mjs keeps the two spellings in step with each other', () => {
  assert.deepEqual(Object.keys(NAMES), Object.keys(LEGACY))
  for (const key of Object.keys(NAMES)) assert.notEqual(NAMES[key], LEGACY[key], key)
})
```

- [ ] **Step 3:** Create `scripts/migrate.mjs`.

```js
// Moves a repository from the claude-teammates spellings to the fleetmates ones, the first time
// any CLI command runs in it. `scripts/cli.mjs` calls `migrate` once per invocation, before any
// command reads a name; the stop-time hook never does, because it fires inside running teammates.
//
// It refuses rather than acts when a teammate may still be running under the old names, and it
// never retries: a failure stops at the step that failed and prints how to reverse every step
// that ran. See docs/specs/2026-09-13-fleetmates-rename-design.md, section 2.
import { execFile } from 'node:child_process'
import { copyFile, lstat, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureGitignored } from './config.mjs'
import { DEFAULT_STALE_MINUTES, livenessRows } from './liveness.mjs'
import { LEGACY, NAMES } from './names.mjs'
import { printable } from './reviews.mjs'

export const BACKUP_SUFFIX = '.pre-fleetmates'
export const MIGRATION_STEPS = Object.freeze(['branches', 'claim-refs', 'stored-names', 'state-dir', 'manifests', 'gitignore'])

// Only these keys name something the code resolves. Free text — briefs, prompts, findings — is a
// record of what was said at the time and is left as it was written.
const REWRITE_KEYS = new Set(['branch', 'findingsPath', 'verdictFile', 'file'])

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const STATE_SEGMENT = new RegExp(`(^|[\\\\/])${escapeRegExp(LEGACY.stateDir)}(?=[\\\\/]|$)`, 'g')

function runGit(root, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

async function git(root, args) {
  const result = await runGit(root, args)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} exited ${result.code}: ${result.stderr.trim()}`)
  return result.stdout
}

async function exists(p) {
  try {
    await lstat(p)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

// For the reverse commands only: they are printed for an operator to paste into a POSIX shell.
const shellQuote = (s) => (/^[\w./@:+=-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)

export function rewriteStoredName(value) {
  if (typeof value !== 'string') return value
  let next = value
  if (next.startsWith(`${LEGACY.refPrefix}/`)) next = `${NAMES.refPrefix}/${next.slice(LEGACY.refPrefix.length + 1)}`
  else if (next.startsWith(`${LEGACY.branchPrefix}/`)) next = `${NAMES.branchPrefix}/${next.slice(LEGACY.branchPrefix.length + 1)}`
  return next.replace(STATE_SEGMENT, `$1${NAMES.stateDir}`)
}

// `Object.fromEntries`, not assignment: a planted `"__proto__"` key in agent-written JSON is an
// own property after JSON.parse, and assigning it onto `{}` would set the prototype instead.
function rewriteStoredNames(node) {
  if (Array.isArray(node)) return node.map(rewriteStoredNames)
  if (node === null || typeof node !== 'object') return node
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [
    key,
    REWRITE_KEYS.has(key) && typeof value === 'string' ? rewriteStoredName(value) : rewriteStoredNames(value),
  ]))
}

const renamedBranch = (name) => `${NAMES.branchPrefix}/${name.slice(LEGACY.branchPrefix.length + 1)}`
const renamedRef = (ref) => `${NAMES.refPrefix}/${ref.slice(LEGACY.refPrefix.length + 1)}`

async function filesUnder(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    // Links are not followed: a planted link would otherwise have this rewrite files outside the
    // state directory.
    if (entry.isSymbolicLink()) continue
    // Nor is a worktree registered inside it: that is someone's checkout, and its JSON files are
    // project content, not run state.
    if (entry.isDirectory() && await exists(path.join(full, '.git'))) continue
    if (entry.isDirectory()) found.push(...await filesUnder(full))
    else if (entry.isFile()) found.push(full)
  }
  return found
}

async function listWorktrees(root) {
  const result = await runGit(root, ['worktree', 'list', '--porcelain'])
  if (result.code !== 0) return []
  const entries = []
  let current = null
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null }
      entries.push(current)
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  return entries
}

function isUnder(child, parent) {
  const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  const rel = path.relative(fold(parent), fold(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export async function legacyInventory(root) {
  const refs = await runGit(root, [
    'for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${LEGACY.branchPrefix}/`, `${LEGACY.refPrefix}/`,
  ])
  const branches = []
  const claimRefs = []
  if (refs.code === 0) {
    for (const line of refs.stdout.split(/\r?\n/)) {
      const space = line.lastIndexOf(' ')
      if (space === -1) continue
      const ref = line.slice(0, space)
      const sha = line.slice(space + 1)
      if (ref.startsWith(`refs/heads/${LEGACY.branchPrefix}/`)) branches.push({ name: ref.slice('refs/heads/'.length), sha })
      else if (ref.startsWith(`${LEGACY.refPrefix}/`)) claimRefs.push({ ref, sha })
    }
  }
  return {
    gitRepo: refs.code === 0,
    stateDir: await exists(path.join(root, LEGACY.stateDir)),
    gateFile: await exists(path.join(root, LEGACY.gateFile)),
    localFile: await exists(path.join(root, LEGACY.localFile)),
    branches,
    claimRefs,
  }
}

const nothingLegacy = (inv) => !inv.stateDir && !inv.gateFile && !inv.localFile && inv.branches.length === 0 && inv.claimRefs.length === 0

async function conflicts(root, inv) {
  const found = []
  for (const [present, legacy, current] of [
    [inv.stateDir, LEGACY.stateDir, NAMES.stateDir],
    [inv.gateFile, LEGACY.gateFile, NAMES.gateFile],
    [inv.localFile, LEGACY.localFile, NAMES.localFile],
  ]) {
    if (present && await exists(path.join(root, current))) found.push(`${legacy} and ${current} both exist`)
  }
  for (const { name } of inv.branches) {
    const target = renamedBranch(name)
    if ((await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`])).code === 0) {
      found.push(`branches ${printable(name)} and ${printable(target)} both exist`)
    }
  }
  for (const { ref } of inv.claimRefs) {
    const target = renamedRef(ref)
    if ((await runGit(root, ['rev-parse', '--verify', '--quiet', target])).code === 0) {
      found.push(`refs ${printable(ref)} and ${printable(target)} both exist`)
    }
  }
  return found
}

// The same two signals `cli.mjs liveness` gathers, over EVERY task of every legacy run: `migrate`
// cannot derive the current phase, and a wider net can only refuse more.
async function liveTasks(root, { measureTouch, now, staleMinutes }) {
  const stateDir = path.join(root, LEGACY.stateDir)
  const byBranch = new Map((await listWorktrees(root)).filter((w) => w.branch).map((w) => [w.branch, w.path]))
  const live = []
  for (const entry of await readdir(stateDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let plan
    try {
      plan = JSON.parse(await readFile(path.join(stateDir, entry.name, 'plan.json'), 'utf8'))
    } catch {
      continue
    }
    const tasks = (Array.isArray(plan?.tasks) ? plan.tasks : []).filter((t) => typeof t?.id === 'string')
    const tips = {}
    const touches = {}
    for (const task of tasks) {
      const branch = `${LEGACY.branchPrefix}/${entry.name}/${task.id}`
      const tip = await runGit(root, ['log', '-1', '--format=%ct', `refs/heads/${branch}`, '--'])
      if (tip.code === 0 && tip.stdout.trim() !== '') tips[task.id] = { branch, at: Number(tip.stdout.trim()) * 1000 }
      const dir = byBranch.get(branch)
      if (dir && measureTouch) {
        const walked = await measureTouch(dir).catch(() => ({ at: null, floored: false }))
        touches[task.id] = { branch, at: walked.at, floored: walked.floored === true }
      }
    }
    for (const row of livenessRows({ tasks, tips, touches, now, staleMinutes })) {
      if (row.state === 'working' || row.unknownReason === 'walk-capped') live.push(`${printable(entry.name)}/${printable(row.taskId)}`)
    }
  }
  return live
}

export async function migrate(root, {
  io = { out: console.log, err: console.error },
  measureTouch = null,
  now = Date.now(),
  staleMinutes = DEFAULT_STALE_MINUTES,
  // A TEST SEAM and nothing else: production callers never pass it. It is how each step's
  // failure path is reached without breaking git or the filesystem for real.
  beforeStep = async () => {},
} = {}) {
  root = path.resolve(root)
  const inv = await legacyInventory(root)
  if (nothingLegacy(inv)) return { code: 0, migrated: false }

  const clash = await conflicts(root, inv)
  if (clash.length > 0) {
    io.out(`cannot migrate ${LEGACY.product} names to ${NAMES.product}: ${clash.join('; ')}. Remove or merge one of each pair by hand, then re-run.`)
    return { code: 2, migrated: false }
  }
  if (inv.stateDir) {
    const live = await liveTasks(root, { measureTouch, now, staleMinutes })
    if (live.length > 0) {
      io.out(`cannot migrate ${LEGACY.product} names to ${NAMES.product} while teammates are live: ${live.join(', ')}. `
        + `A teammate on the old plugin keeps writing to ${LEGACY.stateDir}/ after the move, which splits its run. `
        + `Wait until they go stale (${staleMinutes} minutes with no commit and no file write) or stop the fleet, then re-run.`)
      return { code: 2, migrated: false }
    }
  }

  const done = []
  const record = (did, undo) => {
    done.push({ did, undo })
    io.err(`  ${did}`)
  }
  const legacyState = path.join(root, LEGACY.stateDir)
  const currentState = path.join(root, NAMES.stateDir)
  const rel = (p) => path.relative(root, p).split(path.sep).join('/')

  const steps = {
    branches: async () => {
      for (const { name } of inv.branches) {
        const target = renamedBranch(name)
        await git(root, ['branch', '-m', name, target])
        record(`branch ${printable(name)} -> ${printable(target)}`, `git branch -m ${shellQuote(target)} ${shellQuote(name)}`)
      }
    },
    'claim-refs': async () => {
      for (const { ref, sha } of inv.claimRefs) {
        const target = renamedRef(ref)
        await git(root, ['update-ref', target, sha, ''])
        await git(root, ['update-ref', '-d', ref, sha])
        record(`ref ${printable(ref)} -> ${printable(target)}`, `git update-ref ${shellQuote(ref)} ${sha} && git update-ref -d ${shellQuote(target)} ${sha}`)
      }
    },
    'stored-names': async () => {
      if (!inv.stateDir) return
      for (const file of await filesUnder(legacyState)) {
        if (file.endsWith(BACKUP_SUFFIX)) continue
        const text = await readFile(file, 'utf8')
        let next = null
        if (file.endsWith('.json')) {
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            continue
          }
          const rewritten = rewriteStoredNames(parsed)
          if (JSON.stringify(rewritten) !== JSON.stringify(parsed)) {
            next = /\n\s/.test(text.trim()) ? `${JSON.stringify(rewritten, null, 2)}\n` : `${JSON.stringify(rewritten)}\n`
          }
        } else if (path.basename(file) === 'map.md' && text.startsWith(`<!-- ${LEGACY.mapHeader} `)) {
          next = `<!-- ${NAMES.mapHeader} ${text.slice(`<!-- ${LEGACY.mapHeader} `.length)}`
        }
        if (next === null) continue
        const backup = `${file}${BACKUP_SUFFIX}`
        if (!await exists(backup)) await copyFile(file, backup)
        const tmp = `${file}.${process.pid}.tmp`
        await writeFile(tmp, next, 'utf8')
        await rename(tmp, file)
        record(`rewrote stored names in ${printable(rel(file))}`, `mv ${shellQuote(rel(backup))} ${shellQuote(rel(file))}`)
      }
    },
    'state-dir': async () => {
      if (!inv.stateDir) return
      const realState = await realpath(legacyState)
      const inside = (await listWorktrees(root)).filter((w) => isUnder(w.path, realState))
      await rename(legacyState, currentState)
      const repairBack = inside.map((w) => ` && git worktree repair ${shellQuote(w.path)}`).join('')
      record(`moved ${LEGACY.stateDir}/ -> ${NAMES.stateDir}/`, `mv ${NAMES.stateDir} ${LEGACY.stateDir}${repairBack}`)
      for (const w of inside) {
        const moved = path.join(currentState, path.relative(realState, path.resolve(w.path)))
        await git(root, ['worktree', 'repair', moved])
        record(`repaired worktree ${printable(rel(moved))}`, '(reversed by the state directory line below)')
      }
    },
    manifests: async () => {
      for (const [present, legacy, current] of [
        [inv.gateFile, LEGACY.gateFile, NAMES.gateFile],
        [inv.localFile, LEGACY.localFile, NAMES.localFile],
      ]) {
        if (!present) continue
        const tracked = inv.gitRepo && (await runGit(root, ['ls-files', '--error-unmatch', '--', legacy])).code === 0
        if (tracked) {
          await git(root, ['mv', '--', legacy, current])
          record(`git mv ${legacy} ${current}`, `git mv ${current} ${legacy}`)
        } else {
          await rename(path.join(root, legacy), path.join(root, current))
          record(`moved ${legacy} -> ${current}`, `mv ${current} ${legacy}`)
        }
      }
    },
    gitignore: async () => {
      let text = ''
      try {
        text = await readFile(path.join(root, '.gitignore'), 'utf8')
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        const bare = trimmed.replace(/^\//, '').replace(/\/$/, '')
        let replacement = null
        if (bare === LEGACY.stateDir) replacement = trimmed.replace(LEGACY.stateDir, NAMES.stateDir)
        else if (bare === LEGACY.localFile) replacement = trimmed.replace(LEGACY.localFile, NAMES.localFile)
        if (replacement && await ensureGitignored(root, replacement)) {
          record(`added ${replacement} to .gitignore`, `remove the line ${replacement} from .gitignore`)
        }
      }
    },
  }

  io.err(`migrating ${LEGACY.product} names to ${NAMES.product} in ${printable(root)}`)
  for (const name of MIGRATION_STEPS) {
    try {
      await beforeStep(name)
      await steps[name]()
    } catch (err) {
      io.out(`migration to ${NAMES.product} stopped at step ${name}: ${printable(err.message)}`)
      if (done.length === 0) {
        io.out('nothing had been changed yet.')
      } else {
        io.out('already done, and how to reverse it (from the repository root, in this order):')
        for (const step of [...done].reverse()) io.out(`  ${step.undo}    # undoes: ${step.did}`)
      }
      return { code: 4, migrated: false }
    }
  }

  // Backups are only kept while a failure could still need them. Every one left from this or an
  // earlier interrupted attempt now sits under the new state directory.
  if (await exists(currentState)) {
    for (const file of await filesUnder(currentState)) {
      if (file.endsWith(BACKUP_SUFFIX)) await unlink(file).catch(() => {})
    }
  }
  return { code: 0, migrated: true }
}
```

- [ ] **Step 4:** Run `node --test tests/migrate.test.mjs` until green, then `npm test` for the whole suite.
- [ ] **Step 5:** Commit: `feat(migrate): names module and the claude-teammates to fleetmates auto-migration`.

### Task 2: release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Test: `tests/release-workflow.test.mjs`

**Model:** cheap

- [ ] **Step 1:** Create `tests/release-workflow.test.mjs` and watch it fail with ENOENT on `release.yml`.

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8')

test('release runs on a version tag and nowhere else', async () => {
  const yml = await read('.github/workflows/release.yml')
  assert.match(yml, /^on:\n {2}push:\n {4}tags: \['v\*'\]\n/m)
  assert.doesNotMatch(yml, /pull_request|branches:/)
})

test('publish needs the full test matrix, the same one test.yml runs', async () => {
  const [release, tests] = await Promise.all([read('.github/workflows/release.yml'), read('.github/workflows/test.yml')])
  const matrix = (text) => text.match(/os: \[([^\]]+)\]/)?.[1]
  assert.equal(matrix(release), matrix(tests))
  assert.match(release, /publish:\n(?: {4}.*\n)*? {4}needs: test\n/)
})

test('publish authenticates by OIDC with no token secret', async () => {
  const yml = await read('.github/workflows/release.yml')
  assert.match(yml, /id-token: write/)
  assert.doesNotMatch(yml, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./)
  assert.match(yml, /npm publish --provenance --access public/)
})

test('publish refuses a tag that does not match package.json, and an npm too old for trusted publishing', async () => {
  const yml = await read('.github/workflows/release.yml')
  assert.match(yml, /"\$\{GITHUB_REF_NAME\}" != "v\$\{version\}"/)
  assert.match(yml, /11\.5\.1/)
})

test('a version already on npm is reported and skipped, not failed', async () => {
  const yml = await read('.github/workflows/release.yml')
  assert.match(yml, /npm view "fleetmates@\$\{VERSION\}" version/)
  assert.match(yml, /is already on npm — nothing to publish/)
})
```

- [ ] **Step 2:** Create `.github/workflows/release.yml`.

```yaml
name: release

on:
  push:
    tags: ['v*']

jobs:
  test:
    # The same matrix as test.yml: a tag is a release, and a release is the one push whose
    # platform bugs reach users before anyone reads a PR.
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - name: Configure git identity
        run: |
          git config --global user.email "test@example.com"
          git config --global user.name "CI"
      - run: npm test

  publish:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      # npm trusted publishing: the registry exchanges this job's OIDC token for a short-lived
      # publish credential. No npm token exists anywhere to leak or rotate.
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          registry-url: 'https://registry.npmjs.org'
      - name: Tag must match package.json version
        run: |
          version=$(node -p "require('./package.json').version")
          if [ "${GITHUB_REF_NAME}" != "v${version}" ]; then
            echo "tag ${GITHUB_REF_NAME} does not match package.json version ${version}"
            exit 1
          fi
          echo "VERSION=${version}" >> "$GITHUB_ENV"
      - name: npm must support trusted publishing (11.5.1 or later)
        run: |
          npm_version=$(npm --version)
          echo "npm ${npm_version}"
          node -e 'const [a, b, c] = process.argv[1].split(".").map(Number); process.exit(a > 11 || (a === 11 && (b > 5 || (b === 5 && c >= 1))) ? 0 : 1)' "${npm_version}"
      - name: Publish unless this version is already on npm
        run: |
          if [ "$(npm view "fleetmates@${VERSION}" version 2>/dev/null)" = "${VERSION}" ]; then
            echo "fleetmates@${VERSION} is already on npm — nothing to publish"
            exit 0
          fi
          npm publish --provenance --access public
```

- [ ] **Step 3:** `node --test tests/release-workflow.test.mjs` green, then `npm test`.
- [ ] **Step 4:** Commit: `ci(release): publish to npm on a version tag through trusted publishing`.

### Task 3: hooks read npm and warn about a leftover claude-teammates install

**Files:**
- Modify: `hooks/update-check`
- Modify: `hooks/session-start`
- Test: `tests/hook.test.mjs`

**Model:** mid

`hooks/session-start` lines 8, 26 and 28 name the `using-teammates` skill; they belong to Task 5, which renames that skill. Leave them. Every other product-name string in the two hooks changes here.

- [ ] **Step 1:** In `tests/hook.test.mjs`, change the `stateDir` helper (currently `return path.join(configDir, 'claude-teammates')`) to `return path.join(configDir, 'fleetmates')`; change the notice assertions `claude-teammates ${installedVersion} is active` to `fleetmates ${installedVersion} is active` and `/\/plugin update claude-teammates/` to `/\/plugin update fleetmates/`. Then add these tests immediately above the `// Registered LAST on purpose.` comment — the `(mechanism)` test below it must stay the last registration, and every `hookTest` body must end with `hookBodyRan()` or that test fails. Also add, beside the existing `update-check makes no request and writes nothing when opted out` test, the same test run with `{ FLEETMATES_UPDATE_CHECK: 'off' }`. Run `node --test tests/hook.test.mjs` to watch the changed and new ones fail on the old strings and the missing warning.

```js
const legacyPluginsFile = (configDir) => path.join(configDir, 'plugins', 'installed_plugins.json')

hookTest('a claude-teammates install left beside fleetmates is warned about', () => {
  withConfigDir((dir) => {
    mkdirSync(path.join(dir, 'plugins'), { recursive: true })
    writeFileSync(legacyPluginsFile(dir), JSON.stringify({ version: 2, plugins: { 'claude-teammates@claude-teammates': [{}] } }))
    const ctx = contextWith(dir)
    assert.match(ctx, /claude-teammates is still installed alongside fleetmates/)
    assert.match(ctx, /\/plugin uninstall claude-teammates/)
  })
  hookBodyRan()
})

hookTest('no installed-plugins file, or one without claude-teammates, means no warning', () => {
  withConfigDir((dir) => {
    assert.doesNotMatch(contextWith(dir), /still installed alongside/)
    mkdirSync(path.join(dir, 'plugins'), { recursive: true })
    writeFileSync(legacyPluginsFile(dir), JSON.stringify({ version: 2, plugins: { 'fleetmates@fleetmates': [{}] } }))
    assert.doesNotMatch(contextWith(dir), /still installed alongside/)
  })
  hookBodyRan()
})

test('update-check asks the npm registry for fleetmates by default', () => {
  const text = readFileSync(updateCheckScript, 'utf8')
  assert.match(text, /RAW_URL="\$\{1:-https:\/\/registry\.npmjs\.org\/fleetmates\/latest\}"/)
  assert.doesNotMatch(text, /raw\.githubusercontent\.com/)
})

test('both the new and the old opt-out variable switch the update check off', () => {
  const text = readFileSync(updateCheckScript, 'utf8')
  assert.match(text, /\$\{FLEETMATES_UPDATE_CHECK:-\$\{CLAUDE_TEAMMATES_UPDATE_CHECK:-1\}\}/)
})
```

Import `mkdirSync` from `node:fs` at the top if the file does not already.

- [ ] **Step 2:** In `hooks/update-check`: header comment line 2 becomes `# Async SessionStart hook: checks whether a newer fleetmates is published.`; both `STATE_DIR` assignments end in `/fleetmates`; line 32 becomes `RAW_URL="${1:-https://registry.npmjs.org/fleetmates/latest}"`; replace the opt-out block with the one below. The `grep` for `"version"` still works: the registry's `latest` document is flat JSON whose first `"version"` key is the package version.

```bash
# Opt-out is checked first, before anything else: a disabled install makes no
# request at all, rather than making one and discarding the result. The old
# variable is still read: a rename must never switch a network call back on for
# someone who turned it off.
# legacy-name:begin
case "${FLEETMATES_UPDATE_CHECK:-${CLAUDE_TEAMMATES_UPDATE_CHECK:-1}}" in
  0|false|no|off) exit 0 ;;
esac
# legacy-name:end
```

- [ ] **Step 3:** In `hooks/session-start`: line 2's comment says `fleetmates`; both `STATE_DIR` assignments end in `/fleetmates`; the notices read `fleetmates updated: …`, `fleetmates ${installed} is active`, `Release notes: https://github.com/andreymudri/fleetmates/releases/tag/v${installed}`, `fleetmates ${published} is available (installed: ${installed}). Run /plugin update fleetmates`; the broken-install lines read `WARNING: fleetmates is installed but NOT fully working. …` and `… Reinstall with /plugin install fleetmates, …`. Insert this block immediately above `# Output context injection as JSON.`:

```bash
# A claude-teammates install left enabled beside this one runs its own SessionStart and
# SubagentStop hooks too: two entrypoints injected, and an old stop hook looking for
# .teammates/ after fleetmates has migrated it to .fleetmates/. Repeated every session,
# like the broken-install warning, because it stays true until the operator acts.
# `-f`, not `-r`: a FIFO planted at that path would block this synchronous hook forever.
# legacy-name:begin
PLUGINS_FILE=""
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    PLUGINS_FILE="${CLAUDE_CONFIG_DIR}/plugins/installed_plugins.json"
elif [ -n "${HOME:-}" ]; then
    PLUGINS_FILE="${HOME}/.claude/plugins/installed_plugins.json"
fi
if [ -n "${PLUGINS_FILE}" ] && [ -f "${PLUGINS_FILE}" ] && grep -q '"claude-teammates@' "${PLUGINS_FILE}" 2>/dev/null; then
    legacy_warning="WARNING: claude-teammates is still installed alongside fleetmates. Both plugins' hooks run every session and at every teammate stop, and the old ones look for .teammates/ after fleetmates has moved it. Run /plugin uninstall claude-teammates."
    session_context="${session_context}\n\n$(escape_for_json "${legacy_warning}")"
fi
# legacy-name:end
```

- [ ] **Step 4:** `node --test tests/hook.test.mjs` green, then `npm test`.
- [ ] **Step 5:** Commit: `feat(hooks): check npm for updates and warn about a leftover claude-teammates install`.

### Task 4: package, plugin and marketplace manifests

**Files:**
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `tests/harness.test.mjs`
- Modify: `tests/packaging.test.mjs`
- Test: `tests/pack.test.mjs`

**Model:** cheap

- [ ] **Step 1:** In `tests/harness.test.mjs` change `assert.equal(manifest.name, 'claude-teammates')` to `assert.equal(manifest.name, 'fleetmates')`. In `tests/packaging.test.mjs`, in `marketplace manifest names the same plugin as plugin.json`, replace `assert.equal(entry.source, './')` with `assert.deepEqual(entry.source, { source: 'npm', package: 'fleetmates' })` and add `assert.equal(marketplace.name, 'fleetmates')`. Create `tests/pack.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// A shell string on purpose: `npm` is `npm.cmd` on Windows, which execFile cannot start. Nothing
// in the string comes from outside this file.
const packed = () => {
  const out = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return JSON.parse(out)[0]
}

test('the npm package is fleetmates at the plugin manifest version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const plugin = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'fleetmates')
  assert.equal(plugin.name, 'fleetmates')
  assert.equal(pkg.version, plugin.version)
})

test('the package carries the plugin and nothing that only develops it', () => {
  const paths = packed().files.map((f) => f.path)
  for (const required of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/session-start', 'hooks/update-check', 'hooks/run-hook.cmd', 'scripts/cli.mjs', 'templates/phase-workflow.js', 'LICENSE', 'NOTICE.md']) {
    assert.ok(paths.includes(required), `package is missing ${required}`)
  }
  const skills = readdirSync(new URL('../skills/', import.meta.url), { withFileTypes: true }).filter((e) => e.isDirectory())
  for (const skill of skills) assert.ok(paths.includes(`skills/${skill.name}/SKILL.md`), `package is missing skills/${skill.name}/SKILL.md`)
  assert.deepEqual(paths.filter((p) => p.startsWith('tests/') || p.startsWith('docs/') || p.startsWith('.github/')), [])
})
```

Run `node --test tests/harness.test.mjs tests/packaging.test.mjs tests/pack.test.mjs` and watch each changed assertion fail on the old name, source, and on `tests/`/`docs/` being in the pack.

- [ ] **Step 2:** `package.json`: set `"name": "fleetmates"`, `"version": "2.0.0"`, `"homepage": "https://github.com/andreymudri/fleetmates#readme"`, `"repository": { "type": "git", "url": "git+https://github.com/andreymudri/fleetmates.git" }`, `"bugs": { "url": "https://github.com/andreymudri/fleetmates/issues" }`, and add after `"keywords"`:

```json
  "files": [
    ".claude-plugin/",
    "agents/",
    "hooks/",
    "scripts/",
    "skills/",
    "templates/",
    "README.md",
    "LICENSE",
    "LICENSE-THIRD-PARTY",
    "NOTICE.md",
    "CHANGELOG.md"
  ],
```

- [ ] **Step 3:** `.claude-plugin/plugin.json`: `"name": "fleetmates"`, `"version": "2.0.0"`, `"homepage": "https://github.com/andreymudri/fleetmates"`, `"repository": "https://github.com/andreymudri/fleetmates"`.
- [ ] **Step 4:** `.claude-plugin/marketplace.json`:

```json
{
  "name": "fleetmates",
  "owner": {
    "name": "andreymudri"
  },
  "plugins": [
    {
      "name": "fleetmates",
      "source": {
        "source": "npm",
        "package": "fleetmates"
      },
      "description": "Runs a written plan across background teammates, each in its own git worktree, with an automated gate between phases: brainstorming, planning, TDD, debugging, parallel execution, and supervision."
    }
  ]
}
```

- [ ] **Step 5:** The three test files green, then `npm test`.
- [ ] **Step 6:** Commit: `build(package): publish as fleetmates 2.0.0 from npm`.

### Task 5: rename every identifier and wire the migration into the CLI

**Files:**
- Modify: `scripts/brief.mjs`
- Modify: `scripts/cli.mjs`
- Modify: `scripts/config.mjs`
- Modify: `scripts/doctor.mjs`
- Modify: `scripts/enforce.mjs`
- Modify: `scripts/fix-loop.mjs`
- Modify: `scripts/gate-config.mjs`
- Modify: `scripts/gate-runner.mjs`
- Modify: `scripts/git.mjs`
- Modify: `scripts/mapnotes.mjs`
- Modify: `scripts/preview-links.mjs`
- Modify: `scripts/prune.mjs`
- Modify: `scripts/rebuild.mjs`
- Modify: `scripts/review-gen.mjs`
- Modify: `scripts/state.mjs`
- Modify: `scripts/subagent-stop.mjs`
- Modify: `scripts/usage.mjs`
- Modify: `scripts/workflow-gen.mjs`
- Modify: `scripts/liveness.mjs`
- Modify: `hooks/session-start`
- Modify: `templates/phase-workflow.js`
- Modify: `agents/tm-implementer.md`
- Modify: `agents/tm-integrator.md`
- Modify: `agents/tm-reviewer.md`
- Modify: `skills/executing-plans/SKILL.md`
- Modify: `skills/finishing-a-development-branch/SKILL.md`
- Modify: `skills/fleet-lifecycle/SKILL.md`
- Modify: `skills/fleet-supervision/SKILL.md`
- Modify: `skills/parallel-execution/SKILL.md`
- Modify: `skills/phase-gate/SKILL.md`
- Modify: `skills/writing-plans/SKILL.md`
- Modify: `skills/teammates-config/SKILL.md`
- Create: `skills/fleetmates-config/SKILL.md`
- Modify: `skills/using-teammates/SKILL.md`
- Create: `skills/using-fleetmates/SKILL.md`
- Modify: `NOTICE.md`
- Modify: `jsconfig.json`
- Modify: `.gitignore`
- Modify: `teammates.gate.json`
- Create: `fleetmates.gate.json`
- Modify: `tests/adversarial.test.mjs`
- Modify: `tests/brief.test.mjs`
- Modify: `tests/cli.test.mjs`
- Modify: `tests/config.test.mjs`
- Modify: `tests/doctor.test.mjs`
- Modify: `tests/enforce.test.mjs`
- Modify: `tests/fix-loop.test.mjs`
- Modify: `tests/fixtures/teammates-config.SKILL.md`
- Create: `tests/fixtures/fleetmates-config.SKILL.md`
- Modify: `tests/gate-config.test.mjs`
- Modify: `tests/gate-runner.test.mjs`
- Modify: `tests/git.test.mjs`
- Modify: `tests/hook-mechanism.test.mjs`
- Modify: `tests/hook.test.mjs`
- Modify: `tests/liveness.test.mjs`
- Modify: `tests/mapnotes.test.mjs`
- Modify: `tests/md-contract.mjs`
- Modify: `tests/merge-preview.test.mjs`
- Modify: `tests/packaging.test.mjs`
- Modify: `tests/prune.test.mjs`
- Modify: `tests/review-gen.test.mjs`
- Modify: `tests/reviews.test.mjs`
- Modify: `tests/self-gate.test.mjs`
- Modify: `tests/skill-config.test.mjs`
- Modify: `tests/skill-contracts.test.mjs`
- Modify: `tests/skill-entrypoint.test.mjs`
- Modify: `tests/skill-executing-plans.test.mjs`
- Modify: `tests/skill-finishing-branch.test.mjs`
- Modify: `tests/skills.test.mjs`
- Modify: `tests/state.test.mjs`
- Modify: `tests/subagent-stop.test.mjs`
- Modify: `tests/usage-cli.test.mjs`
- Modify: `tests/usage-store.test.mjs`
- Modify: `tests/usage.test.mjs`
- Modify: `tests/workflow-gen.test.mjs`
- Test: `tests/names.test.mjs`
- Test: `tests/migrate-cli.test.mjs`

**Depends:** T1, T3, T4

**Model:** capable

- [ ] **Step 1:** Create `tests/names.test.mjs` and watch it fail, listing the legacy spellings still in `scripts/` and `hooks/`.

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// The two modules whose job is the legacy spelling.
const EXEMPT_FILES = new Set(['scripts/names.mjs', 'scripts/migrate.mjs'])

const LEGACY_SPELLINGS = [
  /claude-teammates/,
  /teammates\.(gate|local)\.(json|yaml)/,
  /(^|[^\w.-])\.teammates(?![\w-])/,
  /refs\/teammates\//,
  /(^|[`'"/\s(])teammates\/(\$\{|<|[\w-]+\/)/,
  /teammates-map/,
  /using-teammates|teammates-config/,
  /CLAUDE_TEAMMATES_/,
  /teammates-\$\{/,
]

// Comments go first, because the comment that explains a name is otherwise the use this test
// counts. JS: whole-line `//` and `*` lines, and a trailing ` // …` preceded by whitespace (so
// `https://` survives). Bash: whole-line `#`. A `legacy-name:begin` … `legacy-name:end` block is
// the sanctioned dual-read (the update-check opt-out and the old-plugin warning) and is skipped.
function codeLines(file, text) {
  const lines = text.split(/\r?\n/)
  const kept = []
  let skipping = false
  for (const [i, raw] of lines.entries()) {
    if (/legacy-name:begin/.test(raw)) { skipping = true; continue }
    if (/legacy-name:end/.test(raw)) { skipping = false; continue }
    if (skipping) continue
    const trimmed = raw.trim()
    if (file.endsWith('.mjs') || file.endsWith('.js')) {
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      kept.push([i + 1, raw.replace(/\s\/\/\s.*$/, '')])
    } else {
      if (trimmed.startsWith('#')) continue
      kept.push([i + 1, raw])
    }
  }
  return kept
}

function sources() {
  const found = []
  for (const dir of ['scripts', 'hooks']) {
    for (const name of readdirSync(path.join(root, dir))) {
      const rel = `${dir}/${name}`
      if (!EXEMPT_FILES.has(rel)) found.push(rel)
    }
  }
  return found
}

test('no legacy spelling is used as a name outside names.mjs and migrate.mjs', () => {
  const hits = []
  for (const rel of sources()) {
    const text = readFileSync(path.join(root, rel), 'utf8')
    for (const [line, code] of codeLines(rel, text)) {
      if (LEGACY_SPELLINGS.some((re) => re.test(code))) hits.push(`${rel}:${line}: ${code.trim()}`)
    }
  }
  assert.deepEqual(hits, [])
})

test('the scan would catch a legacy spelling, so the empty result above means something', () => {
  const planted = codeLines('scripts/x.mjs', "const dir = '.teammates'\n// '.teammates' in a comment\n")
  assert.equal(planted.length, 1)
  assert.ok(LEGACY_SPELLINGS.some((re) => re.test(planted[0][1])))
})
```

- [ ] **Step 2:** Route every definition in `scripts/` through `scripts/names.mjs`:
  - `scripts/config.mjs`: `import { NAMES } from './names.mjs'`; `export const GATE_FILE = NAMES.gateFile`; `export const LOCAL_FILE = NAMES.localFile`.
  - `scripts/gate-config.mjs`: `import { NAMES } from './names.mjs'`; `const MANIFEST = NAMES.gateFile`.
  - `scripts/enforce.mjs`: `import { NAMES } from './names.mjs'`; `taskBranchName` returns `` `${NAMES.branchPrefix}/${runId}/${taskId}` ``. Update the comment above it that says it "imports nothing": it now imports only `names.mjs`, which itself imports nothing.
  - `scripts/state.mjs`: `import { NAMES } from './names.mjs'`; every `path.join(root, '.teammates', …)` (lines 40, 272, 274, 301, 304, 323) uses `NAMES.stateDir`.
  - `scripts/git.mjs:750`: `` `${NAMES.refPrefix}/${runId}/${taskId}` `` with the import.
  - `scripts/prune.mjs:17`: `const TASK_BRANCH = new RegExp(`^${NAMES.branchPrefix}/([^/]+)/([^/]+)$`)`.
  - `scripts/mapnotes.mjs:17,21,35,71`: build `HEADER` as `new RegExp(`^<!--\\s*${NAMES.mapHeader}\\s+run=(\\S+)\\s+sha=(\\S+)\\s*-->`)`, emit `` `<!-- ${NAMES.mapHeader} run=${runId} sha=${sha} -->` ``, and say `${NAMES.mapHeader}` in both messages.
  - `scripts/review-gen.mjs:270`: `` agentType: `${NAMES.product}:tm-reviewer` ``; line 245 says `fleetmates run`.
  - `scripts/workflow-gen.mjs:52,53,61`: `` name: `${NAMES.branchPrefix}-${runId}-phase-${phase}` ``, description `of fleetmates run`, and `branch: taskBranchName(runId, id)` imported from `./enforce.mjs`.
  - `scripts/subagent-stop.mjs:222`: `found.branch ?? taskBranchName(found.runId, found.taskId)`.
  - `scripts/cli.mjs`: lines 2747 and 2749 use `NAMES.stateDir`; 2938, 3397 and 4587 interpolate `${NAMES.stateDir}`; 5082 says `${GATE_FILE}`.
  - `scripts/brief.mjs:258`, `scripts/gate-runner.mjs:660`, `scripts/preview-links.mjs:201`, `scripts/doctor.mjs:66`: interpolate `NAMES.gateFile` / `${NAMES.branchPrefix}/<runId>/<taskId>` instead of the literal.
  - Comments in these files and in `scripts/fix-loop.mjs`, `scripts/liveness.mjs`, `scripts/rebuild.mjs`, `scripts/usage.mjs` that name an identifier (`.teammates/`, `teammates.gate.json`, `teammates/<runId>/<taskId>`, `claude-teammates:…`) are updated to the new spelling; comments about teammates as a role are not.
- [ ] **Step 3:** Rename the two skills and the fixture with history kept: `git mv skills/using-teammates skills/using-fleetmates`, `git mv skills/teammates-config skills/fleetmates-config`, `git mv tests/fixtures/teammates-config.SKILL.md tests/fixtures/fleetmates-config.SKILL.md`, `git mv teammates.gate.json fleetmates.gate.json`. In each renamed `SKILL.md`, set the frontmatter `name:` to the new directory name.
- [ ] **Step 4:** Rewrite the identifiers in the remaining text files. Excluded:
  - `tests/migrate.test.mjs` and `tests/names.test.mjs`, which spell legacy names on purpose;
  - `tests/hook.test.mjs` and `hooks/session-start`, whose `legacy-name` blocks and Task 3 tests must keep the old spelling (Step 5 does them by hand);
  - `.gitignore`, because this repository still holds its own `.teammates/` runs until the new CLI migrates it after merge — replacing the line would un-ignore all of them (Step 5 adds the new lines beside the old).

```bash
git ls-files -z -- tests skills agents templates NOTICE.md jsconfig.json \
  ':!tests/migrate.test.mjs' ':!tests/names.test.mjs' ':!tests/hook.test.mjs' \
| xargs -0 perl -pi -e '
  s/claude-teammates/fleetmates/g;
  s/using-teammates/using-fleetmates/g;
  s/teammates-config/fleetmates-config/g;
  s/teammates\.(gate|local)\.(json|yaml)/fleetmates.$1.$2/g;
  s{refs/teammates/}{refs/fleetmates/}g;
  s/(?<![\w-])\.teammates(?![\w-])/.fleetmates/g;
  s/teammates-map/fleetmates-map/g;
  s{(?<![\w.-])teammates/(?=\$\{|<|[\w-]+/)}{fleetmates/}g;
  s/teammates-(?=\$\{|r1-|3f2a-)/fleetmates-/g;
  s/CLAUDE_TEAMMATES_UPDATE_CHECK/FLEETMATES_UPDATE_CHECK/g;
'
```

Then read `git diff --stat` and spot-check that no prose use of "teammates" as a role was changed.
- [ ] **Step 5:** By hand: `hooks/session-start` line 8 becomes `ENTRYPOINT="${PLUGIN_ROOT}/skills/using-fleetmates/SKILL.md"`, line 26 says `You have fleetmates.` and `'fleetmates:using-fleetmates' skill`, line 28 says `the fleetmates plugin` and `(skills/using-fleetmates/SKILL.md)`. In `tests/hook.test.mjs`, every remaining identifier from the name map takes the new spelling — including `/using-teammates/`, `/claude-teammates/i` and `/using-teammates\/SKILL\.md/` around lines 1083–1109 — EXCEPT inside the four tests Task 3 added (the two `claude-teammates@` warning tests and the two update-check source assertions), which must keep the legacy spelling they test for. In `.gitignore`, add `.fleetmates/` directly below `.teammates/` and `fleetmates.local.json` directly below `teammates.local.json`, keeping both old lines. `jsconfig.json` excludes `.fleetmates` (Step 4 rewrote it).
- [ ] **Step 6:** Create `tests/migrate-cli.test.mjs`, watch it fail (the CLI does not migrate yet), then wire the call into `runCli` in `scripts/cli.mjs`: `import { migrate } from './migrate.mjs'` at the top, and immediately before the `// runId and taskId become path segments under root/.fleetmates` block:

```js
  // Before any command reads a name: a repository claude-teammates left behind is moved to the
  // fleetmates spellings once, or the command refuses and says why. `newestMtime` is the same walk
  // `liveness` uses, so "a teammate is live" means the same thing in both places.
  const migration = await migrate(root, { io, measureTouch: (dir) => newestMtime(dir) })
  if (migration.code !== 0) return migration.code
```

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from '../scripts/cli.mjs'
import { findTaskByWorktree, normaliseWorktree, worktreeKey } from '../scripts/state.mjs'

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const exists = async (p) => { try { await lstat(p); return true } catch { return false } }

async function withLegacyRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-migrate-cli-'))
  try {
    git(root, ['init', '--quiet', '--initial-branch=main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify({ phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }), 'utf8')
    await writeFile(path.join(root, '.gitignore'), '.teammates/\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'adopt claude-teammates'])
    const lines = []
    const errLines = []
    await fn({ root, io: { out: (t) => lines.push(t), err: (t) => errLines.push(t) }, lines, errLines })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('any CLI command migrates a claude-teammates repository before it runs', async () => {
  await withLegacyRepo(async ({ root, io, errLines }) => {
    await runCli(['gate', '--no-fleet', '--root', root], io)
    assert.equal(await exists(path.join(root, 'teammates.gate.json')), false)
    assert.equal(await exists(path.join(root, 'fleetmates.gate.json')), true)
    assert.match(errLines.join('\n'), /migrating claude-teammates names to fleetmates/)
    assert.match(await readFile(path.join(root, '.gitignore'), 'utf8'), /^\.fleetmates\/$/m)
  })
})

test('a refused migration is the command exit, and the command body never runs', async () => {
  await withLegacyRepo(async ({ root, io, lines }) => {
    await writeFile(path.join(root, 'fleetmates.gate.json'), '{}', 'utf8')
    assert.equal(await runCli(['gate', '--no-fleet', '--root', root], io), 2)
    assert.match(lines.join('\n'), /teammates\.gate\.json and fleetmates\.gate\.json both exist/)
    assert.doesNotMatch(lines.join('\n'), /verdict/i)
  })
})

test('a location record written before the migration still names its branch afterwards', async () => {
  await withLegacyRepo(async ({ root, io }) => {
    const worktree = path.join(root, 'wt')
    await mkdir(worktree)
    git(root, ['branch', 'teammates/r1/T1'])
    await mkdir(path.join(root, '.teammates', 'index'), { recursive: true })
    // Written as 1.3.0's `writeLocation` wrote it — the same normalised path and key — but under
    // .teammates/ and naming the legacy branch.
    const normalised = normaliseWorktree(worktree)
    await writeFile(
      path.join(root, '.teammates', 'index', `${worktreeKey(normalised)}.json`),
      `${JSON.stringify({ runId: 'r1', taskId: 'T1', branch: 'teammates/r1/T1', worktree: normalised })}\n`,
      'utf8',
    )
    await runCli(['gate', '--no-fleet', '--root', root], io)
    const found = await findTaskByWorktree(root, worktree)
    assert.equal(found?.branch, 'fleetmates/r1/T1')
  })
})
```
- [ ] **Step 7:** `node --test tests/names.test.mjs tests/migrate-cli.test.mjs` green; `npm test` green; `npm run test:hostile-tmpdir` green. Then `git grep -n -E "claude-teammates|teammates\.gate|\.teammates\b|refs/teammates|using-teammates|teammates-config" -- scripts hooks skills agents templates tests` and confirm every remaining hit is in `scripts/names.mjs`, `scripts/migrate.mjs`, `tests/migrate.test.mjs`, `tests/migrate-cli.test.mjs`, `tests/names.test.mjs`, or a `legacy-name` block.
- [ ] **Step 8:** Commit: `refactor!: rename every claude-teammates identifier to fleetmates and migrate on first run`.

### Task 6: operator documentation

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `SECURITY.md`
- Modify: `CHANGELOG.md`
- Modify: `tests/packaging.test.mjs`

**Depends:** T5

**Model:** mid

- [ ] **Step 1:** In `tests/packaging.test.mjs`, `the README states the retention rule and the branch clause` asserts ``/`\.fleetmates\/<run-id>\/` is never removed by any command/``. Add:

```js
test('the README tells a claude-teammates user how to move over', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /^## Coming from claude-teammates$/m)
  assert.match(readme, /\/plugin uninstall claude-teammates/)
  assert.match(readme, /\/plugin marketplace add andreymudri\/fleetmates/)
})

test('SECURITY.md names the host the update check contacts', async () => {
  const security = await readFile(new URL('../SECURITY.md', import.meta.url), 'utf8')
  assert.match(security, /registry\.npmjs\.org/)
  assert.doesNotMatch(security, /raw\.githubusercontent\.com/)
})
```

Watch all three fail.
- [ ] **Step 2:** `README.md`: every identifier from the spec's name map uses the new spelling; install becomes `/plugin marketplace add andreymudri/fleetmates` then `/plugin install fleetmates`; the local-checkout install instructions become `claude --plugin-dir /path/to/fleetmates`, with one sentence saying the marketplace now installs the published npm package, not a checkout; the opt-out variable is `FLEETMATES_UPDATE_CHECK` (the old one still works). Add a section:

```markdown
## Coming from claude-teammates

fleetmates is claude-teammates, renamed. To move over:

1. `/plugin uninstall claude-teammates` — left installed, its hooks keep running beside the new
   ones, and fleetmates warns about it at every session start until it is gone.
2. `/plugin marketplace add andreymudri/fleetmates`, then `/plugin install fleetmates`.
3. Run any fleetmates command once in each repository. The first run moves `.teammates/`,
   `teammates.gate.json`, `teammates.local.json`, the `teammates/<run>/<task>` branches and the
   `refs/teammates/` claim refs to their `fleetmates` names, and adds the new ignore lines next
   to the old ones. It refuses, and changes nothing, while a teammate from an old run is still
   working, or when both spellings of something already exist.

A migration that fails part-way stops, and prints every step it completed with the command that
reverses it.
```

Keep every sentence `tests/skill-config.test.mjs` pins in the README (the caveman level count and its measurement).
- [ ] **Step 3:** `CONTRIBUTING.md`: repository URL and identifiers renamed; add that local testing uses `claude --plugin-dir .`, because the marketplace installs from npm.
- [ ] **Step 4:** `SECURITY.md`: the update check now contacts `https://registry.npmjs.org/fleetmates/latest` at most once a day; nothing else about what it sends changes. Rename the opt-out variable, noting the old one is still honoured.
- [ ] **Step 5:** `CHANGELOG.md`: a new top entry, keeping every past entry unchanged, and keeping the sentences `tests/skill-config.test.mjs` pins:

```markdown
## 2.0.0 — 2026-09-13

**claude-teammates is now fleetmates**, published on npm as `fleetmates`.

### Breaking

- Plugin, marketplace and npm package are `fleetmates`; skills are namespaced `fleetmates:`, and
  `using-teammates` / `teammates-config` are `using-fleetmates` / `fleetmates-config`.
- On disk: `.fleetmates/`, `fleetmates.gate.json`, `fleetmates.local.json`, task branches
  `fleetmates/<run>/<task>`, claim refs `refs/fleetmates/…`.
- The update-check opt-out is `FLEETMATES_UPDATE_CHECK`; `CLAUDE_TEAMMATES_UPDATE_CHECK` still works.

### Migration

- The first CLI command in a repository migrates every legacy name, or refuses with exit 2 while a
  teammate is live or when both spellings exist. A failure part-way exits 4 and prints how to
  reverse each completed step.
- SessionStart warns while `claude-teammates` is still installed beside `fleetmates`.

### Distribution

- The marketplace installs the plugin from npm. The update check reads the npm registry.
- `release.yml` publishes a `v*` tag through npm trusted publishing, after the three-OS matrix.
```

- [ ] **Step 6:** `node --test tests/packaging.test.mjs tests/skill-config.test.mjs` green, then `npm test`.
- [ ] **Step 7:** Commit: `docs: fleetmates install, migration from claude-teammates, and the 2.0.0 changelog`.
