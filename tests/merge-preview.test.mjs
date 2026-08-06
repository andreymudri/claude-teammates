import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { withMergePreview, conflictPairs } from '../scripts/merge-preview.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

function fakeGit({ conflictPaths = null } = {}) {
  const calls = []
  return {
    calls,
    async addWorktreeDetached(dir, ref) {
      calls.push({ op: 'addWorktreeDetached', dir, ref })
      return dir
    },
    async mergeInto(dir, branches) {
      calls.push({ op: 'mergeInto', dir, branches })
      return conflictPaths
    },
    async removeWorktree(dir) {
      calls.push({ op: 'removeWorktree', dir })
      return true
    },
  }
}

// A git accessor that records operation order into a shared array, so tests can pin whether
// the worktree teardown happens before or after the callback settles.
function orderedGit(order, { conflictPaths = null } = {}) {
  return {
    async addWorktreeDetached(dir, ref) {
      order.push('addWorktreeDetached')
      return dir
    },
    async mergeInto(dir, branches) {
      order.push('mergeInto')
      return conflictPaths
    },
    async removeWorktree(dir) {
      order.push('removeWorktree')
      return true
    },
  }
}

test('a clean merge calls run with a non-null path and the merged branch list', async () => {
  const git = fakeGit()
  const branches = ['teammates/r1/T1', 'teammates/r1/T2']
  let received = null
  await withMergePreview({
    git, base: 'main', branches,
    run: async (args) => { received = args },
  })
  assert.ok(received.path, 'expected a non-null worktree path')
  assert.deepEqual(received.merged, branches)
})

test('an empty branch list calls run with path: null, merged: [] and never creates a worktree', async () => {
  const git = fakeGit()
  let received = null
  await withMergePreview({
    git, base: 'main', branches: [],
    run: async (args) => { received = args },
  })
  assert.deepEqual(received, { path: null, merged: [] })
  assert.equal(git.calls.length, 0, 'no git calls should have been made')
})

test('a conflict calls run with path: null and the conflict report, never with a worktree path', async () => {
  const git = fakeGit({ conflictPaths: ['scripts/cli.mjs'] })
  const branches = ['teammates/r1/T3', 'teammates/r1/T8']
  let received = null
  await withMergePreview({
    git, base: 'main', branches,
    run: async (args) => { received = args },
  })
  assert.equal(received.path, null)
  assert.deepEqual(received.conflict, ['scripts/cli.mjs'])
  assert.equal(received.merged, undefined)
})

test('the worktree is removed after a clean merge', async () => {
  const git = fakeGit()
  await withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} })
  const removeCalls = git.calls.filter((c) => c.op === 'removeWorktree')
  assert.equal(removeCalls.length, 1)
})

test('the worktree is removed after a conflict', async () => {
  const git = fakeGit({ conflictPaths: ['a.mjs'] })
  await withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} })
  const removeCalls = git.calls.filter((c) => c.op === 'removeWorktree')
  assert.equal(removeCalls.length, 1)
})

test('an empty conflict array is a failed preview, not a clean merge and not a reportable conflict', async () => {
  // mergeInto can return [] when the merge fails without leaving unmerged paths: an octopus
  // merge of 3+ branches resets the index before exiting, and non-conflict failures (unset
  // user.email, a deleted branch, unrelated histories, a stale index.lock) never produce one
  // either. `[]` must not be treated as truthy-conflict-with-no-branches, and must not fall
  // through to the clean path. withMergePreview throws instead, so the failure can never be
  // mistaken for either outcome by a caller.
  const git = fakeGit({ conflictPaths: [] })
  let runCalled = false
  await assert.rejects(
    () => withMergePreview({
      git, base: 'main', branches: ['T1'],
      run: async () => { runCalled = true },
    }),
    /merge preview failed/,
  )
  assert.equal(runCalled, false, 'the callback must not run on a failed preview')
  const removeCalls = git.calls.filter((c) => c.op === 'removeWorktree')
  assert.equal(removeCalls.length, 1, 'the worktree must still be cleaned up')
})

test('the clean-merge branch awaits the callback before removing the worktree', async () => {
  const order = []
  const git = orderedGit(order)
  await withMergePreview({
    git, base: 'main', branches: ['T1'],
    run: async () => {
      order.push('run:start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('run:end')
    },
  })
  assert.deepEqual(order, ['addWorktreeDetached', 'mergeInto', 'run:start', 'run:end', 'removeWorktree'])
})

test('the conflict branch awaits the callback before removing the worktree', async () => {
  const order = []
  const git = orderedGit(order, { conflictPaths: ['a.mjs'] })
  await withMergePreview({
    git, base: 'main', branches: ['T1'],
    run: async () => {
      order.push('run:start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('run:end')
    },
  })
  assert.deepEqual(order, ['addWorktreeDetached', 'mergeInto', 'run:start', 'run:end', 'removeWorktree'])
})

test('an accessor that throws from addWorktreeDetached still cleans up and propagates the error', async () => {
  const git = fakeGit()
  git.addWorktreeDetached = async (dir, ref) => {
    git.calls.push({ op: 'addWorktreeDetached', dir, ref })
    throw new Error('boom-add')
  }
  await assert.rejects(
    () => withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} }),
    /boom-add/,
  )
  const removeCalls = git.calls.filter((c) => c.op === 'removeWorktree')
  assert.equal(removeCalls.length, 1, 'the worktree must still be cleaned up even when addWorktreeDetached throws')
})

test('the worktree is removed after run throws, and the throw propagates', async () => {
  const git = fakeGit()
  await assert.rejects(
    () => withMergePreview({
      git, base: 'main', branches: ['T1'],
      run: async () => { throw new Error('boom') },
    }),
    /boom/,
  )
  const removeCalls = git.calls.filter((c) => c.op === 'removeWorktree')
  assert.equal(removeCalls.length, 1)
})

test('the directory handed to addWorktreeDetached is under os.tmpdir(), not under the repository root', async () => {
  const git = fakeGit()
  await withMergePreview({ git, base: 'main', branches: ['T1'], run: async () => {} })
  const addCall = git.calls.find((c) => c.op === 'addWorktreeDetached')
  assert.ok(addCall, 'expected addWorktreeDetached to be called')
  const relativeToTmp = path.relative(tmpdir(), addCall.dir)
  assert.ok(!relativeToTmp.startsWith('..') && !path.isAbsolute(relativeToTmp),
    `expected ${addCall.dir} to be under ${tmpdir()}`)
  const relativeToRepo = path.relative(REPO_ROOT, addCall.dir)
  assert.ok(relativeToRepo.startsWith('..') || path.isAbsolute(relativeToRepo),
    `expected ${addCall.dir} to NOT be under the repository root ${REPO_ROOT}`)
})

test('conflictPairs returns [] for no paths', () => {
  assert.deepEqual(conflictPairs(['T1', 'T2'], []), [])
})

test('conflictPairs returns one pair naming every branch and path otherwise', () => {
  const branches = ['teammates/r1/T3', 'teammates/r1/T8']
  const paths = ['scripts/cli.mjs', 'scripts/gate-runner.mjs']
  assert.deepEqual(conflictPairs(branches, paths), [{ branches, paths }])
})
