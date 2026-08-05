import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runCommandCheck,
  describePendingCheck,
  runChecks,
  aggregateVerdict,
  deriveContext,
  runFilesetCheck,
  runOwnershipCheck,
} from '../scripts/gate-runner.mjs'
import { GitError } from '../scripts/git.mjs'

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

test('an optional failing check does not fail the gate but is reported in optionalFailed', () => {
  const v = aggregateVerdict([{ name: 'a', status: 'pass' }, { name: 'contract', status: 'fail', optional: true }])
  assert.equal(v.verdict, 'PASS')
  assert.deepEqual(v.failed, [])
  assert.deepEqual(v.optionalFailed, ['contract'])
})

test('a non-optional failing check still fails the gate', () => {
  const v = aggregateVerdict([{ name: 'a', status: 'pass' }, { name: 'b', status: 'fail', optional: false }])
  assert.equal(v.verdict, 'FAIL')
  assert.deepEqual(v.failed, ['b'])
  assert.deepEqual(v.optionalFailed, [])
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

// --- fixtures shared by deriveContext / runFilesetCheck / runOwnershipCheck --------------

const RUN_ID = 'r1'
const RUN_BRANCH = 'run'
const BASE_BRANCH = 'main'
const T1_BRANCH = 'teammates/r1/T1'
const T2_BRANCH = 'teammates/r1/T2'

function planMarkdown() {
  return [
    '### Task 1: first task',
    '',
    '**Files:**',
    '- Create: `a.mjs`',
    '',
    '**Depends:** none',
    '',
    '### Task 2: second task',
    '',
    '**Files:**',
    '- Create: `b.mjs`',
    '',
    '**Depends:** T1',
    '',
  ].join('\n')
}

// Builds a fake git object exposing every method deriveContext / runFilesetCheck /
// runOwnershipCheck consume. `resolveRefCalls` records every argument passed to
// resolveRef, in order, so tests can assert every ref reaching git is fully qualified.
function fakeGit(overrides = {}) {
  const resolveRefCalls = []
  const defaults = {
    mergeBase: async () => 'anchorSha1',
    fileAtCommit: async () => planMarkdown(),
    resolveRef: async (ref) => {
      resolveRefCalls.push(ref)
      if (ref === 'refs/heads/run') return 'runSha1'
      return `${ref}-sha`
    },
    branchExists: async () => false,
    isAncestor: async () => false,
    changedFiles: async () => [],
    commitsBetween: async () => [],
    commitParents: async () => [],
    isDirty: async () => false,
  }
  const git = { ...defaults, ...overrides }
  git.resolveRefCalls = resolveRefCalls
  // Preserve call recording even when a test overrides resolveRef directly.
  if (overrides.resolveRef) {
    const custom = overrides.resolveRef
    git.resolveRef = async (ref) => { resolveRefCalls.push(ref); return custom(ref) }
  }
  return git
}

// --- deriveContext ------------------------------------------------------------------------

test('deriveContext derives phase 1 when nothing is integrated', async () => {
  const git = fakeGit()
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, 1)
  assert.equal(ctx.phaseError, null)
  assert.deepEqual(ctx.integratedPhases, [])
  assert.equal(ctx.anchorSha, 'anchorSha1')
  assert.equal(ctx.runSha, 'runSha1')
  assert.equal(ctx.tasks.length, 2)
})

test('deriveContext derives phase 2 once phase 1 branches are ancestors', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    isAncestor: async (sha, runSha) => sha === `refs/heads/${T1_BRANCH}-sha` && runSha === 'runSha1',
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, 2)
  assert.equal(ctx.phaseError, null)
  assert.deepEqual(ctx.integratedPhases, [1])
})

test('deriveContext derives currentPhase: null when every phase is integrated', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    isAncestor: async () => true,
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, null)
  assert.deepEqual(ctx.integratedPhases, [1, 2])
})

test('deriveContext surfaces phaseError for out-of-order integration', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T2_BRANCH,
    isAncestor: async (sha, runSha) => sha === `refs/heads/${T2_BRANCH}-sha` && runSha === 'runSha1',
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, null)
  assert.match(ctx.phaseError, /phase 1/)
  assert.deepEqual(ctx.integratedPhases, [2])
})

// --- runFilesetCheck ------------------------------------------------------------------------

const T1_TASK = { id: 'T1', phase: 1, files: ['a.mjs'] }

test('runFilesetCheck passes on declared changes and records branchShas', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => ['a.mjs'],
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.deepEqual(res.branchShas, { [T1_BRANCH]: `refs/heads/${T1_BRANCH}-sha` })
})

test('runFilesetCheck fails naming a stray path', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => ['a.mjs', 'secret.mjs'],
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /secret\.mjs/)
})

test('runFilesetCheck fails on a missing branch', async () => {
  const git = fakeGit({ branchExists: async () => false })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /does not exist/)
})

