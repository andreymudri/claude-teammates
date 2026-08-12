import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { collectDoctorReport, renderDoctor } from '../scripts/doctor.mjs'
import { GitError, createGit, defaultGitExec } from '../scripts/git.mjs'

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
    // `collectDoctorReport` no longer asks git for merged-branch-tip MEMBERSHIP — it asks the
    // same declared-files question `runFilesetCheck` asks, via `mergedParentFiles` /
    // `landedForFiles` imported from `scripts/gate-runner.mjs`. That walk is built from
    // `commitsBetween` / `commitParents` / `changedFiles`, not a single `mergedBranchTips` call,
    // so a doctor test that wants a task to read `landed: true` has to shape those three the
    // same way `mergedParentFiles` itself reads them; a test that doesn't care leaves them at
    // these no-op defaults and nothing calls them without both `anchorSha` and `runSha`.
    commitsBetween: async () => [],
    commitParents: async () => [],
  }
  return { ...defaults, ...overrides }
}

// The tip the default resolveRef gives T1's branch, which is what a merge of T1 would name as
// its secondary parent.
const T1_TIP = 'refs/heads/teammates/r1/T1-sha'

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

// `mergedParentFiles` reads a merge commit's OWN diff against its OWN first parent, keyed by
// its secondary parent. Shaped here exactly as the real walk would see it: `runSha1` is the
// merge commit that landed T1, its first parent is some prior tip, its second parent is T1's
// own branch tip, and that merge's diff against its first parent is `a.mjs` — T1's declared
// file. `landedForFiles` then reads T1's branch as landed.
test('a branch that landed on the run branch is reported integrated, not as contributing nothing', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({
      changedFiles: async ({ base, branch }) => (base === 'priorSha' && branch === T1_TIP ? ['a.mjs'] : []),
      commitsBetween: async () => ['runSha1', T1_TIP],
      commitParents: async (sha) => (sha === 'runSha1' ? ['priorSha', T1_TIP] : []),
      isAncestor: async (_sha, target) => target === 'runSha1',
    }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
    runSha: 'runSha1', anchorSha: 'anchorSha1',
  })
  assert.equal(report.tasks[0].landed, true)
  assert.deepEqual(report.problems, [])
})

// The distinction the landed test exists for: a branch sitting AT the anchor is an ancestor of
// the run branch too, and it is exactly the stale-base shape. No merge names it, so
// `landedForFiles` reads false without needing a special case.
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
// both halves of the old ancestry-only test while carrying no work of its own. This is the
// shape the emptiness complaint exists for, and it must not read as integrated: nothing merges
// this sha, so `mergedFiles` never indexes it.
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

// The case neither ancestry exclusion could see. The integrator merged a sibling after this
// branch was created, so the run tip moved past the commit the branch is parked at: it is past
// the anchor, it is not the tip, and it carries nothing. The sibling's merge names a DIFFERENT
// sha as its secondary parent, so this task's own sha is never indexed and reads not landed.
test('a branch parked at an intermediate post-anchor commit is not landed', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({
      changedFiles: async () => [],
      resolveRef: async (ref) => (ref === `refs/heads/${RUN_BRANCH}` ? 'runSha2' : 'midSha'),
      // Past the anchor and on the run branch, but not its tip.
      isAncestor: async (_sha, target) => target === 'runSha2',
      commitsBetween: async () => ['runSha2', 'someOtherBranchTip'],
      commitParents: async (sha) => (sha === 'runSha2' ? ['priorSha', 'someOtherBranchTip'] : []),
    }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
    runSha: 'runSha2', anchorSha: 'anchorSha1',
  })
  assert.equal(report.tasks[0].landed, false)
  assert.match(report.problems.join('\n'), /no file changes/)
})

