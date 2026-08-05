const SECTIONS = [
  { state: 'running', label: 'running' },
  { state: 'done', label: 'done' },
  { state: 'blocked', label: 'blocked' },
  { state: 'orphaned', label: 'orphaned' },
  { state: 'pending', label: 'pending' },
]

function describe(task, now) {
  if (task.state === 'running') {
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

  for (const { state, label } of SECTIONS) {
    const group = tasks.filter((t) => t.state === state)
    if (group.length === 0) continue
    const body = group.map((t) => describe(t, now)).join(' ')
    lines.push(`${label.padEnd(9)} ${String(group.length).padStart(1)}  ${body}`)
  }

  const running = tasks.filter((t) => t.state === 'running').length
  lines.push(`idle slots ${Math.max(0, maxParallel - running)}`)
  return lines.join('\n')
}
