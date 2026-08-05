import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const body = async () => readFile(new URL('../skills/systematic-debugging/SKILL.md', import.meta.url), 'utf8')

test('requires a reproduction before any fix is proposed', async () => {
  assert.match(await body(), /reproduc/i)
})

test('requires a hypothesis stated before changing code', async () => {
  assert.match(await body(), /hypothes/i)
})

test('forbids shotgun fixes and speculative changes', async () => {
  assert.match(await body(), /one change at a time|shotgun|speculat/i)
})

test('requires a regression test for the fixed bug', async () => {
  assert.match(await body(), /regression/i)
})

test('carries upstream attribution', async () => {
  assert.match(await body(), /Adapted from the MIT-licensed superpowers plugin/)
})
