import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const body = async () => readFile(new URL('../skills/executing-plans/SKILL.md', import.meta.url), 'utf8')

test('initialises shared run state so the run is resumable', async () => {
  assert.match(await body(), /init-run/)
  assert.match(await body(), /\.teammates/)
})

test('states that a gate manifest is optional for inline work', async () => {
  assert.match(await body(), /optional/i)
})

test('does not require a phase structure or reviewer dispatch for small work', async () => {
  const b = await body()
  assert.match(b, /checkpoint/i)
})

test('says an inline run can be handed to a fleet without translation', async () => {
  assert.match(await body(), /parallel-execution/)
})

test('carries upstream attribution', async () => {
  assert.match(await body(), /Adapted from the MIT-licensed superpowers plugin/)
})
