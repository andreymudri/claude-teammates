import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const skillBody = async () => readFile(new URL('../skills/writing-skills/SKILL.md', import.meta.url), 'utf8')
const templateText = async () => readFile(new URL('../templates/SKILL.template.md', import.meta.url), 'utf8')

test('the template has frontmatter satisfying the same rules real skills must', async () => {
  const text = await templateText()
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  assert.ok(match, 'template has no frontmatter')
  const fields = Object.fromEntries(
    match[1].split(/\r?\n/).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  )
  assert.ok(fields.name, 'template must carry a name field')
  assert.match(fields.description, /^Use when/, 'template description must model the "Use when" convention')
})

test('the skill points at the template', async () => {
  assert.match(await skillBody(), /SKILL\.template\.md/)
})

test('the skill requires verifying a new skill triggers', async () => {
  assert.match(await skillBody(), /trigger/i)
})

test('the skill states the name-matches-folder rule', async () => {
  assert.match(await skillBody(), /folder|directory/i)
})

test('carries upstream attribution', async () => {
  assert.match(await skillBody(), /Adapted from the MIT-licensed superpowers plugin/)
})
