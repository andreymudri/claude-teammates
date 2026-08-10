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

// The generic prompt, byte for byte, for the three lenses that had one before `claims` existed.
// A substring check would still pass if the method text leaked into every lens; these are the
// whole string, so any addition to the shared prompt shows up here and has to be intended.
const GENERIC_PROMPTS = {
  correctness: 'Review the phase 1 diff of teammates run r1 through exactly one lens: correctness.\n\nThe diff under review is these task branches against the run branch run/r1:\n  teammates/r1/T1\n  teammates/r1/T2\nDiff each against its own fork point (git merge-base run/r1 <branch>), never tip against tip.\n\nReport only correctness defects you can tie to a concrete failure: specific input or state producing a specific wrong result. Rate each finding high, medium or low. Findings rated high block this phase, so reserve those. Cite file:line for every finding. No findings is a valid and common result.\n\nYou are read-only. Never write to any ref — no commit, merge, rebase, reset, push or update-ref — on the base branch, the run branch, or any task branch, and never run git checkout in the main worktree. If you need to execute code across branches, create your scratch worktree at /tmp/tm-review-r1-1-correctness, which is outside the repository, and remove it when you are done. If you cannot verify a finding without writing to a shared ref, report it unverified and say what you would have run.\n\nWrite your findings JSON to .teammates/r1/reviews/1-correctness.json before you return, then return the same JSON as your final output. The response is the interface; the file is what makes your review recoverable if you go idle before emitting it.',
  security: 'Review the phase 1 diff of teammates run r1 through exactly one lens: security.\n\nThe diff under review is these task branches against the run branch run/r1:\n  teammates/r1/T1\n  teammates/r1/T2\nDiff each against its own fork point (git merge-base run/r1 <branch>), never tip against tip.\n\nReport only security defects you can tie to a concrete failure: specific input or state producing a specific wrong result. Rate each finding high, medium or low. Findings rated high block this phase, so reserve those. Cite file:line for every finding. No findings is a valid and common result.\n\nYou are read-only. Never write to any ref — no commit, merge, rebase, reset, push or update-ref — on the base branch, the run branch, or any task branch, and never run git checkout in the main worktree. If you need to execute code across branches, create your scratch worktree at /tmp/tm-review-r1-1-security, which is outside the repository, and remove it when you are done. If you cannot verify a finding without writing to a shared ref, report it unverified and say what you would have run.\n\nWrite your findings JSON to .teammates/r1/reviews/1-security.json before you return, then return the same JSON as your final output. The response is the interface; the file is what makes your review recoverable if you go idle before emitting it.',
  tests: 'Review the phase 1 diff of teammates run r1 through exactly one lens: tests.\n\nThe diff under review is these task branches against the run branch run/r1:\n  teammates/r1/T1\n  teammates/r1/T2\nDiff each against its own fork point (git merge-base run/r1 <branch>), never tip against tip.\n\nReport only tests defects you can tie to a concrete failure: specific input or state producing a specific wrong result. Rate each finding high, medium or low. Findings rated high block this phase, so reserve those. Cite file:line for every finding. No findings is a valid and common result.\n\nYou are read-only. Never write to any ref — no commit, merge, rebase, reset, push or update-ref — on the base branch, the run branch, or any task branch, and never run git checkout in the main worktree. If you need to execute code across branches, create your scratch worktree at /tmp/tm-review-r1-1-tests, which is outside the repository, and remove it when you are done. If you cannot verify a finding without writing to a shared ref, report it unverified and say what you would have run.\n\nWrite your findings JSON to .teammates/r1/reviews/1-tests.json before you return, then return the same JSON as your final output. The response is the interface; the file is what makes your review recoverable if you go idle before emitting it.',
}

test('a lens with no method produces the generic prompt byte for byte', () => {
  const out = generateReviewDispatch({ ...BASE, lenses: ['correctness', 'security', 'tests'] })
  for (const r of out.reviewers) assert.equal(r.prompt, GENERIC_PROMPTS[r.lens])
})

// Adding a method to one lens must not add a byte to any other, including when they are
// dispatched together — the method is appended per reviewer, not to the shared prompt.
test('dispatching claims alongside the generic lenses leaves their prompts untouched', () => {
  const out = generateReviewDispatch({
    ...BASE,
    lenses: ['correctness', 'security', 'tests', 'claims'],
    testCommand: 'npm test',
  })
  for (const r of out.reviewers) {
    if (r.lens === 'claims') continue
    assert.equal(r.prompt, GENERIC_PROMPTS[r.lens])
  }
})

const CLAIMS = { ...BASE, lenses: ['claims'], testCommand: 'npm test' }

test('the claims prompt carries the test command, the cap, the baseline and the unprobed list', () => {
  const prompt = generateReviewDispatch(CLAIMS).reviewers[0].prompt
  // The generic prompt is still the head of it: the method is an addition, not a replacement.
  assert.ok(prompt.startsWith(GENERIC_PROMPTS.tests.replace(/\btests\b/g, 'claims')))
  assert.match(prompt, /npm test/)
  assert.match(prompt, /green baseline BEFORE mutating/)
  assert.match(prompt, /top 8\b/)
  assert.match(prompt, /"unprobed"/)
  assert.match(prompt, /"unableToVerify"/)
})

// Degrading to a weaker prompt would leave a lens named for mutation doing static reading, which
// is the review it exists to replace.
test('claims without a test command is refused rather than degraded', () => {
  assert.throws(() => generateReviewDispatch({ ...BASE, lenses: ['claims'] }), /claims/)
  assert.throws(() => generateReviewDispatch({ ...BASE, lenses: ['correctness', 'claims'] }), /claims/)
})

test('a missing test command does not refuse a dispatch without the claims lens', () => {
  assert.doesNotThrow(() => generateReviewDispatch({ ...BASE, lenses: ['correctness'] }))
})

test('the mutation cap is configurable and the configured value reaches the prompt', () => {
  const prompt = generateReviewDispatch({ ...CLAIMS, mutationCap: 3 }).reviewers[0].prompt
  assert.match(prompt, /top 3\b/)
  assert.match(prompt, /at most 3 of what you found/)
  assert.doesNotMatch(prompt, /top 8\b/)
})

test('link paths appear in the baseline step when supplied and the clause is absent when not', () => {
  const withLinks = generateReviewDispatch({ ...CLAIMS, linkPaths: ['node_modules', '.env'] }).reviewers[0].prompt
  assert.match(withLinks, /link these paths in from the repository root/)
  assert.match(withLinks, /node_modules, \.env/)

  const without = generateReviewDispatch(CLAIMS).reviewers[0].prompt
  assert.doesNotMatch(without, /link these paths in from the repository root/)
})
