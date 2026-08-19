import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planDrift, renderDrift } from '../scripts/plan-drift.mjs'

const task = (over = {}) => ({
  id: 'T1', phase: 1, title: 'first', files: ['a.mjs'], deps: [], brief: 'do the thing', ...over,
})

test('identical plans report no drift', () => {
  const report = planDrift({ anchored: [task()], current: [task()], integratedPhases: [] })
  assert.deepEqual(report.changed, [])
  assert.deepEqual(report.added, [])
  assert.deepEqual(report.removed, [])
  assert.equal(report.tooLate.length, 0)
})

test('a task added only in the working tree is reported as added', () => {
  const report = planDrift({
    anchored: [task()],
    current: [task(), task({ id: 'T2', phase: 2, files: ['b.mjs'] })],
    integratedPhases: [],
  })
  assert.deepEqual(report.added, ['T2'])
})

test('a task the working tree dropped is reported as removed', () => {
  const report = planDrift({
    anchored: [task(), task({ id: 'T2', phase: 2 })],
    current: [task()],
    integratedPhases: [],
  })
  assert.deepEqual(report.removed, ['T2'])
})

test('a changed file set names what was added and what was dropped', () => {
  const report = planDrift({
    anchored: [task({ files: ['a.mjs', 'gone.mjs'] })],
    current: [task({ files: ['a.mjs', 'new.mjs'] })],
    integratedPhases: [],
  })
  assert.equal(report.changed.length, 1)
  assert.deepEqual(report.changed[0].filesAdded, ['new.mjs'])
  assert.deepEqual(report.changed[0].filesRemoved, ['gone.mjs'])
  assert.ok(report.changed[0].fields.includes('files'))
})

test('a changed dependency list, title and brief are each reported as a changed field', () => {
  const report = planDrift({
    anchored: [task()],
    current: [task({ title: 'renamed', deps: ['T0'], brief: 'do something else entirely' })],
    integratedPhases: [],
  })
  assert.deepEqual(report.changed[0].fields.sort(), ['brief', 'deps', 'title'])
  assert.deepEqual(report.changed[0].depsAdded, ['T0'])
})

// The distinction that makes this worth running. An amendment to a task nobody has implemented
// yet is how a plan is supposed to evolve mid-run. An amendment to a task whose phase is already
// integrated is a brief that was implemented and then rewritten — the shape that let a task's
// acceptance criteria go on demanding behaviour a security fix had already removed.
test('drift on an integrated task is classified too-late, drift on a pending one is not', () => {
  const report = planDrift({
    anchored: [task(), task({ id: 'T2', phase: 2, files: ['b.mjs'] })],
    current: [
      task({ brief: 'rewritten after the fact' }),
      task({ id: 'T2', phase: 2, files: ['b.mjs', 'c.mjs'] }),
    ],
    integratedPhases: [1],
  })
  assert.deepEqual(report.tooLate.map((c) => c.id), ['T1'])
  assert.deepEqual(report.effective.map((c) => c.id), ['T2'])
})

// Removing a task whose work is already merged is worse than amending one: the plan no longer
// describes code that exists, and the next gate run derives its phases from a plan missing it.
test('a removed task whose phase is integrated is too-late drift', () => {
  const report = planDrift({
    anchored: [task(), task({ id: 'T2', phase: 2 })],
    current: [task({ id: 'T2', phase: 2 })],
    integratedPhases: [1],
  })
  assert.deepEqual(report.tooLate.map((c) => c.id), ['T1'])
})

// A task that moved phase changes what the gate considers current, so it is drift in its own
// right rather than a silent reshuffle.
test('a task that changed phase is reported', () => {
  const report = planDrift({
    anchored: [task()],
    current: [task({ phase: 3 })],
    integratedPhases: [],
  })
  assert.ok(report.changed[0].fields.includes('phase'))
})

