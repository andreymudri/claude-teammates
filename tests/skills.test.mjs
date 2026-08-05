import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const dir = new URL('../skills/', import.meta.url)
const REQUIRED = ['fleet-lifecycle', 'fleet-supervision', 'parallel-execution', 'phase-gate', 'using-teammates']

async function allSkills() {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

async function skill(name) {
  const text = await readFile(new URL(`${name}/SKILL.md`, dir), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  assert.ok(match, `${name} has no frontmatter`)
  const fields = Object.fromEntries(
    match[1].split(/\r?\n/).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  )
  return { fields, body: text.slice(match[0].length) }
}

test('every required fleet skill is present', async () => {
  const names = await allSkills()
  for (const required of REQUIRED) assert.ok(names.includes(required), `missing skill ${required}`)
})

test('each skill has a name matching its folder and a description starting with "Use when"', async () => {
  for (const name of await allSkills()) {
    const { fields } = await skill(name)
    assert.equal(fields.name, name)
    assert.match(fields.description, /^Use when/, `${name} description must start with "Use when"`)
  }
})

test('every cli subcommand referenced by a skill actually exists', async () => {
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  const known = ['init-run', 'gate', 'digest', 'claim', 'unclaim', 'workflow']
  for (const name of await allSkills()) {
    const { body } = await skill(name)
    for (const m of body.matchAll(/cli\.mjs["']?\s+([a-z-]+)/g)) {
      assert.ok(known.includes(m[1]), `${name} calls unknown subcommand ${m[1]}`)
      assert.ok(cli.includes(`'${m[1]}'`), `cli.mjs does not implement ${m[1]}`)
    }
  }
})

test('every agent referenced by a skill exists', async () => {
  const agents = (await readdir(new URL('../agents/', import.meta.url))).map((f) => f.replace('.md', ''))
  for (const name of await allSkills()) {
    const { body } = await skill(name)
    for (const m of body.matchAll(/\btm-[a-z]+\b/g)) {
      assert.ok(agents.includes(m[0]), `${name} references missing agent ${m[0]}`)
    }
  }
})

test('the entrypoint routes to all four working skills', async () => {
  const { body } = await skill('using-teammates')
  for (const name of REQUIRED.filter((n) => n !== 'using-teammates')) {
    assert.ok(body.includes(name), `entrypoint does not route to ${name}`)
  }
})

test('parallel-execution states the workflow threshold and the worktree invariant', async () => {
  const { body } = await skill('parallel-execution')
  assert.match(body, /three or more/)
  assert.match(body, /never touches the main worktree/)
})

test('phase-gate never reports done without a recorded PASS', async () => {
  const { body } = await skill('phase-gate')
  assert.match(body, /never report .*done.* without/i)
  assert.match(body, /skipped/)
})

test('parallel-execution falls back to the direct-agent path when Workflow is declined or unavailable', async () => {
  const { body } = await skill('parallel-execution')
  assert.match(body, /do not stop/i)
  assert.match(body, /Fall back to the\s+direct-agent path/)
})
