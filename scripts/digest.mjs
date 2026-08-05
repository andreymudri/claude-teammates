const SECTIONS = [
  { state: 'running', label: 'running' },
  { state: 'done', label: 'done' },
  { state: 'blocked', label: 'blocked' },
  { state: 'orphaned', label: 'orphaned' },
  { state: 'pending', label: 'pending' },
]

const KNOWN = new Set(SECTIONS.map((s) => s.state))

function describe(task, now) {
  if (task.state === 'running') {
    // A running task with no startedAt is a bookkeeping bug, not a zero-minute task.
    // Say so rather than rendering NaNm.
    if (typeof task.startedAt !== 'number') return `${task.title}(?)`
    const mins = Math.floor((now - task.startedAt) / 60_000)
    return `${task.title}(${mins}m)`
  }
  if (task.state === 'done') return `${task.title} ✓`
  if (task.state === 'blocked') return `${task.title} — needs ${task.blockedBy}`
  return task.title
}

export function renderDigest(status, now) {
  const { runId, phase, totalPhases, maxParallel, tasks } = status
  const lines = [`run ${runId} · phase ${phase}/${totalPhases} · ${tasks.length} tasks`]

  const groups = SECTIONS.map(({ state, label }) => ({
    label,
    group: tasks.filter((t) => t.state === state),
  }))
  // Never drop a task: an unrecognized state is surfaced under `unknown` rather than
  // silently omitted. A task missing from the digest is a task nobody chases.
  groups.push({ label: 'unknown', group: tasks.filter((t) => !KNOWN.has(t.state)) })

  for (const { label, group } of groups) {
    if (group.length === 0) continue
    const body = group.map((t) => describe(t, now)).join(' ')
    lines.push(`${label.padEnd(9)} ${String(group.length).padStart(1)}  ${body}`)
  }

  const running = tasks.filter((t) => t.state === 'running').length
  lines.push(`idle slots ${Math.max(0, maxParallel - running)}`)
  return lines.join('\n')
}
