import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePath,
  taskBranchName,
  resolveTaskBranch,
  filesetViolations,
  derivePhase,
  ownershipViolations,
  baseExplainedNote,
  verdictCoversTree,
  planHash,
} from '../scripts/enforce.mjs'

test('backslashes, leading ./ and leading / all normalize to a bare posix path', () => {
  assert.equal(normalizePath('scripts\\git.mjs'), 'scripts/git.mjs')
  assert.equal(normalizePath('./scripts/git.mjs'), 'scripts/git.mjs')
  assert.equal(normalizePath('/scripts/git.mjs'), 'scripts/git.mjs')
})

test('a change inside the declared set is not a violation', () => {
  assert.deepEqual(filesetViolations(['a.mjs'], ['a.mjs', 'b.mjs']), [])
})

test('a change outside the declared set is a violation', () => {
  assert.deepEqual(filesetViolations(['a.mjs', 'secret.mjs'], ['a.mjs']), ['secret.mjs'])
})

test('separator style does not create a false violation', () => {
  assert.deepEqual(filesetViolations(['scripts/git.mjs'], ['scripts\\git.mjs']), [])
})

test('a case-only mismatch is a violation', () => {
  assert.deepEqual(filesetViolations(['Scripts/Git.mjs'], ['scripts/git.mjs']), ['Scripts/Git.mjs'])
})

test('a glob in the declared set matches nothing and reads as a violation', () => {
  assert.deepEqual(filesetViolations(['scripts/git.mjs'], ['scripts/*.mjs']), ['scripts/git.mjs'])
})

test('an empty diff is never a violation', () => {
  assert.deepEqual(filesetViolations([], ['a.mjs']), [])
})

test('a task declaring no files makes every change a violation', () => {
  assert.deepEqual(filesetViolations(['a.mjs'], []), ['a.mjs'])
})

test('the branch convention is teammates/<runId>/<taskId>', () => {
  assert.equal(taskBranchName('r1', 'T1'), 'teammates/r1/T1')
})

test('a branch field on the task is ignored in favour of the convention', () => {
  assert.equal(resolveTaskBranch({ id: 'T1', branch: 'custom' }, 'r1'), 'teammates/r1/T1')
})

test('with no recorded branch the convention is used', () => {
  assert.equal(resolveTaskBranch({ id: 'T1' }, 'r1'), 'teammates/r1/T1')
})

test('a task with no id resolves to null', () => {
  assert.equal(resolveTaskBranch({}, 'r1'), null)
})

// --- derivePhase -----------------------------------------------------------------------

test('derivePhase returns phase 1 when nothing is integrated', () => {
  assert.deepEqual(
    derivePhase({ tasks: [{ phase: 1 }, { phase: 2 }], integratedPhases: [] }),
    { phase: 1 },
  )
})

test('derivePhase returns phase 2 when phase 1 is integrated', () => {
  assert.deepEqual(
    derivePhase({ tasks: [{ phase: 1 }, { phase: 2 }], integratedPhases: [1] }),
    { phase: 2 },
  )
})

test('derivePhase returns phase null when every phase is integrated', () => {
  assert.deepEqual(
    derivePhase({ tasks: [{ phase: 1 }, { phase: 2 }], integratedPhases: [1, 2] }),
    { phase: null },
  )
})

test('derivePhase errors when a later phase is integrated but an earlier one is not', () => {
  const result = derivePhase({ tasks: [{ phase: 1 }, { phase: 2 }], integratedPhases: [2] })
  assert.ok(result.error)
  assert.match(result.error, /phase 1/)
})

test('derivePhase errors on a non-integer phase', () => {
  const result = derivePhase({ tasks: [{ phase: 1.5 }], integratedPhases: [] })
  assert.ok(result.error)
  assert.match(result.error, /non-integer phase/)
})

test('derivePhase handles non-contiguous phases', () => {
  assert.deepEqual(
    derivePhase({ tasks: [{ phase: 1 }, { phase: 3 }, { phase: 4 }], integratedPhases: [] }),
    { phase: 1 },
  )
})

test('derivePhase sorts its input rather than trusting task order', () => {
  // Tasks listed in descending phase order must still yield the lowest un-integrated phase.
  assert.deepEqual(
    derivePhase({ tasks: [{ phase: 3 }, { phase: 2 }, { phase: 1 }], integratedPhases: [] }),
    { phase: 1 },
  )
})

// --- ownershipViolations -----------------------------------------------------------------

