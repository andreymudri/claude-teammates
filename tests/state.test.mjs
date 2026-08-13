import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
