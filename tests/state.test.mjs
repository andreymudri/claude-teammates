import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  runDir,
  readState,
  writeState,
  claimTask,
  releaseClaim,
  readFixRounds,
  recordFixRound,
  normaliseWorktree,
  writeLocation,
  findTaskByWorktree,
} from '../scripts/state.mjs'

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-'))
  try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('runDir places state under .teammates/<runId>', () => {
  assert.equal(runDir('/repo', 'abc'), path.join('/repo', '.teammates', 'abc'))
})

test('readState returns null when the file does not exist', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await readState(root, 'r1', 'plan'), null)
  })
})

test('writeState then readState round-trips', async () => {
  await withTempRoot(async (root) => {
    await writeState(root, 'r1', 'plan', { tasks: [{ id: 'T1' }] })
    assert.deepEqual(await readState(root, 'r1', 'plan'), { tasks: [{ id: 'T1' }] })
  })
})

test('writeState overwrites an existing file completely', async () => {
  await withTempRoot(async (root) => {
    await writeState(root, 'r1', 'status', { a: 1, b: 2 })
    await writeState(root, 'r1', 'status', { a: 9 })
    assert.deepEqual(await readState(root, 'r1', 'status'), { a: 9 })
  })
})

test('claimTask succeeds once and fails for a second claimant', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-a'), true)
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-b'), false)
  })
})

test('claimTask allows different tasks to be claimed independently', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-a'), true)
    assert.equal(await claimTask(root, 'r1', 'T2', 'impl-b'), true)
  })
})

test('releasing a claim then re-claiming the task succeeds', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-a'), true)
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-b'), false)
    await releaseClaim(root, 'r1', 'T1')
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-b'), true)
  })
})

test('releasing a nonexistent claim is not an error', async () => {
  await withTempRoot(async (root) => {
    await assert.doesNotReject(releaseClaim(root, 'r1', 'never-claimed'))
    assert.equal(await releaseClaim(root, 'r1', 'never-claimed'), true)
  })
})

test('concurrent claims on one task produce exactly one winner', async () => {
  await withTempRoot(async (root) => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimTask(root, 'r1', 'T1', `impl-${i}`)),
    )
    assert.equal(results.filter(Boolean).length, 1)
  })
})

// The location record. These tests are about one directory having several spellings: what git
// prints, what a hook payload carries, and what a shell reports are three different strings for
// the same worktree, and the lookup is only useful if all three find the same record.

test('writeLocation writes .teammates/<runId>/worktrees/<taskId>.json with taskId, worktree and branch', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const written = await writeLocation(root, 'r1', 'T1', { worktree, branch: 'teammates/r1/T1' })
    assert.equal(written, path.join(root, '.teammates', 'r1', 'worktrees', 'T1.json'))
    assert.deepEqual(JSON.parse(await readFile(written, 'utf8')), {
      taskId: 'T1',
      worktree,
      branch: 'teammates/r1/T1',
    })
  })
})

test('writeLocation called a second time overwrites rather than failing', async () => {
  await withTempRoot(async (root) => {
    const first = path.join(root, 'wt', 'agent-1')
    const second = path.join(root, 'wt', 'agent-2')
    await writeLocation(root, 'r1', 'T1', { worktree: first, branch: 'teammates/r1/T1' })
    await assert.doesNotReject(
      writeLocation(root, 'r1', 'T1', { worktree: second, branch: 'teammates/r1/T1' }),
    )
    const record = JSON.parse(
      await readFile(path.join(root, '.teammates', 'r1', 'worktrees', 'T1.json'), 'utf8'),
    )
    assert.equal(record.worktree, second)
    // The old worktree no longer resolves; the respawned one does.
    assert.equal(await findTaskByWorktree(root, first), null)
    assert.deepEqual(await findTaskByWorktree(root, second), {
      runId: 'r1',
      taskId: 'T1',
      branch: 'teammates/r1/T1',
    })
  })
})

