import { escalateTier } from './routing.mjs'

// A fileset or ownership failure is a process violation, not a code defect. Retrying it would
// apply optimisation pressure toward widening the plan's file set, which phase-gate forbids.
const PROCESS_KINDS = new Set(['fileset', 'ownership'])

const DEFAULT_FIX_ROUNDS = 2

function attribute(check, tasks) {
  const ids = new Set()
  if (check.kind === 'agent') {
    for (const finding of check.findings ?? []) {
      const owner = tasks.find((t) => t.files.includes(finding.file))
      if (owner) ids.add(owner.id)
    }
    return [...ids]
  }
  if (check.kind === 'command') {
    // Deliberately conservative. Retrying the wrong teammate on someone else's failure
    // wastes a round and pollutes an innocent branch, so no match means escalate.
    const output = check.output ?? ''
    for (const task of tasks) {
      if (task.files.some((file) => output.includes(file))) ids.add(task.id)
    }
    return [...ids]
  }
  return []
}

export function decideFix(verdict, phase, tasks, rounds, config) {
  const failed = (verdict?.checks ?? []).filter((check) => check.status === 'fail')
  if (failed.length === 0) return { decision: 'none', tasks: [], reason: null }

  const violation = failed.find((check) => PROCESS_KINDS.has(check.kind))
  if (violation) {
    return { decision: 'escalate', tasks: [], reason: 'process-violation', check: violation.name }
  }

  const targets = new Map()
  for (const check of failed) {
    const ids = attribute(check, tasks)
    if (ids.length === 0) {
      return { decision: 'escalate', tasks: [], reason: 'unattributable', check: check.name }
    }
    for (const id of ids) {
      if (!targets.has(id)) targets.set(id, [])
      targets.get(id).push(check.name)
    }
  }

  const budget = config?.fixRounds ?? DEFAULT_FIX_ROUNDS
  const phaseRounds = rounds?.[String(phase)] ?? {}
  for (const id of targets.keys()) {
    if ((phaseRounds[id] ?? 0) >= budget) {
      return { decision: 'escalate', tasks: [], reason: 'budget-exhausted', taskId: id }
    }
  }

  const retries = [...targets].map(([id, checks]) => {
    const task = tasks.find((t) => t.id === id)
    return { taskId: id, tier: escalateTier(task.tier), round: (phaseRounds[id] ?? 0) + 1, checks }
  })
  return { decision: 'retry', tasks: retries, reason: null }
}
