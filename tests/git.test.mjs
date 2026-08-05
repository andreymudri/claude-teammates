import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGit, GitError, defaultGitExec } from '../scripts/git.mjs'

const recorder = (result = { code: 0, stdout: '', stderr: '' }) => {
  const calls = []
  const exec = async (args) => { calls.push(args); return result }
  return { calls, exec }
}

test('changedFiles diffs the merge base with three dots, NUL-delimited and unquoted', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'a.mjs\0b.mjs\0', stderr: '' })
  const files = await createGit({ cwd: '/x', exec }).changedFiles({ base: 'main', branch: 'tm/1' })
  assert.deepEqual(calls[0], [
    '-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--end-of-options', 'main...tm/1', '--',
  ])
  assert.deepEqual(files, ['a.mjs', 'b.mjs'])
})

test('changedFiles does not let a leading-dash base reach option position', async () => {
  const { calls, exec } = recorder({ code: 128, stdout: '', stderr: 'bad revision' })
  await assert.rejects(
    () => createGit({ exec }).changedFiles({ base: '--output=stolen', branch: 'T1' }),
    GitError,
  )
  assert.deepEqual(calls[0], [
    '-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--end-of-options', '--output=stolen...T1', '--',
  ])
})

test('changedFiles drops empty NUL-delimited entries', async () => {
  const { exec } = recorder({ code: 0, stdout: 'a.mjs\0\0', stderr: '' })
  assert.deepEqual(await createGit({ exec }).changedFiles({ base: 'm', branch: 'b' }), ['a.mjs'])
})

test('changedFiles does not mangle a non-ASCII path', async () => {
  const { exec } = recorder({ code: 0, stdout: 'café.mjs\0', stderr: '' })
  assert.deepEqual(await createGit({ exec }).changedFiles({ base: 'm', branch: 'b' }), ['café.mjs'])
})

test('changedFiles does not trim a leading-space filename into a different name', async () => {
  const { exec } = recorder({ code: 0, stdout: ' a.mjs\0', stderr: '' })
  assert.deepEqual(await createGit({ exec }).changedFiles({ base: 'm', branch: 'b' }), [' a.mjs'])
})

test('a non-zero exit throws GitError carrying stderr', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: 'not a git repository' })
  await assert.rejects(
    () => createGit({ exec }).headSha(),
    (err) => err instanceof GitError && /not a git repository/.test(err.message),
  )
})

test('headSha returns the trimmed sha on success', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc123\n', stderr: '' })
  assert.equal(await createGit({ exec }).headSha(), 'abc123')
  assert.deepEqual(calls[0], ['rev-parse', 'HEAD'])
})

test('branchExists answers false on exit 1 instead of throwing', async () => {
  const { calls, exec } = recorder({ code: 1, stdout: '', stderr: '' })
  assert.equal(await createGit({ exec }).branchExists('teammates/r1/T1'), false)
  assert.deepEqual(calls[0], ['rev-parse', '--verify', '--quiet', 'refs/heads/teammates/r1/T1'])
})

test('branchExists throws GitError on exit 128 rather than reporting the branch absent', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: 'not a git repository' })
  await assert.rejects(
    () => createGit({ exec }).branchExists('teammates/r1/T1'),
    (err) => err instanceof GitError && /not a git repository/.test(err.message),
  )
})

test('isDirty is true when porcelain output is non-empty', async () => {
  const { exec } = recorder({ code: 0, stdout: ' M scripts/git.mjs\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), true)
})

test('isDirty is false when porcelain output is empty', async () => {
  const { exec } = recorder({ code: 0, stdout: '\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), false)
})

test('currentBranch trims the abbreviated ref', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'master\n', stderr: '' })
  assert.equal(await createGit({ exec }).currentBranch(), 'master')
  assert.deepEqual(calls[0], ['rev-parse', '--abbrev-ref', 'HEAD'])
})

test('against a real repository, changedFiles reports the branch-only change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'task.txt'), 'task\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'task'])

    assert.deepEqual(await git.changedFiles({ base: 'main', branch: 'teammates/r1/T1' }), ['task.txt'])
    assert.equal(await git.branchExists('teammates/r1/T1'), true)
    assert.equal(await git.branchExists('teammates/r1/T9'), false)
    assert.equal(await git.isDirty(), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('changedFiles fails closed instead of resolving the rev string as a pathspec', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])

    // No branch named "ghost" exists, but a file whose name equals the rev string does.
    // Without --end-of-options/--, git resolves "main...ghost" as a pathspec instead of a
    // revision range, exiting 0 with empty output — a silent, false "no changes".
    await writeFile(path.join(root, 'main...ghost'), 'planted\n', 'utf8')

    await assert.rejects(
      () => git.changedFiles({ base: 'main', branch: 'ghost' }),
      GitError,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
