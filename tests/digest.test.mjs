import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderDigest } from '../scripts/digest.mjs'

const NOW = 1_000_000_000_000
const min = (m) => NOW - m * 60_000

const status = {
  runId: '3f2a',
  phase: 2,
  totalPhases: 4,
  maxParallel: 6,
  tasks: [
    { id: 'T1', title: 'auth-mw', state: 'running', startedAt: min(12) },
    { id: 'T2', title: 'db-schema', state: 'running', startedAt: min(9) },
    { id: 'T3', title: 'parser', state: 'done' },
    { id: 'T4', title: 'billing', state: 'blocked', blockedBy: 'db-schema' },
  ],
}

test('header carries run id, phase and task count', () => {
  const out = renderDigest(status, NOW)
  assert.match(out, /run 3f2a · phase 2\/4 · 4 tasks/)
})

test('running tasks show title and elapsed minutes', () => {
  const out = renderDigest(status, NOW)
  assert.match(out, /auth-mw\(12m\)/)
  assert.match(out, /db-schema\(9m\)/)
})

test('done tasks are listed with a check mark', () => {
  assert.match(renderDigest(status, NOW), /done\s+1\s+parser ✓/)
})

test('blocked tasks name their blocker', () => {
  assert.match(renderDigest(status, NOW), /billing — needs db-schema/)
})

test('idle slots are maxParallel minus running', () => {
  assert.match(renderDigest(status, NOW), /idle slots 4/)
})

test('idle slots never go negative', () => {
  const busy = { ...status, maxParallel: 1 }
  assert.match(renderDigest(busy, NOW), /idle slots 0/)
})

test('orphaned tasks are surfaced, never counted as done', () => {
  const withOrphan = { ...status, tasks: [...status.tasks, { id: 'T5', title: 'ui', state: 'orphaned' }] }
  const out = renderDigest(withOrphan, NOW)
  assert.match(out, /orphaned\s+1\s+ui/)
  assert.match(out, /done\s+1\s/)
})

test('a section with no tasks is omitted', () => {
  const clean = { ...status, tasks: [{ id: 'T1', title: 'x', state: 'done' }] }
  const out = renderDigest(clean, NOW)
  assert.ok(!out.includes('blocked'))
})

test('an unrecognized state appears under unknown section', () => {
  const withUnknown = { ...status, tasks: [...status.tasks, { id: 'T5', title: 'ghost', state: 'weird' }] }
  const out = renderDigest(withUnknown, NOW)
  assert.match(out, /unknown\s+1\s+ghost/)
})

test('a running task with no startedAt renders (?) not NaNm', () => {
  const noStart = { ...status, tasks: [{ id: 'T1', title: 'broken', state: 'running' }] }
  const out = renderDigest(noStart, NOW)
  assert.match(out, /broken\(\?\)/)
  assert.ok(!out.includes('NaN'))
})

test('with caveman omitted the output is identical to current expected strings', () => {
  const out1 = renderDigest(status, NOW)
  const out2 = renderDigest(status, NOW, false)
  assert.strictEqual(out1, out2)
  assert.match(out1, /run 3f2a · phase 2\/4 · 4 tasks/)
  assert.match(out1, /auth-mw\(12m\)/)
  assert.match(out1, /idle slots 4/)
})

test('with caveman: true the header takes terse form', () => {
  const out = renderDigest(status, NOW, true)
  assert.match(out, /^3f2a p2\/4 n4/)
})

test('with caveman: true a running task uses terse format', () => {
  const out = renderDigest(status, NOW, true)
  assert.match(out, /auth-mw12m/)
  assert.match(out, /db-schema9m/)
})

test('with caveman: true a blocked task uses terse format', () => {
  const out = renderDigest(status, NOW, true)
  assert.match(out, /billing<db-schema/)
})

test('with caveman: true the footer takes terse form', () => {
  const out = renderDigest(status, NOW, true)
  assert.match(out, /idle 4$/)
})

test('with caveman: true an unrecognized state still appears under unknown', () => {
  const withUnknown = { ...status, tasks: [...status.tasks, { id: 'T5', title: 'ghost', state: 'weird' }] }
  const out = renderDigest(withUnknown, NOW, true)
  assert.match(out, /unknown 1 ghost/)
})

test('with caveman: true a running task with no startedAt renders ? and never NaN', () => {
  const noStart = { ...status, tasks: [{ id: 'T1', title: 'broken', state: 'running' }] }
  const out = renderDigest(noStart, NOW, true)
  assert.match(out, /broken\?/)
  assert.ok(!out.includes('NaN'))
})
