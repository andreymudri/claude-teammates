import { escalateTier } from './routing.mjs'
import { normalizePath } from './enforce.mjs'

// A fileset or ownership failure is a process violation, not a code defect. Retrying it would
// apply optimisation pressure toward widening the plan's file set, which phase-gate forbids.
const PROCESS_KINDS = new Set(['fileset', 'ownership'])

const DEFAULT_FIX_ROUNDS = 2

// A plan written before model routing existed carries no tier. `escalateTier` throws on an
// unknown tier, and this function's whole contract is to return a decision the caller can
// serialise, so an old plan must not turn a gate FAIL into an uncaught crash. `mid` is the
// same default `inferTier` falls through to.
const DEFAULT_TIER = 'mid'

// Both sides of every comparison go through `normalizePath` (the repo-wide convention, from
// enforce.mjs) so a reviewer that reports `C:\repo\src\a.mjs` still matches the plan's
// declared POSIX `src/a.mjs`. Normalisation alone is not enough: it leaves an absolute path
// with a machine-specific prefix, so the declared path is matched as a whole trailing run of
// path segments rather than by raw equality — `vendor/other-src/a.mjs` is not `src/a.mjs`.
function ownsFile(task, reported) {
  const candidate = normalizePath(reported)
  return (task.files ?? []).some((declared) => {
    const file = normalizePath(declared)
    return candidate === file || candidate.endsWith(`/${file}`)
  })
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g

// Path characters that may not sit directly against a match in free-form command output. `/`
// is excluded on the leading side only — an absolute path legitimately prefixes the declared
// one — while a trailing `/` would make the match a directory component of some other path
// and a trailing `.` or `-` a neighbouring file such as `src/a.mjs.snap`, which belongs to
// nobody. An unbounded `output.includes(file)` attributed those to the declaring task.
function mentions(output, declared) {
  const file = normalizePath(declared).replace(REGEX_META, '\\$&')
  return new RegExp(`(?<![0-9A-Za-z._-])${file}(?![0-9A-Za-z._\\-/])`).test(output)
}

function attribute(check, tasks) {
  const ids = new Set()
  if (check.kind === 'agent') {
    for (const finding of check.findings ?? []) {
      const owner = tasks.find((t) => ownsFile(t, finding.file))
      if (owner) ids.add(owner.id)
    }
    return [...ids]
  }
  if (check.kind === 'command') {
    // Deliberately conservative. Retrying the wrong teammate on someone else's failure
    // wastes a round and pollutes an innocent branch, so no match means escalate.
    const output = normalizePath(check.output ?? '')
    for (const task of tasks) {
      if ((task.files ?? []).some((file) => mentions(output, file))) ids.add(task.id)
    }
    return [...ids]
  }
  return []
}

// `verdict` is the object `scripts/cli.mjs` prints: `aggregateVerdict`'s summary — whose
// `failed`/`optionalFailed`/`skipped`/`pending` are arrays of check *names* — spread over the
// per-check objects, which live under `results`. There is no `checks` key; reading one meant
// seeing zero failing checks on every real gate FAIL, so the process-violation rule never
// fired on real output.
//
// `rounds` is what `readFixRounds(status, phase)` returns: the per-phase `{ taskId: count }`
// map, already unwrapped. Indexing it by phase a second time yields `{}`, which silently
// disabled the budget and pinned every retry at round 1.
export function decideFix(verdict, phase, tasks, rounds, config) {
  // An `optional` failure is surfaced by the gate but never blocks it — aggregateVerdict
  // routes it to `optionalFailed` and still returns PASS. An advisory lint must not escalate
  // a phase the gate passed, so it must not enter the failing set here either.
  const failed = (verdict?.results ?? []).filter(
    (check) => check.status === 'fail' && check.optional !== true,
  )
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
  const phaseRounds = rounds ?? {}
  for (const id of targets.keys()) {
    if ((phaseRounds[id] ?? 0) >= budget) {
      return { decision: 'escalate', tasks: [], reason: 'budget-exhausted', taskId: id }
    }
  }

  const retries = [...targets].map(([id, checks]) => {
    const task = tasks.find((t) => t.id === id)
    const tier = escalateTier(task?.tier ?? DEFAULT_TIER)
    return { taskId: id, tier, round: (phaseRounds[id] ?? 0) + 1, checks }
  })
  return { decision: 'retry', tasks: retries, reason: null }
}
