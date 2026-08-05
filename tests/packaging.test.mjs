import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const readJson = async (rel) => JSON.parse(await readFile(new URL(rel, import.meta.url), 'utf8'))

test('marketplace manifest names the same plugin as plugin.json', async () => {
  const marketplace = await readJson('../.claude-plugin/marketplace.json')
  const plugin = await readJson('../.claude-plugin/plugin.json')
  const entry = marketplace.plugins.find((p) => p.name === plugin.name)
  assert.ok(entry, `marketplace.json does not list ${plugin.name}`)
  assert.equal(entry.source, './')
})

test('third-party license text is present and names the upstream author', async () => {
  const text = await readFile(new URL('../LICENSE-THIRD-PARTY', import.meta.url), 'utf8')
  assert.match(text, /MIT/)
  assert.match(text, /Jesse Vincent/)
  assert.match(text, /superpowers/i)
})

test('NOTICE lists every adapted skill and no skill that does not exist', async () => {
  const notice = await readFile(new URL('../NOTICE.md', import.meta.url), 'utf8')
  const present = (await readdir(new URL('../skills/', import.meta.url), { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  const ADAPTED = ['brainstorming', 'executing-plans', 'receiving-code-review', 'systematic-debugging', 'test-driven-development', 'writing-skills']
  for (const name of ADAPTED) assert.ok(notice.includes(name), `NOTICE.md omits adapted skill ${name}`)
  for (const m of notice.matchAll(/`([a-z-]+)`/g)) {
    if (present.includes(m[1]) || m[1].includes('.')) continue
    assert.ok(!m[1].startsWith('skills/'), `NOTICE.md references missing skill ${m[1]}`)
  }
})

test('NOTICE marks the original skills as original', async () => {
  const notice = await readFile(new URL('../NOTICE.md', import.meta.url), 'utf8')
  for (const name of ['writing-plans', 'finishing-a-development-branch', 'using-teammates']) {
    assert.ok(notice.includes(name), `NOTICE.md omits original skill ${name}`)
  }
})