test('findTaskByWorktree matches a trailing separator against a record written without one', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    await writeLocation(root, 'r1', 'T7', { worktree, branch: 'teammates/r1/T7' })
    assert.deepEqual(await findTaskByWorktree(root, `${worktree}${path.sep}`), {
      runId: 'r1',
      taskId: 'T7',
      branch: 'teammates/r1/T7',
    })
  })
})

test('findTaskByWorktree on win32 matches across drive-letter case and separator style', {
  skip: process.platform !== 'win32' ? 'win32 only' : false,
}, async () => {
  await withTempRoot(async (root) => {
    // Written the way the harness spells it: backslashes, upper-case drive letter.
    const worktree = path.resolve(path.join(root, 'wt', 'agent-1'))
    const upper = worktree[0].toUpperCase() + worktree.slice(1)
    await writeLocation(root, 'r1', 'T4', { worktree: upper, branch: 'teammates/r1/T4' })
    const expected = { runId: 'r1', taskId: 'T4', branch: 'teammates/r1/T4' }
    // The way git prints it: forward slashes.
    assert.deepEqual(await findTaskByWorktree(root, upper.replace(/\\/g, '/')), expected)
    // The way a shell reports it: lower-case drive letter.
    assert.deepEqual(
      await findTaskByWorktree(root, upper[0].toLowerCase() + upper.slice(1)),
      expected,
    )
    // And all three at once, with a trailing separator on top.
    assert.deepEqual(
      await findTaskByWorktree(root, `${upper[0].toLowerCase()}${upper.slice(1).replace(/\\/g, '/')}/`),
      expected,
    )
  })
})

test('normaliseWorktree collapses the spellings it compares and rejects non-strings', () => {
  assert.equal(normaliseWorktree(''), '')
  assert.equal(normaliseWorktree(null), '')
  assert.equal(normaliseWorktree(undefined), '')
  assert.equal(normaliseWorktree(42), '')
  const base = path.resolve(path.join('some', 'where'))
  assert.equal(normaliseWorktree(base), normaliseWorktree(`${base}${path.sep}`))
  if (process.platform === 'win32') {
    assert.equal(normaliseWorktree(base), normaliseWorktree(base.replace(/\\/g, '/')))
    assert.equal(normaliseWorktree(base), normaliseWorktree(base.toUpperCase()))
  }
})

test('findTaskByWorktree returns null for an unknown worktree and for an empty query', async () => {
  await withTempRoot(async (root) => {
    await writeLocation(root, 'r1', 'T1', {
      worktree: path.join(root, 'wt', 'agent-1'),
      branch: 'teammates/r1/T1',
    })
    assert.equal(await findTaskByWorktree(root, path.join(root, 'wt', 'nobody')), null)
    assert.equal(await findTaskByWorktree(root, ''), null)
    assert.equal(await findTaskByWorktree(root, undefined), null)
  })
})

test('findTaskByWorktree returns null when there is no .teammates directory at all', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await findTaskByWorktree(root, path.join(root, 'wt', 'agent-1')), null)
  })
})

test('findTaskByWorktree skips a run with no worktrees directory', async () => {
  await withTempRoot(async (root) => {
    await writeState(root, 'r0', 'plan', { tasks: [] })
    await writeLocation(root, 'r1', 'T2', {
      worktree: path.join(root, 'wt', 'agent-2'),
      branch: 'teammates/r1/T2',
    })
    assert.deepEqual(await findTaskByWorktree(root, path.join(root, 'wt', 'agent-2')), {
      runId: 'r1',
      taskId: 'T2',
      branch: 'teammates/r1/T2',
    })
  })
})

test('findTaskByWorktree skips a malformed record without throwing and still finds a good one', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, '.teammates', 'r1', 'worktrees')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'T1.json'), 'not json at all', 'utf8')
    await writeFile(path.join(dir, 'notes.txt'), 'ignored', 'utf8')
    const worktree = path.join(root, 'wt', 'agent-3')
    await writeLocation(root, 'r1', 'T3', { worktree, branch: 'teammates/r1/T3' })
    assert.deepEqual(await findTaskByWorktree(root, worktree), {
      runId: 'r1',
      taskId: 'T3',
      branch: 'teammates/r1/T3',
    })
    // And a query that matches nothing still returns null rather than throwing on the bad file.
    assert.equal(await findTaskByWorktree(root, path.join(root, 'wt', 'agent-9')), null)
  })
})

