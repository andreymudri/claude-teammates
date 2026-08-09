import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPrunableWorktrees, renderPrunePlan, leakedPreviews } from '../scripts/prune.mjs'

const RUN_ID = 'r1'

const wt = (path, branch) => ({ path, branch, head: 'aaa', detached: false })

test('a worktree holding this run’s task branch is selected', () => {
  const plan = selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo', 'run/r1'), wt('/repo/.claude/worktrees/a1', 'teammates/r1/T1')],
    mainWorktree: '/repo',
  })
  assert.deepEqual(plan.prunable.map((w) => w.path), ['/repo/.claude/worktrees/a1'])
})

// Pruning another run's worktree kills a fleet nobody asked about. The run id is the whole
// filter, and it is matched on the branch's own prefix rather than on the path.
test('a worktree belonging to another run is left alone and reported', () => {
  const plan = selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo', 'run/r1'), wt('/repo/.claude/worktrees/b1', 'teammates/r2/T1')],
    mainWorktree: '/repo',
  })
  assert.deepEqual(plan.prunable, [])
  const other = plan.skipped.find((s) => s.path.endsWith('b1'))
  assert.equal(other.reason, 'belongs to another run')
})

// The main worktree is where the whole design says no teammate ever works. Removing it would
// take the operator's checkout with it.
test('the main worktree is never prunable, whatever branch it holds', () => {
  const plan = selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo', 'teammates/r1/T1')],
    mainWorktree: '/repo',
  })
  assert.deepEqual(plan.prunable, [])
  assert.match(plan.skipped[0].reason, /main worktree/i)
})

test('a detached worktree with no branch is left alone', () => {
  const plan = selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo', 'run/r1'), { path: '/tmp/preview', branch: null, head: 'bbb', detached: true }],
    mainWorktree: '/repo',
  })
  assert.deepEqual(plan.prunable, [])
  const preview = plan.skipped.find((s) => s.path.endsWith('preview'))
  assert.match(preview.reason, /no branch/i)
})

// `phase-gate` resolves a `retry` by resuming the same teammate, and a resumed teammate whose
// worktree is gone cannot start. So a phase without a recorded PASS is not prunable at all —
// that is the rule this command exists to make unmissable rather than merely written down.
test('a task whose phase has not passed its gate is refused, and named', () => {
  const plan = selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo/.claude/worktrees/a1', 'teammates/r1/T1')],
    mainWorktree: '/repo',
    taskPhases: { T1: 1 },
    passedPhases: [],
  })
  assert.deepEqual(plan.prunable, [])
  assert.match(plan.skipped[0].reason, /phase 1 has no passing gate/i)
})

test('a task whose phase passed its gate is prunable', () => {
  const plan = selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo/.claude/worktrees/a1', 'teammates/r1/T1')],
    mainWorktree: '/repo',
    taskPhases: { T1: 1 },
    passedPhases: [1],
  })
  assert.deepEqual(plan.prunable.map((w) => w.path), ['/repo/.claude/worktrees/a1'])
})

// Without the phase map the command cannot tell whether pruning is safe. Defaulting to "prune"
// would restore exactly the behaviour that made a fix round unresumable.
test('a task with no known phase is refused rather than assumed safe', () => {
  const plan = selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo/.claude/worktrees/a1', 'teammates/r1/T9')],
    mainWorktree: '/repo',
    taskPhases: { T1: 1 },
    passedPhases: [1],
  })
  assert.deepEqual(plan.prunable, [])
  assert.match(plan.skipped[0].reason, /not in the plan/i)
})

test('renderPrunePlan lists what it would remove and what it refused, with reasons', () => {
  const out = renderPrunePlan(selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [
      wt('/repo', 'run/r1'),
      wt('/repo/.claude/worktrees/a1', 'teammates/r1/T1'),
      wt('/repo/.claude/worktrees/b1', 'teammates/r2/T1'),
    ],
    mainWorktree: '/repo',
    taskPhases: { T1: 1 },
    passedPhases: [1],
  }))
  assert.match(out, /a1/)
  assert.match(out, /b1/)
  assert.match(out, /another run/i)
})

test('renderPrunePlan says plainly when there is nothing to remove', () => {
  const out = renderPrunePlan(selectPrunableWorktrees({
    runId: RUN_ID, worktrees: [wt('/repo', 'run/r1')], mainWorktree: '/repo',
  }))
  assert.match(out, /nothing to prune/i)
})

const preview = (path) => ({ path, branch: null, head: 'ccc', detached: true })
const TEMP = '/tmp'

test('a detached tm-preview worktree under temp is identified as leaked', () => {
  const out = leakedPreviews(
    [preview('C:/Users/x/AppData/Local/Temp/tm-preview-AbCdEf')],
    { tempRoot: 'C:/Users/x/AppData/Local/Temp' },
  )
  assert.deepEqual(out, [{ path: 'C:/Users/x/AppData/Local/Temp/tm-preview-AbCdEf', head: 'ccc' }])
})

// Named like a preview but holding a branch: not ours to reap. Something is checked out there.
// Two guards sit on that line — a branch, and the detached flag — and each is pinned alone here,
// because a test that flips both together goes green with either one deleted.
test('a worktree with a branch checked out is never treated as a leaked preview', () => {
  assert.deepEqual(
    leakedPreviews([{ path: '/tmp/tm-preview-x', branch: 'teammates/r1/T1', head: 'a', detached: false }], { tempRoot: TEMP }),
    [],
  )
})

