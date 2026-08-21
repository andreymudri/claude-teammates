import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeRun, renderRunSummary, suppliedForPhase, validateSuppliedPhases, renderPlanNotes } from '../scripts/finish.mjs'

const phase = (n, over = {}) => ({
  phase: n,
  verdict: { verdict: 'PASS', failed: [], optionalFailed: [], skipped: [], pending: [] },
  ...over,
})

test('every phase passing summarizes as complete', () => {
  const summary = summarizeRun([phase(1), phase(2)])
  assert.equal(summary.complete, true)
  assert.deepEqual(summary.failedPhases, [])
  assert.deepEqual(summary.pendingPhases, [])
})

test('a failed check names the phase and the check that failed it', () => {
  const summary = summarizeRun([
    phase(1),
    phase(2, { verdict: { verdict: 'FAIL', failed: ['fileset'], optionalFailed: [], skipped: [], pending: [] } }),
  ])
  assert.equal(summary.complete, false)
  assert.deepEqual(summary.failedPhases, [2])
  assert.deepEqual(summary.pendingPhases, [])
})

// A pending `agent` check is not a failure — nothing about it was computed at all. It is the
// difference between "this phase is broken" and "this phase is unverified", and collapsing the
// two would let an operator read an unreviewed run as a rejected one, or worse, retry it.
test('a pending check is reported apart from a failure', () => {
  const summary = summarizeRun([
    phase(1, { verdict: { verdict: 'FAIL', failed: [], optionalFailed: [], skipped: [], pending: ['review'] } }),
  ])
  assert.equal(summary.complete, false)
  assert.deepEqual(summary.failedPhases, [])
  assert.deepEqual(summary.pendingPhases, [1])
})

test('a phase both failing and pending counts as failing', () => {
  const summary = summarizeRun([
    phase(1, { verdict: { verdict: 'FAIL', failed: ['test'], optionalFailed: [], skipped: [], pending: ['review'] } }),
  ])
  assert.deepEqual(summary.failedPhases, [1])
  assert.deepEqual(summary.pendingPhases, [])
})

// A run with no phases at all must never read as finished: it is a plan that parsed to nothing,
// not a body of work that passed.
test('a run with no phases is not complete', () => {
  const summary = summarizeRun([])
  assert.equal(summary.complete, false)
})

test('the rendered table carries one row per phase, its verdict and its blocking checks', () => {
  const out = renderRunSummary('r1', [
    phase(1),
    phase(2, { verdict: { verdict: 'FAIL', failed: ['ownership'], optionalFailed: [], skipped: [], pending: [] } }),
    phase(3, { verdict: { verdict: 'FAIL', failed: [], optionalFailed: [], skipped: [], pending: ['review'] } }),
  ])
  assert.match(out, /phase 1\s+PASS/)
  assert.match(out, /phase 2\s+FAIL/)
  assert.match(out, /ownership/)
  assert.match(out, /phase 3/)
  assert.match(out, /pending/)
  assert.match(out, /not finished/i)
})

test('the rendered table says the run is verified when every phase passes', () => {
  const out = renderRunSummary('r1', [phase(1), phase(2)])
  assert.match(out, /every phase/i)
  assert.doesNotMatch(out, /not finished/i)
})

// The recomputation is the evidence. Saying so in the output keeps a pasted table from being
// read later as a record that once passed — the exact confusion status.gates already causes.
test('the rendered table states that the verdicts were recomputed now', () => {
  assert.match(renderRunSummary('r1', [phase(1)]), /recomputed/i)
})

test('results are selected by phase, never shared between phases', () => {
  const supplied = { phases: { 1: { results: [{ name: 'review', status: 'pass' }] }, 2: { results: [] } } }
  assert.equal(suppliedForPhase(supplied, 1).length, 1)
  assert.deepEqual(suppliedForPhase(supplied, 2), [])
  assert.deepEqual(suppliedForPhase(supplied, 3), [])
})

test('a missing or malformed results file yields nothing rather than throwing', () => {
  assert.deepEqual(suppliedForPhase(null, 1), [])
  assert.deepEqual(suppliedForPhase({ phases: null }, 1), [])
})

test('a results file shaped as a flat list is refused, naming the shape expected', () => {
  assert.match(validateSuppliedPhases([{ name: 'review' }]), /must be a JSON object shaped/)
  assert.match(validateSuppliedPhases({ results: [] }), /names no phases/)
})

