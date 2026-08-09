import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectDoctorReport, renderDoctor } from '../scripts/doctor.mjs'

const RUN_ID = 'r1'
const RUN_BRANCH = 'run/r1'
const BASE_BRANCH = 'master'
const T1 = { id: 'T1', phase: 1, files: ['a.mjs'] }
const T2 = { id: 'T2', phase: 1, files: ['b.mjs'] }

// Everything the report says comes from git, never from `.teammates/` — the same rule the
// enforcement checks follow, and the reason this is worth running at all: `digest` renders
// status.json, which the agents being diagnosed write.
function fakeGit(overrides = {}) {
  const defaults = {
    currentBranch: async () => RUN_BRANCH,
    dirtyPaths: async () => [],
    worktrees: async () => [{ path: '/repo', head: 'aaa', branch: RUN_BRANCH, detached: false }],
    branchExists: async () => true,
    resolveRef: async (ref) => `${ref}-sha`,
    mergeBase: async () => 'fork-sha',
    changedFiles: async () => ['a.mjs'],
    commitSubject: async () => 'abc1234 did the work',
    isAncestor: async () => false,
  }
  return { ...defaults, ...overrides }
}

test('a healthy run reports every task as contributing and finds no problems', async () => {
  const report = await collectDoctorReport({
    git: fakeGit(), runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
  })
  assert.equal(report.problems.length, 0)
  assert.equal(report.tasks[0].branch, 'teammates/r1/T1')
  assert.equal(report.tasks[0].exists, true)
  assert.deepEqual(report.tasks[0].changed, ['a.mjs'])
})

// The stale-base incident: the branch exists and points somewhere real, but contributes nothing
// from its own fork point, so the task would merge as a no-op while its result says done.
test('a task branch with no contribution is reported as a problem naming the task', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({ changedFiles: async () => [] }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
  })
  assert.equal(report.tasks[0].changed.length, 0)
  assert.equal(report.problems.length, 1)
  assert.match(report.problems[0], /T1/)
  assert.match(report.problems[0], /no file changes/i)
})

test('a missing task branch is reported without failing the whole report', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({ branchExists: async (name) => name !== 'teammates/r1/T2' }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1, T2],
  })
  assert.equal(report.tasks[1].exists, false)
  assert.equal(report.tasks.length, 2)
  assert.match(report.problems.join('\n'), /T2/)
})

// The side door the ownership check now fails on, surfaced before the gate runs rather than as
// a phase verdict after the fact.
test('a task branch on the base but not the run branch is reported as a side door', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({ isAncestor: async (_sha, target) => target === `refs/heads/${BASE_BRANCH}-sha` }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
  })
  assert.equal(report.tasks[0].sideDoor, true)
  assert.match(report.problems.join('\n'), /base branch/i)
})

test('the main worktree sitting off the run branch is a problem', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({ currentBranch: async () => 'master' }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
  })
  assert.equal(report.mainBranch, 'master')
  assert.match(report.problems.join('\n'), /main worktree/i)
})

test('dirty paths in the main worktree are listed, not just counted', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({ dirtyPaths: async () => [{ status: '??', path: 'stray.txt' }] }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
  })
  assert.match(report.problems.join('\n'), /stray\.txt/)
})

// A teammate's commit landing on the harness's own branch is what left a conventional task ref
// empty. The worktree listing is where that is visible before anyone reads a diff.
test('a worktree holding a harness agent branch is reported', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({
      worktrees: async () => [
        { path: '/repo', head: 'aaa', branch: RUN_BRANCH, detached: false },
        { path: '/repo/.claude/worktrees/a1', head: 'bbb', branch: 'worktree-agent-9', detached: false },
      ],
    }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
  })
  assert.equal(report.worktrees.length, 2)
  assert.match(report.problems.join('\n'), /worktree-agent-9/)
})

// A reviewer's scratch worktree inside the repository failed `ownership` for a whole run.
test('a worktree inside the repository that is not the harness directory is reported', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({
      repoRoot: '/repo',
      worktrees: async () => [
        { path: '/repo', head: 'aaa', branch: RUN_BRANCH, detached: false },
        { path: '/repo/scratch-review', head: 'ccc', branch: 'review-tmp', detached: false },
      ],
    }),
    repoRoot: '/repo',
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
  })
  assert.match(report.problems.join('\n'), /scratch-review/)
})

test('renderDoctor prints every task line and ends with the problem count', () => {
  const out = renderDoctor({
    runId: RUN_ID,
    runBranch: RUN_BRANCH,
    baseBranch: BASE_BRANCH,
    mainBranch: RUN_BRANCH,
    dirty: [],
    worktrees: [{ path: '/repo', branch: RUN_BRANCH, detached: false }],
    tasks: [
      { id: 'T1', branch: 'teammates/r1/T1', exists: true, tip: 'abc1234 work', changed: ['a.mjs'], sideDoor: false },
      { id: 'T2', branch: 'teammates/r1/T2', exists: false, tip: null, changed: [], sideDoor: false },
    ],
    problems: ['T2: branch teammates/r1/T2 does not exist'],
  })
  assert.match(out, /T1/)
  assert.match(out, /abc1234/)
  assert.match(out, /T2/)
  assert.match(out, /1 problem/)
})

test('renderDoctor says so plainly when nothing is wrong', () => {
  const out = renderDoctor({
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, mainBranch: RUN_BRANCH,
    dirty: [], worktrees: [], tasks: [], problems: [],
  })
  assert.match(out, /no problems/i)
})

test('a branch that landed on the run branch is reported integrated, not as contributing nothing', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({
      changedFiles: async () => [],
      // On the run branch and past the anchor: landed.
      isAncestor: async (_sha, target) => target === 'runSha1',
    }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
    runSha: 'runSha1', anchorSha: 'anchorSha1',
  })
  assert.equal(report.tasks[0].landed, true)
  assert.deepEqual(report.problems, [])
})

// The distinction the landed test exists for: a branch sitting AT the anchor is an ancestor of
// the run branch too, and it is exactly the stale-base shape.
test('a branch parked at the anchor is still reported as contributing nothing', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({ changedFiles: async () => [], isAncestor: async () => true }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
    runSha: 'runSha1', anchorSha: 'anchorSha1',
  })
  assert.equal(report.tasks[0].landed, false)
  assert.match(report.problems.join('\n'), /no file changes/)
})

// From phase 2 onward the run tip is past the anchor, so a branch parked at the tip satisfies
// both halves of the landed test while carrying no work of its own. This is the shape the
// emptiness complaint exists for, and it must not read as integrated.
test('a branch parked at the current run tip is not landed', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({
      changedFiles: async () => [],
      // Ancestor of the run tip, not of the anchor: the run-tip-parked shape.
      isAncestor: async (_sha, target) => target === 'runSha1',
      resolveRef: async () => 'runSha1',
    }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
    runSha: 'runSha1', anchorSha: 'anchorSha1',
  })
  assert.equal(report.tasks[0].landed, false)
  assert.match(report.problems.join('\n'), /no file changes/)
})

test('renderDoctor prints integrated rather than NO CHANGES for a landed task', () => {
  const out = renderDoctor({
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, mainBranch: RUN_BRANCH,
    dirty: [], worktrees: [],
    tasks: [{ id: 'T1', branch: 'teammates/r1/T1', exists: true, tip: 'abc work', changed: [], sideDoor: false, landed: true }],
    problems: [],
  })
  assert.match(out, /integrated/)
  assert.doesNotMatch(out, /NO CHANGES/)
})
