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

test('normalizeDeclarePath basic aliases: tasks declaring a.mjs and ./a.mjs land in different phases', () => {
  // This test pins that assignPhases uses normalizeDeclarePath to detect file
  // conflicts. The ./a.mjs declaration canonicalizes via the same basic rules as
  // enforce.mjs's normalizePath (remove leading ./), so both tasks touch the same
  // file and must go to different phases. Fails only if normalizeDeclarePath
  // reverts to raw string comparison.
  const out = assignPhases([task('T1', ['a.mjs']), task('T2', ['./a.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 2])
})

test('normalizeDeclarePath basic aliases: tasks declaring a/b.mjs and a\\b.mjs land in different phases', () => {
  // This test pins that assignPhases uses normalizeDeclarePath to detect file
  // conflicts. The a\b.mjs declaration canonicalizes via the same basic rules as
  // enforce.mjs's normalizePath (replace backslashes), so both tasks touch the same
  // file and must go to different phases. Fails only if normalizeDeclarePath
  // reverts to raw string comparison.
  const out = assignPhases([task('T1', ['a/b.mjs']), task('T2', ['a\\b.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 2])
})

test('case-sensitive differences: tasks declaring A.mjs and a.mjs land in the same phase', () => {
  // This test pins that normalizeDeclarePath preserves case-sensitivity via its
  // reliance on enforce.mjs's normalizePath, which does not fold case. A.mjs and
  // a.mjs remain distinct after normalization, so they are different files and can
  // both go in phase 1. The test is pinned by normalizeDeclarePath, not by
  // normalizePath directly: fails only if normalizeDeclarePath is case-folded
  // (e.g., by adding .toLowerCase() in phases.mjs). This pins the precondition
  // that assignPhases depends on: if the underlying normalizer changes to fold
  // case, both declarations would collide and the test would expect phase 1 but
  // see phase [1, 2].
  const out = assignPhases([task('T1', ['A.mjs']), task('T2', ['a.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 1])
})

test('interior ./: tasks declaring a/b.mjs and a/./b.mjs land in different phases', () => {
  // Declared paths can contain redundant interior ./ segments from copy-paste or
  // typos. These must be normalized to detect the actual file collision, else two
  // tasks declaring the same file under different spellings are both placed in
  // phase 1 and dispatched concurrently against the same real file.
  const out = assignPhases([task('T1', ['a/b.mjs']), task('T2', ['a/./b.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 2])
})

test('repeated separators: tasks declaring a/b.mjs and a//b.mjs land in different phases', () => {
  // Declared paths can contain repeated separators from typos. These must be
  // normalized to detect the actual file collision.
  const out = assignPhases([task('T1', ['a/b.mjs']), task('T2', ['a//b.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 2])
})

test('repeated leading ./: tasks declaring a.mjs and ././a.mjs land in different phases', () => {
  // Declared paths can contain repeated leading ./ from typos. These must be
  // normalized to detect the actual file collision.
  const out = assignPhases([task('T1', ['a.mjs']), task('T2', ['././a.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 2])
})

test('.. segments: tasks declaring a/b.mjs and a/../a/b.mjs land in different phases', () => {
  // Declared paths can contain .. segments that resolve to the same real file.
  // These must be normalized to detect the actual file collision.
  const out = assignPhases([task('T1', ['a/b.mjs']), task('T2', ['a/../a/b.mjs'])])
  assert.deepEqual(out.map((t) => t.phase), [1, 2])
})

test('multiple spellings converge: four redundant spellings of the same file all conflict', () => {
  // Key invariant: if normalizeDeclarePath uses the same basic cleanup rules as
  // enforce.mjs's normalizePath, then normalizeDeclarePath(a) === normalizeDeclarePath(b)
  // implies paths equal under normalizePath. This test verifies the stronger direction:
  // four different declared spellings that all collapse to the same canonical form must
  // all conflict with each other. This proves normalizeDeclarePath correctly identifies
  // multiple representations as a single file.
  const out = assignPhases([
    task('T1', ['a/b.mjs']),
    task('T2', ['a/./b.mjs']),      // Interior ./
    task('T3', ['a//b.mjs']),       // Repeated separator
    task('T4', ['a/../a/b.mjs']),   // .. segment
  ])
  // All must be in different phases, proving they all normalize to the same file
  assert.deepEqual(out.map((t) => t.phase), [1, 2, 3, 4])
})
