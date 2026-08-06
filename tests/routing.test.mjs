import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TIERS, inferTier, escalateTier } from '../scripts/routing.mjs'

function makeTask(overrides = {}) {
  return {
    id: 'T1',
    files: [],
    deps: [],
    brief: '',
    ...overrides,
  }
}

test('a task depended on by two others infers capable', () => {
  const task = makeTask({ id: 'T1' })
  const tasks = [
    task,
    makeTask({ id: 'T2', deps: ['T1'] }),
    makeTask({ id: 'T3', deps: ['T1'] }),
  ]
  assert.equal(inferTier(task, tasks), 'capable')
})

test('a task depended on by exactly one other does not infer capable on that rule alone', () => {
  const task = makeTask({ id: 'T1' })
  const tasks = [task, makeTask({ id: 'T2', deps: ['T1'] })]
  assert.notEqual(inferTier(task, tasks), 'capable')
})

test('a task with five declared files infers capable', () => {
  const task = makeTask({ files: ['a', 'b', 'c', 'd', 'e'] })
  assert.equal(inferTier(task, [task]), 'capable')
})

// Pins the file-count threshold from below: four files is the largest task that is still not
// capable on file count alone. Without this, `> 4` mutated to `>= 4` routes every four-file
// task to the most expensive tier and the rest of the suite stays green.
test('a task with four declared files, no fenced brief and no dependents infers mid', () => {
  const task = makeTask({ files: ['a', 'b', 'c', 'd'], brief: '' })
  assert.equal(inferTier(task, [task]), 'mid')
})

test('a task whose brief contains a fenced block and declares two files infers cheap', () => {
  const task = makeTask({ files: ['a', 'b'], brief: 'do this:\n```js\nconst x = 1\n```' })
  assert.equal(inferTier(task, [task]), 'cheap')
})

test('the same fenced brief with three declared files infers mid', () => {
  const task = makeTask({ files: ['a', 'b', 'c'], brief: 'do this:\n```js\nconst x = 1\n```' })
  assert.equal(inferTier(task, [task]), 'mid')
})

// Pins the fence rule as an upper bound rather than an equality: one file is under the limit
// and must still be cheap. Without this, `<= 2` mutated to `=== 2` demotes every single-file
// fenced task to mid and the rest of the suite stays green.
test('a fenced brief with a single declared file infers cheap', () => {
  const task = makeTask({ files: ['a'], brief: 'do this:\n```js\nconst x = 1\n```' })
  assert.equal(inferTier(task, [task]), 'cheap')
})

test('a task with no brief and two files infers mid', () => {
  const task = makeTask({ files: ['a', 'b'], brief: '' })
  assert.equal(inferTier(task, [task]), 'mid')
})

test('escalateTier walks cheap to mid, mid to capable, and caps at capable', () => {
  assert.equal(escalateTier('cheap'), 'mid')
  assert.equal(escalateTier('mid'), 'capable')
  assert.equal(escalateTier('capable'), 'capable')
})

test('escalateTier throws on an unknown tier', () => {
  assert.throws(() => escalateTier('enormous'), /unknown tier: enormous/)
})

test('TIERS is exactly cheap, mid, capable in order', () => {
  assert.deepEqual(TIERS, ['cheap', 'mid', 'capable'])
})
