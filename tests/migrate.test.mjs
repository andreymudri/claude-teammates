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
