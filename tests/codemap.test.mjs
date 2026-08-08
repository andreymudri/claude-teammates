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
  // From src/order.ts the controller is 2/3; from test/order.spec.ts it is only 1/2. The
  // strongest of the two must win, so the pinned value is 2/3 — keeping the weakest instead
  // would report 1/2, and summing them would report something above 1.
  assert.equal(controller.confidence, 2 / 3)
})

// Three candidates with clearly different confidences: 0.75, 0.5 and 0.25 against the same
// declared file. Only asserting a length leaves the sort direction unpinned — reversing it
// still returns one result when top is 1.
const RANK_HISTORY = [
  ['rank/a.ts', 'rank/x.ts', 'rank/y.ts', 'rank/z.ts'],
  ['rank/a.ts', 'rank/x.ts', 'rank/y.ts'],
  ['rank/a.ts', 'rank/x.ts'],
  ['rank/a.ts'],
]

test('neighbours are ranked by confidence and capped by top', () => {
  const c = buildCoupling(RANK_HISTORY)
  const out = neighboursOf(c, ['rank/a.ts'], { top: 3, minSupport: 1 })
  assert.deepEqual(out.map((n) => n.path), ['rank/x.ts', 'rank/y.ts', 'rank/z.ts'])
  assert.equal(neighboursOf(c, ['rank/a.ts'], { top: 1, minSupport: 1 }).length, 1)
})

// No other test omits its thresholds, so the module's documented defaults were never actually
// exercised — every option could drift silently as long as callers kept passing explicit values.

test('a commit larger than the default cap is excluded when maxCommitFiles is not passed', () => {
  const big = Array.from({ length: 41 }, (_, i) => `default/f${i}.ts`)
  const c = buildCoupling([big, ['default/a.ts', 'default/b.ts']])
  assert.equal(c.usedCommits, 1)
  assert.equal(c.support.get('default/f0.ts'), undefined)
})

test('a file with support 2 contributes no neighbours when minSupport is not passed', () => {
  const c = buildCoupling([
    ['default/lonely.ts', 'default/friend.ts'],
    ['default/lonely.ts', 'default/friend.ts'],
  ])
  assert.deepEqual(neighboursOf(c, ['default/lonely.ts']), [])
})

test('neighboursOf returns at most five neighbours when top is not passed', () => {
  const commits = Array.from({ length: 6 }, (_, i) => ['default/hub.ts', `default/n${i}.ts`])
  const c = buildCoupling(commits)
  const out = neighboursOf(c, ['default/hub.ts'])
  assert.equal(out.length, 5)
})

test('hotPairs excludes a pair below the default support floor when minSupport is not passed', () => {
  const c = buildCoupling([
    ['default/solo.ts', 'default/partner.ts'],
    ['default/solo.ts', 'default/partner.ts'],
  ])
  assert.deepEqual(hotPairs(c), [])
})

// hotPairs and neighboursOf claim to never disagree about what counts. neighboursOf only
// trusts a file's own coupling once that file itself clears the support floor; a `&&` version
// of hotPairs's floor admits a pair as soon as EITHER endpoint clears it, so a file seen in a
// single commit can still top the list at 100% confidence just by pairing with something
// well-established.
test('hotPairs admits a pair only when the reported file itself clears the floor', () => {
  const c = buildCoupling([
    ['default/popular.ts', 'default/once.ts'],
    ['default/popular.ts', 'default/other1.ts'],
    ['default/popular.ts', 'default/other2.ts'],
  ])
  const pairs = hotPairs(c, { minSupport: 3 })
  assert.deepEqual(pairs, [])
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
