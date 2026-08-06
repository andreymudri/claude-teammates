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

// --- attribution: the most specific declared path owns the file, not the first task listed ---

// T1 declares `src/a.mjs` and T2 declares `vendor/src/a.mjs`. A suffix match makes the reported
// `vendor/src/a.mjs` look like T1's file too, and `tasks.find` then hands the retry to whichever
// task the plan happened to list first. T1 would be retried on a path outside its own declared
// write set: either the round is wasted or T1 widens its fileset and trips the next gate.
const nestedTasks = [
  { id: 'T1', files: ['src/a.mjs'], tier: 'cheap' },
  { id: 'T2', files: ['vendor/src/a.mjs'], tier: 'mid' },
]

test('an agent finding citing vendor/src/a.mjs retries the task that declares it, not the suffix match', () => {
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'vendor/src/a.mjs' }])])
  const result = decideFix(verdict, 1, nestedTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T2'])
})

test('the other direction: an agent finding citing src/a.mjs still retries only the shorter declarer', () => {
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/a.mjs' }])])
  const result = decideFix(verdict, 1, nestedTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T1'])
})

test('a command output naming vendor/src/a.mjs attributes to the owner alone, not to both tasks', () => {
  const verdict = emitVerdict([commandCheck('command-check', 'FAIL vendor/src/a.mjs:3 boom')])
  const result = decideFix(verdict, 1, nestedTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T2'])
})

test('a command output naming both declared paths still attributes to both, one occurrence each', () => {
  const verdict = emitVerdict([
    commandCheck('command-check', 'FAIL vendor/src/a.mjs:3 boom\nFAIL src/a.mjs:9 boom'),
  ])
  const result = decideFix(verdict, 1, nestedTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId).sort(), ['T1', 'T2'])
})

// A bare single-segment declaration has no directory to anchor it, so a trailing-segment match
// would let it claim every same-named file in the tree — the widest possible over-attribution.
const bareTasks = [{ id: 'T1', files: ['a.mjs'], tier: 'mid' }]

test('a task declaring a bare filename does not claim a nested file of the same name (agent)', () => {
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'vendor/dep/a.mjs' }])])
  const result = decideFix(verdict, 1, bareTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
})

test('a task declaring a bare filename does not claim a nested file of the same name (command)', () => {
  const verdict = emitVerdict([commandCheck('command-check', 'FAIL vendor/dep/a.mjs:3 boom')])
  const result = decideFix(verdict, 1, bareTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
})

test('a task declaring a bare filename still owns that file at the repo root', () => {
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: './a.mjs' }])])
  const result = decideFix(verdict, 1, bareTasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T1'])
})

// --- the leading path boundary in `mentions` ---

// Pins `(?<![0-9A-Za-z._-])`. Deleting it leaves every other test green while letting a task
// that declares only `src/a.mjs` be retried for a failure in someone else's `other-src/a.mjs`.
test('command output naming a differently-prefixed sibling directory does not attribute', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    commandCheck('command-check', 'vendor/other-src/a.mjs: parse error'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.equal(result.check, 'command-check')
})

test('command output naming a file whose leading segment merely ends in the declared one does not attribute', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([commandCheck('command-check', 'my-src/a.mjs failed')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
})

// --- the failing set must mirror aggregateVerdict's blocking set ---

// aggregateVerdict blocks on three things: a non-optional `fail`, ANY unrecognized or missing
// status, and ANY non-optional `pending`. Counting only the first means the gate FAILs while
// decideFix returns `none`. The skill forbids integrating on `none` and asks the operator to
// re-derive the verdict — but re-deriving is deterministic, so gate -> none -> gate loops
// forever with no escalate exit. Every one of these must reach a terminal decision.
test('a non-optional pending check blocks the gate, so it must not read as decision none', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'mcp-check', kind: 'mcp', status: 'pending', output: 'no runner for kind mcp', optional: false },
  ])
  assert.equal(verdict.verdict, 'FAIL')
  assert.deepEqual(verdict.pending, ['mcp-check'])

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.notEqual(result.decision, 'none')
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.equal(result.check, 'mcp-check')
})