// "phases" itself must be an object keyed by phase number. `{"phases": []}` is the case that
// matters most: an array has typeof 'object', so a validator that only checked typeof would
// let it through, `Object.entries` on an array iterates its indices (or nothing, if empty), and
// finish would silently supply nothing while telling the operator the check is still pending.
// The assertion below matches text only this specific refusal contains — "keyed by phase
// number" — so deleting the refusal and falling through to the flat-list message (which also
// contains the word "phases") does not accidentally satisfy this test.
test('"phases" that is not an object is refused, not silently emptied', () => {
  assert.match(validateSuppliedPhases({ phases: [] }), /"phases" must be an object keyed by phase number/)
  assert.match(validateSuppliedPhases({ phases: 'x' }), /"phases" must be an object keyed by phase number/)
  assert.match(validateSuppliedPhases({ phases: null }), /"phases" must be an object keyed by phase number/)
})

test('a non-numeric phase key is refused', () => {
  assert.match(validateSuppliedPhases({ phases: { default: { results: [] } } }), /non-numeric phase/)
})

// A key that parses to a number but is not that number's own canonical string form matches
// nothing at lookup: `suppliedForPhase` looks up `byPhase[String(phase)]`, so '01' never
// resolves to phase 1. Refusing here is the chosen behaviour (see the comment in finish.mjs),
// so each of these must be rejected rather than silently accepted and then never found.
test('a numeric phase key that is not its own canonical form is refused', () => {
  for (const key of ['01', '1.0', ' 1', '1e0', '0x1', '']) {
    assert.match(
      validateSuppliedPhases({ phases: { [key]: { results: [] } } }),
      /non-canonical phase key/,
      `expected ${JSON.stringify(key)} to be refused`,
    )
  }
})

test('a phase entry without a results array is refused', () => {
  assert.match(validateSuppliedPhases({ phases: { 1: {} } }), /results array/)
})

test('a well-formed file passes validation', () => {
  assert.equal(validateSuppliedPhases({ phases: { 1: { results: [] } } }), null)
})

test('the summary marks a phase that passed on supplied results', () => {
  const out = renderRunSummary('r1', [
    { phase: 1, supplied: true, verdict: { verdict: 'PASS', failed: [], optionalFailed: [], skipped: [], pending: [] } },
  ])
  assert.match(out, /review supplied/)
})

test('renderPlanNotes returns empty string when plan is empty', () => {
  assert.equal(renderPlanNotes({}), '')
})

test('renderPlanNotes renders destination alone', () => {
  const out = renderPlanNotes({
    destination: 'the gate can answer "is this run landable" without an operator reading prose.',
    notYetSpecified: [],
  })
  assert.match(out, /^Destination:/)
  assert.match(out, /the gate can answer/)
  assert.doesNotMatch(out, /Not yet specified/)
})

test('renderPlanNotes renders fog alone', () => {
  const out = renderPlanNotes({
    destination: null,
    notYetSpecified: [
      { text: 'How should finish report a phase whose reviewers disagreed?', line: 10 },
      { text: 'Does the map coupling data belong in the gate at all?', line: 11 },
    ],
  })
  assert.doesNotMatch(out, /^Destination:/)
  assert.match(out, /Not yet specified \(2 open\)/)
  assert.match(out, /How should finish report/)
  assert.match(out, /Does the map coupling data/)
})

test('renderPlanNotes renders both destination and fog', () => {
  const out = renderPlanNotes({
    destination: 'a clear goal',
    notYetSpecified: [
      { text: 'What is X?', line: 5 },
    ],
  })
  assert.match(out, /^Destination: a clear goal\n/)
  assert.match(out, /Not yet specified \(1 open\)/)
  assert.match(out, /What is X\?/)
})

test('renderPlanNotes does not render outOfScope entries', () => {
  const out = renderPlanNotes({
    destination: 'goal',
    notYetSpecified: [],
    outOfScope: [
      { text: 'Performance optimization', line: 15 },
    ],
  })
  assert.match(out, /Destination: goal/)
  assert.doesNotMatch(out, /Performance optimization/)
})

test('renderPlanNotes returns empty string when destination is null and notYetSpecified is empty', () => {
  assert.equal(renderPlanNotes({
    destination: null,
    notYetSpecified: [],
    outOfScope: [{ text: 'something', line: 1 }],
  }), '')
})
