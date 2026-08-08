import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

// The harness creates these for the whole run. Counting them would fail ownership at every
// phase of every fleet, in any repo that has not happened to ignore the path.
test('isDirty ignores the harness worktree directory', async () => {
  const { exec } = recorder({ code: 0, stdout: '?? .claude/\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), false)
})

test('isDirty ignores nested harness worktree paths', async () => {
  const { exec } = recorder({ code: 0, stdout: '?? .claude/worktrees/wf_abc-1/src/x.mjs\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), false)
})

// The exemption is one path, not a licence for untracked files generally.
test('isDirty still reports a stray untracked file alongside harness worktrees', async () => {
  const { exec } = recorder({ code: 0, stdout: '?? .claude/\n?? stray.mjs\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), true)
})

test('isDirty still reports a modified tracked file alongside harness worktrees', async () => {
  const { exec } = recorder({ code: 0, stdout: '?? .claude/\n M scripts/git.mjs\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), true)
})

// A path merely starting with the same letters is not the harness directory.
test('isDirty does not exempt a lookalike path', async () => {
  const { exec } = recorder({ code: 0, stdout: '?? .claude-notes/x.md\n', stderr: '' })
  assert.equal(await createGit({ exec }).isDirty(), true)
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

test('addWorktreeDetached resolves the name through refs/heads/ before worktree add', async () => {
  const calls = []
  const exec = async (args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return { code: 0, stdout: 'aaaa111\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const dir = await createGit({ exec }).addWorktreeDetached('/tmp/wt', 'teammates/r1/T1')
  assert.deepEqual(calls[0], [
    'rev-parse', '--verify', '--quiet', '--end-of-options', 'refs/heads/teammates/r1/T1', '--',
  ])
  // The sha, never the bare name: a tag named teammates/r1/T1 must not be what gets checked out.
  assert.deepEqual(calls[1], ['worktree', 'add', '--detach', '--end-of-options', '/tmp/wt', 'aaaa111'])
  assert.equal(dir, '/tmp/wt')
})

test('addWorktreeDetached falls back to the given ref when no such branch exists', async () => {
  const calls = []
  const exec = async (args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  await createGit({ exec }).addWorktreeDetached('/tmp/wt', 'deadbeef')
  assert.deepEqual(calls[1], ['worktree', 'add', '--detach', '--end-of-options', '/tmp/wt', 'deadbeef'])
})

test('addWorktreeDetached passes an already-qualified ref through untouched', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: '', stderr: '' })
  await createGit({ exec }).addWorktreeDetached('/tmp/wt', 'refs/teammates/r1/T1')
  assert.deepEqual(calls[0], [
    'worktree', 'add', '--detach', '--end-of-options', '/tmp/wt', 'refs/teammates/r1/T1',
  ])
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

// One merge per branch, each resolved through refs/heads/ first. Handing git three or more
// heads at once selects the octopus strategy, which resets the index before exiting and so
// destroys the conflicted set the gate has to report.
const mergeMock = ({ mergeResults = {}, unmerged = '', resolve = (n) => `sha-${n}` } = {}) => {
  const calls = []
  const exec = async (args) => {
    calls.push(args)
    if (args.includes('rev-parse')) {
      const ref = args[args.length - 2]
      const name = ref.replace(/^refs\/heads\//, '')
      const sha = resolve(name)
      return sha ? { code: 0, stdout: `${sha}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' }
    }
    if (args.includes('merge')) return mergeResults[args[args.length - 1]] ?? { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: unmerged, stderr: '' }
  }
  return { calls, exec }
}

test('mergeInto merges one branch at a time and returns null when each exits 0', async () => {
  const { calls, exec } = mergeMock()
  const result = await createGit({ exec }).mergeInto('/tmp/wt', ['teammates/r1/T1', 'teammates/r1/T2'])
  assert.equal(result, null)
  assert.deepEqual(calls[0], [
    '-C', '/tmp/wt', 'rev-parse', '--verify', '--quiet', '--end-of-options',
    'refs/heads/teammates/r1/T1', '--',
  ])
  assert.deepEqual(calls[1], [
    '-C', '/tmp/wt', 'merge', '--no-ff', '-m', 'gate merge preview', '--end-of-options',
    'sha-teammates/r1/T1',
  ])
  assert.deepEqual(calls[3], [
    '-C', '/tmp/wt', 'merge', '--no-ff', '-m', 'gate merge preview', '--end-of-options',
    'sha-teammates/r1/T2',
  ])
})

test('mergeInto rejects an empty or non-string dir with GitError', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).mergeInto('', ['b']), GitError)
  assert.deepEqual(calls, [])
})

test('mergeInto rejects a missing or non-string branch list with GitError', async () => {
  const { calls, exec } = recorder()
  const git = createGit({ exec })
  await assert.rejects(() => git.mergeInto('/tmp/wt'), GitError)
  await assert.rejects(() => git.mergeInto('/tmp/wt', []), GitError)
  await assert.rejects(() => git.mergeInto('/tmp/wt', ['a', '']), GitError)
  await assert.rejects(() => git.mergeInto('/tmp/wt', 'a'), GitError)
  assert.deepEqual(calls, [])
})

test('mergeInto returns the conflicted paths instead of throwing when the merge exits non-zero', async () => {
  const { calls, exec } = mergeMock({
    mergeResults: { 'sha-a': { code: 1, stdout: '', stderr: 'CONFLICT' } },
    unmerged: 'shared.txt\nother.txt\n',
  })
  const result = await createGit({ exec }).mergeInto('/tmp/wt', ['a', 'b'])
  assert.deepEqual(result, ['shared.txt', 'other.txt'])
  assert.deepEqual(calls[2], ['-C', '/tmp/wt', 'diff', '--name-only', '--diff-filter=U'])
})

test('mergeInto throws a GitError carrying stderr when a merge fails with nothing unmerged', async () => {
  const { exec } = mergeMock({
    mergeResults: { 'sha-a': { code: 128, stdout: '', stderr: '*** Please tell me who you are.\nCommitter identity unknown' } },
    unmerged: '',
  })
  // An empty array is truthy: reporting one here would name a conflict with no paths and no
  // reason. The failure must surface as a failure, with git's own words.
  await assert.rejects(
    () => createGit({ exec }).mergeInto('/tmp/wt', ['a', 'b']),
    (err) => {
      assert.ok(err instanceof GitError)
      assert.match(err.message, /Committer identity unknown/)
      assert.match(err.message, /\ba\b/)
      return true
    },
  )
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

// --- real-git regression: a tag must not shadow a branch on the way into the preview -------

test('against a real repository, mergeInto and addWorktreeDetached take the branch tip even when a tag of the same name shadows it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-mshadow-'))
  const mergeDir = await mkdtemp(path.join(tmpdir(), 'tm-git-mshadow-wt-'))
  const checkoutDir = await mkdtemp(path.join(tmpdir(), 'tm-git-mshadow-co-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  const present = async (dir, file) => {
    try {
      await readFile(path.join(dir, file), 'utf8')
      return true
    } catch {
      return false
    }
  }
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    const forkPoint = (await git.headSha())

    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'work.txt'), 'work\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'the teammate work'])
    await sh(['checkout', 'main'])

    // One ordinary command inside the teammate's own worktree. --end-of-options stops flag
    // injection but not namespace precedence: git resolves a bare name through refs/tags/
    // BEFORE refs/heads/, warns on stderr only, and exits 0.
    await sh(['tag', 'teammates/r1/T1', forkPoint])

    // The trap, demonstrated: a bare-name merge takes the tag and reports "Already up to date",
    // so the preview would be built from a tree with none of the teammate's work in it.
    await sh(['worktree', 'add', '--detach', '--end-of-options', mergeDir, 'main'])
    const bare = await defaultGitExec(
      ['-C', mergeDir, 'merge', '--no-ff', '-m', 'bare', '--end-of-options', 'teammates/r1/T1'], root,
    )
    assert.equal(bare.code, 0, 'the bare-name merge is expected to succeed against the tag')
    assert.equal(await present(mergeDir, 'work.txt'), false, 'the bare name is expected to merge the tag, not the branch')
    await sh(['worktree', 'remove', '--force', '--end-of-options', mergeDir])

    // mergeInto must be immune: it resolves the branch name through refs/heads/ first, so the
    // preview really does carry the teammate's commit and `npm test` runs against their code.
    await git.addWorktreeDetached(mergeDir, 'main')
    const result = await git.mergeInto(mergeDir, ['teammates/r1/T1'])
    assert.equal(result, null)
    assert.equal(await present(mergeDir, 'work.txt'), true, 'mergeInto must merge the branch tip the tag hid')

    // addWorktreeDetached must resolve the same way when it checks the branch out directly.
    await git.addWorktreeDetached(checkoutDir, 'teammates/r1/T1')
    assert.equal(await present(checkoutDir, 'work.txt'), true, 'addWorktreeDetached must check out the branch tip, not the tag')
  } finally {
    await rm(mergeDir, { recursive: true, force: true })
    await rm(checkoutDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

// --- real-git regression: three or more branches (the octopus reset) -----------------------

test('against a real repository, a conflict across three branches reports the conflicted paths rather than an empty list', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-octopus-'))
  const wtDir = await mkdtemp(path.join(tmpdir(), 'tm-git-octopus-wt-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'shared.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])

    for (const id of ['T1', 'T2', 'T3']) {
      await sh(['checkout', 'main'])
      await sh(['checkout', '-b', `teammates/r1/${id}`])
      await writeFile(path.join(root, 'shared.txt'), `from-${id}\n`, 'utf8')
      await sh(['add', '.'])
      await sh(['commit', '-m', `edit shared.txt on ${id}`])
    }
    await sh(['checkout', 'main'])

    // Handing git all three heads at once selects the octopus strategy, which resets the
    // working tree and index BEFORE exiting: nothing is left carrying U status, so a
    // --diff-filter=U reading of that failure comes back empty and the gate reports a
    // conflict that names nothing.
    await sh(['worktree', 'add', '--detach', '--end-of-options', wtDir, 'main'])
    const octopus = await defaultGitExec(
      ['-C', wtDir, 'merge', '--no-ff', '-m', 'octopus', '--end-of-options',
        'teammates/r1/T1', 'teammates/r1/T2', 'teammates/r1/T3'], root,
    )
    assert.notEqual(octopus.code, 0)
    const afterOctopus = await defaultGitExec(['-C', wtDir, 'diff', '--name-only', '--diff-filter=U'], root)
    assert.equal(afterOctopus.stdout.trim(), '', 'the octopus failure is expected to leave no unmerged paths')

    const result = await git.mergeInto(wtDir, ['teammates/r1/T1', 'teammates/r1/T2', 'teammates/r1/T3'])
    assert.deepEqual(result, ['shared.txt'], 'a three-branch conflict must still name the file it conflicted on')
  } finally {
    await rm(wtDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

// --- real-git regression: a merge failure is not a conflict --------------------------------

test('against a real repository, a merge that fails without conflicting throws instead of reporting an empty conflict', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-git-mfail-'))
  const wtDir = await mkdtemp(path.join(tmpdir(), 'tm-git-mfail-wt-'))
  const otherRoot = await mkdtemp(path.join(tmpdir(), 'tm-git-mfail-other-'))
  const git = createGit({ cwd: root })
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['worktree', 'add', '--detach', '--end-of-options', wtDir, 'main'])

    // A branch that no longer exists: git exits non-zero with "not something we can merge"
    // and leaves nothing unmerged. Reported as a conflict it would be an empty list and a
    // discarded reason; it has to arrive as a failure carrying git's own words.
    await assert.rejects(
      () => git.mergeInto(wtDir, ['teammates/r1/deleted']),
      (err) => {
        assert.ok(err instanceof GitError)
        assert.match(err.message, /not something we can merge|did not match any|unknown revision/i)
        return true
      },
    )

    // An unrelated-histories merge fails the same way and must not read as a conflict either.
    const shOther = (args) => defaultGitExec(args, otherRoot)
    await shOther(['init', '--initial-branch=main'])
    await shOther(['config', 'user.email', 'test@example.com'])
    await shOther(['config', 'user.name', 'test'])
    await writeFile(path.join(otherRoot, 'elsewhere.txt'), 'elsewhere\n', 'utf8')
    await shOther(['add', '.'])
    await shOther(['commit', '-m', 'unrelated base'])
    await sh(['fetch', '--no-tags', '--end-of-options', otherRoot, '+refs/heads/main:refs/heads/unrelated'])

    await assert.rejects(
      () => git.mergeInto(wtDir, ['unrelated']),
      (err) => {
        assert.ok(err instanceof GitError)
        assert.match(err.message, /unrelated histories/i)
        return true
      },
    )
  } finally {
    await rm(wtDir, { recursive: true, force: true })
    await rm(otherRoot, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

// --- doctor primitives ----------------------------------------------------------------------

test('worktrees parses the porcelain listing into path, branch and detached state', async () => {
  const { calls, exec } = recorder({
    code: 0,
    stdout: [
      'worktree C:/repo', 'HEAD abc123', 'branch refs/heads/run/r1', '',
      'worktree C:/repo/.claude/worktrees/agent-1', 'HEAD def456', 'branch refs/heads/teammates/r1/T1', '',
      'worktree C:/tmp/preview', 'HEAD 999999', 'detached', '',
    ].join('\n'),
    stderr: '',
  })
  const list = await createGit({ cwd: '/x', exec }).worktrees()
  assert.deepEqual(calls[0], ['worktree', 'list', '--porcelain'])
  assert.deepEqual(list, [
    { path: 'C:/repo', head: 'abc123', branch: 'run/r1', detached: false },
    { path: 'C:/repo/.claude/worktrees/agent-1', head: 'def456', branch: 'teammates/r1/T1', detached: false },
    { path: 'C:/tmp/preview', head: '999999', branch: null, detached: true },
  ])
})

// The main worktree's own entry has no trailing blank line when it is the only one, and git
// emits `bare` instead of a HEAD for a bare repository. Neither may drop an entry or invent one.
test('worktrees handles a single entry with no trailing blank line', async () => {
  const { exec } = recorder({ code: 0, stdout: 'worktree C:/repo\nHEAD abc123\nbranch refs/heads/main\n', stderr: '' })
  const list = await createGit({ exec }).worktrees()
  assert.deepEqual(list, [{ path: 'C:/repo', head: 'abc123', branch: 'main', detached: false }])
})

// isDirty answers yes/no for the ownership check; the diagnostic needs to say WHICH paths, or
// the operator is left running `git status` by hand — the thing this command exists to replace.
// The same `.claude/` exemption applies, for the same reason: the plugin chose that location.
test('dirtyPaths lists the porcelain entries and exempts the harness worktree directory', async () => {
  const { calls, exec } = recorder({
    code: 0,
    stdout: ' M scripts/cli.mjs\n?? .claude/worktrees/agent-1/x.txt\n?? stray.txt\n',
    stderr: '',
  })
  const paths = await createGit({ exec }).dirtyPaths()
  assert.deepEqual(calls[0], ['-c', 'core.quotePath=false', 'status', '--porcelain'])
  assert.deepEqual(paths, [
    { status: ' M', path: 'scripts/cli.mjs' },
    { status: '??', path: 'stray.txt' },
  ])
})

test('commitSubject returns the short sha and subject of a ref', async () => {
  const { calls, exec } = recorder({ code: 0, stdout: 'abc1234 fix(gate): something\n', stderr: '' })
  const subject = await createGit({ exec }).commitSubject('refs/heads/teammates/r1/T1')
  assert.deepEqual(calls[0], [
    'log', '-n', '1', '--format=%h %s', '--end-of-options', 'refs/heads/teammates/r1/T1', '--',
  ])
  assert.equal(subject, 'abc1234 fix(gate): something')
})

test('commitSubject rejects an empty ref rather than reporting HEAD', async () => {
  const { calls, exec } = recorder()
  await assert.rejects(() => createGit({ exec }).commitSubject(''), GitError)
  assert.deepEqual(calls, [])
})
