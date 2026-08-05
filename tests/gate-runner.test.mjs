import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runCommandCheck, describePendingCheck, runChecks, aggregateVerdict } from '../scripts/gate-runner.mjs'

const fakeExec = (table) => async (cmd) => table[cmd] ?? { code: 127, output: `not stubbed: ${cmd}` }

test('a zero-exit command passes', async () => {
  const exec = fakeExec({ 'npm test': { code: 0, output: 'ok' } })
  const res = await runCommandCheck({ name: 'test', kind: 'command', run: 'npm test' }, { cwd: '.', exec })
  assert.equal(res.status, 'pass')
  assert.equal(res.exitCode, 0)
})

test('a non-zero-exit command fails', async () => {
  const exec = fakeExec({ 'npm test': { code: 1, output: 'boom' } })
  const res = await runCommandCheck({ name: 'test', kind: 'command', run: 'npm test' }, { cwd: '.', exec })
  assert.equal(res.status, 'fail')
  assert.equal(res.exitCode, 1)
  assert.match(res.output, /boom/)
})

test('failed command output is truncated to the last 40 lines', async () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
  const exec = fakeExec({ 'x': { code: 1, output: long } })
  const res = await runCommandCheck({ name: 'x', kind: 'command', run: 'x' }, { cwd: '.', exec })
  assert.equal(res.output.split('\n').length, 40)
  assert.match(res.output, /line 199/)
})

test('agent and mcp checks come back pending', () => {
  const res = describePendingCheck({ name: 'review', kind: 'agent', agent: 'tm-reviewer' })
  assert.equal(res.status, 'pending')
  assert.equal(res.kind, 'agent')
  assert.equal(res.check.agent, 'tm-reviewer')
})

test('runChecks executes commands and describes the rest', async () => {
  const exec = fakeExec({ 'npm test': { code: 0, output: '' } })
  const results = await runChecks([
    { name: 'test', kind: 'command', run: 'npm test' },
    { name: 'review', kind: 'agent', agent: 'tm-reviewer' },
  ], { cwd: '.', exec })
  assert.deepEqual(results.map((r) => r.status), ['pass', 'pending'])
})

test('all-pass aggregates to PASS', () => {
  const v = aggregateVerdict([{ name: 'a', status: 'pass' }, { name: 'b', status: 'pass' }])
  assert.equal(v.verdict, 'PASS')
  assert.deepEqual(v.failed, [])
})

test('any fail aggregates to FAIL and names the check', () => {
  const v = aggregateVerdict([{ name: 'a', status: 'pass' }, { name: 'b', status: 'fail' }])
  assert.equal(v.verdict, 'FAIL')
  assert.deepEqual(v.failed, ['b'])
})

test('a skipped optional check does not fail but is reported', () => {
  const v = aggregateVerdict([{ name: 'a', status: 'pass' }, { name: 'contract', status: 'skip', optional: true }])
  assert.equal(v.verdict, 'PASS')
  assert.deepEqual(v.skipped, ['contract'])
})

test('a non-optional pending check fails the gate', () => {
  const v = aggregateVerdict([{ name: 'review', status: 'pending' }])
  assert.equal(v.verdict, 'FAIL')
  assert.deepEqual(v.pending, ['review'])
})

test('an empty result set fails rather than silently passing', () => {
  assert.equal(aggregateVerdict([]).verdict, 'FAIL')
})

test('a result with no status field aggregates to FAIL', () => {
  const v = aggregateVerdict([{ name: 'x' }])
  assert.equal(v.verdict, 'FAIL')
  assert.deepEqual(v.failed, ['x'])
})

test('a result with an unrecognised status aggregates to FAIL', () => {
  const v = aggregateVerdict([{ name: 'y', status: 'passed' }])
  assert.equal(v.verdict, 'FAIL')
  assert.deepEqual(v.failed, ['y'])
})
