import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const body = async () => readFile(new URL('../skills/test-driven-development/SKILL.md', import.meta.url), 'utf8')

test('requires observing the test fail before implementing', async () => {
  assert.match(await body(), /RED/)
  assert.match(await body(), /fail/i)
})

test('requires the failure to be the expected failure', async () => {
  assert.match(await body(), /expected failure|right reason|correct reason/i)
})

test('names the rationalizations that precede skipping the red step', async () => {
  const b = await body()
  assert.match(b, /obvious|trivial|simple/i)
})

test('carries upstream attribution', async () => {
  assert.match(await body(), /Adapted from the MIT-licensed superpowers plugin/)
})
