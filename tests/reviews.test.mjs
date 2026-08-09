import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewFileName, collectReviewResults, reviewStamp, reviewStale } from '../scripts/reviews.mjs'

test('a lens findings file is named by phase and lens', () => {
  assert.equal(reviewFileName(1, 'correctness'), '1-correctness.json')
  assert.equal(reviewFileName('default', 'tests'), 'default-tests.json')
})

// A lens name is written into a path, so it is untrusted input like any other. A traversing or
// absolute lens must not be able to name a file outside the reviews directory.
test('a lens that tries to escape the reviews directory is refused', () => {
  assert.throws(() => reviewFileName(1, '../../etc/passwd'), /lens/i)
  assert.throws(() => reviewFileName(1, 'a/b'), /lens/i)
  assert.throws(() => reviewFileName(1, ''), /lens/i)
})

const findings = (severity) => [{ severity, file: 'a.mjs', line: 1, summary: 's', failureScenario: 'f' }]

test('every lens present with no findings collects to a single passing result', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['correctness', 'security'],
    files: [
      { lens: 'correctness', findings: [] },
      { lens: 'security', findings: [] },
    ],
    blockOn: ['high'],
  })
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].status, 'pass')
  assert.equal(out.results[0].source, 'file')
  assert.deepEqual(out.missing, [])
})

test('a finding at a blocking severity fails the check and travels with it', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['correctness'],
    files: [{ lens: 'correctness', findings: findings('high') }],
    blockOn: ['high'],
  })
  assert.equal(out.results[0].status, 'fail')
  assert.equal(out.results[0].findings.length, 1)
})

// Severity below the manifest's `blockOn` is reported but does not fail the phase — the same
// rule the gate applies to a returned review, applied to a recovered one.
test('a finding below the blocking severity leaves the check passing', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['correctness'],
    files: [{ lens: 'correctness', findings: findings('low') }],
    blockOn: ['high'],
  })
  assert.equal(out.results[0].status, 'pass')
  assert.equal(out.results[0].findings.length, 1)
})

// The distinction the whole fallback rests on: a lens with no file is a review that was LOST,
// which is not the same fact as a review that found nothing. Emitting a pass for it would hand
// the gate exactly the vacuous PASS the pending status exists to prevent.
test('a lens with no file is reported missing and never becomes an empty pass', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['correctness', 'security', 'tests'],
    files: [{ lens: 'correctness', findings: [] }],
    blockOn: ['high'],
  })
  assert.deepEqual(out.missing, ['security', 'tests'])
  assert.equal(out.results.length, 0)
})

test('a file for a lens nobody asked for is reported rather than silently merged', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['correctness'],
    files: [
      { lens: 'correctness', findings: [] },
      { lens: 'made-up', findings: findings('high') },
    ],
    blockOn: ['high'],
  })
  assert.deepEqual(out.unexpected, ['made-up'])
  // The unexpected lens must not contribute its finding to the verdict either.
  assert.equal(out.results[0].status, 'pass')
})

test('the output names the lens each finding came from', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['correctness', 'security'],
    files: [
      { lens: 'correctness', findings: findings('high') },
      { lens: 'security', findings: findings('medium') },
    ],
    blockOn: ['high'],
  })
  assert.deepEqual(out.results[0].findings.map((f) => f.lens), ['correctness', 'security'])
})

const STAMP = { phase: '1', branches: ['teammates/r1/T1@aaa', 'teammates/r1/T2@bbb'] }

test('a stamp names the phase, the lens and every branch tip it judged', () => {
  const s = reviewStamp({ phase: 1, lens: 'tests', branchShas: { 'teammates/r1/T2': 'bbb', 'teammates/r1/T1': 'aaa' } })
  assert.equal(s.phase, '1')
  assert.equal(s.lens, 'tests')
  // Sorted, so two runs over the same tips produce the same stamp.
  assert.deepEqual(s.branches, ['teammates/r1/T1@aaa', 'teammates/r1/T2@bbb'])
})

test('a stamp matching the current tips is not stale', () => {
  assert.equal(reviewStale({ stamp: { ...STAMP, lens: 'tests' } }, { ...STAMP, lens: 'tests' }), null)
})

// The exact failure this closes: a fix round moves a branch, the old findings file stays on disk.
test('findings describing an older branch tip are stale and say which', () => {
  const why = reviewStale(
    { stamp: { phase: '1', lens: 'tests', branches: ['teammates/r1/T1@aaa'] } },
    { phase: '1', lens: 'tests', branches: ['teammates/r1/T1@ccc'] },
  )
  assert.match(why, /aaa/)
  assert.match(why, /ccc/)
})

test('an unstamped findings file is stale whatever it contains', () => {
  assert.match(reviewStale({ findings: [] }, { ...STAMP, lens: 'tests' }), /no stamp/)
})

test('a stale lens is reported and never contributes a pass', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['correctness'],
    files: [{ lens: 'correctness', findings: [], stamp: { phase: '1', lens: 'correctness', branches: ['teammates/r1/T1@old'] } }],
    expected: { phase: '1', branches: ['teammates/r1/T1@new'] },
    blockOn: ['high'],
  })
  assert.deepEqual(out.results, [])
  assert.deepEqual(out.missing, ['correctness'])
  assert.equal(out.stale.length, 1)
  assert.match(out.stale[0].reason, /old/)
})

test('with no expected stamp supplied, a file without one is still accepted', () => {
  const out = collectReviewResults({
    checkName: 'review', lenses: ['correctness'],
    files: [{ lens: 'correctness', findings: [] }], blockOn: ['high'],
  })
  assert.equal(out.results.length, 1)
  assert.deepEqual(out.stale, [])
})
