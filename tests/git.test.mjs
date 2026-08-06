import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGit, GitError, defaultGitExec, teammateRef } from '../scripts/git.mjs'

const recorder = (result = { code: 0, stdout: '', stderr: '' }) => {
  const calls = []
  const exec = async (args) => { calls.push(args); return result }
  return { calls, exec }
}

test('changedFiles diffs the merge base with three dots, NUL-delimited and unquoted', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'a.mjs\0b.mjs\0', stderr: '' })
  const files = await createGit({ cwd: '/x', exec }).changedFiles({ base: 'main', branch: 'tm/1' })
  assert.deepEqual(calls[0], [
    '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z',
    '--end-of-options', 'main...tm/1', '--',
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
    '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z',
    '--end-of-options', '--output=stolen...T1', '--',
  ])
})

test('changedFiles rejects an empty base string instead of silently diffing against HEAD', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await assert.rejects(
    () => createGit({ exec }).changedFiles({ base: '', branch: 'task' }),
    GitError,
  )
  assert.deepEqual(calls, [])
})

test('changedFiles rejects an empty branch string instead of silently diffing against HEAD', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await assert.rejects(
    () => createGit({ exec }).changedFiles({ base: 'main', branch: '' }),
    GitError,
  )
  assert.deepEqual(calls, [])
})

test('changedFiles rejects a non-string branch rather than stringifying it', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await assert.rejects(
    () => createGit({ exec }).changedFiles({ base: 'main', branch: [] }),
    GitError,
  )
  assert.deepEqual(calls, [])
})

test('changedFiles rejects a whitespace-only base', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await assert.rejects(
    () => createGit({ exec }).changedFiles({ base: '   ', branch: 'task' }),
    GitError,
  )
  assert.deepEqual(calls, [])
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

test('changedFiles reports the pre-image path of a rename, not just the post-image', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    // shared.txt belongs to a different task; only mine.txt is in this task's declared set.
    await writeFile(path.join(root, 'shared.txt'), 'shared\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await sh(['mv', 'shared.txt', 'mine.txt'])
    await sh(['commit', '-m', 'rename shared.txt away'])

    const changed = await git.changedFiles({ base: 'main', branch: 'teammates/r1/T1' })
    // With rename detection on, git reports only mine.txt (the post-image) and the
    // deletion of shared.txt — a file this task never declared — goes unseen.
    assert.ok(changed.includes('shared.txt'), `pre-image shared.txt missing from ${JSON.stringify(changed)}`)
    assert.ok(changed.includes('mine.txt'), `post-image mine.txt missing from ${JSON.stringify(changed)}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultGitExec rejects with GitError, not a plain Error, when the process cannot be spawned', async () => {
  const missingCwd = path.join(tmpdir(), `tm-git-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await assert.rejects(
    () => defaultGitExec(['status'], missingCwd),
    GitError,
  )
})

// --- mergeBase --------------------------------------------------------------------------

test('mergeBase builds the argv exactly, with no trailing -- (merge-base rejects one)', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc123\n', stderr: '' })
  const sha = await createGit({ exec }).mergeBase('a', 'b')
  assert.deepEqual(calls[0], ['merge-base', '--end-of-options', 'a', 'b'])
  assert.equal(sha, 'abc123')
})

test('mergeBase rejects an empty or non-string ref with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).mergeBase('', 'b'), GitError)
  await assert.rejects(() => createGit({ exec }).mergeBase('a', ''), GitError)
  await assert.rejects(() => createGit({ exec }).mergeBase('a', []), GitError)
  assert.deepEqual(calls, [])
})

// --- isAncestor --------------------------------------------------------------------------

test('isAncestor builds the argv exactly, with no trailing --, and returns true on exit 0', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  assert.equal(await createGit({ exec }).isAncestor('a', 'b'), true)
  assert.deepEqual(calls[0], ['merge-base', '--is-ancestor', '--end-of-options', 'a', 'b'])
})

test('isAncestor returns false on exit 1', async () => {
  const { exec } = recorder({ code: 1, stdout: '', stderr: '' })
  assert.equal(await createGit({ exec }).isAncestor('a', 'b'), false)
})

