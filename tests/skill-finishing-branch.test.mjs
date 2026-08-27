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

test('routes worktree and branch cleanup through prune-run rather than by hand', async () => {
  const b = await body()
  assert.match(b, /prune-run --run/)
  assert.match(b, /Do not sweep by hand/)
  assert.match(b, /merge-base --is-ancestor/)
})

test('says .teammates is kept deliberately and is the operator\'s to delete', async () => {
  const b = await body()
  assert.match(b, /\.teammates\/<run-id>\/ stays on disk on purpose/)
  assert.match(b, /rebuild-state/)
})

test('is original and carries no upstream attribution', async () => {
  assert.doesNotMatch(await body(), /Adapted from the MIT-licensed superpowers plugin/)
})

test('handles an inline run with no recorded gates by running the test suite fresh', async () => {
  const b = await body()
  assert.match(b, /gates.*(?:absent|empty)|(?:absent|empty).*gates/i)
  assert.match(b, /full test suite/i)
})

test('handles the case where no run directory exists at all', async () => {
  assert.match(await body(), /no run directory/i)
})
