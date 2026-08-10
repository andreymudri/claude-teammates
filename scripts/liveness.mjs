// Which teammates are actually working, computed from two signals neither of which is a
// self-report: when each task branch was last committed to, and when anything under its worktree
// was last touched. A teammate mid-edit has a fresh worktree and a stale tip; a teammate parked
// waiting for a notification that never arrives has neither.
//
// This is a supervision aid and nothing reads it. Both signals are forgeable by the teammate they
// describe — GIT_COMMITTER_DATE moves a commit's timestamp, and any background process touching a
// file refreshes an mtime — so it must never be cited as evidence for a gate. It catches the
// failure that actually happens, not an adversary.
//
// Pure so it is testable without a repository: the caller gathers `tips` and `touches` and the
// clock, and this decides.

export const DEFAULT_STALE_MINUTES = 20

// A task with no branch and no worktree has not started. Reporting that as a stall would make
// every queued task of a wide phase look like a hung teammate on the first heartbeat.
export function livenessRows({ tasks = [], tips = {}, touches = {}, now, staleMinutes = DEFAULT_STALE_MINUTES } = {}) {
  if (!Number.isFinite(now)) throw new Error(`livenessRows requires a numeric clock, got ${JSON.stringify(now)}`)
  const thresholdMs = staleMinutes * 60 * 1000
  return (tasks ?? []).map((task) => {
    const tip = tips[task.id] ?? null
    const touch = touches[task.id] ?? null
    const tipAgeMs = tip?.at == null ? null : now - tip.at
    const touchAgeMs = touch?.at == null ? null : now - touch.at
    if (tip == null && touch == null) {
      return { taskId: task.id, branch: tip?.branch ?? null, tipAgeMs: null, touchAgeMs: null, floored: false, state: 'not started' }
    }
    // A floored measurement is a LOWER bound on freshness: the walk stopped early, so the newest
    // file may be one it never reached. The task can only be more recently touched than reported,
    // never less — so a floored row is never called stalled.
    const floored = touch?.floored === true
    const ages = [tipAgeMs, touchAgeMs].filter((a) => a != null)
    const fresh = ages.some((age) => age <= thresholdMs)
    const state = fresh || floored ? 'working' : 'stalled'
    return { taskId: task.id, branch: tip?.branch ?? touch?.branch ?? null, tipAgeMs, touchAgeMs, floored, state }
  })
}

export function renderLiveness(rows = [], { staleMinutes = DEFAULT_STALE_MINUTES } = {}) {
  const age = (ms) => (ms == null ? '-' : `${Math.floor(ms / 60000)}m`)
  const lines = [`liveness (stale after ${staleMinutes}m)`, 'task  tip     touched  state']
  for (const row of rows) {
    const note = row.floored ? ' (floor)' : ''
    lines.push(`${row.taskId}  ${age(row.tipAgeMs)}  ${age(row.touchAgeMs)}${note}  ${row.state}`)
  }
  return lines.join('\n')
}

export function hasStall(rows = []) {
  return rows.some((row) => row.state === 'stalled')
}