test('findTaskByWorktree reports a null branch for a record that carries none', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, '.teammates', 'r1', 'worktrees')
    await mkdir(dir, { recursive: true })
    const worktree = path.join(root, 'wt', 'agent-4')
    await writeFile(path.join(dir, 'T5.json'), JSON.stringify({ taskId: 'T5', worktree }), 'utf8')
    assert.deepEqual(await findTaskByWorktree(root, worktree), {
      runId: 'r1',
      taskId: 'T5',
      branch: null,
    })
  })
})

// A taskId reaches writeLocation from `locate --task`, i.e. from the teammate. It is a single
// path segment and nothing else: the traversals below are the ones that do real damage.

test('writeLocation refuses a taskId that climbs out of the worktrees directory', async () => {
  await withTempRoot(async (root) => {
    const args = { worktree: path.join(root, 'wt', 'agent-1'), branch: 'b' }
    for (const taskId of [
      '../claims/T5',
      '..\\claims\\T5',
      '../status',
      '../../../../escaped',
      'nested/T1',
      '..',
      path.join(root, 'absolute'),
    ]) {
      await assert.rejects(
        writeLocation(root, 'r1', taskId, args),
        /escapes the run directory/,
        `taskId ${taskId} was not refused`,
      )
    }
    // Nothing was created anywhere: not the claim that would make T5 unclaimable forever,
    // not an overwritten status.json, not a file outside the run directory.
    assert.equal(await readState(root, 'r1', 'status'), null)
    assert.equal(await claimTask(root, 'r1', 'T5', 'impl-a'), true)
  })
})

test('writeLocation refuses a runId that climbs out of .teammates', async () => {
  await withTempRoot(async (root) => {
    const args = { worktree: path.join(root, 'wt', 'agent-1'), branch: 'b' }
    for (const runId of ['../..', '../escaped', 'nested/r1', '..']) {
      await assert.rejects(writeLocation(root, runId, 'T1', args), /escapes the run directory/)
    }
  })
})

test('writeLocation still accepts an ordinary task and run id after the guard', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const written = await writeLocation(root, 'run-1_x', 'T10', { worktree, branch: 'b' })
    assert.equal(written, path.join(root, '.teammates', 'run-1_x', 'worktrees', 'T10.json'))
  })
})

test('findTaskByWorktree matches a worktree reached through a symlinked parent', async (t) => {
  await withTempRoot(async (root) => {
    const real = path.join(root, 'real', 'agent-1')
    await mkdir(real, { recursive: true })
    const link = path.join(root, 'linked')
    try {
      await symlink(path.join(root, 'real'), link, 'junction')
    } catch (err) {
      t.skip(`symlinks unavailable here: ${err.code}`)
      return
    }
    // Recorded as git prints it (the real path); queried as the harness reports it (through
    // the link). Lexical normalisation alone cannot see these are one directory.
    await writeLocation(root, 'r1', 'T1', { worktree: real, branch: 'teammates/r1/T1' })
    assert.deepEqual(await findTaskByWorktree(root, path.join(link, 'agent-1')), {
      runId: 'r1',
      taskId: 'T1',
      branch: 'teammates/r1/T1',
    })
    // And the other way round: recorded through the link, queried by the real path. Under a
    // second run id, with the first record's mtime forced into the past, so the answer does not
    // depend on two writes microseconds apart landing on distinct mtimes — they tie on any
    // filesystem with coarse mtime granularity, and this assertion would then flip on CI.
    const stale = new Date(Date.now() - 86_400_000)
    await utimes(path.join(root, '.teammates', 'r1', 'worktrees', 'T1.json'), stale, stale)
    await writeLocation(root, 'r2', 'T2', {
      worktree: path.join(link, 'agent-1'),
      branch: 'teammates/r2/T2',
    })
    assert.deepEqual(await findTaskByWorktree(root, real), {
      runId: 'r2',
      taskId: 'T2',
      branch: 'teammates/r2/T2',
    })
  })
})

