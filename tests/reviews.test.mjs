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

// A phase-1 findings file must not satisfy phase 2, even when the lens and the branch tips it
// names line up — the exact reason the stamp carries a phase at all. Deleting the phase
// comparison from `reviewStale` would leave every existing test green, since they all compare
// phase '1' against phase '1'.
test('findings stamped for one phase do not satisfy a different phase', () => {
  const why = reviewStale(
    { stamp: { phase: '1', lens: 'tests', branches: STAMP.branches } },
    { phase: '2', lens: 'tests', branches: STAMP.branches },
  )
  assert.match(why, /phase 1/)
  assert.match(why, /phase 2/)
})

// The lens comparison, pinned the same way: matching phase and branches must not paper over a
// mismatched lens.
test('findings stamped for one lens do not satisfy a different lens', () => {
  const why = reviewStale(
    { stamp: { phase: '1', lens: 'security', branches: STAMP.branches } },
    { phase: '1', lens: 'correctness', branches: STAMP.branches },
  )
  assert.match(why, /security/)
  assert.match(why, /correctness/)
})

// The not-an-object guard, pinned directly rather than relying on it merely not throwing
// elsewhere.
test('a non-object findings file is refused rather than throwing', () => {
  assert.match(reviewStale(null, { ...STAMP, lens: 'tests' }), /not an object/)
  assert.match(reviewStale('nope', { ...STAMP, lens: 'tests' }), /not an object/)
  assert.match(reviewStale([], { ...STAMP, lens: 'tests' }), /not an object/)
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

// A `claims` reviewer that could not get a green baseline probed nothing, and says so in
// `unableToVerify`. Collected as a pass it becomes indistinguishable from a lens that looked at
// everything and found nothing — the same vacuous PASS a missing file is refused for.
test('a lens reporting unableToVerify emits nothing and is named with its reason', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['claims', 'correctness'],
    files: [
      { lens: 'claims', findings: [], unableToVerify: 'the baseline suite was red' },
      { lens: 'correctness', findings: [] },
    ],
    blockOn: ['high'],
  })
  assert.deepEqual(out.results, [])
  assert.equal(out.unverified.length, 1)
  assert.equal(out.unverified[0].lens, 'claims')
  assert.match(out.unverified[0].reason, /baseline suite was red/)
  // Unaccounted for, exactly like a lens whose file never arrived.
  assert.deepEqual(out.missing, ['claims'])
})

// The control for the test above: the refusal must be caused by the key, not by anything else
// about the fixture. Without this, deleting `unableToVerify` from the reason test would still
// leave it green if the file were being rejected for some unrelated reason.
test('the same lens file without unableToVerify collects normally', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['claims', 'correctness'],
    files: [
      { lens: 'claims', findings: [] },
      { lens: 'correctness', findings: [] },
    ],
    blockOn: ['high'],
  })
  assert.deepEqual(out.unverified, [])
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].status, 'pass')
})

// The mere presence of the key is not the test: a reviewer that verified everything and wrote an
// empty string has not reported a failure to verify, and refusing it would cost a real review.
test('an empty unableToVerify string is treated as a verified lens', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['claims'],
    files: [{ lens: 'claims', findings: [], unableToVerify: '' }],
    blockOn: ['high'],
  })
  assert.deepEqual(out.unverified, [])
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].status, 'pass')
})

// The documented shape of the key is a reason string. A value of some other type is neither a
// stated failure nor a clean review, and guessing it either way is wrong for a plausible file —
// so it is refused on its own third route rather than folded into one of the other two.
//
// An EMPTY array is the case that matters most here, because it is what a reviewer that did full
// work plausibly writes. Read as truthy it would refuse a complete review; read as absent it
// would force the same rule to also decide about `true`, where "absent" means a reviewer saying
// it verified nothing is recorded as a pass.
test('an unableToVerify that is not a string is reported as malformed, not silently either way', () => {
  for (const value of [[], ['the baseline suite was red'], true, 0, { why: 'x' }]) {
    const out = collectReviewResults({
      checkName: 'review',
      lenses: ['claims'],
      files: [{ lens: 'claims', findings: [], unableToVerify: value }],
      blockOn: ['high'],
    })
    const shown = JSON.stringify(value)
    assert.deepEqual(out.results, [], `${shown} must not emit a result`)
    assert.deepEqual(out.unverified, [], `${shown} is not a stated reason, so it is not an unverified report`)
    assert.equal(out.malformed.length, 1, `${shown} must be reported as malformed`)
    assert.equal(out.malformed[0].lens, 'claims')
    assert.match(out.malformed[0].reason, /unableToVerify/)
  }
})

