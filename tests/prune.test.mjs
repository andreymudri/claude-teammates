import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPrunableWorktrees, renderPrunePlan } from '../scripts/prune.mjs'

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
