import { readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'

const MANIFEST = 'teammates.gate.json'
const INFERRED_ORDER = ['typecheck', 'lint', 'test', 'build']

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

  checks.push({
    name: 'review',
    kind: 'agent',
    agent: 'tm-reviewer',
    lens: ['correctness', 'security', 'tests'],
    blockOn: ['high'],
  })

  return { maxParallel: defaultMaxParallel(), phases: { default: { checks } } }
}

export function checksForPhase(config, phaseName) {
  const phases = config?.phases ?? {}
  return phases[phaseName]?.checks ?? phases.default?.checks ?? []
}