test('a caller may supply the merged-files index as data, and then no git walk is made for it', async () => {
  const git = fakeGit({
    changedFiles: async () => [],
    commitsBetween: async () => { throw new Error('must not be called when the caller supplies the index') },
  })
  const report = await collectDoctorReport({
    git, runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
    runSha: 'runSha1', anchorSha: 'anchorSha1', mergedFiles: new Map([[T1_TIP, new Set(['a.mjs'])]]),
  })
  assert.equal(report.tasks[0].landed, true)
  assert.deepEqual(report.problems, [])
})

// One merge-history walk for the whole run. Asking per task turns a report over ten tasks into
// ten walks.
test('the merged-files index is computed once per report, not once per task', async () => {
  let calls = 0
  const report = await collectDoctorReport({
    git: fakeGit({
      changedFiles: async () => [],
      commitsBetween: async () => { calls += 1; return [] },
    }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1, T2],
    runSha: 'runSha1', anchorSha: 'anchorSha1',
  })
  assert.equal(calls, 1)
  assert.equal(report.tasks.length, 2)
})

// An un-wired caller supplies no anchor. It must keep getting the old behaviour rather than a
// walk against a missing bound.
test('with no anchorSha nothing is landed and the merged-files walk is never run', async () => {
  let calls = 0
  const report = await collectDoctorReport({
    git: fakeGit({
      changedFiles: async () => ['a.mjs'],
      commitsBetween: async () => { calls += 1; return ['runSha1', T1_TIP] },
    }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
    runSha: 'runSha1',
  })
  assert.equal(calls, 0)
  assert.equal(report.tasks[0].landed, false)
})

// A failed walk is a GitError like any other: it becomes a reported problem, not a crash, and
// not a silent "nothing landed" that would turn every integrated task into a false complaint.
test('a failing merged-files walk is reported as a problem rather than thrown', async () => {
  const report = await collectDoctorReport({
    git: fakeGit({
      changedFiles: async () => [],
      commitsBetween: async () => { throw new GitError('bad revision anchorSha1..runSha1') },
    }),
    runId: RUN_ID, runBranch: RUN_BRANCH, baseBranch: BASE_BRANCH, tasks: [T1],
    runSha: 'runSha1', anchorSha: 'anchorSha1',
  })
  assert.match(report.problems.join('\n'), /bad revision/)
})

// Against real git rather than a fake, because the defect this pins lives in what real rev-list
// output CONTAINS: a plan amendment merges the base into the run branch, so the base tip is a
// secondary parent of a merge inside the range, and for a run whose amendments have landed the
// anchor IS that base tip. A branch parked at the anchor must still be reported as contributing
// nothing — the counterpart of the same fixture in tests/gate-runner.test.mjs, kept in step
// because both files now import the SAME `mergedParentFiles` / `landedForFiles` from
// scripts/gate-runner.mjs rather than computing this twice.
test('a branch parked at the anchor is reported as a problem after a plan amendment (real repo)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-doctor-'))
  const sh = (args) => defaultGitExec(args, root)
  try {
    await sh(['init', '--initial-branch=main'])
    await sh(['config', 'user.email', 'test@example.com'])
    await sh(['config', 'user.name', 'test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'base'])
    await sh(['checkout', '-b', 'run'])
    await writeFile(path.join(root, 'run.txt'), 'r1\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'r1'])
    await sh(['checkout', 'main'])
    await writeFile(path.join(root, 'plan.md'), 'amended\n', 'utf8')
    await sh(['add', '.'])
    await sh(['commit', '-m', 'amend the plan'])
    await sh(['checkout', 'run'])
    await sh(['merge', '--no-ff', '-m', 'merge: plan amendment', 'main'])

    const anchorSha = (await sh(['merge-base', 'main', 'run'])).stdout.trim()
    const runSha = (await sh(['rev-parse', 'run'])).stdout.trim()
    await sh(['branch', 'teammates/r1/T14', anchorSha])

    const report = await collectDoctorReport({
      git: createGit({ cwd: root }),
      runId: RUN_ID, runBranch: 'run', baseBranch: 'main',
      tasks: [{ id: 'T14', phase: 1, files: ['a.mjs'] }],
      anchorSha, runSha,
    })

    assert.equal(report.tasks[0].landed, false)
    assert.equal(report.problems.length, 1)
    assert.match(report.problems[0], /T14: branch teammates\/r1\/T14 has no file changes/)
    assert.doesNotMatch(report.problems[0], /could not determine which branches/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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

// ============================================================================================
// Step 4 — gate and doctor AGREE on the parked-at-a-merged-sibling fixture.
//
// `tests/adversarial.test.mjs` builds this same shape ('gate fails when a task ref is parked at
// a merged SIBLING's tip') to pin the gate's own verdict; it is not this task's file to edit, so
// the fixture is rebuilt here, against a real repository, to pin that `doctor` now agrees with
// that verdict instead of contradicting it. Before this task, `doctor` used bare sha membership
// in `mergedBranchTips` — true for T2's sha here, since T3's merge genuinely names it as a
// secondary parent — so it reported `landed: true` with no problem while the gate FAILed the
// same task. Both now read the same `mergedParentFiles` / `landedForFiles` index, so they must
// agree.
// ============================================================================================

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }) }

test('doctor agrees with the gate on a task ref parked at a merged sibling tip (real repo)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-doctor-sibling-'))
  try {
    git(root, ['init', '--quiet', '--initial-branch=main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    await writeFile(path.join(root, 'base.txt'), 'base\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'base'])
    git(root, ['checkout', '--quiet', '-b', 'run-branch'])

    // T1 (phase 1), merged cleanly.
    git(root, ['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'x\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'T1 work'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T1', 'teammates/r1/T1'])

    // T3 (phase 2 sibling of T2), merged cleanly, carrying c.mjs only.
    git(root, ['checkout', '--quiet', '-b', 'teammates/r1/T3'])
    await writeFile(path.join(root, 'c.mjs'), 'x\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'T3 work'])
    const t3Tip = git(root, ['rev-parse', 'teammates/r1/T3']).trim()
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'Merge T3', 'teammates/r1/T3'])

    // T2 never commits its own work: its ref is pointed straight at T3's own tip commit,
    // never at the merge commit that carried T3's file.
    git(root, ['branch', 'teammates/r1/T2', t3Tip])

    const anchorSha = git(root, ['rev-parse', 'HEAD~2']).trim()
    const runSha = git(root, ['rev-parse', 'run-branch']).trim()
    const gitLib = createGit({ cwd: root })

    const report = await collectDoctorReport({
      git: gitLib,
      runId: 'r1', runBranch: 'run-branch', baseBranch: 'main',
      tasks: [
        { id: 'T1', phase: 1, files: ['a.mjs'] },
        { id: 'T2', phase: 2, files: ['b.mjs'] },
        { id: 'T3', phase: 2, files: ['c.mjs'] },
      ],
      anchorSha, runSha,
    })

    const t1 = report.tasks.find((t) => t.id === 'T1')
    const t2 = report.tasks.find((t) => t.id === 'T2')
    const t3 = report.tasks.find((t) => t.id === 'T3')

    // T1 and T3 both genuinely landed — the merges that carried them named their own declared
    // files.
    assert.equal(t1.landed, true)
    assert.equal(t3.landed, true)
    // T2 is the parked ref: same shape the gate fails on. `doctor` must call it not-landed and
    // name it as a problem, agreeing with the gate rather than contradicting it.
    assert.equal(t2.landed, false)
    assert.match(report.problems.join('\n'), /T2: branch teammates\/r1\/T2 has no file changes/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// A teammate writes its own commit subjects and creates its own branches and worktrees, and every
// one of those reaches `renderDoctor`. A terminal ACTS on control bytes: a subject carrying
// `ESC [ 2 K` `ESC [ 1 A` erases the line reporting it and the line above, and a bare newline lets
// a value close this CLI's line and open one of its own that reads like a line the CLI printed.
// That matters most here, of all commands: `doctor` exists to tell an operator that a teammate's
// `done` was a claim rather than evidence, so a teammate editing what `doctor` says about it
// defeats the check where it is used.
//
// One row per render site. The assertion is on BYTES, because a regex over the rendered string
// matches happily while the payload is still sitting in the output.
const ESC = String.fromCharCode(0x1b)
const FORGED = 'no problems found'
const PAYLOAD = [ESC + '[2K' + ESC + '[1A', String.fromCharCode(0x0d), String.fromCharCode(0x0a), FORGED].join('')

// Every report below carries a problem, so the genuine `no problems found` line is never printed
// and any line reading that way came from the payload.
const doctorReport = (over = {}) => ({
  runId: RUN_ID,
  runBranch: RUN_BRANCH,
  baseBranch: BASE_BRANCH,
  mainBranch: RUN_BRANCH,
  dirty: [],
  worktrees: [],
  tasks: [],
  problems: ['an ordinary problem'],
  ...over,
})

function assertNeutralised(out) {
  const bytes = Buffer.from(out, 'utf8')
  assert.equal(bytes.includes(0x1b), false, 'an ESC byte reached the terminal')
  assert.equal(bytes.includes(0x0d), false, 'a CR byte reached the terminal')
  for (const line of out.split('\n')) {
    assert.notEqual(line.trim(), FORGED, 'a value forged a line of its own')
  }
}

test('renderDoctor neutralises control bytes in the run header', () => {
  const out = renderDoctor(doctorReport({ runId: PAYLOAD, runBranch: PAYLOAD, baseBranch: PAYLOAD }))
  assert.match(out, /run branch/)
  assertNeutralised(out)
})

test('renderDoctor neutralises control bytes in the branch the main worktree is on', () => {
  const out = renderDoctor(doctorReport({ mainBranch: PAYLOAD }))
  assert.match(out, /main worktree on/)
  assertNeutralised(out)
})

test('renderDoctor neutralises control bytes in a worktree branch name and path', () => {
  const out = renderDoctor(doctorReport({
    worktrees: [{ path: PAYLOAD, branch: PAYLOAD, detached: false }],
  }))
  assert.match(out, /worktrees/)
  assertNeutralised(out)
})

test('renderDoctor neutralises control bytes in a missing task id and branch', () => {
  const out = renderDoctor(doctorReport({
    tasks: [{ id: PAYLOAD, branch: PAYLOAD, exists: false, tip: null, changed: [], sideDoor: false, landed: false }],
  }))
  assert.match(out, /MISSING/)
  assertNeutralised(out)
})

test('renderDoctor neutralises control bytes in a present task id and branch', () => {
  const out = renderDoctor(doctorReport({
    tasks: [{ id: PAYLOAD, branch: PAYLOAD, exists: true, tip: 'abc1234 work', changed: ['a.mjs'], sideDoor: false, landed: false }],
  }))
  assert.match(out, /file\(s\)/)
  assertNeutralised(out)
})

// The site the security review reproduced live, with `doctor` still exiting 0: a subject the
// teammate being diagnosed wrote itself.
test('renderDoctor neutralises control bytes in a commit subject the teammate wrote', () => {
  const out = renderDoctor(doctorReport({
    tasks: [{ id: 'T1', branch: 'teammates/r1/T1', exists: true, tip: PAYLOAD, changed: ['a.mjs'], sideDoor: false, landed: false }],
  }))
  assert.match(out, /T1/)
  assertNeutralised(out)
})

test('renderDoctor neutralises control bytes in a problem message', () => {
  const out = renderDoctor(doctorReport({ problems: [`T1: branch ${PAYLOAD} does not exist`] }))
  assert.match(out, /1 problem/)
  assertNeutralised(out)
})
