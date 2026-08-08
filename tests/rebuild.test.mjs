import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskStateFrom, rebuildRunState } from '../scripts/rebuild.mjs'

test('a task with no branch is pending', () => {
  assert.equal(taskStateFrom({ exists: false, contributes: false, merged: false }), 'pending')
})

test('a task whose branch carries work is done, merged or not', () => {
  assert.equal(taskStateFrom({ exists: true, contributes: true, merged: false }), 'done')
  assert.equal(taskStateFrom({ exists: true, contributes: true, merged: true }), 'done')
})

// A branch that exists and contributes nothing is the stale-base shape: something ran, and its
// work is not where the run can see it. Calling that `done` would rebuild the exact false record
// this whole design refuses to trust.
test('a branch that exists but contributes nothing is orphaned, never done', () => {
  assert.equal(taskStateFrom({ exists: true, contributes: false, merged: false }), 'orphaned')
})

// Merged work whose branch no longer shows a contribution is normal: after integration the fork
// point is the branch tip. `merged` settles it.
test('a merged branch is done even when its own diff is now empty', () => {
  assert.equal(taskStateFrom({ exists: true, contributes: false, merged: true }), 'done')
})

const TASKS = [
  { id: 'T1', phase: 1, title: 'first', files: ['a.mjs'], deps: [], tier: 'mid' },
  { id: 'T2', phase: 2, title: 'second', files: ['b.mjs'], deps: ['T1'], tier: 'mid' },
]

test('the rebuilt plan keeps every task, its phase and the total', () => {
  const { plan } = rebuildRunState({
    runId: 'r1',
    tasks: TASKS,
    info: { T1: { exists: true, contributes: true, merged: true }, T2: { exists: false } },
    maxParallel: 4,
    currentPhase: 2,
  })
  assert.equal(plan.runId, 'r1')
  assert.equal(plan.totalPhases, 2)
  assert.deepEqual(plan.tasks.map((t) => t.id), ['T1', 'T2'])
})

test('the rebuilt status carries the derived state of every task', () => {
  const { status } = rebuildRunState({
    runId: 'r1',
    tasks: TASKS,
    info: { T1: { exists: true, contributes: true, merged: true }, T2: { exists: false } },
    maxParallel: 4,
    currentPhase: 2,
  })
  assert.deepEqual(status.tasks, [
    { id: 'T1', title: 'first', state: 'done' },
    { id: 'T2', title: 'second', state: 'pending' },
  ])
  assert.equal(status.phase, 2)
  assert.equal(status.maxParallel, 4)
})

// The whole point. A gate verdict is evidence that checks ran; git carries branches, not
// verdicts. Reconstructing a `gates` entry would manufacture exactly the record the design
// refuses to trust — and this time the plugin itself would be the forger.
test('the rebuilt status contains no gate record at all', () => {
  const { status } = rebuildRunState({
    runId: 'r1', tasks: TASKS, info: {}, maxParallel: 4, currentPhase: 1,
  })
  assert.equal('gates' in status, false)
  assert.equal('fixRounds' in status, false)
})

// A run whose phases are all integrated has no current phase; the record still has to say
// something a reader can act on rather than `null` leaking into the digest's header.
test('a fully integrated run records its last phase rather than null', () => {
  const { status } = rebuildRunState({
    runId: 'r1', tasks: TASKS, info: {}, maxParallel: 4, currentPhase: null,
  })
  assert.equal(status.phase, 2)
})
