import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const body = async () => readFile(new URL('../skills/finishing-a-development-branch/SKILL.md', import.meta.url), 'utf8')

test('requires a recorded gate PASS before presenting work as finished', async () => {
  const b = await body()
  assert.match(b, /status\.gates|recorded PASS/i)
})

test('distinguishes teammate branches from the run branch', async () => {
  const b = await body()
  assert.match(b, /teammate branch/i)
  assert.match(b, /run branch/i)
})

test('names tm-integrator as the sole writer of the run branch', async () => {
  assert.match(await body(), /tm-integrator/)
})

test('covers cleaning up teammate worktrees', async () => {
  assert.match(await body(), /worktree/i)
})

test('is original and carries no upstream attribution', async () => {
  assert.doesNotMatch(await body(), /Adapted from the MIT-licensed superpowers plugin/)
})
