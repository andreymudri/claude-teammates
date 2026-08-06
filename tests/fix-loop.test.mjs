import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideFix } from '../scripts/fix-loop.mjs'
import { aggregateVerdict } from '../scripts/gate-runner.mjs'

function makePhase() {
  const tasks = [
    { id: 'T1', files: ['src/a.mjs'], tier: 'cheap' },
    { id: 'T2', files: ['src/b.mjs'], tier: 'mid' },
  ]
  return tasks
}

// Mirrors what `scripts/cli.mjs` actually prints: aggregateVerdict's summary spread over the
// bound fields, with the per-check objects under `results` — never `checks`. Building the
// fixture through the real aggregator means a change to the emitted shape breaks these tests
// instead of silently making decideFix blind to every real failure.
function emitVerdict(results, phase = 1) {
  const verdict = aggregateVerdict(results)
  const branchShas = Object.assign({}, ...results.map((r) => r.branchShas ?? {}))
  return { ...verdict, anchorSha: 'a'.repeat(40), planHash: 'plan-hash', branchShas, phase, results }
}

function commandCheck(name, output, extra = {}) {
  return { name, kind: 'command', status: 'fail', exitCode: 1, output, optional: false, ...extra }
}

function agentCheck(name, findings, extra = {}) {
  return { name, kind: 'agent', status: 'fail', findings, output: '', optional: false, ...extra }
}

test('a verdict with no failing checks returns decision: none', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'lint', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
  ])
  const result = decideFix(verdict, 1, tasks, {}, {})
  assert.equal(result.decision, 'none')
  assert.deepEqual(result.tasks, [])
  assert.equal(result.reason, null)
})

test('a realistically emitted FAIL verdict is read from results, so a fileset failure escalates', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'fileset', kind: 'fileset', status: 'fail', output: 'T1: outside declared set — src/z.mjs', optional: false },
    agentCheck('agent-check', [{ file: 'src/a.mjs' }]),
  ])
  // Guards the fixture itself: the CLI emits string-name arrays here, not per-check objects.
  assert.deepEqual(verdict.failed, ['fileset', 'agent-check'])
  assert.equal(verdict.checks, undefined)

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
  assert.equal(result.check, 'fileset')
})

test('a failing ownership check escalates with process-violation', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'ownership', kind: 'ownership', status: 'fail', output: 'unexplained commit', optional: false },
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
  assert.equal(result.check, 'ownership')
})

test('a failing agent check citing src/a.mjs retries T1 at tier mid, round 1', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].taskId, 'T1')
  assert.equal(result.tasks[0].tier, 'mid')
  assert.equal(result.tasks[0].round, 1)
  assert.deepEqual(result.tasks[0].checks, ['agent-check'])
})

test('an agent finding citing the SECOND task retries T2, not whichever task came first', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/b.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].taskId, 'T2')
  // T2 is declared `mid`, so its own escalation is `capable` — a tier T1 would never produce.
  assert.equal(result.tasks[0].tier, 'capable')
  assert.equal(result.tasks[0].round, 1)
})

test('a failing command check whose output mentions src/b.mjs retries T2 at tier capable', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([commandCheck('command-check', 'error in src/b.mjs at line 10')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].taskId, 'T2')
  assert.equal(result.tasks[0].tier, 'capable')
})

test('a failing command check whose output mentions no declared file escalates as unattributable', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([commandCheck('command-check', 'error in src/unrelated.mjs')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.equal(result.check, 'command-check')
})

test('an optional check that fails does not drive the loop, matching the PASS the gate issued', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'lint', kind: 'command', status: 'fail', exitCode: 1, output: 'src/a.mjs: advisory', optional: true },
    { name: 'unit', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
  ])
  assert.equal(verdict.verdict, 'PASS')
  assert.deepEqual(verdict.optionalFailed, ['lint'])

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'none')
  assert.deepEqual(result.tasks, [])
})

test('rounds is the already-unwrapped per-phase map: T1 at round 2 with budget 2 is exhausted', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])], 3)
  // Exactly what readFixRounds(status, phase) hands back — the { taskId: count } map itself.
  const rounds = { T1: 2 }
  const result = decideFix(verdict, 3, tasks, rounds, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'budget-exhausted')
  assert.equal(result.taskId, 'T1')
})

test('rounds is not re-indexed by phase, so a count already spent is carried into the next round number', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])], 3)
  const result = decideFix(verdict, 3, tasks, { T1: 1 }, { fixRounds: 3 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks[0].round, 2)
})

test('an agent finding carrying an absolute backslash path still attributes to its owner', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    agentCheck('agent-check', [{ file: 'C:\\projetos\\repo\\src\\b.mjs', line: 12 }]),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].taskId, 'T2')
})

test('an agent finding citing a longer path that merely ends in a declared name does not attribute', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'vendor/other-src/a.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
})

test('command output naming only a neighbouring file does not attribute to the declared prefix', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    commandCheck('command-check', 'snapshot mismatch: src/a.mjs.snap is obsolete'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.equal(result.check, 'command-check')
})

test('command output naming a declared file with a windows path and a line suffix attributes', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    commandCheck('command-check', 'FAIL C:\\projetos\\repo\\src\\a.mjs:41:7 expected 1'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks[0].taskId, 'T1')
})

test('a task at tier capable retries at capable, pinning the cap', () => {
  const tasks = [{ id: 'T1', files: ['src/a.mjs'], tier: 'capable' }]
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks[0].tier, 'capable')
})

test('a task from a plan written before routing existed carries no tier and defaults to mid', () => {
  const tasks = [{ id: 'T1', files: ['src/a.mjs'] }]
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.equal(result.tasks[0].tier, 'capable')
})
