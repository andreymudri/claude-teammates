import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCoupling, confidence, neighboursOf, inventory, hotPairs, renderMap } from '../scripts/codemap.mjs'

const HISTORY = [
  ['src/order.ts', 'src/order.controller.ts', 'test/order.spec.ts'],
  ['src/order.ts', 'src/order.controller.ts'],
  ['src/order.ts', 'test/order.spec.ts'],
  ['src/billing.ts'],
]

test('support counts the commits that touched each file', () => {
  const c = buildCoupling(HISTORY)
  assert.equal(c.support.get('src/order.ts'), 3)
  assert.equal(c.support.get('src/billing.ts'), 1)
  assert.equal(c.usedCommits, 4)
})

test('confidence is the share of a file\'s commits that also touched the other', () => {
  const c = buildCoupling(HISTORY)
  assert.equal(confidence(c, 'src/order.ts', 'src/order.controller.ts'), 2 / 3)
})

// Asymmetry is the point: the controller never moves without the service, but the service moves
// without the controller a third of the time.
test('confidence is asymmetric', () => {
  const c = buildCoupling(HISTORY)
  assert.equal(confidence(c, 'src/order.controller.ts', 'src/order.ts'), 1)
})

test('a file nobody has touched has zero confidence rather than a division by zero', () => {
  assert.equal(confidence(buildCoupling(HISTORY), 'src/nothing.ts', 'src/order.ts'), 0)
})

// A mass rename or a formatting sweep couples everything to everything. Excluded by size,
// because a commit message is a convention and a file count is a fact.
test('a commit touching more files than the cap is excluded entirely', () => {
  const big = Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`)
  const c = buildCoupling([...HISTORY, big], { maxCommitFiles: 40 })
  assert.equal(c.usedCommits, 4)
  assert.equal(c.support.get('src/f0.ts'), undefined)
})

test('neighbours exclude the task\'s own files', () => {
  const c = buildCoupling(HISTORY)
  const out = neighboursOf(c, ['src/order.ts', 'src/order.controller.ts'], { minSupport: 1 })
  assert.deepEqual(out.map((n) => n.path), ['test/order.spec.ts'])
})

// Without a support floor, a file that has existed for one commit reads as maximally coupled to
// whatever arrived with it — the loudest possible signal from the least possible evidence.
test('a file below the support floor contributes no neighbours', () => {
  const c = buildCoupling(HISTORY)
  assert.deepEqual(neighboursOf(c, ['src/billing.ts'], { minSupport: 3 }), [])
})

test('a neighbour coupled to two declared files keeps its strongest score, never a sum', () => {
  const c = buildCoupling(HISTORY)
  const out = neighboursOf(c, ['src/order.ts', 'test/order.spec.ts'], { minSupport: 1 })
  const controller = out.find((n) => n.path === 'src/order.controller.ts')
  assert.ok(controller.confidence <= 1)
})

test('neighbours are ranked by confidence and capped by top', () => {
  const c = buildCoupling(HISTORY)
  assert.equal(neighboursOf(c, ['src/order.ts'], { top: 1, minSupport: 1 }).length, 1)
})

test('inventory rolls files up by directory, largest first', () => {
  const inv = inventory(['src/a.ts', 'src/b.ts', 'test/c.spec.ts', 'README.md'])
  assert.equal(inv.totalFiles, 4)
  assert.deepEqual(inv.rows[0], { dir: 'src', files: 2 })
  assert.ok(inv.rows.some((r) => r.dir === '.'))
})

test('inventory normalizes windows separators so one directory is not counted twice', () => {
  const inv = inventory(['src\\a.ts', 'src/b.ts'])
  assert.deepEqual(inv.rows, [{ dir: 'src', files: 2 }])
})

test('hotPairs reports the strongest direction of each pair', () => {
  const pairs = hotPairs(buildCoupling(HISTORY), { minSupport: 1, top: 1 })
  assert.equal(pairs[0].confidence, 1)
})

test('renderMap prints the totals, the directory rollup and the coupled pairs', () => {
  const out = renderMap({
    inventory: inventory(['src/a.ts', 'src/b.ts']),
    hotPairs: [{ file: 'src/a.ts', other: 'src/b.ts', confidence: 0.5 }],
    usedCommits: 12,
  })
  assert.match(out, /2 tracked files/)
  assert.match(out, /12 commits/)
  assert.match(out, /50%/)
  assert.match(out, /src\/a\.ts -> src\/b\.ts/)
})
