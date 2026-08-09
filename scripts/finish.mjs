// Whether a whole run is finished, phase by phase.
//
// `gate` computes ONE phase — the first un-integrated one — so verifying a completed run meant
// driving it once per phase by hand and reading each JSON verdict separately, with the phase list
// taken from `status.gates`: a file written by the agents being enforced. The phases here come
// from the plan at the anchor, and every verdict is recomputed now. Nothing recorded is consulted.
//
// The split that matters is failed versus pending. A failed check is a phase that was verified
// and did not hold. A pending one was never computed at all — an `agent` or `mcp` check has no
// runner, so it stays pending until a caller supplies it through `gate --results`. Reporting them
// together would turn "nobody reviewed phase 3" into "phase 3 is broken", which invites a retry
// of work that was never wrong.

// The per-phase counterpart of `gate --results`. `finish` recomputes every phase, and every
// phase with an `agent` check comes back pending, because nothing runs an agent check — so on
// this repository's own manifest `finish` could never report a run complete, which it proved on
// run `codemap` against three phases that each held a CLI-computed PASS.
//
// Keyed by phase, because a run's phases are reviewed separately and a single flat list could
// silently satisfy phase 3 with phase 1's review. Same rule as gate's: only `agent` and `mcp`
// results may be supplied, and the verdict is still computed, never taken.
export function suppliedForPhase(supplied, phase) {
  if (!supplied || typeof supplied !== 'object') return []
  const byPhase = supplied.phases ?? {}
  const entry = byPhase[String(phase)]
  return Array.isArray(entry?.results) ? entry.results : []
}

export function validateSuppliedPhases(supplied) {
  if (supplied === null || supplied === undefined) return null
  if (typeof supplied !== 'object' || Array.isArray(supplied)) {
    return '--results must be a JSON object shaped { "phases": { "<n>": { "results": [...] } } }'
  }
  const byPhase = supplied.phases
  if (byPhase === undefined) return '--results names no phases: expected { "phases": { "<n>": { "results": [...] } } }'
  if (byPhase === null || typeof byPhase !== 'object' || Array.isArray(byPhase)) {
    return '--results "phases" must be an object keyed by phase number'
  }
  for (const [phase, entry] of Object.entries(byPhase)) {
    if (!Number.isInteger(Number(phase))) return `--results names a non-numeric phase: ${JSON.stringify(phase)}`
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.results)) {
      return `--results phase ${phase} must be an object with a results array`
    }
  }
  return null
}

export function summarizeRun(phaseResults = []) {
  const failedPhases = []
  const pendingPhases = []
  for (const entry of phaseResults) {
    const verdict = entry.verdict ?? {}
    // Failure first: a phase that both failed a computed check and is missing a review is a
    // failing phase. Recording it as merely unverified would understate it.
    if ((verdict.failed ?? []).length > 0) failedPhases.push(entry.phase)
    else if ((verdict.pending ?? []).length > 0) pendingPhases.push(entry.phase)
  }
  // An empty run is not a passing one. A plan that parsed to zero phases produces no evidence
  // at all, and "no phase failed" is not the same claim as "every phase passed".
  const complete = phaseResults.length > 0 && failedPhases.length === 0 && pendingPhases.length === 0
  return { complete, failedPhases, pendingPhases }
}

export function renderRunSummary(runId, phaseResults = []) {
  const summary = summarizeRun(phaseResults)
  const lines = [`run ${runId} — every verdict below was recomputed from git just now, not read from a record`]

  for (const entry of phaseResults) {
    const verdict = entry.verdict ?? {}
    const blocking = [
      ...(verdict.failed ?? []).map((n) => `failed: ${n}`),
      ...(verdict.pending ?? []).map((n) => `pending: ${n}`),
      ...(verdict.skipped ?? []).map((n) => `skipped: ${n}`),
    ]
    lines.push(`  phase ${entry.phase}   ${verdict.verdict ?? 'FAIL'}${entry.supplied ? ' (review supplied)' : ''}${blocking.length ? `   ${blocking.join(', ')}` : ''}`)
  }

  if (summary.complete) {
    lines.push('every phase passes: the run branch is ready to land')
    return lines.join('\n')
  }

  lines.push('not finished')
  if (summary.failedPhases.length) {
    lines.push(`  phases with a failing check: ${summary.failedPhases.join(', ')} — fix those, do not land`)
  }
  if (summary.pendingPhases.length) {
    lines.push(`  phases with an unverified check: ${summary.pendingPhases.join(', ')} — run those checks and supply them with gate --results; a check nobody ran is not a check that passed`)
  }
  if (phaseResults.length === 0) {
    lines.push('  the plan produced no phases at all, so there is nothing verified here')
  }
  return lines.join('\n')
}
