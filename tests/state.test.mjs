import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
