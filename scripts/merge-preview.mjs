import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The worktree lives under the system temp directory, never inside the repository. An
// in-repo worktree is untracked, so `git status --porcelain` reports it and the ownership
// check reads the main worktree as dirty for the whole run — the deadlock that cost run
// `fixloop` an entire phase gate.
export async function withMergePreview({ git, base, branches = [], run }) {
  if (branches.length === 0) return run({ path: null, merged: [] })
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-preview-'))
  try {
    await git.addWorktreeDetached(dir, base)
    const conflict = await git.mergeInto(dir, branches)
    if (conflict) {
      // An empty array is not a clean merge and not a reportable conflict: an octopus merge
      // of three or more branches resets the index before exiting, and non-conflict failures
      // (unset user.email, a deleted branch, unrelated histories, a stale index.lock) never
      // produce unmerged paths either. Passing `[]` through would let a caller mistake it for
      // a conflict naming no branches, or silently fall back to the raw worktree. Throw instead
      // so the failure cannot be confused with either outcome.
      if (conflict.length === 0) {
        throw new Error('merge preview failed: mergeInto reported a conflict with no paths')
      }
      return await run({ path: null, conflict })
    }
    return await run({ path: dir, merged: branches })
  } finally {
    await git.removeWorktree(dir).catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// A conflict belongs to a pair of branches, not to one task: no single teammate can fix it.
// The gate reports it that way so the fix loop escalates instead of retrying one owner.
export function conflictPairs(branches, paths) {
  if (paths.length === 0) return []
  return [{ branches: [...branches], paths: [...paths] }]
}