test('runFilesetCheck fails when the phase selects zero tasks', async () => {
  const git = fakeGit()
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 2, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /selected no tasks/)
})

test('runFilesetCheck fails on phaseError', async () => {
  const git = fakeGit()
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: 'phase 1 is not integrated but a later phase is' }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /phase 1 is not integrated/)
})

test('runFilesetCheck passes when every phase is integrated (currentPhase null)', async () => {
  const git = fakeGit()
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: null, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

test('runFilesetCheck fails without git access', async () => {
  const check = { name: 'fileset', kind: 'fileset' }
  const res = await runFilesetCheck(check, {})
  assert.equal(res.status, 'fail')
  assert.match(res.output, /no git access/)
})

test('runFilesetCheck converts GitError to a fail', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => { throw new GitError('changedFiles boom') },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /changedFiles boom/)
})

test('runFilesetCheck lets a non-GitError propagate', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => { throw new Error('not a git error') },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  await assert.rejects(() => runFilesetCheck(check, ctx), /not a git error/)
})

// --- runOwnershipCheck ------------------------------------------------------------------------

test('runOwnershipCheck passes when every commit is reachable', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['c1'],
    isAncestor: async (a, b) => a === 'c1' && b === `refs/heads/${T1_BRANCH}-sha`,
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

test('runOwnershipCheck fails naming an unexplained commit and mentioning --no-ff', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['c1'],
    isAncestor: async () => false,
    commitParents: async () => ['p0'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /c1/)
  assert.match(res.output, /--no-ff/)
})

test('runOwnershipCheck accepts a merge commit whose second parent is a task branch', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    isAncestor: async (a, b) => a === 'p1' && b === `refs/heads/${T1_BRANCH}-sha`,
    commitParents: async () => ['p0', 'p1'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

test('runOwnershipCheck fails on a dirty worktree', async () => {
  const git = fakeGit({ isDirty: async () => true })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /uncommitted changes/)
})

test('runOwnershipCheck fails without git access', async () => {
  const check = { name: 'ownership', kind: 'ownership' }
  const res = await runOwnershipCheck(check, {})
  assert.equal(res.status, 'fail')
  assert.match(res.output, /no git access/)
})

test('runOwnershipCheck converts GitError to a fail', async () => {
  const git = fakeGit({ commitsBetween: async () => { throw new GitError('commitsBetween boom') } })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /commitsBetween boom/)
})

// --- runChecks dispatch -----------------------------------------------------------------------

test('runChecks dispatches command, fileset and ownership checks', async () => {
  const exec = fakeExec({ 'npm test': { code: 0, output: '' } })
  const git = fakeGit()
  const ctx = { cwd: '.', exec, git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [], currentPhase: null, phaseError: null }
  const results = await runChecks([
    { name: 'test', kind: 'command', run: 'npm test' },
    { name: 'fileset', kind: 'fileset' },
    { name: 'ownership', kind: 'ownership' },
    { name: 'review', kind: 'agent', agent: 'tm-reviewer' },
  ], ctx)
  assert.deepEqual(results.map((r) => r.status), ['pass', 'pass', 'pass', 'pending'])
})

test('runChecks yields pending for prototype-shadowing kinds', async () => {
  const results = await runChecks([
    { name: 'a', kind: 'toString' },
    { name: 'b', kind: 'constructor' },
    { name: 'c', kind: 'valueOf' },
    { name: 'd', kind: '__proto__' },
  ], {})
  assert.deepEqual(results.map((r) => r.status), ['pending', 'pending', 'pending', 'pending'])
})

test('runChecks records a fail when a runner throws', async () => {
  const git = fakeGit({ branchExists: async () => { throw new Error('unexpected boom') } })
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const results = await runChecks([{ name: 'fileset', kind: 'fileset' }], ctx)
  assert.equal(results[0].status, 'fail')
  assert.match(results[0].output, /check threw/)
  assert.match(results[0].output, /unexpected boom/)
})

// --- tag-shadowing regression: every resolveRef argument must be fully qualified ------------

test('every resolveRef argument reaching git starts with refs/heads/', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    isAncestor: async (sha, runSha) => sha === `refs/heads/${T1_BRANCH}-sha` && runSha === 'runSha1',
  })
  await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })

  const fileset = await runFilesetCheck(
    { name: 'fileset', kind: 'fileset' },
    { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null },
  )
  void fileset

  const ownership = await runOwnershipCheck(
    { name: 'ownership', kind: 'ownership' },
    { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] },
  )
  void ownership

  assert.ok(git.resolveRefCalls.length > 0)
  for (const ref of git.resolveRefCalls) {
    assert.match(ref, /^refs\/heads\//, `resolveRef received a non-fully-qualified ref: ${ref}`)
  }
})
