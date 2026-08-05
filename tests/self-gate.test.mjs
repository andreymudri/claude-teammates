import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadGateConfig, checksForPhase } from '../scripts/gate-config.mjs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('the plugin ships its own gate manifest', async () => {
  const config = await loadGateConfig(root)
  assert.ok(config, 'teammates.gate.json is missing')
  assert.equal(typeof config.maxParallel, 'number')
})

test('the default phase runs the test suite and a review', async () => {
  const checks = checksForPhase(await loadGateConfig(root), 'default')
  const test_ = checks.find((c) => c.name === 'test')
  assert.equal(test_.kind, 'command')
  assert.match(test_.run, /npm test/)
  const review = checks.find((c) => c.name === 'review')
  assert.equal(review.agent, 'tm-reviewer')
})
