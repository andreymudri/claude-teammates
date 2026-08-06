import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateLinkPaths, linkInto } from '../scripts/preview-links.mjs'

async function scratch() {
  return await mkdtemp(path.join(tmpdir(), 'tm-links-test-'))
}

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