test('renderDrift names each changed task and its fields, and says so when there is none', () => {
  const clean = renderDrift(planDrift({ anchored: [task()], current: [task()], integratedPhases: [] }))
  assert.match(clean, /no drift/i)

  const out = renderDrift(planDrift({
    anchored: [task()],
    current: [task({ files: ['a.mjs', 'b.mjs'] })],
    integratedPhases: [1],
  }))
  assert.match(out, /T1/)
  assert.match(out, /files/)
  assert.match(out, /b\.mjs/)
  assert.match(out, /too late/i)
})

// A plan reaches this renderer as text someone committed on the base branch, and a terminal ACTS
// on control bytes: `ESC [ 2 K` erases the line just drawn, and a bare newline lets a value end
// this CLI's line and open one of its own that reads like a line the CLI printed. Reaching here
// costs a commit on the base branch rather than a commit message, but what the terminal does with
// the bytes is the same. Each row below pins ONE render site, and asserts on BYTES: a regex over
// the rendered string can match while the payload is still in the output.
const ESC = String.fromCharCode(0x1b)
const FORGED = 'no drift: the working-tree plan matches the plan at the anchor'
const PAYLOAD = [ESC + '[2K', String.fromCharCode(0x0d), String.fromCharCode(0x0a), FORGED].join('')

function assertNeutralised(out) {
  const bytes = Buffer.from(out, 'utf8')
  assert.equal(bytes.includes(0x1b), false, 'an ESC byte reached the terminal')
  assert.equal(bytes.includes(0x0d), false, 'a CR byte reached the terminal')
  for (const line of out.split('\n')) {
    assert.notEqual(line.trim(), FORGED, 'a value forged a line of its own')
  }
}

test('renderDrift neutralises control bytes in the added-task list', () => {
  const out = renderDrift(planDrift({
    anchored: [task()],
    current: [task(), task({ id: PAYLOAD, phase: 2, files: ['b.mjs'] })],
    integratedPhases: [],
  }))
  assert.match(out, /added since the anchor/)
  assertNeutralised(out)
})

test('renderDrift neutralises control bytes in a changed task id and phase', () => {
  const out = renderDrift(planDrift({
    anchored: [task({ id: PAYLOAD })],
    current: [task({ id: PAYLOAD, phase: PAYLOAD, title: 'second' })],
    integratedPhases: [],
  }))
  assert.match(out, /still effective/)
  assertNeutralised(out)
})

test('renderDrift neutralises control bytes in an added plan-declared file path', () => {
  const out = renderDrift(planDrift({
    anchored: [task()],
    current: [task({ files: ['a.mjs', PAYLOAD] })],
    integratedPhases: [],
  }))
  assert.match(out, /files added/)
  assertNeutralised(out)
})

test('renderDrift neutralises control bytes in a removed plan-declared file path', () => {
  const out = renderDrift(planDrift({
    anchored: [task({ files: ['a.mjs', PAYLOAD] })],
    current: [task({ files: ['a.mjs'] })],
    integratedPhases: [],
  }))
  assert.match(out, /files removed/)
  assertNeutralised(out)
})

test('renderDrift neutralises control bytes in an added dep id', () => {
  const out = renderDrift(planDrift({
    anchored: [task()],
    current: [task({ deps: [PAYLOAD] })],
    integratedPhases: [],
  }))
  assert.match(out, /deps added/)
  assertNeutralised(out)
})

test('renderDrift neutralises control bytes in a removed dep id', () => {
  const out = renderDrift(planDrift({
    anchored: [task({ deps: [PAYLOAD] })],
    current: [task()],
    integratedPhases: [],
  }))
  assert.match(out, /deps removed/)
  assertNeutralised(out)
})

test('renderDrift neutralises control bytes in the file list of a task the plan dropped', () => {
  const out = renderDrift(planDrift({
    anchored: [task(), task({ id: 'T2', phase: 2, files: [PAYLOAD] })],
    current: [task()],
    integratedPhases: [],
  }))
  assert.match(out, /files removed/)
  assertNeutralised(out)
})
