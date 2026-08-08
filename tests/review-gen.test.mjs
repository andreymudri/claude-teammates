import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateReviewDispatch } from '../scripts/review-gen.mjs'

const BASE = {
  runId: 'r1',
  phaseName: '1',
  checkName: 'review',
  lenses: ['correctness', 'security'],
  blockOn: ['high'],
  tier: 'capable',
  runBranch: 'run/r1',
  branches: ['teammates/r1/T1', 'teammates/r1/T2'],
  findingsDir: '.teammates/r1/reviews',
  scratchRoot: '/tmp',
}

test('one dispatch per lens, each naming only its own lens', () => {
  const out = generateReviewDispatch(BASE)
  assert.equal(out.reviewers.length, 2)
  assert.deepEqual(out.reviewers.map((r) => r.lens), ['correctness', 'security'])
  assert.match(out.reviewers[0].prompt, /correctness/)
  assert.doesNotMatch(out.reviewers[0].prompt, /security/)
})

// Six consecutive named reviewer dispatches were lost to idle-without-emitting. The generated
// spec has to carry that as a value the caller can act on, not as advice it might read.
test('every dispatch is explicitly unnamed', () => {
  for (const r of generateReviewDispatch(BASE).reviewers) {
    assert.equal(r.name, null)
    assert.equal(r.agentType, 'claude-teammates:tm-reviewer')
  }
})

test('each dispatch carries its own findings path, derived from phase and lens', () => {
  const out = generateReviewDispatch(BASE)
  assert.equal(out.reviewers[0].findingsPath, '.teammates/r1/reviews/1-correctness.json')
  assert.match(out.reviewers[0].prompt, /1-correctness\.json/)
})

// A reviewer's scratch worktree inside the repository failed `ownership` for a whole run, so
// the path is handed to it rather than left to its judgement.
test('each dispatch names a scratch worktree outside the repository', () => {
  const out = generateReviewDispatch(BASE)
  assert.match(out.reviewers[0].scratchWorktree, /^\/tmp\//)
  assert.match(out.reviewers[0].prompt, /scratch worktree/i)
  assert.match(out.reviewers[0].prompt, new RegExp(out.reviewers[0].scratchWorktree.replace(/\//g, '\\/')))
})

test('the prompt states the diff under review as the phase branches against the run branch', () => {
  const prompt = generateReviewDispatch(BASE).reviewers[0].prompt
  assert.match(prompt, /run\/r1/)
  assert.match(prompt, /teammates\/r1\/T1/)
  assert.match(prompt, /teammates\/r1\/T2/)
})

test('the blocking severity comes from the manifest and is stated in the prompt', () => {
  const prompt = generateReviewDispatch({ ...BASE, blockOn: ['high', 'medium'] }).reviewers[0].prompt
  assert.match(prompt, /high, medium/)
})

// The reviewer's tier is fixed at `capable` unless the tracked manifest configures it, and the
// model for that tier is supplied by the caller — concrete model names never enter this repo.
test('a tier model map supplies the model; without one the tier is still reported', () => {
  const withModels = generateReviewDispatch({ ...BASE, tierModels: { capable: 'opus' } })
  assert.equal(withModels.reviewers[0].model, 'opus')
  assert.equal(withModels.tier, 'capable')

  const without = generateReviewDispatch(BASE)
  assert.equal('model' in without.reviewers[0], false)
  assert.equal(without.tier, 'capable')
})

// Effort falls back differently from tier: unset means inherit the session's, so the option must
// be ABSENT rather than carrying an empty string a dispatcher would pass along verbatim.
test('effort is present only when configured', () => {
  assert.equal('effort' in generateReviewDispatch(BASE).reviewers[0], false)
  assert.equal(generateReviewDispatch({ ...BASE, effort: 'high' }).reviewers[0].effort, 'high')
})

test('a phase with no branches to review is refused rather than dispatched against nothing', () => {
  assert.throws(() => generateReviewDispatch({ ...BASE, branches: [] }), /branch/i)
})

test('a phase with no lenses is refused', () => {
  assert.throws(() => generateReviewDispatch({ ...BASE, lenses: [] }), /lens/i)
})

test('a lens that cannot be a filename is refused before it reaches a path', () => {
  assert.throws(() => generateReviewDispatch({ ...BASE, lenses: ['../escape'] }), /lens/i)
})
