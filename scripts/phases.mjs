import { normalizePath } from './enforce.mjs'

// Normalize a DECLARED path for phase-conflict detection. Declared paths are
// authored by humans in plan files and can contain redundant segments:
// interior ./ (a/./b.mjs), repeated separators (a//b.mjs), multiple leading ./
// (././a.mjs), and .. references (a/../a/b.mjs). These must be resolved to their
// canonical form to detect actual file collisions.
//
// This is stronger than enforce.mjs's normalizePath, which is designed for git
// output (which is already canonical). Applying this stronger normalization to git
// output would change enforcement behaviour to fix a plan-authoring problem.
// That is intentionally not done — normalizePath stays as-is for filesetViolations
// and landedForFiles. This helper is specifically for comparing two things a human
// typed in a plan.
function normalizeDeclarePath(p) {
  // Start with normalizePath's basic cleanup: backslashes -> slashes,
  // remove leading ./ and leading slashes
  let path = String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')

  // Split into segments and canonicalize
  const segments = path.split('/')
  const canonical = []

  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      // Skip empty segments (from repeated slashes) and current-directory references
      continue
    } else if (segment === '..') {
      // Resolve parent directory references
      if (canonical.length > 0) {
        canonical.pop()
      }
    } else {
      canonical.push(segment)
    }
  }

  return canonical.join('/')
}

export function assignPhases(tasks) {
  const scheduled = new Set()
  const out = []
  let remaining = tasks.map((t) => ({ ...t }))
  let phase = 1

  while (remaining.length > 0) {
    const taken = new Set()
    const placed = []
    const deferred = []

    for (const t of remaining) {
      const depsReady = t.deps.every((d) => scheduled.has(d))
      const filesFree = t.files.every((f) => !taken.has(normalizeDeclarePath(f)))
      if (depsReady && filesFree) {
        t.files.forEach((f) => taken.add(normalizeDeclarePath(f)))
        t.phase = phase
        placed.push(t)
      } else {
        deferred.push(t)
      }
    }

    if (placed.length === 0) {
      throw new Error(`unsatisfiable dependencies: ${remaining.map((t) => t.id).join(', ')}`)
    }

    placed.forEach((t) => scheduled.add(t.id))
    out.push(...placed)
    remaining = deferred
    phase += 1
  }

  return out
}
