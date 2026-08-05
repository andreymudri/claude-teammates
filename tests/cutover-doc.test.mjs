import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const doc = async () => readFile(new URL('../docs/CUTOVER.md', import.meta.url), 'utf8')

test('documents the exact settings key to flip', async () => {
  assert.match(await doc(), /superpowers@claude-plugins-official/)
})

test('requires a verified side-by-side session before disabling', async () => {
  const d = await doc()
  assert.match(d, /side.by.side|fresh session/i)
  assert.match(d, /before disabling|only after/i)
})

test('states the change is reversible', async () => {
  assert.match(await doc(), /revers|restore|re-enabl/i)
})

test('names what must not be touched', async () => {
  const d = await doc()
  assert.match(d, /caveman/i)
  assert.match(d, /CLAUDE\.md/)
})