test('isAncestor throws GitError on exit 128 rather than reporting false', async () => {
  const { exec } = recorder({ code: 128, stdout: '', stderr: 'bad revision' })
  await assert.rejects(() => createGit({ exec }).isAncestor('a', 'b'), GitError)
})

test('isAncestor rejects an empty or non-string ref with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).isAncestor('', 'b'), GitError)
  await assert.rejects(() => createGit({ exec }).isAncestor('a', ''), GitError)
  assert.deepEqual(calls, [])
})

// --- commitsBetween ------------------------------------------------------------------------

test('commitsBetween builds the argv with a trailing --, and drops blank lines', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'sha1\nsha2\n\n', stderr: '' })
  const shas = await createGit({ exec }).commitsBetween({ from: 'a', to: 'b' })
  assert.deepEqual(calls[0], ['rev-list', '--end-of-options', 'a..b', '--'])
  assert.deepEqual(shas, ['sha1', 'sha2'])
})

test('commitsBetween rejects an empty or non-string from/to with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).commitsBetween({ from: '', to: 'b' }), GitError)
  await assert.rejects(() => createGit({ exec }).commitsBetween({ from: 'a', to: '' }), GitError)
  assert.deepEqual(calls, [])
})

// --- commitParents ------------------------------------------------------------------------

test('commitParents builds the argv with a trailing --, and slices the sha off the front', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'child parent1 parent2\n', stderr: '' })
  const parents = await createGit({ exec }).commitParents('child')
  assert.deepEqual(calls[0], ['rev-list', '--parents', '-n', '1', '--end-of-options', 'child', '--'])
  assert.deepEqual(parents, ['parent1', 'parent2'])
})

test('commitParents rejects an empty or non-string sha with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).commitParents(''), GitError)
  await assert.rejects(() => createGit({ exec }).commitParents([]), GitError)
  assert.deepEqual(calls, [])
})

// --- branchSha -----------------------------------------------------------------------------

test('branchSha prefixes refs/heads/ and adds a trailing --', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc123\n', stderr: '' })
  const sha = await createGit({ exec }).branchSha('teammates/r1/T1')
  assert.deepEqual(calls[0], ['rev-parse', '--verify', '--end-of-options', 'refs/heads/teammates/r1/T1', '--'])
  assert.equal(sha, 'abc123')
})

test('branchSha rejects an empty or non-string name with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).branchSha(''), GitError)
  await assert.rejects(() => createGit({ exec }).branchSha(null), GitError)
  assert.deepEqual(calls, [])
})

// --- fileAtCommit ----------------------------------------------------------------------------

test('fileAtCommit builds the argv with a trailing --', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'file contents\n', stderr: '' })
  const contents = await createGit({ exec }).fileAtCommit('sha1', 'docs/plan.md')
  assert.deepEqual(calls[0], ['show', '--end-of-options', 'sha1:docs/plan.md', '--'])
  assert.equal(contents, 'file contents\n')
})

test('fileAtCommit rejects an empty or non-string sha/path with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).fileAtCommit('', 'a.md'), GitError)
  await assert.rejects(() => createGit({ exec }).fileAtCommit('sha1', ''), GitError)
  assert.deepEqual(calls, [])
})

// --- resolveRef ------------------------------------------------------------------------------

test('resolveRef builds the argv exactly and returns the trimmed sha', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc123\n', stderr: '' })
  const sha = await createGit({ exec }).resolveRef('refs/heads/teammates/r1/T1')
  assert.deepEqual(calls[0], ['rev-parse', '--verify', '--end-of-options', 'refs/heads/teammates/r1/T1', '--'])
  assert.equal(sha, 'abc123')
})

test('resolveRef rejects a ref that is not fully qualified', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).resolveRef('teammates/r1/T1'), GitError)
  await assert.rejects(() => createGit({ exec }).resolveRef(''), GitError)
  await assert.rejects(() => createGit({ exec }).resolveRef(null), GitError)
  assert.deepEqual(calls, [])
})

// --- fetchRefspec ----------------------------------------------------------------------------

