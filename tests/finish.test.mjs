import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeRun, renderRunSummary, suppliedForPhase, validateSuppliedPhases } from '../scripts/finish.mjs'

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
  assert.match(validateSuppliedPhases([{ name: 'review' }]), /phases/)
  assert.match(validateSuppliedPhases({ results: [] }), /names no phases/)
})

test('a non-numeric phase key is refused', () => {
  assert.match(validateSuppliedPhases({ phases: { default: { results: [] } } }), /non-numeric phase/)
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