test('a detached worktree that still names a branch is never treated as a leaked preview', () => {
  assert.deepEqual(
    leakedPreviews([{ path: '/tmp/tm-preview-y', branch: 'teammates/r1/T1', head: 'a', detached: true }], { tempRoot: TEMP }),
    [],
  )
})

// The third guard, pinned alone as well: a preview is a worktree this tool detached itself. An
// entry that does not report itself detached is not one of ours, whatever it is named.
test('a branchless worktree that is not detached is never treated as a leaked preview', () => {
  assert.deepEqual(
    leakedPreviews([{ path: '/tmp/tm-preview-z', branch: null, head: 'a', detached: false }], { tempRoot: TEMP }),
    [],
  )
})

test('an ordinary detached worktree is not a leaked preview', () => {
  assert.deepEqual(leakedPreviews([preview('/tmp/scratch-thing')], { tempRoot: TEMP }), [])
})

// The name is not the evidence — the location is. An operator may keep a deliberate detached
// worktree called tm-preview-notes anywhere on disk; only the ones this tool itself creates,
// under the temp root, are its to reap.
test('a tm-preview worktree outside the temp root is not identified', () => {
  assert.deepEqual(leakedPreviews([preview('C:/work/tm-preview-notes')], { tempRoot: 'C:/Users/x/AppData/Local/Temp' }), [])
})

test('a temp root neighbour that merely shares a prefix is not inside it', () => {
  assert.deepEqual(leakedPreviews([preview('/tmpx/tm-preview-a')], { tempRoot: TEMP }), [])
})

test('the temp root is compared with the separator normalisation the module already uses', () => {
  const out = leakedPreviews([preview('C:\\Temp\\tm-preview-a')], { tempRoot: 'C:/Temp/' })
  assert.deepEqual(out.map((p) => p.path), ['C:\\Temp\\tm-preview-a'])
})

// Without a temp root the module cannot tell a preview it made from a directory that happens to
// be named like one, so it identifies nothing. Identifying everything would make the failure mode
// "delete an operator's worktree" instead of "report none".
test('no temp root identifies nothing rather than everything', () => {
  assert.deepEqual(leakedPreviews([preview('/tmp/tm-preview-zz')]), [])
  assert.deepEqual(leakedPreviews([preview('/tmp/tm-preview-zz')], { tempRoot: '' }), [])
  assert.deepEqual(leakedPreviews([preview('/tmp/tm-preview-zz')], { tempRoot: null }), [])
})

// tm-preview- appearing as an ancestor segment is somebody else's tree, not a preview. It must
// be neither identified nor quietly dropped from `skipped`, which is how a loosened match hides.
test('a tm-preview- ancestor segment is not a leaked preview and is still reported', () => {
  assert.deepEqual(leakedPreviews([preview('/tmp/tm-preview-archive/wt1')], { tempRoot: TEMP }), [])
  const plan = selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo', 'run/r1'), preview('/tmp/tm-preview-archive/wt1')],
    mainWorktree: '/repo',
    tempRoot: TEMP,
  })
  assert.deepEqual(plan.previews, [])
  assert.equal(plan.skipped.some((s) => s.path === '/tmp/tm-preview-archive/wt1'), true)
})

test('the prune plan lists leaked previews separately from what it left alone', () => {
  const plan = selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo', 'run/r1'), preview('/tmp/tm-preview-zz')],
    mainWorktree: '/repo',
    tempRoot: TEMP,
  })
  assert.deepEqual(plan.previews.map((p) => p.path), ['/tmp/tm-preview-zz'])
  assert.equal(plan.skipped.some((s) => s.path === '/tmp/tm-preview-zz'), false)
  assert.match(renderPrunePlan(plan), /leaked merge previews/)
})

// Same worktree, no temp root: it is not identified as a preview, so it must reappear among the
// refusals. Falling through both lists would be a worktree the command never mentions at all.
test('without a temp root a preview-shaped worktree is reported as left alone', () => {
  const plan = selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo', 'run/r1'), preview('/tmp/tm-preview-zz')],
    mainWorktree: '/repo',
  })
  assert.deepEqual(plan.previews, [])
  assert.match(plan.skipped.find((s) => s.path === '/tmp/tm-preview-zz').reason, /no branch/i)
})

// "nothing to prune" as the first line of a report that goes on to list worktrees `--yes` will
// remove is the exact class of untrue summary this command exists to stop printing.
test('the summary does not claim nothing to prune while previews are listed', () => {
  const out = renderPrunePlan(selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo', 'run/r1'), preview('/tmp/tm-preview-zz')],
    mainWorktree: '/repo',
    tempRoot: TEMP,
  }))
  assert.doesNotMatch(out, /nothing to prune/i)
  assert.match(out, /leaked merge previews/)
})

// Liveness cannot be read off a worktree list: a gate running in another process right now holds
// a detached, branchless tm-preview-* worktree, and reaping it fails that gate with missing files
// instead of a verdict. The output must not promise a safety it cannot check.
test('the previews line qualifies its safety claim instead of asserting it', () => {
  const out = renderPrunePlan(selectPrunableWorktrees({
    runId: RUN_ID,
    worktrees: [wt('/repo', 'run/r1'), preview('/tmp/tm-preview-zz')],
    mainWorktree: '/repo',
    tempRoot: TEMP,
  }))
  assert.match(out, /safe to remove only when no gate is running/i)
  assert.doesNotMatch(out, /safe to remove(?!\s+only when no gate is running)/i)
})