test('an unrecognized status blocks the gate even when marked optional, so decideFix must too', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'weird', kind: 'command', status: 'errored', output: 'src/b.mjs blew up', optional: true },
  ])
  // aggregateVerdict routes unrecognized statuses to `failed` regardless of `optional`.
  assert.equal(verdict.verdict, 'FAIL')
  assert.deepEqual(verdict.failed, ['weird'])

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T2'])
})

test('a missing status blocks the gate and must not be silently dropped from the failing set', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([{ name: 'no-status', kind: 'command', output: '', optional: false }])
  assert.equal(verdict.verdict, 'FAIL')

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
})

test('an optional pending check does not block the gate, so it stays out of the failing set', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'advisory', kind: 'mcp', status: 'pending', output: 'src/a.mjs', optional: true },
    { name: 'unit', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
  ])
  assert.equal(verdict.verdict, 'PASS')

  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'none')
})

test('a skipped check is not blocking and does not enter the failing set', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'unit', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
    { name: 'e2e', kind: 'command', status: 'skip', output: '', optional: false },
  ])
  assert.equal(verdict.verdict, 'PASS')
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'none')
})

// --- the process-violation scan must precede the optional filter ---

// `ALWAYS_ENFORCED_KINDS` forces `optional: false` when the gate constructs the result, inside
// the gate process. decideFix does not consume that object: it consumes a serialized verdict
// handed in by the caller — assembled, per the skill, by the same agent whose fileset violation
// is being adjudicated. `optional: true` on a fileset check is therefore reachable, and it must
// not be able to downgrade the escalation to `none`.
test('a fileset failure marked optional still escalates as a process violation', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'fileset', kind: 'fileset', status: 'fail', output: 'T1 wrote src/z.mjs', optional: true },
    { name: 'unit', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
  assert.equal(result.check, 'fileset')
})

test('an optional fileset failure escalates rather than being masked by an attributable retry', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'fileset', kind: 'fileset', status: 'fail', output: 'T1 wrote src/z.mjs', optional: true },
    commandCheck('unit', 'error in src/a.mjs'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
})

test('an ownership check left pending is outside pass/skip and escalates as a process violation', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'ownership', kind: 'ownership', status: 'pending', output: '', optional: true },
    { name: 'unit', kind: 'command', status: 'pass', exitCode: 0, output: '', optional: false },
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'process-violation')
  assert.equal(result.check, 'ownership')
})

test('a passing fileset check is not a process violation', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'fileset', kind: 'fileset', status: 'pass', output: '', optional: false },
    commandCheck('unit', 'error in src/a.mjs'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T1'])
})

test('a skipped fileset check is not a process violation', () => {
  const tasks = makePhase()
  const verdict = emitVerdict([
    { name: 'fileset', kind: 'fileset', status: 'skip', output: '', optional: false },
    commandCheck('unit', 'error in src/a.mjs'),
  ])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
})

// --- a task carrying no `files` key at all ---

// Pins both `task.files ?? []` sites. A plan task with no declared file set is malformed, but
// decideFix's whole contract is to return a decision the caller can serialise; a TypeError
// crashes the gate loop with no verdict recorded at all.
test('a task with no files key yields a serialisable decision, not a TypeError (agent path)', () => {
  const tasks = [{ id: 'T1', tier: 'mid' }, { id: 'T2', files: ['src/b.mjs'], tier: 'mid' }]
  const verdict = emitVerdict([agentCheck('agent-check', [{ file: 'src/b.mjs' }])])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'retry')
  assert.deepEqual(result.tasks.map((t) => t.taskId), ['T2'])
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('a task with no files key yields a serialisable decision, not a TypeError (command path)', () => {
  const tasks = [{ id: 'T1', tier: 'mid' }]
  const verdict = emitVerdict([commandCheck('command-check', 'error in src/a.mjs')])
  const result = decideFix(verdict, 1, tasks, {}, { fixRounds: 2 })
  assert.equal(result.decision, 'escalate')
  assert.equal(result.reason, 'unattributable')
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})
