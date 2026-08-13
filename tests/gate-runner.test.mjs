import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  mergedParentFiles,
  landedForFiles,
  creditRunTipTasks,
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
    mergedBranchTips: async () => new Set(),
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
    changedFiles: async ({ branch }) => (branch === `refs/heads/${T1_BRANCH}-sha` ? ['a.mjs'] : []),
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
    changedFiles: async () => ['some-file'],
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, null)
  assert.deepEqual(ctx.integratedPhases, [1, 2])
})

test('deriveContext surfaces phaseError for out-of-order integration', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T2_BRANCH,
    isAncestor: async (sha, runSha) => sha === `refs/heads/${T2_BRANCH}-sha` && runSha === 'runSha1',
    changedFiles: async ({ branch }) => (branch === `refs/heads/${T2_BRANCH}-sha` ? ['b.mjs'] : []),
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, null)
  assert.match(ctx.phaseError, /phase 1/)
  assert.deepEqual(ctx.integratedPhases, [2])
})

// A branch created with zero file changes past the anchor must never read as "integrated" —
// isAncestor(X, X) is trivially true, so a phantom branch pointed at the anchor (or at the
// run tip) would otherwise pass with no work done. See the real-repo regression test below
// ("an empty task branch at the run tip does not read as integrated").
test('deriveContext does not treat a branch with zero file changes past the anchor as integrated', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    // isAncestor alone would say yes — the branch sha equals the anchor sha (zero changes).
    isAncestor: async () => true,
    changedFiles: async () => [],
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, 1)
  assert.deepEqual(ctx.integratedPhases, [])
})

// H3-empty: counting commits is not the same as counting file changes. `git commit
// --allow-empty` produces a real commit with zero file changes; a branch consisting only of
// such commits must not read as integrated either.
test('deriveContext does not treat a branch with only empty commits as integrated', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    isAncestor: async () => true,
    // The branch has a real commit (so a commit-counting check would wrongly pass); it just
    // never touched a file.
    changedFiles: async () => [],
  })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  assert.equal(ctx.currentPhase, 1)
  assert.deepEqual(ctx.integratedPhases, [])
})

// M1: a plan that parses to zero tasks must not read as "every phase is integrated". A
// directory anchor (`git show <sha>:docs` renders a tree listing) parses to zero tasks the
// same way an empty file would; derivePhase then returns `{phase: null}` with no error, and
// runFilesetCheck's "nothing left to check" fast path passes vacuously while a task branch
// can carry an undeclared file. An empty task list is a derive failure, not a clean run.
test('deriveContext fails when the plan parses to zero tasks, naming the plan path and anchor', async () => {
  const git = fakeGit({ fileAtCommit: async () => '' })
  const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'docs' })
  assert.equal(ctx.currentPhase, null)
  assert.ok(ctx.phaseError, 'expected a phaseError for a zero-task plan')
  assert.match(ctx.phaseError, /docs/)
  assert.match(ctx.phaseError, /anchorSha1/)
  assert.deepEqual(ctx.tasks, [])
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

