import { normalizePath } from './enforce.mjs'

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
      const filesFree = t.files.every((f) => !taken.has(normalizePath(f)))
      if (depsReady && filesFree) {
        t.files.forEach((f) => taken.add(normalizePath(f)))
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
