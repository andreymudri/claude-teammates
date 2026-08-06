import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateLinkPaths, linkInto } from './preview-links.mjs'

// The worktree lives under the system temp directory, never inside the repository. An
// in-repo worktree is untracked, so `git status --porcelain` reports it and the ownership
// check reads the main worktree as dirty for the whole run — the deadlock that cost run
// `fixloop` an entire phase gate.
export async function withMergePreview({ git, base, branches = [], link = [], repoRoot, run }) {
  // Validated before the worktree exists, so a bad manifest costs nothing.
  const invalid = validateLinkPaths(link)
  if (invalid) throw new Error(invalid)
  // Without this, an undefined repoRoot reaches path.resolve inside linkInto and the `merge`
  // check reports `The "paths[0]" argument must be of type string`, naming neither the cause
  // nor the entry. A caller that declares link entries and forgets the root it resolves them
  // against should be told exactly that.
  if (link.length > 0 && typeof repoRoot !== 'string') {
    throw new Error('merge preview cannot resolve preview.link entries: no repoRoot was given')
  }
  if (branches.length === 0) return run({ path: null, merged: [] })
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-preview-'))
  let teardownLinks = null
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
    // Links are created only on the clean-merge path: the conflict path hands the callback
    // `path: null`, so there is no preview tree to provision.
    teardownLinks = await linkInto(dir, repoRoot, link)
    return await run({ path: dir, merged: branches })
  } finally {
    // Before removeWorktree: `git worktree remove` run against a tree still containing a
    // junction into the repository's real node_modules is not a behaviour to discover in
    // production.
    if (teardownLinks) await teardownLinks()
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