test('fetchRefspec builds the argv with --no-tags and returns the resolved dst sha', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc123\n', stderr: '' })
  const sha = await createGit({ exec }).fetchRefspec({
    from: '/path/to/clone',
    src: 'refs/heads/teammates/r1/T1',
    dst: 'refs/teammates/r1/T1',
  })
  assert.deepEqual(calls[0], [
    'fetch', '--no-tags', '--end-of-options', '/path/to/clone',
    '+refs/heads/teammates/r1/T1:refs/teammates/r1/T1',
  ])
  assert.deepEqual(calls[1], ['rev-parse', '--verify', '--end-of-options', 'refs/teammates/r1/T1', '--'])
  assert.equal(sha, 'abc123')
})

test('fetchRefspec rejects an unqualified src or dst', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(
    () => createGit({ exec }).fetchRefspec({ from: '/x', src: 'teammates/r1/T1', dst: 'refs/teammates/r1/T1' }),
    GitError,
  )
  await assert.rejects(
    () => createGit({ exec }).fetchRefspec({ from: '/x', src: 'refs/heads/teammates/r1/T1', dst: 'teammates/r1/T1' }),
    GitError,
  )
  assert.deepEqual(calls, [])
})

test('fetchRefspec rejects an empty from/src/dst', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(
    () => createGit({ exec }).fetchRefspec({ from: '', src: 'refs/heads/a', dst: 'refs/teammates/a' }),
    GitError,
  )
  assert.deepEqual(calls, [])
})

// --- teammateRef -------------------------------------------------------------------------

test('teammateRef names the orchestrator-only namespace', () => {
  assert.equal(teammateRef('r1', 'T1'), 'refs/teammates/r1/T1')
})

// --- real-git regression: tag shadowing ---------------------------------------------------

test('resolveRef reads the branch tip even when a tag of the same name shadows it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-shadow-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    const baseSha = (await git.headSha())

    // The branch under test carries a real, honest change.
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'task.txt'), 'task\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'task'])
    const branchSha = (await git.headSha())

    // A teammate plants a tag with the SAME NAME as its branch, pointing at the earlier,
    // unchanged commit. A bare-name lookup ("teammates/r1/T1") resolves through refs/tags/
    // BEFORE refs/heads/, so `git diff <anchor>...teammates/r1/T1` would report NO changes
    // — the pass signal — while the branch itself still carries the honest task.txt change.
    await sh(['tag', 'teammates/r1/T1', baseSha])

    // A bare-name diff is fooled by the tag: it reports no changes at all.
    const shadowedDiff = await defaultGitExec(
      ['diff', '--name-only', 'main...teammates/r1/T1'], root,
    )
    assert.equal(shadowedDiff.stdout.trim(), '', 'expected the bare-name diff to be shadowed by the tag')

    // resolveRef, given the fully-qualified branch ref, is immune: it must resolve to the
    // branch's real tip, not the tag's, and a diff by that resolved sha must see task.txt.
    const resolved = await git.resolveRef('refs/heads/teammates/r1/T1')
    assert.equal(resolved, branchSha, 'resolveRef must report the honest branch tip, not the shadowing tag')
    assert.notEqual(resolved, baseSha)

    const changed = await git.changedFiles({ base: 'main', branch: resolved })
    assert.deepEqual(changed, ['task.txt'], 'diffing by the resolved sha must see the branch change the tag hid')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- addWorktreeDetached --------------------------------------------------------------------

test('addWorktreeDetached issues worktree add --detach --end-of-options <dir> <ref>', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  const dir = await createGit({ exec }).addWorktreeDetached('/tmp/wt', 'teammates/r1/T1')
  assert.deepEqual(calls[0], ['worktree', 'add', '--detach', '--end-of-options', '/tmp/wt', 'teammates/r1/T1'])
  assert.equal(dir, '/tmp/wt')
})

test('addWorktreeDetached rejects an empty or non-string dir/ref with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).addWorktreeDetached('', 'ref'), GitError)
  await assert.rejects(() => createGit({ exec }).addWorktreeDetached('dir', ''), GitError)
  await assert.rejects(() => createGit({ exec }).addWorktreeDetached('dir', []), GitError)
  assert.deepEqual(calls, [])
})

