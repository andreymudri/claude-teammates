import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateLinkPaths, linkInto } from './preview-links.mjs'

// The liveness marker a preview's owner HOLDS for as long as it owns the preview.
//
// The leaked-preview reaper in scripts/cli.mjs classifies a preview by name and location alone,
// which cannot tell a preview a gate is using right now from one a killed gate abandoned. That
// is destructive rather than merely untidy: `git worktree remove --force` FOLLOWS a junction and
// deletes the CONTENTS of the link target, and `preview.link` provisions exactly such junctions
// into the repository's real node_modules.
//
// Anything the reaper SAMPLES — an mtime, a registration age — is check-then-act and only
// narrows the window. This marker is different in kind because the owner holds it for a span
// that STRICTLY CONTAINS the span over which the preview is observable: written before
// `git worktree add` is called at all, removed only by the owner's own `finally`. A killed gate
// skips that `finally`, so its marker survives; the reaper reads the pid out of it and finds
// nobody home.
//
// WHY A SIBLING RATHER THAN A FILE INSIDE THE PREVIEW. `git worktree add` requires its directory
// to be empty or absent, so a marker inside the preview could only be written once the add
// RETURNS — and git registers the worktree in `git worktree list` at the START of the add. On a
// 3000-file fixture the registration was visible at t=83ms and the add returned at t=3868ms:
// for those seconds the preview is listed, unmarked, and reaped as leaked, with its junctions
// followed. A sibling path is not the add's to own, so it can be written first, which is what
// turns "the window is narrow" into "there is no window".
export const PREVIEW_OWNER_MARKER = '.tm-preview-owner'

// Keyed to the preview's own directory name, so concurrent gates hold distinct markers and no
// marker can answer for a preview other than its own. The reaper derives the same path from the
// preview path `git worktree list` reports, which is the only thing the two sides share.
export function previewOwnerMarkerPath(dir) {
  return path.join(path.dirname(dir), `${PREVIEW_OWNER_MARKER}-${path.basename(dir)}`)
}

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
  // Claimed BEFORE the worktree is added, because git registers the worktree at the start of the
  // add and not at its end (see previewOwnerMarkerPath). Inside the `try`, so a write that fails
  // still reaches the `finally` that cleans the directory up.
  const marker = previewOwnerMarkerPath(dir)
  let teardownLinks = null
  try {
    await writeFile(marker, `${process.pid}\n`, 'utf8')
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
    // Marker gone, then links gone, then worktree gone. The marker is released FIRST so that
    // the reaper never sees a preview claiming an owner that has already begun tearing down —
    // and a killed gate reaches none of these three, which is the case that must stay marked.
    await rm(marker, { force: true }).catch(() => {})
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
