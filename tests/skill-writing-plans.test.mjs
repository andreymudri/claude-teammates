import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parsePlan } from '../scripts/plan-parser.mjs'
import { assignPhases } from '../scripts/phases.mjs'

const skillPath = new URL('../skills/writing-plans/SKILL.md', import.meta.url)

test('documents exactly the file-line prefixes the parser recognises', async () => {
  const body = await readFile(skillPath, 'utf8')
  for (const prefix of ['Create:', 'Modify:', 'Test:']) {
    assert.ok(body.includes(prefix), `writing-plans must document the ${prefix} prefix`)
  }
})

test('requires an explicit Depends line for dependent tasks', async () => {
  const body = await readFile(skillPath, 'utf8')
  assert.match(body, /\*\*Depends:\*\*/)
})

test('tells authors to omit the Depends line for tasks with no dependencies', async () => {
  const body = await readFile(skillPath, 'utf8')
  assert.match(body, /omit(ting)? the \*\*Depends:\*\*/i)
})

test('states that declared files are the enforced write set', async () => {
  const body = await readFile(skillPath, 'utf8')
  assert.match(body, /write set|permitted.*files|only the files/i)
})

test('requires an init-run self-check before handing a plan to a fleet', async () => {
  const body = await readFile(skillPath, 'utf8')
  assert.match(body, /init-run/)
})

test('requires a Global Constraints section in the plan header', async () => {
  const body = await readFile(skillPath, 'utf8')
  assert.match(body, /Global Constraints/)
})

test('the example plan fragment in the skill actually parses into phased tasks', async () => {
  const body = await readFile(skillPath, 'utf8')
  const fence = /<!-- example-plan -->\n```markdown\n([\s\S]*?)```/.exec(body)
  assert.ok(fence, 'skill must contain an example plan fenced and marked <!-- example-plan -->')
  const tasks = parsePlan(fence[1])
  assert.ok(tasks.length >= 2, 'example must contain at least two tasks')
  for (const t of tasks) {
    assert.ok(t.files.length > 0, `${t.id} declares no files — the failure this skill exists to prevent`)
  }
  const phased = assignPhases(tasks)
  assert.ok(phased.some((t) => t.phase > 1), 'example must exercise dependency ordering')
})
