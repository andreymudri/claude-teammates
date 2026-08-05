import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const skillsDir = new URL('../skills/', import.meta.url)
const body = async () => readFile(new URL('using-teammates/SKILL.md', skillsDir), 'utf8')

test('routes to every skill that exists', async () => {
  const names = (await readdir(skillsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name !== 'using-teammates')
    .map((e) => e.name)
  const b = await body()
  for (const name of names) {
    assert.ok(b.includes(name), `entrypoint does not route to ${name}`)
  }
})

test('every skill the routing table names actually exists', async () => {
  const present = (await readdir(skillsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  const b = await body()
  for (const m of b.matchAll(/`([a-z-]+)`/g)) {
    const candidate = m[1]
    if (candidate.includes('-') && /^(brainstorming|writing-|executing-|test-driven|systematic-|receiving-|finishing-|fleet-|parallel-|phase-|using-)/.test(candidate)) {
      assert.ok(present.includes(candidate), `routing table names missing skill ${candidate}`)
    }
  }
})

test('requires invoking a skill before any response including clarifying questions', async () => {
  assert.match(await body(), /clarifying question/i)
})

test('carries the red-flag rationalization table', async () => {
  const b = await body()
  assert.match(b, /simple question/i)
  assert.match(b, /overkill/i)
})

test('states process skills take priority over implementation skills', async () => {
  assert.match(await body(), /priority|first/i)
})

test('keeps the fleet invariants', async () => {
  const b = await body()
  assert.match(b, /never touches the main worktree|main worktree/i)
  assert.match(b, /tm-integrator/)
})