// The empty array and the non-empty array must land on the SAME route. Pinned as two cases
// rather than one, because a rule that reads emptiness rather than type would split them — and
// the next spelling should be caught by this test rather than by a reviewer.
test('an empty and a non-empty unableToVerify array are both malformed, never one of each', () => {
  const collect = (value) => collectReviewResults({
    checkName: 'review', lenses: ['claims'],
    files: [{ lens: 'claims', findings: [], unableToVerify: value }], blockOn: ['high'],
  })
  const empty = collect([])
  const full = collect(['the baseline suite was red'])
  assert.equal(empty.malformed.length, 1)
  assert.equal(full.malformed.length, 1)
  assert.deepEqual(empty.unverified, [])
  assert.deepEqual(full.unverified, [])
})

// `null` is the JSON spelling of "no value", not of "some value this code cannot read", so it is
// the reviewer having made no report at all — the same answer as leaving the key out.
test('a null unableToVerify is the key being absent, and the lens collects', () => {
  const out = collectReviewResults({
    checkName: 'review', lenses: ['claims'],
    files: [{ lens: 'claims', findings: [], unableToVerify: null }], blockOn: ['high'],
  })
  assert.deepEqual(out.malformed, [])
  assert.deepEqual(out.unverified, [])
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].status, 'pass')
})

// A whitespace-only string is an empty one written differently, and the carve-out has to survive
// the malformed route being added beside it.
test('a whitespace-only unableToVerify collects and is not malformed either', () => {
  const out = collectReviewResults({
    checkName: 'review', lenses: ['claims'],
    files: [{ lens: 'claims', findings: [], unableToVerify: '   ' }], blockOn: ['high'],
  })
  assert.deepEqual(out.malformed, [])
  assert.deepEqual(out.unverified, [])
  assert.equal(out.results.length, 1)
})

// A bounded review must not read as an exhaustive one where the operator actually looks: the
// count belongs in the check output, not only in a file they would have to open.
test('unprobed claims reach the emitted output with their count and lens', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['claims'],
    files: [{ lens: 'claims', findings: [], unprobed: ['a.mjs:1', 'b.mjs:2', 'c.mjs:3'] }],
    blockOn: ['high'],
  })
  assert.equal(out.results[0].status, 'pass')
  assert.match(out.results[0].output, /3/)
  assert.match(out.results[0].output, /claims/)
  assert.match(out.results[0].output, /not reached/i)
})

// The same sentence has to survive a failing verdict, or the one review most worth bounding —
// the one that already found a blocker — is the one that reads as exhaustive.
test('unprobed reaches the output of a failing check too', () => {
  const out = collectReviewResults({
    checkName: 'review',
    lenses: ['claims'],
    files: [{ lens: 'claims', findings: findings('high'), unprobed: ['a.mjs:1'] }],
    blockOn: ['high'],
  })
  assert.equal(out.results[0].status, 'fail')
  assert.match(out.results[0].output, /not reached/i)
})

// No unprobed claims must not produce the sentence at all, or "bounded" would be printed over
// every exhaustive review and stop meaning anything.
test('a lens with nothing unprobed says nothing about being bounded', () => {
  const out = collectReviewResults({
    checkName: 'review', lenses: ['claims'],
    files: [{ lens: 'claims', findings: [], unprobed: [] }], blockOn: ['high'],
  })
  assert.doesNotMatch(out.results[0].output, /not reached/i)
})

test('with no expected stamp supplied, a file without one is still accepted', () => {
  const out = collectReviewResults({
    checkName: 'review', lenses: ['correctness'],
    files: [{ lens: 'correctness', findings: [] }], blockOn: ['high'],
  })
  assert.equal(out.results.length, 1)
  assert.deepEqual(out.stale, [])
})
