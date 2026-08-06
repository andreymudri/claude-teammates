import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideFix } from '../scripts/fix-loop.mjs'

function makePhase() {
  const tasks = [
    { id: 'T1', files: ['src/a.mjs'], tier: 'cheap' },
    { id: 'T2', files: ['src/b.mjs'], tier: 'mid' },
  ]
  return tasks
}

test('a verdict with no failing checks returns decision: none', () => {
  const tasks = makePhase()
  const verdict = { checks: [{ name: 'lint', status: 'pass' }] }
  const result = decideFix(verdict, 1, tasks, {}, {})
  assert.equal(result.decision, 'none')
  assert.deepEqual(result.tasks, [])
  assert.equal(result.reason, null)
})

test('a failing fileset check escalates with process-violation even with an attributable failure and rounds remaining', () => {
  const tasks = makePhase()
  const verdict = {
    checks: [
      { name: 'fileset-check', kind: 'fileset', status: 'fail' },
      {
        name: 'agent-check',
        kind: 'agent',
        status: 'fail',
        findings: [{ file: 'src/a.mjs' }],
      },
    ],
  }
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
  assert.equal(result.check, 'fileset-check')
})

test('a failing ownership check escalates with process-violation', () => {
  const tasks = makePhase()
  const verdict = {
    checks: [{ name: 'ownership-check', kind: 'ownership', status: 'fail' }],
  }
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
  assert.equal(result.check, 'ownership-check')
})

test('a failing agent check citing src/a.mjs retries T1 at tier mid, round 1', () => {
  const tasks = makePhase()
  const verdict = {
    checks: [
      {
        name: 'agent-check',
        kind: 'agent',
        status: 'fail',
        findings: [{ file: 'src/a.mjs' }],
      },
    ],
  }
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].taskId, 'T1')
  assert.equal(result.tasks[0].tier, 'mid')
  assert.equal(result.tasks[0].round, 1)
})

test('a failing command check whose output mentions src/b.mjs retries T2 at tier capable', () => {
  const tasks = makePhase()
  const verdict = {
    checks: [
      {
        name: 'command-check',
        kind: 'command',
        status: 'fail',
        output: 'error in src/b.mjs at line 10',
      },
    ],
  }
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].taskId, 'T2')
  assert.equal(result.tasks[0].tier, 'capable')
})

test('a failing command check whose output mentions no declared file escalates as unattributable', () => {
  const tasks = makePhase()
  const verdict = {
    checks: [
      {
        name: 'command-check',
        kind: 'command',
        status: 'fail',
        output: 'error in src/unrelated.mjs',
      },
    ],
  }
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.equal(result.check, 'command-check')
})

test('a task already at round 2 with a budget of 2 escalates as budget-exhausted', () => {
  const tasks = makePhase()
  const verdict = {
    checks: [
      {
        name: 'agent-check',
        kind: 'agent',
        status: 'fail',
        findings: [{ file: 'src/a.mjs' }],
      },
    ],
  }
  const rounds = { 1: { T1: 2 } }
  const result = decideFix(verdict, 1, tasks, rounds, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'budget-exhausted')
  assert.equal(result.taskId, 'T1')
})

test('a task at tier capable retries at capable, pinning the cap', () => {
  const tasks = [{ id: 'T1', files: ['src/a.mjs'], tier: 'capable' }]
  const verdict = {
    checks: [
      {
        name: 'agent-check',
        kind: 'agent',
        status: 'fail',
        findings: [{ file: 'src/a.mjs' }],
      },
    ],
  }
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks[0].tier, 'capable')
})
