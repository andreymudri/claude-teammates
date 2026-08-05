import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  runCommandCheck,
  describePendingCheck,
  runChecks,
  aggregateVerdict,
  deriveContext,
  runFilesetCheck,
  runOwnershipCheck,
} from '../scripts/gate-runner.mjs'
import { GitError, createGit, defaultGitExec } from '../scripts/git.mjs'

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
    commitsBetween: async ({ to }) => (to === `refs/heads/${T1_BRANCH}-sha` ? ['t1-commit'] : []),
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
    commitsBetween: async () => ['some-commit'],
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, null)
  assert.deepEqual(ctx.integratedPhases, [1, 2])
})

test('deriveContext surfaces phaseError for out-of-order integration', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T2_BRANCH,
    isAncestor: async (sha, runSha) => sha === `refs/heads/${T2_BRANCH}-sha` && runSha === 'runSha1',
    commitsBetween: async ({ to }) => (to === `refs/heads/${T2_BRANCH}-sha` ? ['t2-commit'] : []),
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, null)
  assert.match(ctx.phaseError, /phase 1/)
  assert.deepEqual(ctx.integratedPhases, [2])
})

// A branch created with zero commits past the anchor must never read as "integrated" —
// isAncestor(X, X) is trivially true, so a phantom branch pointed at the anchor (or at the
// run tip) would otherwise pass with no work done. See the real-repo regression test below
// ("an empty task branch at the run tip does not read as integrated").
test('deriveContext does not treat a branch with zero commits past the anchor as integrated', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    // isAncestor alone would say yes — the branch sha equals the anchor sha (zero commits).
    isAncestor: async () => true,
    commitsBetween: async () => [],
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, 1)
  assert.deepEqual(ctx.integratedPhases, [])
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