// The gate protects the run branch, so work merged straight into the BASE branch — the shape of
// the fixloop incident, where a reviewer octopus-merged seven task branches into master with no
// gate PASS and no integrator — was accepted with a note. It needs no stored run-start base sha
// to catch: this run's work is supposed to reach the base by riding the run branch, so a task
// branch that is an ancestor of the base but not of the run branch got there by a side door.
test('a task branch that reached the base branch without the run branch is a violation', () => {
  const v = ownershipViolations({
    runBranch: 'run',
    baseBranch: 'master',
    taskBranches: ['teammates/r1/T1'],
    sideDoorBranches: ['teammates/r1/T1'],
    unexplainedCommits: [],
    dirty: false,
  })
  assert.equal(v.length, 1)
  assert.match(v[0], /teammates\/r1\/T1/)
  assert.match(v[0], /master/)
  assert.match(v[0], /run/)
})

test('a task branch on neither the base nor the run branch is not a side-door violation', () => {
  const v = ownershipViolations({
    runBranch: 'run',
    baseBranch: 'master',
    taskBranches: ['teammates/r1/T1'],
    sideDoorBranches: [],
    unexplainedCommits: [],
    dirty: false,
  })
  assert.deepEqual(v, [])
})

test('no unexplained commits and no alias collisions is clean', () => {
  const v = ownershipViolations({
    runBranch: 'main', taskBranches: ['teammates/r1/T1'], unexplainedCommits: [], dirty: false,
  })
  assert.deepEqual(v, [])
})

test('a task branch equal to the run branch is a violation', () => {
  const v = ownershipViolations({ runBranch: 'main', taskBranches: ['main'], unexplainedCommits: [], dirty: false })
  assert.equal(v.length, 1)
  assert.match(v[0], /only tm-integrator writes there/)
})

test('a case-only alias of the run branch is a violation', () => {
  const v = ownershipViolations({ runBranch: 'main', taskBranches: ['Main'], unexplainedCommits: [], dirty: false })
  assert.equal(v.length, 1)
  assert.match(v[0], /only tm-integrator writes there/)
})

test('a refs/heads/ prefixed alias of the run branch is a violation', () => {
  const v = ownershipViolations({ runBranch: 'main', taskBranches: ['refs/heads/main'], unexplainedCommits: [], dirty: false })
  assert.equal(v.length, 1)
  assert.match(v[0], /only tm-integrator writes there/)
})

test('a heads/ prefixed alias of the run branch is a violation', () => {
  const v = ownershipViolations({ runBranch: 'main', taskBranches: ['heads/main'], unexplainedCommits: [], dirty: false })
  assert.equal(v.length, 1)
  assert.match(v[0], /only tm-integrator writes there/)
})

test('a doubly-prefixed refs/heads/refs/heads/ alias is a violation', () => {
  const v = ownershipViolations({
    runBranch: 'refs/heads/main', taskBranches: ['refs/heads/refs/heads/main'], unexplainedCommits: [], dirty: false,
  })
  assert.equal(v.length, 1)
  assert.match(v[0], /only tm-integrator writes there/)
})

test('a doubly-prefixed heads/heads/ alias is a violation', () => {
  const v = ownershipViolations({
    runBranch: 'heads/main', taskBranches: ['heads/heads/main'], unexplainedCommits: [], dirty: false,
  })
  assert.equal(v.length, 1)
  assert.match(v[0], /only tm-integrator writes there/)
})

test('each unexplained commit is flagged and names --no-ff', () => {
  const v = ownershipViolations({
    runBranch: 'main', taskBranches: ['teammates/r1/T1'], unexplainedCommits: ['abc123', 'def456'], dirty: false,
  })
  assert.equal(v.length, 2)
  assert.match(v[0], /abc123/)
  assert.match(v[0], /reachable from no task branch/)
  assert.match(v[0], /--no-ff/)
  assert.match(v[1], /def456/)
})

// The ownership check now also accepts base-branch ancestry as an explanation. A reader who is
// only told "no task branch" is sent hunting for a direct write when the real question is why
// the commit is not on the base either — the message must name that possibility itself.
test('an unexplained commit names the base branch as a ruled-out explanation', () => {
  const v = ownershipViolations({
    runBranch: 'main', taskBranches: ['teammates/r1/T1'], unexplainedCommits: ['abc123'], dirty: false,
  })
  assert.equal(v.length, 1)
  assert.match(v[0], /base branch/)
})

