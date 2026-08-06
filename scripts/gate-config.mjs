import { readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'

const MANIFEST = 'teammates.gate.json'
const INFERRED_ORDER = ['typecheck', 'lint', 'test', 'build']
const DEFAULT_FIX_ROUNDS = 2

export function defaultMaxParallel() {
  return Math.max(1, Math.min(8, availableParallelism() - 2))
}

export async function loadGateConfig(root) {
  try {
    return JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export function inferGateConfig(pkg) {
  const scripts = pkg?.scripts ?? {}
  const checks = INFERRED_ORDER
    .filter((name) => typeof scripts[name] === 'string')
    .map((name) => ({ name, kind: 'command', run: `npm run ${name}` }))

  checks.push({ name: 'fileset', kind: 'fileset' })
  checks.push({ name: 'ownership', kind: 'ownership' })

  checks.push({
    name: 'review',
    kind: 'agent',
    agent: 'tm-reviewer',
    lens: ['correctness', 'security', 'tests'],
    blockOn: ['high'],
  })

  return {
    maxParallel: defaultMaxParallel(),
    phases: { default: { fixRounds: DEFAULT_FIX_ROUNDS, checks } },
  }
}

export function checksForPhase(config, phaseName) {
  const phases = config?.phases ?? {}
  return phases[phaseName]?.checks ?? phases.default?.checks ?? []
}

// A fix-round budget is only meaningful as a non-negative whole number: the loop
// compares `roundsSoFar >= budget`, and any other value makes that comparison
// NaN -> false forever, leaving the retry loop unbounded. Discard anything else
// so the next fallback in the chain supplies a usable bound.
function validFixRounds(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

export function fixRoundsForPhase(config, phaseName) {
  const phases = config?.phases ?? {}
  return validFixRounds(phases[phaseName]?.fixRounds)
    ?? validFixRounds(phases.default?.fixRounds)
    ?? DEFAULT_FIX_ROUNDS
}
