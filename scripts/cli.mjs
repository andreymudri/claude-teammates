import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlan } from './plan-parser.mjs'
import { assignPhases } from './phases.mjs'
import { readState, writeState, claimTask, releaseClaim } from './state.mjs'
import { loadGateConfig, inferGateConfig, checksForPhase, defaultMaxParallel } from './gate-config.mjs'
import { runChecks, aggregateVerdict } from './gate-runner.mjs'
import { renderDigest } from './digest.mjs'
import { generatePhaseWorkflow } from './workflow-gen.mjs'
import { createGit } from './git.mjs'
import { deriveContext } from './gate-runner.mjs'

const USAGE = `usage: cli.mjs <init-run|gate|digest|claim|unclaim|workflow|complete> [options]

  init-run <planPath> --run <id> [--root <path>]
  gate     --run <id> --plan <path> [--base <branch>] [--root <path>] [--phase <name>] [--no-fleet]
  digest   --run <id> [--root <path>]
  claim    --run <id> --task <id> --by <teammate> [--root <path>]
  unclaim  --run <id> --task <id> [--root <path>]
  workflow --run <id> --phase <n> [--root <path>]
  complete --run <id> --task <id> --plan <path> [--base <branch>] [--root <path>]`

// A flag followed by nothing, or by another flag, is a boolean switch (e.g. --no-fleet)
// and takes no value. Without this, a boolean flag anywhere but the very last argv
// position swallows the next flag's name as its own value, and at the very last position
// reads as `undefined` — either way `flags['no-fleet'] !== undefined` never sees it.
function parseFlags(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        i += 1
      }
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

const REQUIRED = {
  'init-run': ['run'],
  gate: ['run', 'plan'],
  digest: ['run'],
  claim: ['run', 'task', 'by'],
  unclaim: ['run', 'task'],
  workflow: ['run', 'phase'],
  complete: ['run', 'task', 'plan'],
}

// A skill branches on this CLI's exit code. A missing argument must produce the usage
// message and exit 2, never an unhandled TypeError and a stack trace.
function missingArgs(command, flags, positional) {
  const missing = (REQUIRED[command] ?? []).filter((f) => !flags[f]).map((f) => `--${f}`)
  if (command === 'init-run' && !positional[0]) missing.unshift('<planPath>')
  if (command === 'workflow' && flags.phase && !Number.isInteger(Number(flags.phase))) {
    missing.push('--phase <integer>')
  }
  return missing
}

async function resolveBaseBranch(git, flag) {
  if (flag) return flag
  for (const candidate of ['main', 'master']) {
    if (await git.branchExists(candidate)) return candidate
  }
  throw new Error('could not determine the base branch — pass --base')
}

async function derive(root, runId, flags) {
  const git = createGit({ cwd: root })
  const runBranch = await git.currentBranch()
  const baseBranch = await resolveBaseBranch(git, flags.base)
  return deriveContext({ git, runId, runBranch, baseBranch, planPath: flags.plan })
}