// --- baseExplainedNote --------------------------------------------------------------------
//
// Accepting base ancestry silently would delete the only signal the old (wrong) failure
// carried: that the baseline moved mid-run. The note is what keeps a passing gate honest
// about what it admitted.

test('the base-explained note names every admitted commit and the base branch', () => {
  const note = baseExplainedNote({ baseBranch: 'main', commits: ['abc123', 'def456'] })
  assert.match(note, /abc123/)
  assert.match(note, /def456/)
  assert.match(note, /main/)
})

test('the base-explained note is empty when nothing was admitted by base ancestry', () => {
  assert.equal(baseExplainedNote({ baseBranch: 'main', commits: [] }), '')
  assert.equal(baseExplainedNote({ baseBranch: 'main' }), '')
  assert.equal(baseExplainedNote(), '')
})

test('a dirty worktree is a violation', () => {
  const v = ownershipViolations({ runBranch: 'main', taskBranches: [], unexplainedCommits: [], dirty: true })
  assert.equal(v.length, 1)
  assert.match(v[0], /uncommitted changes/)
})

test('a missing runBranch short-circuits', () => {
  const v = ownershipViolations({ runBranch: null, taskBranches: ['x'], unexplainedCommits: ['y'], dirty: true })
  assert.equal(v.length, 1)
  assert.match(v[0], /cannot establish what it is protecting/)
})

// --- verdictCoversTree --------------------------------------------------------------------

const baseVerdict = {
  verdict: 'PASS',
  anchorSha: 'anchor1',
  planHash: 'ph1',
  branchShas: { 'teammates/r1/T1': 'sha1' },
}
const baseCurrent = {
  anchorSha: 'anchor1',
  planHash: 'ph1',
  branchShas: { 'teammates/r1/T1': 'sha1' },
}

test('verdictCoversTree is null for a matching PASS', () => {
  assert.equal(verdictCoversTree(baseVerdict, baseCurrent), null)
})

test('verdictCoversTree gives a reason for a non-PASS verdict', () => {
  assert.match(verdictCoversTree({ ...baseVerdict, verdict: 'FAIL' }, baseCurrent), /no passing verdict/)
})

test('verdictCoversTree gives a reason for a missing verdict', () => {
  assert.match(verdictCoversTree(null, baseCurrent), /no passing verdict/)
})

test('verdictCoversTree gives a reason for a moved anchor', () => {
  assert.match(verdictCoversTree(baseVerdict, { ...baseCurrent, anchorSha: 'anchor2' }), /anchor moved/)
})

test('verdictCoversTree gives a reason for a changed plan hash', () => {
  assert.match(verdictCoversTree(baseVerdict, { ...baseCurrent, planHash: 'ph2' }), /plan changed/)
})

test('verdictCoversTree gives a reason for a moved branch', () => {
  assert.match(
    verdictCoversTree(baseVerdict, { ...baseCurrent, branchShas: { 'teammates/r1/T1': 'sha2' } }),
    /branch teammates\/r1\/T1 moved/,
  )
})

test('verdictCoversTree flags a branch present in current but not in the recorded verdict', () => {
  const current = { ...baseCurrent, branchShas: { ...baseCurrent.branchShas, 'teammates/r1/T2': 'sha3' } }
  assert.match(verdictCoversTree(baseVerdict, current), /branch teammates\/r1\/T2 moved/)
})

test('verdictCoversTree flags a branch present in the recorded verdict but not in current', () => {
  const verdict = { ...baseVerdict, branchShas: { ...baseVerdict.branchShas, 'teammates/r1/T2': 'sha3' } }
  assert.match(verdictCoversTree(verdict, baseCurrent), /branch teammates\/r1\/T2 moved/)
})

// --- planHash -------------------------------------------------------------------------------

test('planHash is stable for equal input', () => {
  assert.equal(planHash('# plan\n\nsome text'), planHash('# plan\n\nsome text'))
})

test('planHash differs for a one-character change', () => {
  assert.notEqual(planHash('# plan A'), planHash('# plan B'))
})

test('planHash handles empty and nullish input', () => {
  assert.equal(planHash(''), planHash(undefined))
  assert.equal(planHash(null), planHash(''))
})

test('planHash output matches the 8-hex-character format', () => {
  assert.match(planHash('anything'), /^[0-9a-f]{8}$/)
  assert.match(planHash(''), /^[0-9a-f]{8}$/)
  assert.match(planHash('a very long piece of plan markdown text right here'), /^[0-9a-f]{8}$/)
})
