import { mkdir, realpath, stat, symlink, unlink } from 'node:fs/promises'
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
  const seen = new Set()
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
    // Caught here so the second link never reaches symlink(): its EEXIST is indistinguishable
    // from a genuinely tracked path, and reporting a repeat as "already present in the merged
    // tree, linking over it would shadow the merged result" describes something that did not
    // happen. Nothing is tracked and nothing is shadowed — the manifest just says it twice.
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) {
      return `preview.link repeats the entry ${JSON.stringify(entry)}; list each build input once`
    }
    seen.add(key)
  }
  return null
}

export async function linkInto(dir, repoRoot, paths = []) {
  const created = []
  const teardown = async () => {
    for (const linkPath of created.reverse()) await unlink(linkPath).catch(() => {})
  }
  for (const entry of paths) {
    // Repeated even though validateLinkPaths already ran: that check cannot see the root.
    const target = path.resolve(repoRoot, entry)
    // '.' and 'a/..' both survive validateLinkPaths and resolve to the root itself. Refusing
    // them is right, but path.relative returns '' for that, and reporting '' as an escape sends
    // the reader hunting for a '..' the entry does not contain.
    if (path.relative(repoRoot, target) === '') {
      await teardown()
      throw new Error(`preview link ${JSON.stringify(entry)} resolves to the repository root `
        + 'itself, which is not a build input; remove it from preview.link')
    }
    if (isOutside(repoRoot, target)) {
      await teardown()
      throw new Error(`preview link ${JSON.stringify(entry)} resolves outside the repository`)
    }
    // The check above compares path *strings*: path.resolve and path.relative never follow a
    // symlink or a junction, so an in-repo `node_modules` linked into a shared store — pnpm's
    // default, and exactly what inferGateConfig emits — passes it while pointing outside the
    // repository, with write-through. Resolve both sides for real. Resolving the root too is
    // what keeps this correct when the root itself is a symlink (macOS /tmp is the classic
    // case): comparing a resolved target against an unresolved root would reject every entry.
    const real = await realpathBoth(repoRoot, target)
    if (real && isOutside(real.root, real.target)) {
      await teardown()
      throw new Error(`preview link ${JSON.stringify(entry)} resolves outside the repository`)
    }
    // Everything above constrains where the link POINTS. This constrains where it is WRITTEN,
    // which the target checks say nothing about. Two shapes reach outside `dir` otherwise:
    // a Windows drive-relative entry like 'C:nm', which resolves under repoRoot as a target but
    // to the C: drive's cwd as a linkPath; and traversal through a link this same loop made,
    // since entries are processed in order — manifest ['pkg', 'pkg/injected/deep/node_modules']
    // has the second entry's recursive mkdir follow `preview/pkg` into the real repository and
    // create directories there, which teardown does not remove because it only unlinks.
    const linkPath = path.resolve(dir, entry)
    const inside = await confinedToPreview(dir, linkPath)
    if (!inside) {
      await teardown()
      throw new Error(`preview link ${JSON.stringify(entry)} would be created outside the `
        + 'preview tree')
    }
    try {
      // A nested entry like 'packages/web/node_modules' has a parent that `git worktree add`
      // never materializes when it holds no tracked files. Without this the symlink fails
      // ENOENT and the handler blames the target, which does exist.
      await mkdir(path.dirname(linkPath), { recursive: true })
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

// `rel.startsWith('..')` would be a string prefix test, so an in-repo directory legitimately
// named '..cache' reads as an escape. Compare whole segments instead. `rel === ''` — the root
// itself — is deliberately NOT outside: callers that must refuse it say so with their own
// message, and the deepest-existing-ancestor check below legitimately lands on `dir` itself.
function isOutside(root, target) {
  const rel = path.relative(root, target)
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
}

// A textual check on linkPath is not enough: the parent may be a link this loop just created,
// and mkdir/symlink both traverse it. Resolve the deepest ancestor that already exists — that
// is the point where writing actually lands — and require it to sit inside the resolved `dir`.
// A textual isOutside(dir, linkPath) would be a redundant fast path, so there is none: when
// linkPath sits outside `dir` textually — the Windows 'C:nm' shape, where linkPath resolves
// against another drive's cwd — every existing ancestor of it is outside `dir` too (at best an
// ancestor OF dir, which relative()s to '..'), so the walk below already rejects it.
async function confinedToPreview(dir, linkPath) {
  const realDir = await realpath(dir).catch(() => null)
  if (realDir === null) return false
  let cursor = linkPath
  for (;;) {
    const resolved = await realpath(cursor).catch(() => null)
    // `dir` itself is a legitimate landing point — isOutside treats rel === '' as inside.
    if (resolved !== null) return !isOutside(realDir, resolved)
    const parent = path.dirname(cursor)
    // Reached the filesystem root without finding anything that exists: nothing under `dir`
    // exists either, so there is no tree to write into.
    if (parent === cursor) return false
    cursor = parent
  }
}

// Returns null when the target does not exist yet — the stat below then produces the ENOENT
// message, which says something useful, rather than a raw realpath failure.
async function realpathBoth(root, target) {
  try {
    return { root: await realpath(root), target: await realpath(target) }
  } catch {
    return null
  }
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
