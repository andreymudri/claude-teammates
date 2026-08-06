import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateLinkPaths, linkInto } from '../scripts/preview-links.mjs'

async function scratch() {
  return await mkdtemp(path.join(tmpdir(), 'tm-links-test-'))
}

// A junction is the only directory link Windows creates without elevation, the same choice the
// implementation makes. Tests that need a real on-disk link have to make it the same way.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

test('validateLinkPaths accepts a repo-relative directory and an empty list', () => {
  assert.equal(validateLinkPaths(['node_modules']), null)
  assert.equal(validateLinkPaths([]), null)
})

test('validateLinkPaths rejects a non-string entry', () => {
  const message = validateLinkPaths([42])
  assert.ok(message, 'expected a rejection message')
  assert.match(message, /non-empty strings/)
})

test('validateLinkPaths rejects an empty string entry', () => {
  assert.match(validateLinkPaths(['']), /non-empty strings/)
})

test('validateLinkPaths rejects a whitespace-only entry', () => {
  assert.match(validateLinkPaths(['   ']), /non-empty strings/)
})

test('validateLinkPaths rejects an absolute path', () => {
  const absolute = path.resolve(tmpdir(), 'outside')
  assert.match(validateLinkPaths([absolute]), /repo-relative/)
})

test("validateLinkPaths rejects '..'", () => {
  assert.match(validateLinkPaths(['..']), /escapes the repository/)
})

test("validateLinkPaths rejects '../outside'", () => {
  assert.match(validateLinkPaths(['../outside']), /escapes the repository/)
})

test("validateLinkPaths rejects 'a/../../outside', which only escapes after normalisation", () => {
  assert.match(validateLinkPaths(['a/../../outside']), /escapes the repository/)
})

test('validateLinkPaths rejects a non-array argument', () => {
  assert.match(validateLinkPaths('node_modules'), /must be an array/)
  assert.match(validateLinkPaths(null), /must be an array/)
  assert.match(validateLinkPaths(undefined), /must be an array/)
})

