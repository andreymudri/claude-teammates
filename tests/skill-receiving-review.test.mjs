import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const body = async () => readFile(new URL('../skills/receiving-code-review/SKILL.md', import.meta.url), 'utf8')

test('requires verifying a finding before implementing it', async () => {
  assert.match(await body(), /verif/i)
})

test('forbids performative agreement', async () => {
  assert.match(await body(), /performative|blind|reflexive/i)
})

test('covers findings that are wrong', async () => {
  assert.match(await body(), /wrong|incorrect|false positive/i)
})

test('references tm-reviewer as a source of findings', async () => {
  assert.match(await body(), /tm-reviewer/)
})

test('carries upstream attribution', async () => {
  assert.match(await body(), /Adapted from the MIT-licensed superpowers plugin/)
})
