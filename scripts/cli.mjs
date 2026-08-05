import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parsePlan } from './plan-parser.mjs'
import { assignPhases } from './phases.mjs'
import { readState, writeState, claimTask } from './state.mjs'
import { loadGateConfig, inferGateConfig, checksForPhase, defaultMaxParallel } from './gate-config.mjs'
import { runChecks, aggregateVerdict } from './gate-runner.mjs'
import { renderDigest } from './digest.mjs'
import { generatePhaseWorkflow } from './workflow-gen.mjs'

const USAGE = `usage: cli.mjs <init-run|gate|digest|claim|workflow> [options]

  init-run <planPath> --run <id> [--root <path>]
  gate     --run <id> [--root <path>] [--phase <name>]
  digest   --run <id> [--root <path>]
  claim    --run <id> --task <id> --by <teammate> [--root <path>]
  workflow --run <id> --phase <n> [--root <path>]`

function parseFlags(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1]
      i += 1
    } else {
      positional.push(argv[i])
    }
  }
  return { flags, positional }
}

async function readPackage(root) {
  try {
    return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

export async function runCli(argv, io = { out: console.log }) {
  const [command, ...rest] = argv
  const { flags, positional } = parseFlags(rest)
  const root = flags.root ?? process.cwd()
  const runId = flags.run

  if (command === 'init-run') {
    const tasks = assignPhases(parsePlan(await readFile(positional[0], 'utf8')))
    const totalPhases = tasks.reduce((max, t) => Math.max(max, t.phase), 0)
    await writeState(root, runId, 'plan', { runId, totalPhases, tasks })
    await writeState(root, runId, 'status', {
      runId,
      phase: 1,
      totalPhases,
      maxParallel: defaultMaxParallel(),
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, state: 'pending' })),
    })
    for (let p = 1; p <= totalPhases; p += 1) {
      const ids = tasks.filter((t) => t.phase === p).map((t) => t.id).join(', ')
      io.out(`phase ${p}: ${ids}`)
    }
    return 0
  }

  if (command === 'digest') {
    const status = await readState(root, runId, 'status')
    if (!status) { io.out(`no status for run ${runId}`); return 1 }
    io.out(renderDigest(status, Date.now()))
    return 0
  }

  if (command === 'claim') {
    const won = await claimTask(root, runId, flags.task, flags.by)
    io.out(won ? 'claimed' : 'taken')
    return won ? 0 : 1
  }

  if (command === 'workflow') {
    const plan = await readState(root, runId, 'plan')
    if (!plan) { io.out(`no plan for run ${runId}`); return 1 }
    const phase = Number(flags.phase)
    const src = await generatePhaseWorkflow({
      runId,
      phase,
      tasks: plan.tasks.filter((t) => t.phase === phase),
      maxParallel: defaultMaxParallel(),
    })
    io.out(src)
    return 0
  }

  if (command === 'gate') {
    let config = await loadGateConfig(root)
    if (!config) {
      config = inferGateConfig(await readPackage(root))
      io.out('inferred gate manifest — review, then save as teammates.gate.json:')
      io.out(JSON.stringify(config, null, 2))
      return 3
    }
    const results = await runChecks(checksForPhase(config, flags.phase ?? 'default'), { cwd: root })
    const verdict = aggregateVerdict(results)
    io.out(JSON.stringify({ ...verdict, results }, null, 2))
    return verdict.verdict === 'PASS' ? 0 : 1
  }

  io.out(USAGE)
  return 2
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2))
}
