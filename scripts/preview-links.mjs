import { stat, symlink, unlink } from 'node:fs/promises'
import path from 'node:path'

// A junction is the only directory link Windows creates without elevation. POSIX takes 'dir'.
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

// The manifest is read from the working tree by loadGateConfig, which an enforced agent can
// edit — the same reachability that made the empty-check-list regression a `high`. Without
// this, a link entry of '../../../../Users/someone' creates a junction into the preview, and a
// command check then runs arbitrary project code inside a tree containing it.
export function validateLinkPaths(paths) {
  if (!Array.isArray(paths)) {
    return 'preview.link must be an array of repo-relative directory paths'
  }
  for (const entry of paths) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return `preview.link entries must be non-empty strings, got ${JSON.stringify(entry)}`
    }
    if (path.isAbsolute(entry)) {
      return `preview.link entry must be repo-relative, got ${JSON.stringify(entry)}`
    }
    const normalized = path.normalize(entry)
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      return `preview.link entry escapes the repository: ${JSON.stringify(entry)}`
    }
  }
  return null
}

export async function linkInto(dir, repoRoot, paths = []) {
  const created = []
  const teardown = async () => {
    for (const linkPath of created.reverse()) await unlink(linkPath).catch(() => {})
  }
  for (const entry of paths) {
    // Repeated even though validateLinkPaths already ran: that check cannot see the root, and a
    // symlinked repo root can make a textually-safe entry resolve outside it.
    const target = path.resolve(repoRoot, entry)
    const rel = path.relative(repoRoot, target)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      await teardown()
      throw new Error(`preview link ${JSON.stringify(entry)} resolves outside the repository`)
    }
    const linkPath = path.resolve(dir, entry)
    try {
      // Statted first because neither a POSIX symlink nor a Windows junction refuses a missing
      // target — both create a dangling link. A dangling link would defer the failure to a
      // command check, where a preview missing its build inputs looks exactly like a code defect.
      const info = await stat(target)
      if (!info.isDirectory()) {
        const err = new Error(`${entry} is not a directory`)
        err.code = 'ENOTDIR'
        throw err
      }
      await symlink(target, linkPath, LINK_TYPE)
    } catch (err) {
      await teardown()
      throw new Error(linkFailureMessage(entry, err))
    }
    created.push(linkPath)
  }
  return teardown
}

// A missing target and a tracked path are both manifest errors, and each gets the sentence that
// says what to do about it.
function linkFailureMessage(entry, err) {
  if (err.code === 'ENOENT') {
    return `preview link '${entry}' failed: ENOENT — no such directory in the repository. `
      + 'Run your install step, or remove it from preview.link in teammates.gate.json'
  }
  if (err.code === 'EEXIST') {
    return `preview link '${entry}' failed: the path is tracked and already present in the merged `
      + 'tree. Linking over it would shadow the merged result; remove it from preview.link'
  }
  return `preview link '${entry}' failed: ${err.message}`
}
