import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadGateConfig, inferGateConfig, checksForPhase } from '../scripts/gate-config.mjs'

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-gate-'))
  try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('loadGateConfig returns null when the manifest is absent', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await loadGateConfig(root), null)
  })
})

test('loadGateConfig reads the manifest', async () => {
  await withTempRoot(async (root) => {
    const config = { maxParallel: 4, phases: { default: { checks: [] } } }
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(config), 'utf8')
    assert.deepEqual(await loadGateConfig(root), config)
  })
})

test('inferGateConfig includes only scripts that exist', () => {
  const config = inferGateConfig({ scripts: { test: 'vitest run', build: 'next build' } })
  const names = config.phases.default.checks.map((c) => c.name)
  assert.deepEqual(names, ['test', 'build', 'fileset', 'ownership', 'review'])
})

test('inferGateConfig always appends fileset and ownership checks before review', () => {
  const config = inferGateConfig({ scripts: { test: 'node --test' } })
  const names = config.phases.default.checks.map((c) => c.name)
  assert.deepEqual(names, ['test', 'fileset', 'ownership', 'review'])
  const fileset = config.phases.default.checks.find((c) => c.name === 'fileset')
  const ownership = config.phases.default.checks.find((c) => c.name === 'ownership')
  assert.equal(fileset.kind, 'fileset')
  assert.notEqual(fileset.optional, true)
  assert.equal(ownership.kind, 'ownership')
  assert.notEqual(ownership.optional, true)
})

test('inferGateConfig orders typecheck, lint, test, build', () => {
  const config = inferGateConfig({ scripts: { build: 'b', lint: 'l', typecheck: 't', test: 'x' } })
  const names = config.phases.default.checks.filter((c) => c.kind === 'command').map((c) => c.name)
  assert.deepEqual(names, ['typecheck', 'lint', 'test', 'build'])
})

test('inferGateConfig always appends the review agent check', () => {
  const config = inferGateConfig({})
  const review = config.phases.default.checks.at(-1)
  assert.equal(review.kind, 'agent')
  assert.equal(review.agent, 'tm-reviewer')
  assert.deepEqual(review.blockOn, ['high'])
})

test('inferGateConfig sets a maxParallel default', () => {
  assert.equal(typeof inferGateConfig({}).maxParallel, 'number')
})

test('checksForPhase prefers a named phase over default', () => {
  const config = {
    phases: {
      default: { checks: [{ name: 'a', kind: 'command' }] },
      integration: { checks: [{ name: 'b', kind: 'command' }] },
    },
  }
  assert.equal(checksForPhase(config, 'integration')[0].name, 'b')
  assert.equal(checksForPhase(config, 'phase-2')[0].name, 'a')
})

test('checksForPhase returns an empty array when nothing is configured', () => {
  assert.deepEqual(checksForPhase({ phases: {} }, 'default'), [])
})
