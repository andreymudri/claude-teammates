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

test('normalizePath aliases: tasks declaring a.mjs and ./a.mjs land in different phases', () => {
  // This test pins that assignPhases uses normalizePath to detect file conflicts.
  // ./a.mjs normalizes to a.mjs, so both tasks touch the same file and must go
  // to different phases. Fails if assignPhases compares raw strings instead.
  const out = assignPhases([task('T1', ['a.mjs']), task('T2', ['./a.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 2])
})

test('normalizePath aliases: tasks declaring a/b.mjs and a\\b.mjs land in different phases', () => {
  // This test pins that assignPhases uses normalizePath to detect file conflicts.
  // a\b.mjs normalizes to a/b.mjs, so both tasks touch the same file and must go
  // to different phases. Fails if assignPhases compares raw strings instead.
  const out = assignPhases([task('T1', ['a/b.mjs']), task('T2', ['a\\b.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 2])
})

test('case-sensitive differences: tasks declaring A.mjs and a.mjs land in the same phase', () => {
  // This test pins that normalizePath preserves case-sensitivity, a critical
  // precondition for assignPhases to work correctly. A.mjs and a.mjs normalize
  // to themselves (case-sensitive), so they are distinct files and can both
  // go in phase 1. Fails only if normalizePath is case-folded (e.g., by adding
  // .toLowerCase()). When that happens, both normalize to a single key and
  // must go to different phases, but the test expects them in the same phase.
  // This test does not directly pin the assignPhases change, but it pins the
  // normalizePath behavior that assignPhases depends on.
  const out = assignPhases([task('T1', ['A.mjs']), task('T2', ['a.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 1])
})