// Records are never deleted and worktree paths are reused, so several runs can hold a record
// for one directory. Whichever one `locate` wrote most recently is the live teammate's.
test('findTaskByWorktree resolves duplicate records by write time, not readdir order', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const stale = await writeLocation(root, 'aaa-old', 'T9', { worktree, branch: 'teammates/aaa-old/T9' })
    const live = await writeLocation(root, 'zzz-current', 'T2', { worktree, branch: 'teammates/zzz-current/T2' })
    const old = new Date(Date.now() - 86_400_000)
    await utimes(stale, old, old)
    assert.deepEqual(await findTaskByWorktree(root, worktree), {
      runId: 'zzz-current',
      taskId: 'T2',
      branch: 'teammates/zzz-current/T2',
    })
    // The mirror case, which readdir order and reverse-alphabetical order both get wrong:
    // the newest record now sorts FIRST by name.
    const newer = await writeLocation(root, 'bbb-newest', 'T3', { worktree, branch: 'teammates/bbb-newest/T3' })
    const past = new Date(Date.now() - 3_600_000)
    await utimes(live, past, past)
    const soon = new Date(Date.now() + 60_000)
    await utimes(newer, soon, soon)
    assert.deepEqual(await findTaskByWorktree(root, worktree), {
      runId: 'bbb-newest',
      taskId: 'T3',
      branch: 'teammates/bbb-newest/T3',
    })
  })
})

test('findTaskByWorktree breaks an exact mtime tie across runs deterministically rather than by directory order', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const a = await writeLocation(root, 'aaa', 'T1', { worktree, branch: 'a' })
    const b = await writeLocation(root, 'zzz', 'T2', { worktree, branch: 'z' })
    const same = new Date(1_700_000_000_000)
    await utimes(a, same, same)
    await utimes(b, same, same)
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await findTaskByWorktree(root, worktree), {
        runId: 'zzz',
        taskId: 'T2',
        branch: 'z',
      })
    }
  })
})

// The run id cannot settle a tie between two records of the SAME run, and that is the reachable
// case: a respawned teammate reuses an agent-<hash> path within one run, on a filesystem whose
// mtime granularity collapses both writes onto one timestamp.
test('findTaskByWorktree breaks an exact mtime tie inside one run rather than by directory order', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const first = await writeLocation(root, 'r1', 'T1', { worktree, branch: 'teammates/r1/T1' })
    const second = await writeLocation(root, 'r1', 'T2', { worktree, branch: 'teammates/r1/T2' })
    const same = new Date(1_700_000_000_000)
    await utimes(first, same, same)
    await utimes(second, same, same)
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await findTaskByWorktree(root, worktree), {
        runId: 'r1',
        taskId: 'T2',
        branch: 'teammates/r1/T2',
      })
    }
  })
})

// writeLocation's guard constrains the record's FILENAME. A teammate with a shell can write the
// file itself and put anything in its CONTENT, and the taskId read back out is handed to a caller
// that spends it as `complete --task`. So the read side validates too.
test('findTaskByWorktree skips a hand-written record whose taskId is a traversal', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, '.teammates', 'r1', 'worktrees')
    await mkdir(dir, { recursive: true })
    const worktree = path.join(root, 'wt', 'agent-1')
    for (const taskId of [
      '../../../escaped',
      '..\\..\\escaped',
      'nested/T1',
      '..',
      '.',
      '',
      path.join(root, 'absolute'),
      42,
      null,
      { id: 'T1' },
    ]) {
      await writeFile(path.join(dir, 'T1.json'), JSON.stringify({ taskId, worktree, branch: 'b' }), 'utf8')
      assert.equal(
        await findTaskByWorktree(root, worktree),
        null,
        `a record carrying taskId ${JSON.stringify(taskId)} was returned rather than skipped`,
      )
    }
  })
})

