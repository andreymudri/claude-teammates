import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignPhases } from '../scripts/phases.mjs'

const task = (id, files = [], deps = []) => ({ id, title: id, files, deps })

test('independent tasks with disjoint files share one phase', () => {
  const out = assignPhases([task('T1', ['a.mjs']), task('T2', ['b.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 1])
})

test('tasks touching the same file are split across phases', () => {
  const out = assignPhases([task('T1', ['a.mjs']), task('T2', ['a.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 2])
})

test('a dependency forces a later phase', () => {
  const out = assignPhases([task('T1', ['a.mjs']), task('T2', ['b.mjs'], ['T1'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 2])
})

test('a dependency chain produces one phase per link', () => {
  const out = assignPhases([
    task('T1', ['a.mjs']),
    task('T2', ['b.mjs'], ['T1']),
    task('T3', ['c.mjs'], ['T2']),
  ])
  assert.deepEqual(out.map((t) => t.phase), [1, 2, 3])
})

test('preserves input order within a phase', () => {
  const out = assignPhases([task('T1', ['a.mjs']), task('T2', ['b.mjs']), task('T3', ['c.mjs'])])
  assert.deepEqual(out.map((t) => t.id), ['T1', 'T2', 'T3'])
})

test('throws on a dependency cycle', () => {
  assert.throws(
    () => assignPhases([task('T1', ['a.mjs'], ['T2']), task('T2', ['b.mjs'], ['T1'])]),
    /unsatisfiable dependencies: T1, T2/,
  )
})

test('throws on an unknown dependency', () => {
  assert.throws(
    () => assignPhases([task('T1', ['a.mjs'], ['T9'])]),
    /unsatisfiable dependencies: T1/,
  )
})

test('handles an empty task list', () => {
  assert.deepEqual(assignPhases([]), [])
})
