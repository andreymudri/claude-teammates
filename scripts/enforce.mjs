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
export function resolveTaskBranch(task, runId) {
  return task?.branch ?? (task?.id ? taskBranchName(runId, task.id) : null)
}

export function filesetViolations(changed, declared) {
  const allowed = new Set((declared ?? []).map(normalizePath))
  return (changed ?? []).map(normalizePath).filter((p) => !allowed.has(p))
}

export function ownershipViolations({ runBranch, baseSha, headSha, dirty, taskBranches = [] }) {
  const violations = []
  if (!runBranch || !baseSha) {
    violations.push('run has no recorded runBranch/baseSha — re-run init-run inside a git repository')
    return violations
  }
  for (const branch of taskBranches) {
    if (branch === runBranch) {
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
