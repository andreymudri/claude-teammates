import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const dir = new URL('../skills/', import.meta.url)

export async function allSkills() {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

export async function skill(name) {
  const text = await readFile(new URL(`${name}/SKILL.md`, dir), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  assert.ok(match, `${name} has no frontmatter`)
  const fields = Object.fromEntries(
    match[1].split(/\r?\n/).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  )
  return { fields, body: text.slice(match[0].length) }
}

test('every skill directory contains a SKILL.md with valid frontmatter', async () => {
  const names = await allSkills()
  assert.ok(names.length >= 5, 'expected at least the five fleet skills')
  for (const name of names) {
    const { fields } = await skill(name)
    assert.equal(fields.name, name, `${name}: frontmatter name must match folder`)
    assert.match(fields.description, /^Use when/, `${name}: description must start with "Use when"`)
  }
})

test('no skill invokes the CLI by a relative path', async () => {
  for (const name of await allSkills()) {
    const { body } = await skill(name)
    assert.ok(
      !/(?<!\$\{?CLAUDE_PLUGIN_ROOT\}?\/scripts\/)cli\.mjs/.test(body.replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?\/scripts\/cli\.mjs/g, 'OK')),
      `${name}: invokes cli.mjs without CLAUDE_PLUGIN_ROOT`,
    )
  }
})

test('adapted skills credit the upstream project', async () => {
  const ADAPTED = ['brainstorming', 'executing-plans', 'receiving-code-review', 'systematic-debugging', 'test-driven-development', 'writing-skills']
  const present = await allSkills()
  for (const name of ADAPTED.filter((n) => present.includes(n))) {
    const { body } = await skill(name)
    assert.match(body, /Adapted from the MIT-licensed superpowers plugin/, `${name}: missing attribution line`)
  }
})

test('parallel-execution documents all three model tiers and the --models flag', async () => {
  const { body } = await skill('parallel-execution')
  assert.match(body, /\bcheap\b/)
  assert.match(body, /\bmid\b/)
  assert.match(body, /\bcapable\b/)
  assert.match(body, /--models/)
})

test('phase-gate documents the fix subcommand and the cost-bound framing', async () => {
  const { body } = await skill('phase-gate')
  assert.match(body, /cli\.mjs["']?\s+fix\b/)
  assert.match(body, /cost bound, not a security bound/)
})

test('tm-implementer forbids weakening a test to satisfy a fix-round finding', async () => {
  const body = await readFile(new URL('../agents/tm-implementer.md', import.meta.url), 'utf8')
  assert.match(body, /do not weaken or delete a test/i)
})