test('runFilesetCheck passes when every phase is integrated (currentPhase null) and records branchShas', async () => {
  const git = fakeGit({ branchExists: async () => true })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: null, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
  // A PASS with no branchShas reads to verdictCoversTree as still covering the tree no
  // matter how branches move afterwards — the resolved shas must be attached even on the
  // all-integrated short-circuit.
  assert.deepEqual(res.branchShas, { [T1_BRANCH]: `refs/heads/${T1_BRANCH}-sha` })
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

test('runOwnershipCheck fails a merge commit that carries extra content beyond its second parent', async () => {
  const branchSha = `refs/heads/${T1_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    isAncestor: async (a, b) => a === 'p1' && b === branchSha,
    commitParents: async () => ['p0', 'p1'],
    // The merge commit differs from its first parent by a.mjs (the branch's real work) and
    // BACKDOOR.mjs (content the merge introduced on its own); the branch itself only ever
    // touched a.mjs against that same first parent.
    changedFiles: async ({ base, branch }) => {
      if (base === 'p0' && branch === 'm1') return ['a.mjs', 'BACKDOOR.mjs']
      if (base === 'p0' && branch === 'p1') return ['a.mjs']
      return []
    },
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /m1/)
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

// Mirrors the fileset check's equivalent test — without this, the two checks are silently
// asymmetric: fileset lets a non-GitError propagate (tested above), and until this test
// existed, ownership's identical `if (!(err instanceof GitError)) throw err` had no coverage.
test('runOwnershipCheck lets a non-GitError propagate', async () => {
  const git = fakeGit({ commitsBetween: async () => { throw new Error('not a git error') } })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [] }
  await assert.rejects(() => runOwnershipCheck(check, ctx), /not a git error/)
})

// Mutation-testing gap: mutating `parents.slice(1)` to `parents` at the ownership scan site
// left the suite green, because every prior test only ever exercised a *second* parent
// explaining a merge. Reproduced concretely: the run branch fast-forwards onto a task
// branch's tip, then takes a direct commit — that commit's sole (first) parent is the task
// branch tip. isAncestor(firstParent, firstParent) is trivially true, so if the scan ever
// includes the first parent, the direct write explains itself. `parents.slice(1)` must
// exclude it.
test('a commit whose sole parent sits on a task branch is still unexplained', async () => {
  const branchSha = `refs/heads/${T1_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['c1'],
    // Reflexive only: true exactly when the two arguments are literally the same value.
    // The direct commit 'c1' is not itself the branch tip, so the initial "is the commit
    // itself an ancestor of a task branch" check is false — only the parent-scan path can
    // wrongly explain it, and only if that scan is allowed to see the first parent.
    isAncestor: async (a, b) => a === b,
    commitParents: async () => [branchSha],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /c1/)
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

// --- tag-shadowing regression: every ref-shaped argument reaching git must be a sha or a
// fully-qualified ref ------------------------------------------------------------------------
//
// A narrower version of this test once asserted only that every `resolveRef` argument was
// fully qualified. That version could not see H1: `deriveContext` called `git.mergeBase`
// with the bare `baseBranch`/`runBranch` strings directly, never routing them through
// `resolveRef` at all, so the earlier test passed while the bypass was live. This version
// records every ref-shaped argument reaching *every* method a bare name could reach —
// mergeBase, isAncestor, commitsBetween, changedFiles, commitParents, fileAtCommit, and
// resolveRef — and requires each to already be a sha or a fully-qualified `refs/...` ref.

function shaFor(ref) {
  // A stable, sha-shaped (40 lowercase hex chars) fake, so downstream calls receive
  // something a real caller could not mistake for a bare branch name.
  let hash = 0x811c9dc5
  const text = String(ref)
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').repeat(5).slice(0, 40)
}

function refShapedFakeGit() {
  const calls = { resolveRef: [], mergeBase: [], isAncestor: [], commitsBetween: [], changedFiles: [], commitParents: [], fileAtCommit: [] }
  const git = {
    async mergeBase(a, b) { calls.mergeBase.push([a, b]); return shaFor(`merge-base:${a}:${b}`) },
    async fileAtCommit(sha, filePath) { calls.fileAtCommit.push(sha); void filePath; return planMarkdown() },
    async resolveRef(ref) { calls.resolveRef.push(ref); return shaFor(ref) },
    async branchExists(name) { return name === T1_BRANCH || name === T2_BRANCH },
    async isAncestor(ancestor, descendant) { calls.isAncestor.push([ancestor, descendant]); return true },
    async changedFiles({ base, branch }) { calls.changedFiles.push({ base, branch }); return [] },
    async commitsBetween({ from, to }) { calls.commitsBetween.push({ from, to }); return [shaFor('commit1')] },
    async commitParents(sha) { calls.commitParents.push(sha); return [shaFor('parent0'), shaFor('parent1')] },
    async isDirty() { return false },
  }
  return { git, calls }
}

test('every ref-shaped argument reaching git is a sha or a fully-qualified ref', async () => {
  const { git, calls } = refShapedFakeGit()

  await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  await runFilesetCheck(
    { name: 'fileset', kind: 'fileset' },
    { git, runId: RUN_ID, anchorSha: shaFor('anchor'), tasks: [T1_TASK], currentPhase: 1, phaseError: null },
  )
  await runOwnershipCheck(
    { name: 'ownership', kind: 'ownership' },
    { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: shaFor('anchor'), runSha: shaFor('run'), tasks: [T1_TASK] },
  )

  const shaped = (v) => /^[0-9a-f]{40}$/.test(v) || /^refs\//.test(v)
  const assertAllShaped = (label, values) => {
    for (const v of values) assert.ok(shaped(v), `${label} received a bare, non-shaped ref: ${JSON.stringify(v)}`)
  }
  assertAllShaped('resolveRef', calls.resolveRef)
  assertAllShaped('fileAtCommit', calls.fileAtCommit)
  assertAllShaped('mergeBase', calls.mergeBase.flat())
  assertAllShaped('isAncestor', calls.isAncestor.flat())
  assertAllShaped('commitsBetween', calls.commitsBetween.flatMap(({ from, to }) => [from, to]))
  assertAllShaped('changedFiles', calls.changedFiles.flatMap(({ base, branch }) => [base, branch]))
  assertAllShaped('commitParents', calls.commitParents)

  assert.ok(calls.mergeBase.length > 0, 'mergeBase was never called')
  assert.ok(calls.isAncestor.length > 0, 'isAncestor was never called')
  assert.ok(calls.commitsBetween.length > 0, 'commitsBetween was never called')
  assert.ok(calls.changedFiles.length > 0, 'changedFiles was never called')
  assert.ok(calls.commitParents.length >= 0)
  assert.ok(calls.fileAtCommit.length > 0, 'fileAtCommit was never called')
})

// --- real-repo regressions: H2 (evil merge) and H3 (empty task branch) ----------------------

async function withRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-gate-runner-'))
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await fn({ root, sh, git: createGit({ cwd: root }) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function singleTaskPlan() {
  return [
    '### Task 1: first task',
    '',
    '**Files:**',
    '- Create: `a.mjs`',
    '',
    '**Depends:** none',
    '',
  ].join('\n')
}

// H2: a merge commit's --no-ff shape is not proof its tree carries only what its second
// parent contributed. Reproduced with `git merge --no-ff --no-commit`, then adding an
// out-of-band file before completing the commit.
test('an evil --no-ff merge that carries extra content is unexplained (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '--no-commit', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'BACKDOOR.mjs'), 'export const backdoor = true\n', 'utf8')
    await sh(['add', '-A'])
    await sh(['commit', '-m', 'Merge T1'])

    const mergeSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck({ name: 'ownership', kind: 'ownership' }, ctx)

    assert.equal(res.status, 'fail')
    assert.match(res.output, new RegExp(mergeSha))
  })
})

// H3: isAncestor(X, X) is trivially true, so a task branch created at the run tip with zero
// commits of its own must not read as "integrated" — otherwise a run in which no task did
// any work returns a clean gate PASS.
test('an empty task branch at the run tip does not read as integrated (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    // Created at the run tip; no commits of its own.
    await sh(['branch', 'teammates/r1/T1'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })

    assert.deepEqual(ctx.integratedPhases, [])
    assert.equal(ctx.currentPhase, 1)

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.notEqual(res.output, 'every phase in the plan is integrated')
  })
})
