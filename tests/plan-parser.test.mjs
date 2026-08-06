import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlan } from '../scripts/plan-parser.mjs'
import { assignPhases } from '../scripts/phases.mjs'

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

test('skips fake task headings inside fenced code blocks', () => {
  const planWithFencedFake = `### Task 1: Real

**Files:**
- Create: \`real.mjs\`

## Example

\`\`\`
### Task 9: Fake
\`\`\`
`
  const tasks = parsePlan(planWithFencedFake)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].id, 'T1')
  assert.ok(!tasks.some((t) => t.id === 'T9'), 'T9 should not be parsed from inside fence')
})

test('skips file entries inside fenced code blocks', () => {
  const planWithFencedFile = `### Task 1: Real

**Files:**
- Create: \`real.mjs\`

\`\`\`markdown
- Create: \`ghost.mjs\`
\`\`\`
`
  const tasks = parsePlan(planWithFencedFile)
  assert.deepEqual(tasks[0].files, ['real.mjs'])
  assert.ok(!tasks[0].files.includes('ghost.mjs'), 'ghost.mjs should not be parsed from inside fence')
})

test('respects nested fences with different fence lengths', () => {
  const planWithNestedFences = `### Task 1: Real

**Files:**
- Create: \`real.mjs\`

\`\`\`\`
\`\`\`
### Task 8: AlsoFake
\`\`\`
\`\`\`\`
`
  const tasks = parsePlan(planWithNestedFences)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].id, 'T1')
  assert.ok(!tasks.some((t) => t.id === 'T8'), 'T8 should not be parsed from inside nested fence')
})

test('treats "Depends: none" as no dependencies', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Depends:** none\n'
  const tasks = parsePlan(plan)
  assert.deepEqual(tasks[0].deps, [])
})

test('treats "Depends: N/A" as no dependencies, case-insensitively', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Depends:** N/A\n'
  const tasks = parsePlan(plan)
  assert.deepEqual(tasks[0].deps, [])
})

test('treats "Depends: -" as no dependencies', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Depends:** -\n'
  const tasks = parsePlan(plan)
  assert.deepEqual(tasks[0].deps, [])
})

test('drops only the sentinel when mixed with a real dependency id', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Depends:** T1, none\n'
  const tasks = parsePlan(plan)
  assert.deepEqual(tasks[0].deps, ['T1'])
})

test('an unknown dependency id still throws from assignPhases', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Depends:** T99\n'
  const tasks = parsePlan(plan)
  assert.deepEqual(tasks[0].deps, ['T99'])
  assert.throws(() => assignPhases(tasks), /unsatisfiable dependencies: T1/)
})

test('parses a declared Model line into tier and tierSource', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Model:** cheap\n'
  const tasks = parsePlan(plan)
  assert.equal(tasks[0].tier, 'cheap')
  assert.equal(tasks[0].tierSource, 'declared')
})

test('leaves tier and tierSource undefined when there is no Model line', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n'
  const tasks = parsePlan(plan)
  assert.equal(tasks[0].tier, undefined)
  assert.equal(tasks[0].tierSource, undefined)
})

test('captures the task brief including a fenced code block, stopping at the next heading', () => {
  const plan = `### Task 1: X

**Files:**
- Create: \`a.mjs\`

Some brief text.

\`\`\`js
const x = 1
\`\`\`

### Task 2: Y

**Files:**
- Create: \`b.mjs\`
`
  const tasks = parsePlan(plan)
  assert.ok(tasks[0].brief.includes('Some brief text.'))
  assert.ok(tasks[0].brief.includes('```js'))
  assert.ok(tasks[0].brief.includes('const x = 1'))
  assert.ok(!tasks[0].brief.includes('Task 2'))
  assert.ok(!tasks[0].brief.includes('b.mjs'))
})

test('parses an unrecognised Model value without throwing', () => {
  const plan = '### Task 1: X\n\n**Files:**\n- Create: `a.mjs`\n\n**Model:** enormous\n'
  const tasks = parsePlan(plan)
  assert.equal(tasks[0].tier, 'enormous')
  assert.equal(tasks[0].tierSource, 'declared')
})
