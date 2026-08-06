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