export async function runCli(argv, io = { out: console.log }) {
  const [command, ...rest] = argv
  const { flags, positional } = parseFlags(rest)
  const root = flags.root ?? process.cwd()
  const runId = flags.run

  if (REQUIRED[command]) {
    const missing = missingArgs(command, flags, positional)
    if (missing.length > 0) {
      io.out(`missing required argument: ${missing.join(', ')}\n\n${USAGE}`)
      return 2
    }
  }

  if (command === 'init-run') {
    const tasks = assignPhases(parsePlan(await readFile(positional[0], 'utf8')))
    const totalPhases = tasks.reduce((max, t) => Math.max(max, t.phase), 0)
    const config = await loadGateConfig(root)
    await writeState(root, runId, 'plan', { runId, totalPhases, tasks })
    // Recorded for reporting only. The gate derives the anchor, the phase, and every
    // verdict from git; nothing here decides anything.
    await writeState(root, runId, 'status', {
      runId,
      phase: 1,
      totalPhases,
      maxParallel: config?.maxParallel ?? defaultMaxParallel(),
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

  if (command === 'unclaim') {
    await releaseClaim(root, runId, flags.task)
    io.out('released')
    return 0
  }

  if (command === 'workflow') {
    const plan = await readState(root, runId, 'plan')
    if (!plan) { io.out(`no plan for run ${runId}`); return 1 }
    const phase = Number(flags.phase)
    const config = await loadGateConfig(root)
    const src = await generatePhaseWorkflow({
      runId,
      phase,
      tasks: plan.tasks.filter((t) => t.phase === phase),
      maxParallel: config?.maxParallel ?? defaultMaxParallel(),
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
    const phaseName = flags.phase ?? 'default'
    const all = checksForPhase(config, phaseName)
    const solo = flags['no-fleet'] !== undefined

    // --no-fleet is the only way the enforcement checks are skipped, and the caller must
    // say it. Inferring "solo" from missing state let deleting one file record a PASS.
    const checks = solo ? all.filter((c) => c.kind !== 'fileset' && c.kind !== 'ownership') : all
    if (solo) io.out('--no-fleet: enforcement checks are not running')

    let ctx = { cwd: root }
    if (!solo) {
      try {
        ctx = { cwd: root, ...(await derive(root, runId, flags)) }
      } catch (err) {
        io.out(JSON.stringify({ verdict: 'FAIL', failed: ['derive'], error: err.message }, null, 2))
        return 1
      }
    }

    const results = await runChecks(checks, ctx)
    const verdict = aggregateVerdict(results)
    const branchShas = Object.assign({}, ...results.map((r) => r.branchShas ?? {}))
    const bound = { ...verdict, anchorSha: ctx.anchorSha, planHash: ctx.planHash, branchShas, phase: ctx.currentPhase }
    io.out(JSON.stringify({ ...bound, results }, null, 2))

    // Recorded for digests and supervision. Nothing reads this to decide anything.
    const status = await readState(root, runId, 'status')
    if (status) {
      status.gates = status.gates ?? {}
      status.gates[String(ctx.currentPhase ?? phaseName)] = { ...bound, recordedAt: Date.now() }
      await writeState(root, runId, 'status', status)
    }
    return verdict.verdict === 'PASS' ? 0 : 1
  }

  if (command === 'complete') {
    let ctx
    try {
      ctx = { cwd: root, ...(await derive(root, runId, flags)) }
    } catch (err) {
      io.out(`cannot verify completion: ${err.message}`)
      return 4
    }
    const config = await loadGateConfig(root)
    if (!config) { io.out('no gate manifest — cannot verify completion'); return 4 }

    // The gate is recomputed. A PASS recorded in status.json is never consulted, so a
    // stale or forged one buys nothing.
    const results = await runChecks(checksForPhase(config, flags.phase ?? 'default'), ctx)
    const verdict = aggregateVerdict(results)
    if (verdict.verdict !== 'PASS') {
      const why = [...verdict.failed, ...verdict.pending].join(', ')
      io.out(`gate does not pass for phase ${ctx.currentPhase}: ${why}`)
      return 4
    }

    const status = await readState(root, runId, 'status')
    if (!status) { io.out(`no status for run ${runId}`); return 1 }
    const task = (status.tasks ?? []).find((t) => t.id === flags.task)
    if (!task) { io.out(`no task ${flags.task} in run ${runId}`); return 1 }
    task.state = 'done'
    await writeState(root, runId, 'status', status)
    io.out(`${flags.task} done`)
    return 0
  }

  io.out(USAGE)
  return 2
}

// import.meta.main only exists from Node 24.2. On an older runtime it is undefined, and
// treating that as falsy would make the CLI print nothing and exit 0 — which a caller like
// phase-gate reads as PASS. Fall back to comparing argv[1] against this module's own path
// so the guard never silently skips running a subcommand.
export function isEntryPoint(main, argv1, moduleUrlPath) {
  if (main !== undefined) return main
  return argv1 === moduleUrlPath
}

if (isEntryPoint(import.meta.main, process.argv[1], fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli(process.argv.slice(2))
}
