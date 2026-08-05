// Plans are authored by hand on Windows and read by git, which always emits posix
// separators. Both sides are normalized before comparison. Comparison stays
// case-sensitive: git is case-sensitive, and a case-only mismatch is a real mistake.
export function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

export function taskBranchName(runId, taskId) {
  return `teammates/${runId}/${taskId}`
}

// A recorded branch wins; the convention is the fallback. A task that resolves to
// neither is the caller's failure to handle, never a silent pass.
//
// A branch that was explicitly declared but is empty or whitespace-only is a plan
// defect, not "no branch was declared" — it deliberately resolves to null rather
// than falling back to the convention, so a defective declaration surfaces as a
// gate failure instead of being silently papered over. (Falling through to the
// convention here would also hide the defect from whoever wrote the plan.)
export function resolveTaskBranch(task, runId) {
  if (task && 'branch' in task && task.branch != null) {
    return typeof task.branch === 'string' && task.branch.trim() === '' ? null : task.branch
  }
  return task?.id ? taskBranchName(runId, task.id) : null
}

export function filesetViolations(changed, declared) {
  const allowed = new Set((declared ?? []).map(normalizePath))
  return (changed ?? []).map(normalizePath).filter((p) => !allowed.has(p))
}

// Different spellings can name the same ref to git: `refs/heads/main`, `heads/main`
// and `main` are one ref, and on this (case-insensitive) filesystem `Main` and `main`
// are the same branch too. Strip a leading refs/heads/ or heads/ and compare
// case-insensitively so those aliases can't slip past the run-branch guard.
//
// This is still a string comparison, not a git query: this module stays pure and has
// no git access, so it cannot resolve either side to a sha. A branch that is the same
// commit as the run branch under a name this normalization does not recognize (or that
// only collides by sha on a case-sensitive filesystem) will not be caught here — a
// sha-based comparison would be strictly correct but needs the git wrapper, which lives
// in the caller, not this predicate.
function normalizeBranchRef(name) {
  return String(name).replace(/^refs\/heads\//, '').replace(/^heads\//, '').toLowerCase()
}

export function ownershipViolations({ runBranch, baseSha, headSha, dirty, taskBranches = [] }) {
  const violations = []
  if (!runBranch || !baseSha) {
    violations.push('run has no recorded runBranch/baseSha — re-run init-run inside a git repository')
    return violations
  }
  for (const branch of taskBranches) {
    if (normalizeBranchRef(branch) === normalizeBranchRef(runBranch)) {
      violations.push(`task branch ${branch} is the run branch; only tm-integrator writes there`)
    }
  }
  if (headSha !== baseSha) {
    violations.push(`main worktree HEAD moved from ${baseSha} to ${headSha} without a recorded integration — run: cli.mjs integrated`)
  }
  if (dirty) {
    violations.push('main worktree has uncommitted changes; teammates work only in their own worktrees')
  }
  return violations
}

export function completionBlock(status, phaseName) {
  const gate = status?.gates?.[phaseName]
  if (!gate) return `no gate recorded for phase ${phaseName} — run the gate before completing`
  if (gate.verdict !== 'PASS') return `gate for phase ${phaseName} is ${gate.verdict}, not PASS`
  return null
}