// `mergedParentFiles`'s in-range filter, pinned directly: a task ref parked exactly at the
// ANCHOR, where the merge naming the anchor as a secondary parent happens to carry a file with
// the SAME NAME as the parked task's own declared file (the coincidence a plan amendment could
// produce). Without the filter, the anchor itself would be keyed and `landedForFiles` would
// read this ref as landed on a merge it was never part of — the anchor is the boundary
// `commitsBetween` excludes, not a commit this run's history begins from. The run tip IS the
// integrator's merge commit, on the walk's own first-parent chain (`commitParents('mergeSha1')`
// is reached directly from `runSha`), so this test actually exercises the filter rather than
// stopping before the walk ever visits the merge — the filter's necessity was reconfirmed
// against this exact mock, in this shape, before the test was written.
test('runFilesetCheck does not read a ref parked at the anchor as landed even when a coincidental filename matches', async () => {
  const T2_TASK = { id: 'T2', phase: 1, files: ['b.mjs'] }
  const git = fakeGit({
    branchExists: async () => true,
    resolveRef: async (ref) => {
      // T2 is parked exactly at the anchor.
      if (ref === `refs/heads/${T2_BRANCH}`) return 'anchorSha1'
      return `${ref}-sha`
    },
    commitsBetween: async () => ['mergeSha1'],
    // The lone in-range merge's SECOND parent is the anchor itself — the shape a plan
    // amendment produces once its own base tip becomes the anchor. It is also the run tip
    // itself, so the chain walk reaches it in one step from `runSha`.
    commitParents: async (sha) => (sha === 'mergeSha1' ? ['firstParentSha', 'anchorSha1'] : []),
    // Coincidence: the amendment merge happens to touch a file named `b.mjs`, the same name
    // T2 declared. The walk's own call shape diffs the SECONDARY PARENT's own tree
    // (`anchorSha1`) against the chain's prior tip (`firstParentSha`), not the merge commit's.
    changedFiles: async ({ base, branch }) => (base === 'firstParentSha' && branch === 'anchorSha1' ? ['b.mjs'] : []),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, runSha: 'mergeSha1', anchorSha: 'anchorSha1',
    tasks: [T2_TASK], currentPhase: 1, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /T2: branch teammates\/r1\/T2 contributes no file changes/)
})

// T2 (phase 2, under check) sits at T1's tip (phase 1, merged). T2's own diff is empty and
// T1's sha IS a merged tip, so without the duplicate rule this passes — the shape
// `deriveContext`'s "ref parked at a merged SIBLING'S tip" comment names as undefended.
// Fix-round rewrite: T2's ref is pointed at T1's own merged tip (the shared sha), instead of
// committing. The merge that landed T1 carried T1's declared file, `a.mjs` — never T2's `b.mjs`
// — so `landedForFiles` reads false for T2 even though the sha is shared and genuinely merged.
// No message names T1 at all: T2's own failure is self-contained, and does not depend on
// reasoning about any other ref, only on what the merge that named its sha actually carried.
test('runFilesetCheck fails a branch parked on a merged sibling\'s tip, naming only its own no-op', async () => {
  const T2_TASK = { id: 'T2', phase: 2, files: ['b.mjs'] }
  const SHARED_SHA = 'sharedSha1'
  const git = fakeGit({
    branchExists: async () => true,
    resolveRef: async (ref) => {
      if (ref === `refs/heads/${T1_BRANCH}`) return SHARED_SHA
      if (ref === `refs/heads/${T2_BRANCH}`) return SHARED_SHA
      if (ref === 'refs/heads/run') return 'runSha1'
      return `${ref}-sha`
    },
    commitsBetween: async () => ['mergeSha1', SHARED_SHA],
    commitParents: async (sha) => (sha === 'mergeSha1' ? ['firstParentSha', SHARED_SHA] : []),
    // The merge naming the shared sha carried T1's declared file, never T2's.
    changedFiles: async ({ base, branch }) => (base === 'firstParentSha' && branch === 'mergeSha1' ? ['a.mjs'] : []),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1',
    tasks: [T1_TASK, T2_TASK], currentPhase: 2, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /T2: branch teammates\/r1\/T2 contributes no file changes past its fork point/)
  assert.doesNotMatch(res.output, /T1/)
})

// T8 and T9 (phase 3, untouched) both sit at the run tip while phase 2 is gated. Widening the
// SUBJECT to every task in the run — rather than only the phase under check — would fail this
// phase for two not-yet-started refs of a LATER phase, which is not a violation of anything.
test('runFilesetCheck does not fail the current phase for two refs of a later phase sharing a sha', async () => {
  const T2_TASK = { id: 'T2', phase: 2, files: ['b.mjs'] }
  const T8_TASK = { id: 'T8', phase: 3, files: ['h.mjs'] }
  const T9_TASK = { id: 'T9', phase: 3, files: ['i.mjs'] }
  const T8_BRANCH = 'teammates/r1/T8'
  const T9_BRANCH = 'teammates/r1/T9'
  const FUTURE_SHA = 'futureSha1'
  const git = fakeGit({
    branchExists: async () => true,
    resolveRef: async (ref) => {
      if (ref === `refs/heads/${T8_BRANCH}`) return FUTURE_SHA
      if (ref === `refs/heads/${T9_BRANCH}`) return FUTURE_SHA
      if (ref === 'refs/heads/run') return 'runSha1'
      return `${ref}-sha`
    },
    changedFiles: async ({ branch }) => (branch === `refs/heads/${T2_BRANCH}-sha` ? ['b.mjs'] : []),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1',
    tasks: [T2_TASK, T8_TASK, T9_TASK], currentPhase: 2, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

// `mergedParentFiles` walks every task ref's merge history, not just this phase's, so a
// corrupted ref anywhere in that history must fail the check cleanly rather than let the
// GitError propagate as an uncaught throw where a FAIL verdict belongs.
test('runFilesetCheck fails with the git error when the merge-history walk fails', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
    commitsBetween: async () => { throw new GitError('bad revision anchorSha1..runSha1') },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1',
    tasks: [T1_TASK], currentPhase: 1, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /could not walk this run's merge history/)
  assert.match(res.output, /bad revision/)
})

// A teammate that skips its `git checkout -B teammates/<run>/<task>` and commits on the
// harness's own worktree branch leaves the conventional ref existing but empty: it points at
// the run tip with no work on it. `filesetViolations` of an empty change list is empty, so the
// check used to pass, the task merged as a no-op, and the returned `status: done` was believed.
// An existing branch that contributes nothing is a failure, not a clean pass.
// Wiring for the side-door rule: the branch is an ancestor of the base but not of the run
// branch. isAncestor is asked exactly that pair of questions, and a merge into the base with no
// gate PASS is a fail, not a pass carrying a note.
test('runOwnershipCheck fails a task branch merged into the base branch but not the run branch', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => [],
    isAncestor: async (sha, target) => sha === `refs/heads/${T1_BRANCH}-sha` && target === 'baseSha1',
    resolveRef: async (ref) => {
      if (ref === 'refs/heads/run') return 'runSha1'
      if (ref === 'refs/heads/main') return 'baseSha1'
      return `${ref}-sha`
    },
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, new RegExp(T1_BRANCH))
  assert.match(res.output, /main/)
})

test('runOwnershipCheck passes a task branch that is an ancestor of both the base and the run branch', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => [],
    // Landed the ordinary way: the run branch carries it, and the run branch has since landed
    // on the base. Ancestor of both, and no violation.
    isAncestor: async () => true,
    resolveRef: async (ref) => {
      if (ref === 'refs/heads/run') return 'runSha1'
      if (ref === 'refs/heads/main') return 'baseSha1'
      return `${ref}-sha`
    },
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

// A branch that is ALREADY an ancestor of the run branch has landed: merge-base(run, branch) is
// the branch's own tip, so its diff is vacuously empty for a reason that has nothing to do with
// whether work was done. Reported as a violation, that turns every re-verification of an
// integrated phase — which is exactly what `finish` does — into a false failure. The emptiness
// rule is about work that never reached the conventional ref, and that question is only
// meaningful before the branch is merged.
test('runFilesetCheck does not report an already-integrated branch as contributing nothing', async () => {
  const t1Sha = `refs/heads/${T1_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    isAncestor: async (_sha, target) => target === 'mergeSha1',
    // The run tip IS the integrator's merge commit — the walk starts at `runSha` and follows
    // `parents[0]` back to `anchorSha`, so the merge must be reachable from `runSha` by that
    // exact chain, not merely present somewhere in `commitsBetween`'s output.
    commitsBetween: async () => ['mergeSha1', t1Sha],
    commitParents: async (sha) => (sha === 'mergeSha1' ? ['anchorSha1', t1Sha] : []),
    // T1's own sha is already on the run branch, so its fork-point diff (this check's own
    // top-level diff, computed the same way for every task) is empty — merge-base(run, sha)
    // is `sha` itself, exactly like a real already-landed branch.
    mergeBase: async (_run, sha) => (sha === t1Sha ? t1Sha : 'anchorSha1'),
    // The merge that landed T1's branch carried its declared file, `a.mjs` — T1's own
    // contribution since it diverged from the chain's prior tip (the anchor here) — which is
    // what makes the branch read as integrated, not ancestry alone.
    changedFiles: async ({ base, branch }) => (base === 'anchorSha1' && branch === t1Sha ? ['a.mjs'] : []),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'mergeSha1', anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.deepEqual(res.branchShas, { [T1_BRANCH]: t1Sha })
})

// `landedForFiles`'s path normalization, pinned directly: plans are hand-authored on Windows,
// and `plan-parser` stores a declared path verbatim, so a task declaring `./a.mjs` (a leading
// `./` a human might type) must still match a merge diff reporting the same file as plain
// `a.mjs` — the shape `git diff --name-only` actually reports paths in. Without normalizing
// both sides the same way `filesetViolations` does, a branch that genuinely landed would read
// as not-landed over a formatting difference, not a real absence.
test('runFilesetCheck matches a declared path against a differently-normalized merge diff path', async () => {
  const dotSlashTask = { id: 'T1', phase: 1, files: ['./a.mjs'] }
  const t1Sha = `refs/heads/${T1_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    isAncestor: async (_sha, target) => target === 'mergeSha1',
    commitsBetween: async () => ['mergeSha1', t1Sha],
    commitParents: async (sha) => (sha === 'mergeSha1' ? ['anchorSha1', t1Sha] : []),
    mergeBase: async (_run, sha) => (sha === t1Sha ? t1Sha : 'anchorSha1'),
    // The diff reports the plain path, with no leading `./` — the declared path has one.
    changedFiles: async ({ base, branch }) => (base === 'anchorSha1' && branch === t1Sha ? ['a.mjs'] : []),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'mergeSha1', anchorSha: 'anchorSha1', tasks: [dotSlashTask], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

// `mergedParentFiles` unions file sets across two chain commits that both name the SAME sha as
// a secondary parent, rather than keeping only the first. Chain: `runSha` (M2) -> M1 ->
// `anchorSha`. Both M2 and M1 name `sharedParent` as their own secondary parent, but from
// different first parents, so each contributes a DIFFERENT file to the union: M2's own diff
// (base M1) gives `y.mjs`; M1's own diff (base anchor) gives `x.mjs`. The task here declares
// only `x.mjs` — the file M1's traversal contributes, processed SECOND since the walk starts at
// `runSha` and only reaches M1 afterward. A "first merge wins" version (keeping the set from
// M2's visit and never adding to it) would read this task as not-landed.
test('mergedParentFiles unions file sets across two merges naming the same sha, rather than keeping only the first', async () => {
  const declaresSecondFile = { id: 'T1', phase: 1, files: ['x.mjs'] }
  const git = fakeGit({
    branchExists: async () => true,
    isAncestor: async (_sha, target) => target === 'M2',
    resolveRef: async (ref) => (ref === `refs/heads/${T1_BRANCH}` ? 'sharedParent' : `${ref}-sha`),
    commitsBetween: async () => ['M2', 'M1', 'sharedParent'],
    commitParents: async (sha) => {
      if (sha === 'M2') return ['M1', 'sharedParent']
      if (sha === 'M1') return ['anchorSha1', 'sharedParent']
      return []
    },
    mergeBase: async (_run, sha) => (sha === 'sharedParent' ? 'sharedParent' : 'anchorSha1'),
    changedFiles: async ({ base, branch }) => {
      if (branch !== 'sharedParent') return []
      if (base === 'M1') return ['y.mjs'] // M2's own visit
      if (base === 'anchorSha1') return ['x.mjs'] // M1's own visit
      return []
    },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'M2', anchorSha: 'anchorSha1', tasks: [declaresSecondFile], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

// `mergedParentFiles` and `landedForFiles` are exported so `scripts/doctor.mjs` can decide
// `landed` with the exact same predicate `runFilesetCheck` enforces with, rather than keeping a
// second implementation that could silently disagree with the gate. Called directly here,
// outside `runFilesetCheck`, to pin the export itself — not just behaviour reachable only
// through the check.
test('mergedParentFiles and landedForFiles are exported and usable directly', async () => {
  const git = fakeGit({
    commitsBetween: async () => ['M1', 'sharedParent'],
    commitParents: async (sha) => (sha === 'M1' ? ['anchorSha1', 'sharedParent'] : []),
    changedFiles: async ({ base, branch }) => (base === 'anchorSha1' && branch === 'sharedParent' ? ['x.mjs'] : []),
  })
  const index = await mergedParentFiles(git, { anchorSha: 'anchorSha1', runSha: 'M1' })
  assert.equal(landedForFiles(index, 'sharedParent', ['x.mjs']), true)
  assert.equal(landedForFiles(index, 'sharedParent', ['y.mjs']), false)
  assert.equal(landedForFiles(index, 'someOtherSha', ['x.mjs']), false)
})

// One merge-history walk for the whole phase, not one per task: `mergedParentFiles` is called
// once, before the per-task loop, and its result is reused for every task in the phase.
test('runFilesetCheck builds the merge-history index once for the whole phase, not once per task', async () => {
  let calls = 0
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
    commitsBetween: async () => { calls += 1; return [] },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1',
    tasks: [T1_TASK, { id: 'T2', phase: 1, files: ['b.mjs'] }], currentPhase: 1, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.equal(calls, 1)
})

// Reversed from the design this replaced: the merge-history walk used to be lazy, skipped
// entirely when every branch's own diff came up non-empty. `mergedParentFiles` is now built
// unconditionally, before the per-task loop even inspects any branch's diff, because
// `deriveContext`'s own integration credit needs the SAME index regardless of what any single
// task's diff looks like, and `runFilesetCheck` builds its own copy the same way. Pinned here so
// reintroducing laziness (skipping the walk when it looks unneeded) is a deliberate choice, not
// an accidental regression: every branch below carries real, non-empty changes, and the walk
// still runs.
test('runFilesetCheck builds the merge-history index even when every branch carries its own changes', async () => {
  let calls = 0
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => ['a.mjs'],
    commitsBetween: async () => { calls += 1; return [] },
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.equal(calls, 1)
})

// The enforcing counterpart of doctor's run-tip case. From phase 2 onward the run tip is past
// the anchor, so a branch left exactly where `git checkout -B <task> <run branch>` put it
// satisfies both halves of the landed test while carrying no work of its own — and this check
// decides whether the phase may integrate.
test('runFilesetCheck fails a branch parked at the run tip with no contribution', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
    isAncestor: async (_sha, target) => target === 'runSha1',
    resolveRef: async () => 'runSha1',
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'runSha1', anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /contributes no file changes/)
})

// The case a run-tip-only exclusion cannot see. The integrator merged a sibling after this
// branch was created, so the run tip moved past the commit the branch is parked at: it is past
// the anchor, it is not the tip, and — with no merge in range naming this sha at all (the
// default `commitsBetween`/`commitParents` stubs return nothing) — `landedForFiles` reads false
// regardless of the sha's relationship to the tip.
test('runFilesetCheck fails a branch parked at an intermediate post-anchor commit', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
    isAncestor: async (_sha, target) => target === 'runSha2',
    resolveRef: async (ref) => (ref === 'refs/heads/run' ? 'runSha2' : 'midSha'),
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, runSha: 'runSha2', anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /contributes no file changes/)
})

test('runFilesetCheck fails when a task branch contributes no file changes', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => [],
  })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /T1/)
  assert.match(res.output, /no file changes/)
  // The branch sha is still recorded, so verdictCoversTree keeps working across a fix round.
  assert.deepEqual(res.branchShas, { [T1_BRANCH]: `refs/heads/${T1_BRANCH}-sha` })
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

// M2: `optional: true` is meaningful on a `command` check ("advisory") but on `fileset` or
// `ownership` it means "detect the violation and ship anyway", which is never coherent. An
// uncommitted manifest marking either check optional must not be able to disable enforcement
// while appearing to record it — the result must always come back non-optional so
// aggregateVerdict counts it.
test('runFilesetCheck ignores optional:true and still fails the gate on a violation', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    changedFiles: async () => ['a.mjs', 'secret.mjs'],
  })
  const check = { name: 'fileset', kind: 'fileset', optional: true }
  const ctx = { git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK], currentPhase: 1, phaseError: null }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.equal(res.optional, false)
  assert.equal(aggregateVerdict([res]).verdict, 'FAIL')
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

test('runOwnershipCheck fails a merge commit whose content for a file has no source in any parent', async () => {
  const branchSha = `refs/heads/${T1_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    isAncestor: async (a, b) => a === 'p1' && b === branchSha,
    commitParents: async () => ['p0', 'p1'],
    mergeBase: async (a, b) => (a === 'p0' && b === 'p1' ? 'base01' : 'anchorSha1'),
    // BACKDOOR.mjs differs between the merge commit and its first parent, but neither the
    // first parent nor the second parent (nor their common base) ever had it — content with
    // no legitimate source.
    changedFiles: async ({ base, branch }) => (base === 'p0' && branch === 'm1' ? ['BACKDOOR.mjs'] : []),
    fileAtCommit: async (sha, filePath) => {
      if (filePath === 'BACKDOOR.mjs' && sha === 'm1') return 'export const backdoor = true\n'
      throw new GitError(`no such path ${filePath} at ${sha}`)
    },
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /m1/)
})

// The confirmed gap: a two-parent-owned merge short-circuited on the first matching
// secondary parent, so an octopus merge with a legitimate parent AND a rogue (unowned)
// parent was waved through — content riding in behind the rogue parent was never inspected.
// Every secondary parent must be independently confirmed as an ancestor of a task branch.
test('runOwnershipCheck requires every parent of an octopus merge to be owned by a task branch', async () => {
  const t1Sha = `refs/heads/${T1_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    commitsBetween: async () => ['m1'],
    // Only the T1 branch tip is an ancestor of a task branch; 'rogue' is not.
    isAncestor: async (a, b) => a === t1Sha && b === t1Sha,
    commitParents: async () => ['p0', t1Sha, 'rogue'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /m1/)
})

// Advancing the base branch mid-run and merging it into the run branch produces a merge whose
// secondary parent is the base, never a task branch. Without base ancestry as an explanation
// that legitimate advance is indistinguishable from a direct write — run `preview` hit exactly
// this and paid for a full run-branch rebuild.
test('runOwnershipCheck accepts a merge whose secondary parent is an ancestor of the base branch', async () => {
  const baseSha = `refs/heads/${BASE_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    // Nothing on a task branch explains this merge; only the base does.
    isAncestor: async (a, b) => a === 'baseAdvance' && b === baseSha,
    commitParents: async () => ['p0', 'baseAdvance'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
})

// Accepting base ancestry must not turn into accepting anything: a plain, parentless-of-any-
// -owner commit written straight onto the run branch is still the case this check exists for.
test('runOwnershipCheck still fails a direct write explained by neither a task branch nor the base', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['c1'],
    isAncestor: async () => false,
    commitParents: async () => ['p0'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /c1/)
})

// The octopus case, now with base ancestry in play: one legitimate base parent must not vouch
// for a rogue sibling parent. Every secondary parent is still checked independently.
test('runOwnershipCheck fails an octopus merge mixing a base-owned parent with an unowned one', async () => {
  const baseSha = `refs/heads/${BASE_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    isAncestor: async (a, b) => a === 'baseAdvance' && b === baseSha,
    commitParents: async () => ['p0', 'baseAdvance', 'rogue'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /m1/)
})

// A run configured with a base branch that does not exist keeps today's behaviour exactly:
// no resolve is attempted (which would be a GitError and fail the check for a new reason),
// and the commit stays unexplained.
test('runOwnershipCheck leaves a commit unexplained when the base branch does not exist', async () => {
  const git = fakeGit({
    branchExists: async (name) => name === T1_BRANCH,
    commitsBetween: async () => ['m1'],
    isAncestor: async () => false,
    commitParents: async () => ['p0', 'baseAdvance'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: 'no-such-base',
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /m1/)
  assert.ok(
    !git.resolveRefCalls.includes('refs/heads/no-such-base'),
    'no resolve should be attempted for a base branch that does not exist',
  )
})

// Accepting base ancestry costs a signal: before it, an accidental commit landing on the base
// branch mid-run rode into the run branch as an ownership FAILURE — wrong, but the only place
// a moved baseline was ever visible. Nothing pins the base ref, so the movement itself cannot
// be detected after the fact; what can be preserved is a record of what was admitted because
// of it. A pass that admitted nothing must stay quiet, or the note becomes noise nobody reads.
test('runOwnershipCheck records every base-explained commit in its own passing output', async () => {
  const baseSha = `refs/heads/${BASE_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    isAncestor: async (a, b) => a === 'baseAdvance' && b === baseSha,
    commitParents: async () => ['p0', 'baseAdvance'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.match(res.output, /m1/)
})

test('the base-explained note names the base branch it accepted the commit from', async () => {
  const baseSha = `refs/heads/${BASE_BRANCH}-sha`
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    isAncestor: async (a, b) => a === 'baseAdvance' && b === baseSha,
    commitParents: async () => ['p0', 'baseAdvance'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.match(res.output, new RegExp(BASE_BRANCH))
})

test('a pass with no base-explained commits carries no note and an empty output', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['m1'],
    // Explained the ordinary way: the secondary parent is an ancestor of a task branch.
    isAncestor: async (a, b) => a === 'p1' && b === `refs/heads/${T1_BRANCH}-sha`,
    commitParents: async () => ['p0', 'p1'],
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [T1_TASK],
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.equal(res.output, '')
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

test('runOwnershipCheck ignores optional:true and still fails the gate on a violation', async () => {
  const git = fakeGit({ isDirty: async () => true })
  const check = { name: 'ownership', kind: 'ownership', optional: true }
  const ctx = { git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1', tasks: [] }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.equal(res.optional, false)
  assert.equal(aggregateVerdict([res]).verdict, 'FAIL')
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
  // The gate's own computed merge check leads the list; this ctx has no in-progress phase and
  // so no branches to preview, which is a clean merge by definition.
  assert.deepEqual(results.map((r) => r.name), ['merge', 'test', 'fileset', 'ownership', 'review'])
  assert.deepEqual(results.map((r) => r.status), ['pass', 'pass', 'pass', 'pass', 'pending'])
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
  // The same throw stops the merge preview from being assembled, so the merge check fails too;
  // the fileset check still reports its own throw rather than vanishing behind it.
  assert.equal(results[0].name, 'merge')
  assert.equal(results[0].status, 'fail')
  const fileset = results.find((r) => r.name === 'fileset')
  assert.equal(fileset.status, 'fail')
  assert.match(fileset.output, /check threw/)
  assert.match(fileset.output, /unexpected boom/)
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
  const calls = { resolveRef: [], mergeBase: [], isAncestor: [], commitsBetween: [], changedFiles: [], commitParents: [], fileAtCommit: [], mergedBranchTips: [] }
  const git = {
    async mergeBase(a, b) { calls.mergeBase.push([a, b]); return shaFor(`merge-base:${a}:${b}`) },
    async fileAtCommit(sha, filePath) { calls.fileAtCommit.push(sha); void filePath; return planMarkdown() },
    async resolveRef(ref) { calls.resolveRef.push(ref); return shaFor(ref) },
    async branchExists(name) { return name === T1_BRANCH || name === T2_BRANCH },
    async isAncestor(ancestor, descendant) { calls.isAncestor.push([ancestor, descendant]); return true },
    async changedFiles({ base, branch }) { calls.changedFiles.push({ base, branch }); return [] },
    async commitsBetween({ from, to }) { calls.commitsBetween.push({ from, to }); return [shaFor('commit1')] },
    async commitParents(sha) { calls.commitParents.push(sha); return [shaFor('parent0'), shaFor('parent1')] },
    async mergedBranchTips({ runSha, anchorSha }) { calls.mergedBranchTips.push({ runSha, anchorSha }); return new Set() },
    async isDirty() { return false },
  }
  return { git, calls }
}

test('every ref-shaped argument reaching git is a sha or a fully-qualified ref', async () => {
  const { git, calls } = refShapedFakeGit()

  await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
  await runFilesetCheck(
    { name: 'fileset', kind: 'fileset' },
    { git, runId: RUN_ID, anchorSha: shaFor('anchor'), runSha: shaFor('run'), tasks: [T1_TASK], currentPhase: 1, phaseError: null },
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
  // `mergedBranchTips` is no longer called by anything in this file — the fix-round rewrite
  // replaced it with `mergedParentFiles`, built from `commitsBetween`/`commitParents`/
  // `changedFiles` directly, which the assertions above already cover.
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

// Two phases whose declared sets OVERLAP: T2 modifies a file T1 created. Legal across phases
// (`scripts/phases.mjs` enforces disjointness only within a phase) and routine in a real plan,
// which is what makes it the shape a containment-only run-tip test lets through.
function overlappingTwoPhasePlan() {
  return [
    '### Task 1: first task',
    '',
    '**Files:**',
    '- Create: `a.mjs`',
    '- Create: `b.mjs`',
    '',
    '**Depends:** none',
    '',
    '### Task 2: second task',
    '',
    '**Files:**',
    '- Modify: `a.mjs`',
    '',
    '**Depends:** T1',
    '',
  ].join('\n')
}

// Two phases with disjoint declared sets, both of which a single merge carries — so two run-tip
// refs are each individually eligible for the same parent and only scarcity separates them.
function twoPhaseBothFilesPlan() {
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
    '- Modify: `b.mjs`',
    '',
    '**Depends:** T1',
    '',
  ].join('\n')
}

// Three tasks over two phases, with TWO tasks in phase 2 — the shape the anchor-based
// "integrated" test could not judge, because it needs a sibling whose merge moves the run tip
// past a branch parked in that same phase.
function twoInSecondPhasePlan() {
  return [
    '### Task 1: first task',
    '',
    '**Files:**',
    '- Create: `a.mjs`',
    '',
    '**Depends:** none',
    '',
    '### Task 2: parked task',
    '',
    '**Files:**',
    '- Create: `b.mjs`',
    '',
    '**Depends:** T1',
    '',
    '### Task 3: sibling task',
    '',
    '**Files:**',
    '- Create: `c.mjs`',
    '',
    '**Depends:** T1',
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

// The more useful attack: keep the filename the task legitimately owns, but replace its
// reviewed content during the merge. A name-set comparison (the previous version of this
// check) cannot see this — both the name set and the ancestry look honest. Only a
// byte-for-byte content comparison against the branch's actual contribution catches it.
test('a merge that tampers with content under an unchanged filename is unexplained (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'from-branch\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '--no-commit', 'teammates/r1/T1'])
    // Same filename the merge legitimately brings in, different bytes.
    await writeFile(path.join(root, 'a.mjs'), 'TAMPERED-IN-MERGE\n', 'utf8')
    await sh(['add', '-A'])
    await sh(['commit', '-m', 'Merge T1'])

    const mergeSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck({ name: 'ownership', kind: 'ownership' }, ctx)

    assert.equal(res.status, 'fail')
    assert.match(res.output, new RegExp(mergeSha))
  })
})

// The other side of the same coin: an integrator resolving a genuine conflict legitimately
// writes content into the merge commit that matches neither parent verbatim. If the content
// check cannot tell this apart from tampering, it breaks ordinary integration, which is
// worse than the hole it closes. Two branches modify the same line differently from a common
// ancestor; the run branch already carries one of them (phase 1, cleanly merged); merging
// the second produces a real git conflict, hand-resolved and committed.
test('a genuine hand-resolved merge conflict is explained, not flagged as tampering (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), planMarkdown(), 'utf8')
    await writeFile(path.join(root, 'shared.txt'), 'line1\nline2\nline3\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // Phase 1: T2 changes shared.txt, merges cleanly onto run.
    await sh(['checkout', '-b', 'teammates/r1/T2'])
    await writeFile(path.join(root, 'shared.txt'), 'line1\nline2-T2\nline3\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T2 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T2', 'teammates/r1/T2'])

    // Phase 2: T1, branched from the original anchor (unaware of T2's change), changes the
    // same line differently — a genuine conflict when merged onto run.
    await sh(['checkout', 'main'])
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'shared.txt'), 'line1\nline2-T1\nline3\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    const merge = await sh(['merge', '--no-ff', '--no-commit', 'teammates/r1/T1'])
    assert.match(merge.stdout + merge.stderr, /[Cc]onflict/, 'expected a real git conflict to set up this test')
    // Hand-resolve, combining both intents — content matching neither parent verbatim.
    await writeFile(path.join(root, 'shared.txt'), 'line1\nline2-merged\nline3\n', 'utf8')
    await sh(['add', 'shared.txt'])
    await sh(['commit', '-m', 'Merge T1 (resolved conflict)'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck({ name: 'ownership', kind: 'ownership' }, ctx)

    assert.equal(res.status, 'pass', res.output)
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

// The shape no ancestry exclusion could see, against real git. T2 is parked at a commit that is
// past the anchor, on the run branch, and no longer its tip — because the run tip moved on after
// T2's ref was created. Ancestry says "landed" for all three of those facts; only the merge that
// carried T1 (and never carried T2) tells them apart.
test('a phase-1 branch parked at an intermediate post-anchor commit fails the fileset check (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])
    const afterT1 = (await sh(['rev-parse', 'run'])).stdout.trim()

    // T2's ref is created here and never moves — the stale-base shape.
    await sh(['branch', 'teammates/r1/T2', afterT1])

    // The run tip then moves past it: a sibling branch, outside the plan, is merged in. T2 is
    // now parked at an INTERMEDIATE post-anchor commit — afterT1 is the FIRST parent of this
    // merge, so nothing names it as a branch the run branch carried.
    await sh(['checkout', '-b', 'sibling', afterT1])
    await writeFile(path.join(root, 'c.txt'), 'c\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'sibling work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge sibling', 'sibling'])
    assert.notEqual((await sh(['rev-parse', 'run'])).stdout.trim(), afterT1)

    // The context is built directly rather than through deriveContext: deriveContext decides
    // which phases are integrated by diffing each branch against the run ANCHOR, so a branch
    // parked downstream of a sibling's merge shows that sibling's files and reads as integrated
    // there. That is a separate question in a separate function, and this task does not change
    // it; what is under test here is the fileset check's own landed test against real git.
    const anchorSha = (await sh(['merge-base', 'main', 'run'])).stdout.trim()
    const runSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    const ctx = {
      git,
      runId: 'r1',
      runSha,
      anchorSha,
      tasks: [{ id: 'T1', phase: 1, files: ['a.mjs'] }, { id: 'T2', phase: 1, files: ['b.mjs'] }],
      currentPhase: 1,
      phaseError: null,
    }
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)

    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch teammates\/r1\/T2 contributes no file changes/)
    // T1 was genuinely merged in, so its empty diff is still excused.
    assert.doesNotMatch(res.output, /T1:/)
  })
})

// The merge-parent test subsumes the TIP exclusion but NOT the anchor exclusion, because this
// plugin's own plan-amendment procedure merges the base branch into the run branch — so the base
// tip is a secondary parent of a merge inside the range, and for a run whose amendments have all
// landed, merge-base(base, run) IS that base tip. Without filtering, the anchor is a member of
// the merged set, and a task branch parked at the anchor — a teammate that ran
// `git checkout -B <task> <base>`, committed on some other ref, and left the conventional ref
// empty — reads as merged and the phase integrates a no-op. This is the shape the old
// `!isAncestor(sha, anchorSha)` clause caught, and an enforcing check must never get less strict.
test('a task branch parked at the anchor still fails after a plan amendment merged the base in (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await writeFile(path.join(root, 'run.txt'), 'r1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'r1'])

    // The plan amendment: the base advances, and the run branch merges it in.
    await sh(['checkout', 'main'])
    await writeFile(path.join(root, 'plan.md'), 'amended\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'amend the plan'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'merge: plan amendment', 'main'])

    const anchorSha = (await sh(['merge-base', 'main', 'run'])).stdout.trim()
    const runSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    assert.equal(anchorSha, (await sh(['rev-parse', 'main'])).stdout.trim(), 'fixture: the anchor is the base tip')

    // The stale ref: created off the base, never moved, carrying nothing.
    await sh(['branch', 'teammates/r1/T14', anchorSha])

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, {
      git, runId: 'r1', runSha, anchorSha,
      tasks: [{ id: 'T14', phase: 1, files: ['a.mjs'] }], currentPhase: 1, phaseError: null,
    })

    assert.equal(res.status, 'fail')
    assert.match(res.output, /T14: branch teammates\/r1\/T14 contributes no file changes/)
  })
})

// The limit the comment above the landed test states, pinned so the comment is checkable rather
// than merely plausible. A branch integrated by FAST-FORWARD carries real work, but leaves no
// merge commit to name it and no diff past its own fork point, so it is indistinguishable from a
// branch parked at that same commit and is failed. `tm-integrator`'s contract is `--no-ff` for
// exactly this reason. If this test ever starts failing, the comment is what needs revisiting.
test('a fast-forward-integrated branch is failed, not excused — the stated limit (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--ff-only', 'teammates/r1/T1'])

    const anchorSha = (await sh(['merge-base', 'main', 'run'])).stdout.trim()
    const runSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, {
      git, runId: 'r1', runSha, anchorSha,
      tasks: [{ id: 'T1', phase: 1, files: ['a.mjs'] }], currentPhase: 1, phaseError: null,
    })

    assert.equal(res.status, 'fail')
    assert.match(res.output, /contributes no file changes/)
  })
})

// The same limit, at `deriveContext`'s own level rather than `runFilesetCheck`'s: a
// fast-forward leaves no merge commit, so the branch's sha is never a key in `mergedFiles`
// (built by `mergedParentFiles`, which walks only merge commits), and `landedForFiles` reads
// false even though the work genuinely is on the run branch. `tm-integrator`'s contract is
// `--no-ff` for exactly this reason.
test('deriveContext does not read a fast-forward-integrated branch as integrated (real repo)', async () => {
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
    await sh(['merge', '--ff-only', 'teammates/r1/T1'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    assert.deepEqual(ctx.integratedPhases, [])
    assert.equal(ctx.currentPhase, 1)
  })
})

// H3-empty: a single `git commit --allow-empty`, honestly merged, is a real commit — a
// commit-counting guard would call the phase integrated even though the branch touched no
// file. The guard must count file changes, not commits.
test('a branch consisting only of an empty commit does not read as integrated (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await sh(['commit', '--allow-empty', '-m', 'empty T1 commit'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })

    assert.deepEqual(ctx.integratedPhases, [])
    assert.equal(ctx.currentPhase, 1)
  })
})

// V3: a merge that brings in a file and deletes it before committing is invisible to a diff
// taken only between the merge commit and its first parent — added, then removed, nets to
// no difference at all. Deletion is a content change with no legitimate source, exactly like
// a fabricated addition, and must be caught the same way.
test('a merge that deletes the task branch\'s entire contribution is unexplained (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), singleTaskPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'content\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '--no-commit', 'teammates/r1/T1'])
    await sh(['rm', '-f', 'a.mjs'])
    await sh(['commit', '-m', 'Merge T1 (dropped)'])

    const mergeSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck({ name: 'ownership', kind: 'ownership' }, ctx)

    assert.equal(res.status, 'fail')
    assert.match(res.output, new RegExp(mergeSha))
  })
})

// H1: `fileset` must diff a task branch against its actual fork point off the run branch, not
// against the run anchor fixed at the start of the whole run. A phase-2 branch legitimately
// forks from the run branch *after* phase 1 was merged into it, so phase 1's files land in a
// phase-2 branch's diff against the (stale) anchor even though the phase-2 teammate never
// touched them. `anchor...branch` does not save this either: once the anchor is an ancestor of
// the branch, `merge-base(anchor, branch) == anchor`, so the three-dot diff degenerates to the
// same two-dot diff. The fix diffs against `merge-base(runSha, branchSha)` instead — the task
// branch's real fork point off the run branch as it stood when the teammate branched.
test('runFilesetCheck does not blame a phase-2 branch for phase-1 files merged onto run before it forked (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), planMarkdown(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // Phase 1: T1 commits a.mjs, merged --no-ff onto run.
    await sh(['checkout', '-b', T1_BRANCH])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', T1_BRANCH])

    // Phase 2: T2 branches off run *after* phase 1 landed, and commits only b.mjs.
    await sh(['checkout', '-b', T2_BRANCH])
    await writeFile(path.join(root, 'b.mjs'), 'export const b = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T2 work'])
    await sh(['checkout', 'run'])

    const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
    assert.equal(ctx.currentPhase, 2)
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'pass', res.output)

    // Extend: T2 also commits a stray file. The fail must name only the stray file, not
    // a.mjs, which T2 never touched.
    await sh(['checkout', T2_BRANCH])
    await writeFile(path.join(root, 'stray.mjs'), 'export const stray = true\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T2 stray commit'])
    await sh(['checkout', 'run'])

    const ctx2 = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })
    const res2 = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx2)
    assert.equal(res2.status, 'fail')
    assert.match(res2.output, /stray\.mjs/)
    assert.doesNotMatch(res2.output, /a\.mjs/)
  })
})

// The same stale base, one function earlier: `deriveContext` decided whether a phase was
// integrated by diffing each task branch against the run ANCHOR. From phase 2 onward the run tip
// is past the anchor, so a branch parked at the run tip and never committed to shows the SIBLING'S
// merged files as its own work; the phase reads integrated, `derivePhase` advances past it, and
// `runFilesetCheck` takes its "every phase in the plan is integrated" fast path — so the landed
// test below never runs for that task at all and the empty ref merges as a no-op behind a PASS.
// A fake git cannot exhibit this: it lives in what real `merge-base` and `changedFiles` return.
test('a phase-2 branch parked at the run tip does not read as integrated (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), twoInSecondPhasePlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // Phase 1: real work, merged --no-ff, so the run tip is now past the anchor.
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])
    const afterT1 = (await sh(['rev-parse', 'run'])).stdout.trim()

    // Phase 2, T2: the ref is created at the run tip as it stands right now and never moves —
    // the teammate committed on some other branch, or never committed at all.
    await sh(['branch', 'teammates/r1/T2', afterT1])

    // Phase 2, T3: real work, merged --no-ff, so the run tip moves past where T2 is parked.
    await sh(['checkout', '-b', 'teammates/r1/T3', afterT1])
    await writeFile(path.join(root, 'c.mjs'), 'export const c = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T3 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T3', 'teammates/r1/T3'])
    assert.notEqual((await sh(['rev-parse', 'run'])).stdout.trim(), afterT1)

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })

    // Phase 1 genuinely integrated; phase 2 is not, because T2 contributed nothing of its own.
    assert.deepEqual(ctx.integratedPhases, [1])
    assert.equal(ctx.currentPhase, 2)
    assert.equal(ctx.phaseError, null)

    // And because phase 2 is still the current phase, the landed test is actually reached:
    // T2 is reported as contributing nothing, while T3's merged (and therefore empty) diff is
    // still excused.
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch teammates\/r1\/T2 contributes no file changes/)
    assert.doesNotMatch(res.output, /T3:/)
  })
})

// Fix-round rewrite (round 4): three earlier designs tried to classify the SHARED SHA as
// suspicious or benign, and each broke something real (see the comment above `mergedParentFiles`
// in scripts/gate-runner.mjs for the full history). This test pins the design that replaced
// them: T3 does the real work and is merged `--no-ff`; T2 never commits and its ref is pointed
// at T3's own tip instead of at the merge commit that carried it. `deriveContext` no longer
// special-cases the shared sha at all — it asks, per task, whether the merge that landed this
// sha actually carried THIS task's declared files. The merge that landed T3's tip carried
// `c.mjs`, T3's own file, never T2's `b.mjs`, so T2 reads false and phase 2 does not integrate
// on T3's legitimate merge alone. `integratedPhases` is the ordinary computed array on every
// path — no dedicated phaseError, no silent exclusion. Phase 1 IS genuinely integrated and
// phase 2 genuinely is not, so `currentPhase` reads the unremarkable 2, and
// `runFilesetCheck`'s own empty-diff test (over the SAME shared `mergedParentFiles` index)
// reports T2's true, actionable, self-contained failure.
test('deriveContext does not credit a ref parked on a merged sibling\'s tip, and integratedPhases stays the computed set', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), twoInSecondPhasePlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])

    await sh(['checkout', '-b', 'teammates/r1/T3'])
    await writeFile(path.join(root, 'c.mjs'), 'export const c = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T3 work'])
    const t3Tip = (await sh(['rev-parse', 'teammates/r1/T3'])).stdout.trim()
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T3', 'teammates/r1/T3'])

    // T2 never commits: its ref is pointed straight at T3's own tip commit.
    await sh(['branch', 'teammates/r1/T2', t3Tip])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })

    // Phase 1 genuinely integrated, and `integratedPhases` says so directly — no dedicated
    // phaseError, no `[]` regardless of what is actually integrated (the shape that inverted
    // `plan-drift`'s verdict in the previous fix round).
    assert.deepEqual(ctx.integratedPhases, [1])
    assert.equal(ctx.currentPhase, 2)
    assert.equal(ctx.phaseError, null)

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch teammates\/r1\/T2 contributes no file changes/)
    assert.doesNotMatch(res.output, /T3:/)
  })
})

// The discriminator's other half: two refs sharing the RUN TIP itself are the ordinary state
// every fleet passes through between `git checkout -B <task> <run branch>` and its first
// commit. Reproduced with the real CLI (fix-round finding A): a phase-1 plan with every task
// branch freshly created and nothing committed used to report each task as "parked at" a
// sibling; the true, actionable cause is that none of them has done any work yet.
test('deriveContext does not treat siblings sharing the run tip as a violation (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), twoInSecondPhasePlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // T1 is the only phase-1 task in this plan; give it its own real, unmerged commit so the
    // run tip advances past main, then park T2 and T3 (both phase 2, still un-started) exactly
    // where `git checkout -B <task> <run branch>` would put them.
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])

    const runTip = (await sh(['rev-parse', 'run'])).stdout.trim()
    await sh(['branch', 'teammates/r1/T2', runTip])
    await sh(['branch', 'teammates/r1/T3', runTip])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })

    assert.equal(ctx.phaseError, null)
    assert.deepEqual(ctx.integratedPhases, [1])
    assert.equal(ctx.currentPhase, 2)

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch teammates\/r1\/T2 contributes no file changes/)
    assert.match(res.output, /T3: branch teammates\/r1\/T3 contributes no file changes/)
    assert.doesNotMatch(res.output, /parked at the other's tip/)
  })
})

// The plan-amendment shape, against the merge index `deriveContext` uses to find a merged
// branch's fork point. This plugin's amendment procedure merges the BASE branch into the run
// branch, so the base tip is printed as a secondary parent of a merge inside anchor..run — and
// for a run whose amendments have landed, merge-base(base, run) IS that base tip. An index that
// keys every secondary parent therefore keys the ANCHOR, and a task ref parked there gets a
// fork point far behind the anchor, filling its diff with the base branch's own commits. It
// would read as work, its phase would read integrated, `currentPhase` would go null, and
// `runFilesetCheck` would return the vacuous "every phase in the plan is integrated" pass — the
// exact pass the fork-point base exists to stop reaching. `mergedBranchTips` filters its parents
// to the range for this same reason; the index must filter the same way.
//
// Not a constructed shape: `run/followups` itself carries `merge: plan amendment` commits.
test('a task branch parked at the anchor does not read as integrated after a plan amendment (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), planMarkdown(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // Phase 1: real work, merged --no-ff.
    await sh(['checkout', '-b', T1_BRANCH])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', T1_BRANCH])

    // The plan amendment: the base advances and the run branch merges it in, so the base tip
    // is a secondary parent of a merge inside anchor..run, and is itself the anchor.
    await sh(['checkout', 'main'])
    await writeFile(path.join(root, 'amend.txt'), 'amended\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'amend the plan'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'merge: plan amendment', 'main'])

    const anchorSha = (await sh(['merge-base', 'main', 'run'])).stdout.trim()
    assert.equal(anchorSha, (await sh(['rev-parse', 'main'])).stdout.trim(), 'fixture: the anchor is the base tip')

    // Phase 2's ref: created off the base, never committed to.
    await sh(['branch', T2_BRANCH, anchorSha])

    const ctx = await deriveContext({ git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, planPath: 'plan.md' })

    assert.deepEqual(ctx.integratedPhases, [1])
    assert.equal(ctx.currentPhase, 2)
    assert.equal(ctx.phaseError, null)

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch teammates\/r1\/T2 contributes no file changes/)
  })
})

// V5: pinned exactly to the coordinator's literal reported repro (both tasks declaring the
// same file, T1 merging clean first, T2 conflicting second) to settle a reported
// contradiction. Extensive re-testing (this shape, the reverse order, and a variant where
// the seed commit lives only on the run branch) could not reproduce a FAIL — this
// implementation returns PASS for all of them, consistent with the one-sentence rule stated
// above mergeContentExplainedByParents. Pinned here so any future regression is caught, and
// so the exact tested shape is on record.
test('a hand-resolved conflict over the coordinator\'s exact V5 scenario is explained, not flagged (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), [
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
      '- Create: `a.mjs`',
      '',
      '**Depends:** none',
      '',
    ].join('\n'), 'utf8')
    await writeFile(path.join(root, 'a.mjs'), 'line1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'line1 edited by T1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', '-b', 'teammates/r1/T2', 'main'])
    await writeFile(path.join(root, 'a.mjs'), 'line1 edited by T2\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T2 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])
    const conflict = await sh(['merge', '--no-ff', '--no-commit', 'teammates/r1/T2'])
    assert.match(conflict.stdout + conflict.stderr, /[Cc]onflict/, 'expected a real git conflict to set up this test')
    await writeFile(path.join(root, 'a.mjs'), 'line1 edited by T1 and T2\n', 'utf8')
    await sh(['add', 'a.mjs'])
    await sh(['commit', '-m', 'Merge T2'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runOwnershipCheck({ name: 'ownership', kind: 'ownership' }, ctx)

    assert.equal(res.status, 'pass', res.output)
  })
})

// --- runChecks merge preview -----------------------------------------------------------------
//
// The gate's `command` checks are meaningless against any tree but the one integration will
// actually produce, so runChecks builds the phase's merge preview itself and runs the whole
// check list inside it. These tests pin the four outcomes that preview can have — clean,
// conflicted, failed outright, and "no branches to merge" — plus the fact that a manifest can
// neither supply nor suppress the computed `merge` check.

const T2_PHASE1_TASK = { id: 'T2', phase: 1, files: ['b.mjs'] }

// A git double carrying the worktree methods withMergePreview drives. The defaults describe a
// phase whose branches all exist and merge cleanly.
function previewGit(overrides = {}) {
  return fakeGit({
    branchExists: async () => true,
    addWorktreeDetached: async (dir) => dir,
    mergeInto: async () => null,
    removeWorktree: async () => true,
    ...overrides,
  })
}

function previewCtx(overrides = {}) {
  return {
    cwd: '/project/root',
    runId: RUN_ID,
    runBranch: RUN_BRANCH,
    baseBranch: BASE_BRANCH,
    anchorSha: 'anchorSha1',
    runSha: 'runSha1',
    tasks: [T1_TASK],
    currentPhase: 1,
    phaseError: null,
    ...overrides,
  }
}

const recordingExec = (calls, result = { code: 0, output: '' }) => async (cmd, cwd) => {
  calls.push({ cmd, cwd })
  return result
}

test('a command check runs inside the merge preview worktree when the phase merges cleanly', async () => {
  const calls = []
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec(calls) })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)

  assert.deepEqual(results.map((r) => [r.name, r.kind, r.status]), [
    ['merge', 'merge', 'pass'],
    ['test', 'command', 'pass'],
  ])
  assert.equal(calls.length, 1)
  assert.notEqual(calls[0].cwd, '/project/root', 'the command must not run against the project root')
  assert.match(calls[0].cwd, /tm-preview-/)
})

test('the computed merge check can never be marked optional by a manifest', async () => {
  const ctx = previewCtx({ git: previewGit({ mergeInto: async () => ['a.mjs'] }) })
  const results = await runChecks([], ctx)
  assert.equal(results[0].name, 'merge')
  assert.equal(results[0].optional, false)
})

test('a conflicting phase fails the merge check with the pair report and skips every command check', async () => {
  const calls = []
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async () => ['a.mjs', 'b.mjs'] }),
    exec: recordingExec(calls),
    tasks: [T1_TASK, T2_PHASE1_TASK],
  })
  const results = await runChecks([
    { name: 'test', kind: 'command', run: 'npm test' },
    { name: 'lint', kind: 'command', run: 'npm run lint' },
  ], ctx)

  const [merge, ...rest] = results
  assert.equal(merge.name, 'merge')
  assert.equal(merge.status, 'fail')
  assert.deepEqual(merge.pairs, [{ branches: [T1_BRANCH, T2_BRANCH], paths: ['a.mjs', 'b.mjs'] }])
  // The report names both branches and both paths, so the fix loop can escalate to a pair
  // rather than blaming one owner.
  assert.deepEqual(JSON.parse(merge.output), merge.pairs)

  assert.deepEqual(rest.map((r) => r.status), ['skip', 'skip'])
  for (const r of rest) assert.match(r.output, /does not merge cleanly/)
  assert.equal(calls.length, 0, 'no command may run against the unmerged tree')
})

test('a conflicting phase yields FAIL, and the block comes from the merge check itself', async () => {
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async () => ['a.mjs'] }),
    exec: recordingExec([]),
    tasks: [T1_TASK, T2_PHASE1_TASK],
  })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  const verdict = aggregateVerdict(results)
  assert.equal(verdict.verdict, 'FAIL')
  // aggregateVerdict does not block on `skip`; the skipped command checks are reporting only.
  assert.deepEqual(verdict.failed, ['merge'])
  assert.deepEqual(verdict.skipped, ['test'])
})

// withMergePreview rejects when the preview could not be built at all — a merge that failed
// without leaving unmerged paths (unset user.email, a deleted branch, unrelated histories),
// or a worktree that could not be created. That is neither a clean tree nor a reportable
// conflict, so the gate records the merge check as a fail carrying git's reason and skips the
// command checks rather than running them against the unmerged tree.
test('a merge preview that fails outright fails the merge check and skips the command checks', async () => {
  const calls = []
  const ctx = previewCtx({
    // mergeInto reporting a conflict with no paths: withMergePreview throws rather than
    // handing the callback a conflict naming nothing.
    git: previewGit({ mergeInto: async () => [] }),
    exec: recordingExec(calls),
  })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)

  assert.equal(results[0].name, 'merge')
  assert.equal(results[0].status, 'fail')
  assert.match(results[0].output, /merge preview/)
  assert.equal(results[1].status, 'skip')
  assert.equal(calls.length, 0, 'no command may run when the preview could not be built')
  assert.equal(aggregateVerdict(results).verdict, 'FAIL')
})

test('a solo run builds no merge preview and runs command checks against the project root', async () => {
  const calls = []
  // A solo (--no-fleet) ctx carries no git at all; ctx.solo is honoured too, so a caller that
  // says so explicitly is never previewed either.
  for (const ctx of [
    { cwd: '/project/root', exec: recordingExec(calls) },
    { cwd: '/project/root', exec: recordingExec(calls), solo: true, git: previewGit() },
  ]) {
    const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
    assert.deepEqual(results.map((r) => r.name), ['test'])
    assert.equal(results[0].status, 'pass')
  }
  assert.deepEqual(calls.map((c) => c.cwd), ['/project/root', '/project/root'])
})

test('a phase with no task branches passes the merge check and runs commands against the run tree', async () => {
  const calls = []
  const ctx = previewCtx({
    git: previewGit({
      branchExists: async () => false,
      addWorktreeDetached: async () => { throw new Error('no worktree may be created with nothing to merge') },
    }),
    exec: recordingExec(calls),
  })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['merge', 'pass'], ['test', 'pass']])
  assert.deepEqual(calls.map((c) => c.cwd), ['/project/root'])
})

test('a manifest entry claiming kind "merge" finds no runner and lands as pending, blocking the phase', async () => {
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec([]) })
  const results = await runChecks([{ name: 'merge', kind: 'merge' }], ctx)
  // The first result is the gate's own computed merge check; the manifest's entry cannot
  // supply or suppress it, and lands as pending.
  assert.deepEqual(results.map((r) => r.status), ['pass', 'pending'])
  const verdict = aggregateVerdict(results)
  assert.equal(verdict.verdict, 'FAIL')
  assert.deepEqual(verdict.pending, ['merge'])
})

test('a manifest entry claiming kind "merge" cannot mark itself optional to escape blocking', async () => {
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec([]) })
  const results = await runChecks([{ name: 'merge', kind: 'merge', optional: true }], ctx)
  assert.equal(results[1].status, 'pending')
  assert.equal(results[1].optional, false)
  assert.equal(aggregateVerdict(results).verdict, 'FAIL')
})

// The worktree has to outlive the whole check list, not just the merge: if withMergePreview's
// callback returned as soon as the merge was known, the directory would already be gone by the
// time the first command ran.
test('the preview worktree is removed once, after the last check has run inside it', async () => {
  const order = []
  const git = previewGit({
    addWorktreeDetached: async (dir) => {
      await writeFile(path.join(dir, 'marker.txt'), 'inside the preview\n', 'utf8')
      order.push('add')
      return dir
    },
    removeWorktree: async (dir) => { order.push('remove'); assert.match(dir, /tm-preview-/); return true },
  })
  const read = []
  const exec = async (cmd, cwd) => {
    order.push(cmd)
    read.push((await readFile(path.join(cwd, 'marker.txt'), 'utf8')).trim())
    return { code: 0, output: '' }
  }
  const results = await runChecks([
    { name: 'test', kind: 'command', run: 'npm test' },
    { name: 'lint', kind: 'command', run: 'npm run lint' },
  ], previewCtx({ git, exec }))

  assert.deepEqual(results.map((r) => r.status), ['pass', 'pass', 'pass'])
  assert.deepEqual(read, ['inside the preview', 'inside the preview'])
  assert.deepEqual(order, ['add', 'npm test', 'npm run lint', 'remove'])
  assert.equal(order.filter((o) => o === 'remove').length, 1)
})

// The fail-closed clause in aggregateVerdict ("no checks ran, so nothing was verified") has to
// survive the gate prepending its own computed results to the list. An enforced agent that
// empties the working-tree manifest — the very edit that stops `fileset` and `ownership` from
// running — must not turn the phase green just because the gate's own `merge` check is sitting
// in the results array. The regression test for this invariant that calls aggregateVerdict([])
// directly cannot see it: the array is never empty by the time it is aggregated. These go
// through runChecks.
test('a manifest that contributed zero checks fails the phase even though the gate computed a merge result', async () => {
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec([]) })
  const results = await runChecks([], ctx)
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['merge', 'pass']])
  const verdict = aggregateVerdict(results)
  assert.equal(verdict.verdict, 'FAIL', 'a passing self-generated merge is not a verified phase')
})

test('an empty manifest fails the phase on every preview outcome, and matches --no-fleet', async () => {
  const outcomes = {
    clean: previewGit(),
    conflicted: previewGit({ mergeInto: async () => ['a.mjs'] }),
    // mergeInto reporting a conflict with no paths: withMergePreview throws, so this is the
    // preview-could-not-be-built path.
    unbuildable: previewGit({ mergeInto: async () => [] }),
  }
  for (const [name, git] of Object.entries(outcomes)) {
    const results = await runChecks([], previewCtx({ git, exec: recordingExec([]) }))
    assert.equal(aggregateVerdict(results).verdict, 'FAIL', `empty manifest passed on the ${name} preview`)
  }
  // The solo path builds no preview at all and has always failed closed here. The two modes
  // must agree: an empty check list is never a pass.
  assert.equal(aggregateVerdict(await runChecks([], { cwd: '/project/root', solo: true })).verdict, 'FAIL')
})

// The counterpart: one real manifest check is enough to make the list non-empty, so the fix
// above cannot be satisfied by failing every fleet phase.
test('a single passing manifest check still yields PASS alongside the computed merge result', async () => {
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec([]) })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.equal(aggregateVerdict(results).verdict, 'PASS')
})

// The preview must be built from the *run branch*, the tree integration actually merges into,
// not from the base branch. In a two-phase run whose phase 1 is already merged into the run
// branch, a preview built from the base would hand phase 2 a tree with none of phase 1's code
// in it: command checks fail against a tree integration will never produce, and a
// phase-1/phase-2 conflict is blamed on the wrong pair. Nothing else asserts the ref, so
// swapping it stays green.
test('the preview worktree is created from the run branch, not the base branch', async () => {
  const bases = []
  const ctx = previewCtx({
    git: previewGit({ addWorktreeDetached: async (dir, base) => { bases.push(base); return dir } }),
    exec: recordingExec([]),
  })
  await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(bases, [RUN_BRANCH])
  assert.notEqual(bases[0], BASE_BRANCH)
})

// The previewed branch set is the current phase's, resolved exactly the way the fileset check
// resolves it. Without this, a phase-2 teammate pushing a branch while phase 1 is being gated
// gets merged into phase 1's preview, and a conflict or a broken command among branches outside
// the phase fails phase 1 — sending the fix loop at tasks that are not even in it.
test('only the current phase\'s branches are merged into the preview', async () => {
  const merged = []
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async (_dir, branches) => { merged.push(...branches); return null } }),
    exec: recordingExec([]),
    tasks: [T1_TASK, T2_PHASE1_TASK, { id: 'T3', phase: 2, files: ['c.mjs'] }],
  })
  await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(merged, [T1_BRANCH, T2_BRANCH])
  assert.ok(!merged.includes('teammates/r1/T3'), 'a phase-2 branch must not reach a phase-1 preview')
})

// The `previewed` guard exists so a throw raised *after* the callback resolved can never re-run
// checks that already ran. Unreachable with the real accessor — its removeWorktree is async, so
// withMergePreview's `.catch()` swallows it — but reachable with one that throws synchronously,
// which is exactly the shape a future edit could introduce.
test('a throw raised after the checks already ran does not run them a second time', async () => {
  const calls = []
  let branchExistsCalls = 0
  const git = previewGit({
    branchExists: async () => { branchExistsCalls += 1; return true },
    // Synchronous throw: `git.removeWorktree(dir).catch(...)` never gets a promise to catch, so
    // the rejection escapes the `finally` after `run` has already resolved.
    removeWorktree: () => { throw new Error('worktree teardown boom') },
  })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], previewCtx({ git, exec: recordingExec(calls) }))

  assert.equal(branchExistsCalls, 1, 'the branch set must not be reassembled for a second run')
  assert.equal(calls.length, 1, 'the command check must not execute twice')
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['merge', 'fail'], ['test', 'fail']])
  assert.match(results[0].output, /worktree teardown boom/)
  assert.equal(aggregateVerdict(results).verdict, 'FAIL')
})

test('a branch lookup that throws while assembling the preview fails the merge check, not the run', async () => {
  const calls = []
  const ctx = previewCtx({
    git: previewGit({ branchExists: async () => { throw new Error('branch lookup boom') } }),
    exec: recordingExec(calls),
  })
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.equal(results[0].name, 'merge')
  assert.equal(results[0].status, 'fail')
  assert.match(results[0].output, /branch lookup boom/)
  assert.equal(results[1].status, 'skip')
  assert.equal(calls.length, 0)
})

// --- ctx.taskScope: narrowing a `complete` invocation to one task --------------------------
//
// `complete` verifies the calling task, not the whole phase, so `cli.mjs` marks its context
// with `taskScope: <task id>`. `gate` never sets it. Two places in this file honour the marker
// — the previewed branch set and the fileset check's phase-task list — while `runOwnershipCheck`
// deliberately does not, which is the whole reason the narrowing travels as a marker rather
// than as a pre-filtered `ctx.tasks`: ownership must keep explaining *every* commit on the run
// branch, and a filtered task list would silently hide a direct write riding in behind
// whichever task happens to finish first.
//
// These tests drive `runChecks` / `runFilesetCheck` / `runOwnershipCheck` directly, so they pin
// this file's half of the contract whether or not the `cli.mjs` half has landed yet.

const T3_PHASE2_TASK = { id: 'T3', phase: 2, files: ['c.mjs'] }
const T3_BRANCH = 'teammates/r1/T3'

// The finding this closes: with the phase-wide branch set, the first teammate of a 3-task phase
// to run `complete` gets every sibling's branch merged into its preview. A sibling's stray
// commit — or a sibling branch that does not exist yet — fails the preview, and the teammate
// reads it as "my own work is broken".
test('with taskScope set, only that task\'s branch is merged into the preview', async () => {
  const merged = []
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async (_dir, branches) => { merged.push(...branches); return null } }),
    exec: recordingExec([]),
    tasks: [T1_TASK, T2_PHASE1_TASK],
    taskScope: 'T2',
  })
  await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(merged, [T2_BRANCH])
  assert.ok(!merged.includes(T1_BRANCH), 'a sibling\'s branch must not reach a task-scoped preview')
})

// The paired half, and the property most worth pinning: absent the marker — every `gate`
// invocation — the previewed set is byte-for-byte the phase-wide set it has always been.
test('with taskScope absent, the previewed branch set is the whole phase, unchanged', async () => {
  const merged = []
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async (_dir, branches) => { merged.push(...branches); return null } }),
    exec: recordingExec([]),
    tasks: [T1_TASK, T2_PHASE1_TASK, T3_PHASE2_TASK],
  })
  assert.equal(ctx.taskScope, undefined)
  await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(merged, [T1_BRANCH, T2_BRANCH])
})

// A taskScope that names nothing in the current phase narrows to zero tasks, which the existing
// "selected no tasks" guard turns into a fail. Fail-closed, not a vacuous pass.
test('a taskScope naming no task in the current phase previews nothing and does not pass vacuously', async () => {
  const merged = []
  const ctx = previewCtx({
    git: previewGit({ mergeInto: async (_dir, branches) => { merged.push(...branches); return null } }),
    exec: recordingExec([]),
    tasks: [T1_TASK, T3_PHASE2_TASK],
    taskScope: 'T3',
  })
  const results = await runChecks([{ name: 'fileset', kind: 'fileset' }], ctx)
  assert.deepEqual(merged, [])
  assert.equal(results.find((r) => r.name === 'fileset').status, 'fail')
  assert.equal(aggregateVerdict(results).verdict, 'FAIL')
})

const scopedFilesetGit = () => fakeGit({
  branchExists: async () => true,
  // T2's branch carries a path outside its declared set; T1's is clean.
  changedFiles: async ({ branch }) => (branch.includes('T2') ? ['b.mjs', 'stray.mjs'] : ['a.mjs']),
})

test('with taskScope set, runFilesetCheck considers only that task', async () => {
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git: scopedFilesetGit(), runId: RUN_ID, anchorSha: 'anchorSha1', runSha: 'runSha1',
    tasks: [T1_TASK, T2_PHASE1_TASK], currentPhase: 1, phaseError: null, taskScope: 'T1',
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass', 'a sibling\'s violation must not fail the scoped task')
  assert.deepEqual(res.branchShas, { [T1_BRANCH]: `refs/heads/${T1_BRANCH}-sha` })
})

// The same context without the marker: the sibling's violation is exactly as fatal as it is
// today. Together with the test above this pins that the narrowing is the marker's doing and
// nothing else.
test('with taskScope absent, runFilesetCheck still walks every task in the phase', async () => {
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git: scopedFilesetGit(), runId: RUN_ID, anchorSha: 'anchorSha1', runSha: 'runSha1',
    tasks: [T1_TASK, T2_PHASE1_TASK], currentPhase: 1, phaseError: null,
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'fail')
  assert.match(res.output, /T2: outside declared set/)
  assert.deepEqual(res.branchShas, {
    [T1_BRANCH]: `refs/heads/${T1_BRANCH}-sha`,
    [T2_BRANCH]: `refs/heads/${T2_BRANCH}-sha`,
  })
})

// The all-integrated short-circuit records branch shas for verdictCoversTree rather than
// diffing. A task-scoped verdict must not claim to cover a sibling's branch either: recording
// one would let a sibling moving its branch invalidate this task's verdict.
test('with taskScope set, the all-integrated path records only that task\'s branch sha', async () => {
  const git = fakeGit({ branchExists: async () => true })
  const check = { name: 'fileset', kind: 'fileset' }
  const ctx = {
    git, runId: RUN_ID, anchorSha: 'anchorSha1', tasks: [T1_TASK, T2_PHASE1_TASK],
    currentPhase: null, phaseError: null, taskScope: 'T2',
  }
  const res = await runFilesetCheck(check, ctx)
  assert.equal(res.status, 'pass')
  assert.deepEqual(res.branchShas, { [T2_BRANCH]: `refs/heads/${T2_BRANCH}-sha` })
})

// Ownership is the one that must NOT narrow. A commit explained only by a *sibling's* branch
// stays explained under taskScope; if the marker leaked into runOwnershipCheck, that commit
// would read as unexplained and the scoped teammate would be blocked by work it does not own —
// and the same leak is what would let a direct write hide behind whichever task ran first.
test('with taskScope set, runOwnershipCheck still sees every task in the run', async () => {
  const git = fakeGit({
    branchExists: async () => true,
    commitsBetween: async () => ['c1'],
    isAncestor: async (a, b) => a === 'c1' && b === `refs/heads/${T2_BRANCH}-sha`,
  })
  const check = { name: 'ownership', kind: 'ownership' }
  const ctx = {
    git, runId: RUN_ID, runBranch: RUN_BRANCH, anchorSha: 'anchorSha1', runSha: 'runSha1',
    tasks: [T1_TASK, T2_PHASE1_TASK, T3_PHASE2_TASK], taskScope: 'T1',
  }
  const res = await runOwnershipCheck(check, ctx)
  assert.equal(res.status, 'pass')
  // Every task branch in the run was resolved, not just the scoped one — including a task from
  // another phase, since ownership is run-wide and not phase-wide either.
  for (const branch of [T1_BRANCH, T2_BRANCH, T3_BRANCH]) {
    assert.ok(git.resolveRefCalls.includes(`refs/heads/${branch}`), `${branch} must still be consulted`)
  }
})

// --- ctx.previewLink: declared preview.link entries reaching withMergePreview --------------
//
// previewLinks(config) (gate-config.mjs) has to actually reach withMergePreview for the
// feature to do anything. runChecks is the wiring point: it must pass ctx.previewLink through
// as `link`, and ctx.cwd through as `repoRoot`, on every call — real linking, driven through
// the real withMergePreview/linkInto, not a git double, since the double covers only the
// worktree operations withMergePreview needs, and linking is real filesystem work.

async function withLinkableRepoRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-gate-runner-link-'))
  try {
    const deps = path.join(root, 'deps')
    await mkdir(deps, { recursive: true })
    await writeFile(path.join(deps, 'marker.txt'), 'linked build input\n', 'utf8')
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('ctx.previewLink reaches withMergePreview and is linked into the preview tree', async () => {
  await withLinkableRepoRoot(async (root) => {
    const seen = []
    const ctx = previewCtx({
      cwd: root,
      previewLink: ['deps'],
      git: previewGit(),
      exec: async (cmd, cwd) => {
        seen.push(await readFile(path.join(cwd, 'deps', 'marker.txt'), 'utf8'))
        return { code: 0, output: '' }
      },
    })
    const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
    assert.deepEqual(results.map((r) => r.status), ['pass', 'pass'])
    assert.deepEqual(seen, ['linked build input\n'])
  })
})

test('a link failure records the merge check as fail with the link message and skips command checks', async () => {
  await withLinkableRepoRoot(async (root) => {
    const calls = []
    const ctx = previewCtx({
      cwd: root,
      // 'absent' does not exist under root: linkInto fails with an ENOENT-shaped message
      // before the callback (and so the command check) ever runs.
      previewLink: ['absent'],
      git: previewGit(),
      exec: recordingExec(calls),
    })
    const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
    assert.equal(results[0].name, 'merge')
    assert.equal(results[0].status, 'fail')
    assert.match(results[0].output, /preview link 'absent' failed/)
    assert.equal(results[1].status, 'skip')
    assert.equal(calls.length, 0, 'no command may run when linking failed')
    assert.equal(aggregateVerdict(results).verdict, 'FAIL')
  })
})

test('with ctx.previewLink absent, the preview receives no links and behaves exactly as before', async () => {
  const calls = []
  // cwd is not a real directory: with no link entries, repoRoot is passed through but never
  // consulted, so this must behave identically to every preview test above that predates
  // ctx.previewLink.
  const ctx = previewCtx({ git: previewGit(), exec: recordingExec(calls) })
  assert.equal(ctx.previewLink, undefined)
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['merge', 'pass'], ['test', 'pass']])
  // The one property "identical to today" most needs: the command still runs inside the
  // preview worktree, not at ctx.cwd, exactly as it did before ctx.previewLink existed.
  assert.equal(calls.length, 1)
  assert.match(calls[0].cwd, /tm-preview-/)
})

test('a solo run builds no preview and consults no links even when ctx.previewLink is set', async () => {
  const calls = []
  const ctx = {
    cwd: '/project/root',
    exec: recordingExec(calls),
    solo: true,
    previewLink: ['deps'],
    git: previewGit(),
  }
  const results = await runChecks([{ name: 'test', kind: 'command', run: 'npm test' }], ctx)
  assert.deepEqual(results.map((r) => [r.name, r.status]), [['test', 'pass']])
  assert.deepEqual(calls.map((c) => c.cwd), ['/project/root'])
})

// --- ownWorkBase: the run-tip position, closed by scarcity (real repo) -----------------------
//
// Was a LIMIT: the gate FAILed a genuinely, fully landed task because a ref at the run tip is not
// a key in `mergedParentFiles`'s index. `creditRunTipTasks` matches such a ref to a merged parent
// that carried its whole declared set and that no other task ref already points at. This is the
// exact construction the LIMIT used to pin, with the assertions inverted — the shape was not
// changed to make it pass.
test('ownWorkBase: a fix round re-pointing an already-integrated branch at the run tip reads as landed (real repo)', async () => {
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
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])

    // The brief's own recommended fix-round step: `git checkout -B teammates/r1/T1 run`. T1's
    // work is already, genuinely, on the run branch — this only moves where the CONVENTIONAL
    // REF points, at a commit that is already the run tip. Nothing else claims T1's merge, so
    // the parent is free and T1 matches it.
    await sh(['branch', '-f', 'teammates/r1/T1', 'run'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    assert.deepEqual(ctx.integratedPhases, [1])

    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'pass')
  })
})

// The regression guard, and the reason `creditRunTipTasks` matches instead of testing
// containment. A closure that asked only "did some merged parent carry this task's whole declared
// set" (`f6e2191`, reverted by `227abf2`) passed this: T1's merge carried a SUPERSET of T2's
// declared set, which a phase-2 task that only MODIFIES a file phase 1 created has by
// construction. T1's own ref still points at that parent, so it is spent and T2 matches nothing.
// If this test ever goes green on a PASS, the enforcing check has been traded away again.
test('a run-tip ref is NOT credited with a merge another task ref still points at (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), overlappingTwoPhasePlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // T1 declares and lands BOTH files; T2 declares only `a.mjs` and never writes anything.
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await writeFile(path.join(root, 'b.mjs'), 'export const b = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])

    await sh(['branch', '-f', 'teammates/r1/T2', 'run'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    assert.equal(ctx.currentPhase, 2)
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch teammates\/r1\/T2 contributes no file changes past its fork point/)
  })
})

// Scarcity is a cap, not a per-ref test: two refs both re-pointed to the run tip cannot both be
// credited with the one merge between them, so one is always left over and its phase does not
// read as integrated.
test('two refs at the run tip cannot both be credited with a single merged parent (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), twoPhaseBothFilesPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await writeFile(path.join(root, 'b.mjs'), 'export const b = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])

    await sh(['branch', '-f', 'teammates/r1/T1', 'run'])
    await sh(['branch', '-f', 'teammates/r1/T2', 'run'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
  })
})

// --- the spare parent, closed (real repo) ----------------------------------------------------
//
// Was a LIMIT. Two merges crediting the SAME task — an initial integration plus a fix round's own
// merge — put two parents in the index while only one ref points AT one of them, and the leftover
// was matchable by a run-tip ref whose declared set it contained in full. `spentParents` closes it
// by spending a parent that is an ANCESTOR of a task ref whose declared set the parent's carried
// files intersect, not only one a ref points directly at. Same construction the LIMIT pinned, with
// the assertion inverted.
test('the spare parent of a task merged twice is spent, not matchable by a run-tip ref (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), overlappingTwoPhasePlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    // T1 lands `a.mjs`, then a fix round lands a second merge also touching `a.mjs`. Two parents
    // now carry T1's file; T1's ref can only point at one of them.
    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])
    await sh(['checkout', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 2\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 fix round'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1 again', 'teammates/r1/T1'])

    // T2 declares `a.mjs`, writes nothing, parks at the run tip. Both parents carry `a.mjs` and
    // both are ancestors of T1's ref, so neither is free.
    await sh(['branch', '-f', 'teammates/r1/T2', 'run'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'fail')
    assert.match(res.output, /T2: branch teammates\/r1\/T2 contributes no file changes past its fork point/)
  })
})

// The direction spending must NOT break, and the reason `spentParents` requires the carried files
// to intersect the ref's OWN declared set rather than spending on ancestry alone. A phase-2 task
// legitimately forks from the run tip after phase 1 was merged, so phase 1's merged parent is an
// ancestor of the phase-2 ref. On ancestry alone that parent reads as spent by a task that never
// earned it, and a fix round re-pointing phase 1's own ref at the run tip fails a genuinely landed
// task — the exact false FAIL this whole mechanism exists to remove. Measured, not reasoned about:
// deleting the intersection guard turns this test red.
test('a later sibling does not spend the merged parent of an earlier task it never earned (real repo)', async () => {
  await withRepo(async ({ root, sh, git }) => {
    await writeFile(path.join(root, 'plan.md'), twoPhaseBothFilesPlan(), 'utf8')
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])

    await sh(['checkout', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T1 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])

    // T2 forks AFTER T1's merge, so T1's merged parent is an ancestor of T2's tip.
    await sh(['checkout', '-b', 'teammates/r1/T2', 'run'])
    await writeFile(path.join(root, 'b.mjs'), 'export const b = 1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'T2 work'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'Merge T2', 'teammates/r1/T2'])

    // T1's fix round finds nothing to change and leaves its ref at the run tip.
    await sh(['branch', '-f', 'teammates/r1/T1', 'run'])

    const ctx = await deriveContext({ git, runId: 'r1', runBranch: 'run', baseBranch: 'main', planPath: 'plan.md' })
    const res = await runFilesetCheck({ name: 'fileset', kind: 'fileset' }, ctx)
    assert.equal(res.status, 'pass')
  })
})

test('creditRunTipTasks matches on containment, spends each parent once, and never credits an empty declared set', () => {
  const mergedFiles = new Map([
    ['P1', new Set(['a.mjs', 'b.mjs'])],
    ['P2', new Set(['c.mjs'])],
  ])
  const runSha = 'RUNTIP'

  // A parent no ref points at, containing the whole declared set: credited.
  assert.deepEqual(
    [...creditRunTipTasks({
      tasks: [{ id: 'T1', files: ['a.mjs'] }],
      shaByTask: new Map([['T1', runSha]]),
      runSha, mergedFiles,
    })],
    ['T1'],
  )

  // The same parent, but another task's ref points AT it: spent, so nothing is credited.
  assert.deepEqual(
    [...creditRunTipTasks({
      tasks: [{ id: 'T1', files: ['a.mjs', 'b.mjs'] }, { id: 'T2', files: ['a.mjs'] }],
      shaByTask: new Map([['T1', 'P1'], ['T2', runSha]]),
      runSha, mergedFiles,
    })],
    [],
  )

  // Two run-tip tasks, one eligible parent: exactly one is credited, never both.
  assert.equal(
    creditRunTipTasks({
      tasks: [{ id: 'T1', files: ['a.mjs'] }, { id: 'T2', files: ['b.mjs'] }],
      shaByTask: new Map([['T1', runSha], ['T2', runSha]]),
      runSha, mergedFiles,
    }).size,
    1,
  )

  // Augmenting, not greedy: T1 can only use P1, T2 can use either. T1 must not be starved by T2
  // taking P1 first.
  assert.equal(
    creditRunTipTasks({
      tasks: [{ id: 'T2', files: [] }, { id: 'T1', files: ['a.mjs'] }],
      shaByTask: new Map([['T1', runSha], ['T2', runSha]]),
      runSha, mergedFiles,
    }).has('T1'),
    true,
  )

  // Partial containment is not containment.
  assert.deepEqual(
    [...creditRunTipTasks({
      tasks: [{ id: 'T1', files: ['a.mjs', 'c.mjs'] }],
      shaByTask: new Map([['T1', runSha]]),
      runSha, mergedFiles,
    })],
    [],
  )

  // An empty declared set is contained in every parent and must still be credited by none.
  assert.deepEqual(
    [...creditRunTipTasks({
      tasks: [{ id: 'T1', files: [] }],
      shaByTask: new Map([['T1', runSha]]),
      runSha, mergedFiles,
    })],
    [],
  )
})