test('findTaskByWorktree skips a record whose taskId does not name its own file', async () => {
  await withTempRoot(async (root) => {
    const dir = path.join(root, '.teammates', 'r1', 'worktrees')
    await mkdir(dir, { recursive: true })
    const worktree = path.join(root, 'wt', 'agent-1')
    // A plain segment, so the traversal check alone would pass it — but T1.json claiming to be
    // T9 means one of the two is a lie, and the file name is the half the writer's guard bounds.
    await writeFile(path.join(dir, 'T1.json'), JSON.stringify({ taskId: 'T9', worktree }), 'utf8')
    assert.equal(await findTaskByWorktree(root, worktree), null)
    // The honest record next to it is still found, so this skips a record rather than the run.
    await writeLocation(root, 'r1', 'T2', { worktree, branch: 'teammates/r1/T2' })
    assert.deepEqual(await findTaskByWorktree(root, worktree), {
      runId: 'r1',
      taskId: 'T2',
      branch: 'teammates/r1/T2',
    })
  })
})

// A cross-file source assertion, not a behavioural one. Observing a torn read requires winning
// a race against a write that finishes in microseconds, which is exactly the flaky test this
// suite avoids; the property is structural — the bytes never appear at the target path under a
// non-final name — so the structure is what gets pinned. Replacing the tmp+rename pair with a
// direct writeFile(target, ...) fails here.
test('writeLocation writes through a unique temp file and renames, never straight to the target', async () => {
  const source = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'state.mjs'),
    'utf8',
  )
  const start = source.indexOf('export async function writeLocation')
  assert.notEqual(start, -1, 'writeLocation is no longer declared under that name')
  const body = source.slice(start, source.indexOf('\n}', start))
  assert.match(body, /const tmp = `\$\{target\}\.\$\{process\.pid\}\./,
    'the temp name must be unique per writer, or two writers share one scratch file')
  assert.match(body, /await writeFile\(tmp,/, 'the payload must be written to the temp file')
  assert.match(body, /await rename\(tmp, target\)/, 'the temp file must be renamed onto the target')
  assert.doesNotMatch(body, /writeFile\(\s*target/,
    'writing straight to the target lets a concurrent reader see a half-written record')
})

// The location record is deliberately separate from the claim: adding it must not have relaxed
// the claim's atomicity or changed the bytes it writes.
test('claimTask still refuses a second claim and still writes exactly { taskId, teammate }', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-a'), true)
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-b'), false)
    const raw = await readFile(path.join(root, '.teammates', 'r1', 'claims', 'T1.json'), 'utf8')
    assert.equal(raw, JSON.stringify({ taskId: 'T1', teammate: 'impl-a' }))
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['taskId', 'teammate'])
  })
})

test('readFixRounds returns {} for a status with no fixRounds, and for null', () => {
  assert.deepEqual(readFixRounds({}, 'Implement'), {})
  assert.deepEqual(readFixRounds(null, 'Implement'), {})
})

test('readFixRounds accepts a numeric phase and a string phase interchangeably', () => {
  const status = { fixRounds: { '2': { T1: 1 } } }
  assert.deepEqual(readFixRounds(status, 2), { T1: 1 })
  assert.deepEqual(readFixRounds(status, '2'), { T1: 1 })
})

test('recordFixRound increments from absent to 1, then 1 to 2', () => {
  let status = recordFixRound({}, 'Implement', 'T1')
  assert.equal(status.fixRounds.Implement.T1, 1)
  status = recordFixRound(status, 'Implement', 'T1')
  assert.equal(status.fixRounds.Implement.T1, 2)
})

test('recordFixRound does not mutate the status object it was given, and leaves another phase untouched', () => {
  const before = { fixRounds: { Verify: { T2: 3 } } }
  const after = recordFixRound(before, 'Implement', 'T1')
  assert.deepEqual(before, { fixRounds: { Verify: { T2: 3 } } })
  assert.deepEqual(after.fixRounds.Verify, { T2: 3 })
  assert.equal(after.fixRounds.Implement.T1, 1)
})
