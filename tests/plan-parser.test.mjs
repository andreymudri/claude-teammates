import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan } from '../scripts/plan-parser.mjs'

const PLAN = `
# Some Plan

### Task 1: State store

**Files:**
- Create: \`scripts/state.mjs\`
- Test: \`tests/state.test.mjs\`

- [ ] **Step 1: do it**

### Task 2: Parser

**Files:**
- Create: \`scripts/plan-parser.mjs\`
- Modify: \`scripts/state.mjs:10-20\`

**Depends:** T1

- [ ] **Step 1: do it**
`

test('parses task ids and titles', () => {
  const tasks = parsePlan(PLAN)
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].id, 'T1')
  assert.equal(tasks[0].title, 'State store')
  assert.equal(tasks[1].id, 'T2')
})

test('collects create, modify and test paths', () => {
  const [first, second] = parsePlan(PLAN)
  assert.deepEqual(first.files, ['scripts/state.mjs', 'tests/state.test.mjs'])
  assert.deepEqual(second.files, ['scripts/plan-parser.mjs', 'scripts/state.mjs'])
})

test('strips line ranges from modify paths', () => {
  const [, second] = parsePlan(PLAN)
  assert.ok(!second.files.some((f) => f.includes(':')))
})

test('reads declared dependencies and defaults to empty', () => {
  const [first, second] = parsePlan(PLAN)
  assert.deepEqual(first.deps, [])
  assert.deepEqual(second.deps, ['T1'])
})

test('ignores paths outside the Files block', () => {
  const tasks = parsePlan('### Task 1: X\n\nSee \`docs/readme.md\` for context.\n\n**Files:**\n- Create: \`a.mjs\`\n')
  assert.deepEqual(tasks[0].files, ['a.mjs'])
})

test('throws on duplicate task ids', () => {
  const dup = '### Task 1: A\n\n**Files:**\n- Create: \`a.mjs\`\n\n### Task 1: B\n\n**Files:**\n- Create: \`b.mjs\`\n'
  assert.throws(() => parsePlan(dup), /duplicate task id: T1/)
})

test('returns an empty array for a plan with no tasks', () => {
  assert.deepEqual(parsePlan('# Nothing here\n'), [])
})

test('exits Files block at checked checkbox', () => {
  const planWithCheckedStep = `### Task 1: Work

**Files:**
- Create: \`a.mjs\`

- [x] **Step 1: done**

Later, some prose about modifications:
- Modify: \`stray.mjs\`
`
  const tasks = parsePlan(planWithCheckedStep)
  assert.deepEqual(tasks[0].files, ['a.mjs'])
  assert.ok(!tasks[0].files.includes('stray.mjs'), 'stray.mjs should not be collected from prose after checked step')
})