// --- removeWorktree ----------------------------------------------------------------------

test('removeWorktree issues worktree remove --force --end-of-options <dir>', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  const ok = await createGit({ exec }).removeWorktree('/tmp/wt')
  assert.deepEqual(calls[0], ['worktree', 'remove', '--force', '--end-of-options', '/tmp/wt'])
  assert.equal(ok, true)
})

test('removeWorktree rejects an empty dir with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).removeWorktree(''), GitError)
  assert.deepEqual(calls, [])
})

// --- mergeInto -----------------------------------------------------------------------------

test('mergeInto returns null when the merge exits 0', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  const result = await createGit({ exec }).mergeInto('/tmp/wt', ['teammates/r1/T1', 'teammates/r1/T2'])
  assert.equal(result, null)
  assert.deepEqual(calls[0], [
    '-C', '/tmp/wt', 'merge', '--no-ff', '-m', 'gate merge preview', '--end-of-options',
    'teammates/r1/T1', 'teammates/r1/T2',
  ])
})

test('mergeInto rejects an empty or non-string dir with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).mergeInto('', ['b']), GitError)
  assert.deepEqual(calls, [])
})

test('mergeInto returns the conflicted paths instead of throwing when the merge exits non-zero', async () => {
  let call = 0
  const calls = []
  const exec = async (args) => {
    calls.push(args)
    call += 1
    if (call === 1) return { code: 1, stdout: '', stderr: 'CONFLICT' }
    return { code: 0, stdout: 'shared.txt\nother.txt\n', stderr: '' }
  }
  const result = await createGit({ exec }).mergeInto('/tmp/wt', ['a', 'b'])
  assert.deepEqual(result, ['shared.txt', 'other.txt'])
  assert.deepEqual(calls[0], [
    '-C', '/tmp/wt', 'merge', '--no-ff', '-m', 'gate merge preview', '--end-of-options', 'a', 'b',
  ])
  assert.deepEqual(calls[1], ['-C', '/tmp/wt', 'diff', '--name-only', '--diff-filter=U'])
})

// --- real-repository: mergeInto -------------------------------------------------------------

test('against a real repository, mergeInto merges cleanly across different files and reports conflicts on the same line', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-merge-'))
  const wtCleanDir = await mkdtemp(path.join(tmpdir(), 'tm-git-merge-wt-clean-'))
  const wtConflictDir = await mkdtemp(path.join(tmpdir(), 'tm-git-merge-wt-conflict-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'shared.txt'), 'base\n', 'utf8')
    await writeFile(path.join(root, 'other.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])

    // Two branches that touch different files merge cleanly.
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.txt'), 'a\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'add a.txt'])
    await sh(['checkout', 'main'])

    await sh(['checkout', '-b', 'teammates/r1/T2'])
    await writeFile(path.join(root, 'b.txt'), 'b\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'add b.txt'])
    await sh(['checkout', 'main'])

    await sh(['worktree', 'add', '--detach', '--end-of-options', wtCleanDir, 'main'])
    const cleanResult = await git.mergeInto(wtCleanDir, ['teammates/r1/T1', 'teammates/r1/T2'])
    assert.equal(cleanResult, null)
    await sh(['worktree', 'remove', '--force', '--end-of-options', wtCleanDir])

    // Two branches that edit the same line conflict, and reporting that must not throw.
    await sh(['checkout', '-b', 'teammates/r1/T3'])
    await writeFile(path.join(root, 'shared.txt'), 'from-t3\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'edit shared.txt on T3'])
    await sh(['checkout', 'main'])

    await sh(['checkout', '-b', 'teammates/r1/T4'])
    await writeFile(path.join(root, 'shared.txt'), 'from-t4\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'edit shared.txt on T4'])
    await sh(['checkout', 'main'])

    await sh(['worktree', 'add', '--detach', '--end-of-options', wtConflictDir, 'main'])
    const conflictResult = await git.mergeInto(wtConflictDir, ['teammates/r1/T3', 'teammates/r1/T4'])
    assert.deepEqual(conflictResult, ['shared.txt'])
  } finally {
    await rm(wtCleanDir, { recursive: true, force: true })
    await rm(wtConflictDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})