test('linkInto creates a link that resolves to the real target', async () => {
  const root = await scratch()
  const dir = await scratch()
  try {
    await mkdir(path.join(root, 'deps'))
    await writeFile(path.join(root, 'deps', 'marker.txt'), 'from-target')
    const teardown = await linkInto(dir, root, ['deps'])
    const through = await readFile(path.join(dir, 'deps', 'marker.txt'), 'utf8')
    assert.equal(through, 'from-target')
    await teardown()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('teardown removes the links and leaves the targets writable and intact', async () => {
  const root = await scratch()
  const dir = await scratch()
  try {
    await mkdir(path.join(root, 'deps'))
    await writeFile(path.join(root, 'deps', 'marker.txt'), 'from-target')
    const teardown = await linkInto(dir, root, ['deps'])
    await teardown()
    await assert.rejects(() => lstat(path.join(dir, 'deps')), /ENOENT/)
    // Asserting the real directory still exists would pass even against a teardown that
    // emptied it. Write a new file into it and read it back instead.
    await writeFile(path.join(root, 'deps', 'after.txt'), 'still-here')
    assert.equal(await readFile(path.join(root, 'deps', 'after.txt'), 'utf8'), 'still-here')
    assert.equal(await readFile(path.join(root, 'deps', 'marker.txt'), 'utf8'), 'from-target')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('a valid entry followed by a missing one leaves nothing behind', async () => {
  const root = await scratch()
  const dir = await scratch()
  try {
    await mkdir(path.join(root, 'deps'))
    await assert.rejects(() => linkInto(dir, root, ['deps', 'absent']), /preview link/)
    await assert.rejects(() => lstat(path.join(dir, 'deps')), /ENOENT/,
      'the first link must be torn down when a later one fails')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing target names the entry and says to install or remove it from preview.link', async () => {
  const root = await scratch()
  const dir = await scratch()
  try {
    await assert.rejects(
      () => linkInto(dir, root, ['node_modules']),
      (err) => {
        assert.match(err.message, /node_modules/)
        assert.match(err.message, /ENOENT/)
        assert.match(err.message, /install step/)
        assert.match(err.message, /preview\.link/)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('linkInto with no paths creates nothing and returns a teardown that is safe to call', async () => {
  const dir = await scratch()
  const root = await scratch()
  try {
    const teardown = await linkInto(dir, root)
    await teardown()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('an entry resolving outside the repository root is refused even after validation', async () => {
  const root = await scratch()
  const dir = await scratch()
  try {
    await assert.rejects(
      () => linkInto(dir, root, ['a/../../escape']),
      /resolves outside the repository/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('a nested entry is linked even when its parent is absent from the merged tree', async () => {
  const root = await scratch()
  const dir = await scratch()
  try {
    // 'packages/web' holds no tracked files, so `git worktree add` never materializes it. The
    // entry is still a legitimate manifest and must be linked, not refused.
    await mkdir(path.join(root, 'packages', 'web', 'node_modules'), { recursive: true })
    await writeFile(path.join(root, 'packages', 'web', 'node_modules', 'marker.txt'), 'from-target')
    const entry = path.join('packages', 'web', 'node_modules')
    const teardown = await linkInto(dir, root, [entry])
    assert.equal(await readFile(path.join(dir, entry, 'marker.txt'), 'utf8'), 'from-target')
    await teardown()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('an in-repo entry that is itself a link pointing outside the repository is refused', async () => {
  const root = await scratch()
  const dir = await scratch()
  const outside = await scratch()
  try {
    // The pnpm shape: an in-repo directory that is a link into a shared store. Textually
    // 'vendor' sits under the root and stat() follows the link, so only realpath catches it.
    await writeFile(path.join(outside, 'secret.txt'), 'outside-the-repo')
    await symlink(outside, path.join(root, 'vendor'), LINK_TYPE)
    await assert.rejects(
      () => linkInto(dir, root, ['vendor']),
      /resolves outside the repository/,
    )
    await assert.rejects(() => lstat(path.join(dir, 'vendor')), /ENOENT/,
      'no link into the outside directory may survive the rejection')
  } finally {
    await rm(path.join(root, 'vendor'), { recursive: true, force: true }).catch(() => {})
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('a repository root that is itself a link still links its own entries', async () => {
  // Resolving only the target would make every entry look external whenever the root is a
  // symlink — macOS /tmp is the classic case. Both sides get resolved, so this must pass.
  const real = await scratch()
  const dir = await scratch()
  const parent = await scratch()
  const root = path.join(parent, 'link-to-root')
  try {
    await mkdir(path.join(real, 'deps'))
    await writeFile(path.join(real, 'deps', 'marker.txt'), 'from-target')
    await symlink(real, root, LINK_TYPE)
    const teardown = await linkInto(dir, root, ['deps'])
    assert.equal(await readFile(path.join(dir, 'deps', 'marker.txt'), 'utf8'), 'from-target')
    await teardown()
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {})
    await rm(parent, { recursive: true, force: true })
    await rm(real, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('an entry that names a regular file rather than a directory is refused by name', async () => {
  const root = await scratch()
  const dir = await scratch()
  try {
    await writeFile(path.join(root, 'deps'), 'not a directory')
    await assert.rejects(
      () => linkInto(dir, root, ['deps']),
      (err) => {
        assert.match(err.message, /deps/)
        assert.match(err.message, /not a directory/)
        return true
      },
    )
    await assert.rejects(() => lstat(path.join(dir, 'deps')), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test("an in-repo directory named '..cache' is accepted, not read as an escape", async () => {
  const root = await scratch()
  const dir = await scratch()
  try {
    await mkdir(path.join(root, '..cache'))
    await writeFile(path.join(root, '..cache', 'marker.txt'), 'from-target')
    const teardown = await linkInto(dir, root, ['..cache'])
    assert.equal(await readFile(path.join(dir, '..cache', 'marker.txt'), 'utf8'), 'from-target')
    await teardown()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})

test('a path already present in the merged tree is reported as a shadowing manifest error', async () => {
  const root = await scratch()
  const dir = await scratch()
  try {
    await mkdir(path.join(root, 'deps'))
    // The tracked-and-merged case: `git worktree add` already put this path in the tree.
    await mkdir(path.join(dir, 'deps'))
    await assert.rejects(
      () => linkInto(dir, root, ['deps']),
      (err) => {
        assert.match(err.message, /deps/)
        assert.match(err.message, /already present in the merged tree/)
        assert.match(err.message, /shadow/)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})
