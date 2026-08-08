// Which of a run's worktrees may be removed, and which may not.
//
// The rule this encodes was written down twice and got followed wrongly both times, because it
// lives in two skills that each state half of it. `parallel-execution` wants a returned
// teammate's worktree gone so a later dispatch can take its branch; `phase-gate` resolves a
// `retry` by RESUMING that same teammate, which fails outright once its worktree is gone —
// taking the task's whole context with it. The reconciliation is: not until the phase has a
// passing gate.
//
// So the phase gate's verdict, not the teammate's return, is what makes a worktree prunable.
// Every refusal is reported with its reason rather than silently skipped: a command that removes
// three of five worktrees and says nothing about the other two reads as a complete job.
//
// Pure. The caller lists the worktrees, names the main one, and supplies the plan's task→phase
// map and the phases that hold a passing gate.

const TASK_BRANCH = /^teammates\/([^/]+)\/([^/]+)$/

function norm(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

export function selectPrunableWorktrees({
  runId,
  worktrees = [],
  mainWorktree = null,
  taskPhases = null,
  passedPhases = [],
} = {}) {
  const prunable = []
  const skipped = []
  const passed = new Set(passedPhases ?? [])

  for (const wt of worktrees) {
    const isMain = mainWorktree != null && norm(wt.path) === norm(mainWorktree)
    if (isMain) {
      // Stated even when it holds no task branch: the one worktree the whole design keeps
      // teammates out of is the one an over-eager prune would take from the operator.
      skipped.push({ path: wt.path, reason: 'this is the main worktree; it is never pruned' })
      continue
    }
    if (!wt.branch) {
      skipped.push({ path: wt.path, reason: 'no branch checked out (detached); this run does not own it' })
      continue
    }
    const match = TASK_BRANCH.exec(wt.branch)
    if (!match) {
      skipped.push({ path: wt.path, reason: `holds ${wt.branch}, which is not a task branch of any run` })
      continue
    }
    const [, branchRun, taskId] = match
    if (branchRun !== runId) {
      skipped.push({ path: wt.path, reason: 'belongs to another run' })
      continue
    }

    // No phase map supplied: the caller is not in a position to say whether a fix round could
    // still need this worktree, so nothing is removed. Assuming "safe" here is precisely the
    // default that made a retry unresumable.
    if (taskPhases) {
      const phase = taskPhases[taskId]
      if (phase === undefined) {
        skipped.push({ path: wt.path, reason: `holds ${wt.branch}, whose task is not in the plan` })
        continue
      }
      if (!passed.has(phase)) {
        skipped.push({ path: wt.path, reason: `phase ${phase} has no passing gate yet; a retry resumes this teammate and cannot without its worktree` })
        continue
      }
    }
    prunable.push({ path: wt.path, branch: wt.branch, taskId })
  }

  return { runId, prunable, skipped }
}

export function renderPrunePlan(plan) {
  const lines = []
  if (plan.prunable.length === 0) lines.push('nothing to prune')
  else {
    lines.push(`prunable (${plan.prunable.length}):`)
    for (const w of plan.prunable) lines.push(`  ${w.taskId}  ${w.branch}  ${w.path}`)
  }
  if (plan.skipped.length) {
    lines.push('left alone:')
    for (const s of plan.skipped) lines.push(`  ${s.path} — ${s.reason}`)
  }
  return lines.join('\n')
}
