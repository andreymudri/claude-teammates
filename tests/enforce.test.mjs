import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePath,
  taskBranchName,
  resolveTaskBranch,
  filesetViolations,
  ownershipViolations,
  completionBlock,
} from '../scripts/enforce.mjs'

test('backslashes, leading ./ and leading / all normalize to a bare posix path', () => {
  assert.equal(normalizePath('scripts\\git.mjs'), 'scripts/git.mjs')
  assert.equal(normalizePath('./scripts/git.mjs'), 'scripts/git.mjs')
  assert.equal(normalizePath('/scripts/git.mjs'), 'scripts/git.mjs')
})

test('a change inside the declared set is not a violation', () => {
  assert.deepEqual(filesetViolations(['a.mjs'], ['a.mjs', 'b.mjs']), [])
})

test('a change outside the declared set is a violation', () => {
  assert.deepEqual(filesetViolations(['a.mjs', 'secret.mjs'], ['a.mjs']), ['secret.mjs'])
})

test('separator style does not create a false violation', () => {
  assert.deepEqual(filesetViolations(['scripts/git.mjs'], ['scripts\\git.mjs']), [])
})

test('a case-only mismatch is a violation', () => {
  assert.deepEqual(filesetViolations(['Scripts/Git.mjs'], ['scripts/git.mjs']), ['Scripts/Git.mjs'])
})

test('a glob in the declared set matches nothing and reads as a violation', () => {
  assert.deepEqual(filesetViolations(['scripts/git.mjs'], ['scripts/*.mjs']), ['scripts/git.mjs'])
})

test('an empty diff is never a violation', () => {
  assert.deepEqual(filesetViolations([], ['a.mjs']), [])
})

test('a task declaring no files makes every change a violation', () => {
  assert.deepEqual(filesetViolations(['a.mjs'], []), ['a.mjs'])
})

test('the branch convention is teammates/<runId>/<taskId>', () => {
  assert.equal(taskBranchName('r1', 'T1'), 'teammates/r1/T1')
})

test('a recorded branch beats the convention', () => {
  assert.equal(resolveTaskBranch({ id: 'T1', branch: 'custom' }, 'r1'), 'custom')
})

test('with no recorded branch the convention is used', () => {
  assert.equal(resolveTaskBranch({ id: 'T1' }, 'r1'), 'teammates/r1/T1')
})

test('a task with neither id nor branch resolves to null', () => {
  assert.equal(resolveTaskBranch({}, 'r1'), null)
})

test('an empty-string branch resolves to null instead of failing open', () => {
  assert.equal(resolveTaskBranch({ id: 'T1', branch: '' }, 'r1'), null)
})

test('a whitespace-only branch resolves to null instead of failing open', () => {
  assert.equal(resolveTaskBranch({ id: 'T1', branch: '   ' }, 'r1'), null)
})

test('an unmoved, clean main worktree with distinct task branches has no violations', () => {
  const v = ownershipViolations({
    runBranch: 'main', baseSha: 'abc', headSha: 'abc', dirty: false, taskBranches: ['teammates/r1/T1'],
  })
  assert.deepEqual(v, [])
})

test('a task branch equal to the run branch is a violation', () => {
  const v = ownershipViolations({
    runBranch: 'main', baseSha: 'abc', headSha: 'abc', dirty: false, taskBranches: ['main'],
  })
  assert.equal(v.length, 1)
  assert.match(v[0], /only tm-integrator writes there/)
})

test('a case-only alias of the run branch is a violation', () => {
  const v = ownershipViolations({
    runBranch: 'main', baseSha: 'abc', headSha: 'abc', dirty: false, taskBranches: ['Main'],
  })
  assert.equal(v.length, 1)
  assert.match(v[0], /only tm-integrator writes there/)
})

test('a refs/heads/ prefixed alias of the run branch is a violation', () => {
  const v = ownershipViolations({
    runBranch: 'main', baseSha: 'abc', headSha: 'abc', dirty: false, taskBranches: ['refs/heads/main'],
  })
  assert.equal(v.length, 1)
  assert.match(v[0], /only tm-integrator writes there/)
})

test('a heads/ prefixed alias of the run branch is a violation', () => {
  const v = ownershipViolations({
    runBranch: 'main', baseSha: 'abc', headSha: 'abc', dirty: false, taskBranches: ['heads/main'],
  })
  assert.equal(v.length, 1)
  assert.match(v[0], /only tm-integrator writes there/)
})

test('a moved main HEAD is a violation naming the integrated command', () => {
  const v = ownershipViolations({ runBranch: 'main', baseSha: 'abc', headSha: 'def', dirty: false })
  assert.equal(v.length, 1)
  assert.match(v[0], /cli\.mjs integrated/)
})

test('a dirty main worktree is a violation', () => {
  const v = ownershipViolations({ runBranch: 'main', baseSha: 'abc', headSha: 'abc', dirty: true })
  assert.equal(v.length, 1)
  assert.match(v[0], /uncommitted changes/)
})

test('a missing runBranch or baseSha is itself a violation and short-circuits', () => {
  const v = ownershipViolations({ runBranch: null, baseSha: null, headSha: 'abc', dirty: true })
  assert.equal(v.length, 1)
  assert.match(v[0], /init-run/)
})

test('completion is blocked when no gate is recorded', () => {
  assert.match(completionBlock({ gates: {} }, 'default'), /no gate recorded/)
})

test('completion is blocked when the recorded gate is FAIL', () => {
  assert.match(completionBlock({ gates: { default: { verdict: 'FAIL' } } }, 'default'), /not PASS/)
})

test('completion is allowed on a recorded PASS', () => {
  assert.equal(completionBlock({ gates: { default: { verdict: 'PASS' } } }, 'default'), null)
})

test('completion is blocked when status is missing entirely', () => {
  assert.match(completionBlock(null, 'default'), /no gate recorded/)
})
