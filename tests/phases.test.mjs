import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignPhases } from '../scripts/phases.mjs'
import { parsePlan } from '../scripts/plan-parser.mjs'

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
  // This file imports only assignPhases and never calls enforce.mjs's normalizePath, so
  // it can only pin what normalizeDeclarePath itself does: four different declared
  // spellings of one file all collapse to the same canonical form, so all four tasks
  // conflict with each other. It says nothing about whether normalizeDeclarePath's
  // notion of "same file" matches normalizePath's. ONE dimension of that question is
  // pinned, and only one: CASE, by a test on each side — a change on the normalizePath
  // side is caught by 'a case-only mismatch is a violation' in tests/enforce.test.mjs,
  // and a change on the normalizeDeclarePath side by 'case-sensitive differences: tasks
  // declaring A.mjs and a.mjs land in the same phase' in this file. Divergence in any
  // other dimension — separator handling, .. resolution, unicode normalization — is
  // pinned by neither file, so this pair is a case check, not a general divergence check.
  const out = assignPhases([
    task('T1', ['a/b.mjs']),
    task('T2', ['a/./b.mjs']),      // Interior ./
    task('T3', ['a//b.mjs']),       // Repeated separator
    task('T4', ['a/../a/b.mjs']),   // .. segment
  ])
  // All must be in different phases, proving they all normalize to the same file
  assert.deepEqual(out.map((t) => t.phase), [1, 2, 3, 4])
})

test('fog-of-war and out-of-scope sections do not leak into the parsed task list', () => {
  // scripts/phases.mjs reads an empty file list as "conflicts with nothing", so every task
  // with no declared files lands in phase 1. If a fog or out-of-scope entry ever leaked into
  // the task list as a task, it would land in phase 1 with no declared files, dispatched as a
  // teammate against a question instead of a file set. This test is the thing standing
  // between that regression and a green run.
  const withNotes = `
### Task 1: build the thing

**Files:**
- Create: \`a.mjs\`

**Depends:** none

- [ ] **Step 1:** Do the thing.

## Destination

The gate can answer "is this run landable" without an operator reading prose.

## Not Yet Specified

- How should finish report a phase whose reviewers disagreed?
- Does the map's coupling data belong in the gate at all?
- What happens when two fog entries name the same open question?

## Out of Scope

- Migrating existing plans to the new section format.
- Auto-generating fog entries from review comments.

### Task 2: build the other thing

**Files:**
- Create: \`b.mjs\`

**Depends:** T1

- [ ] **Step 1:** Do the other thing.
`

  const withoutNotes = `
### Task 1: build the thing

**Files:**
- Create: \`a.mjs\`

**Depends:** none

- [ ] **Step 1:** Do the thing.

### Task 2: build the other thing

**Files:**
- Create: \`b.mjs\`

**Depends:** T1

- [ ] **Step 1:** Do the other thing.
`

  const tasksWithNotes = parsePlan(withNotes)
  const tasksWithoutNotes = parsePlan(withoutNotes)

  assert.deepEqual(
    tasksWithNotes.map(({ id, title, files, deps }) => ({ id, title, files, deps })),
    tasksWithoutNotes.map(({ id, title, files, deps }) => ({ id, title, files, deps })),
  )

  const phasesWithNotes = assignPhases(tasksWithNotes)
  const phasesWithoutNotes = assignPhases(tasksWithoutNotes)

  assert.deepEqual(
    phasesWithNotes.map((t) => t.phase),
    phasesWithoutNotes.map((t) => t.phase),
  )
})
