import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlan } from './plan-parser.mjs'
import { assignPhases } from './phases.mjs'
import { readState, writeState, claimTask, releaseClaim, readFixRounds, recordFixRound } from './state.mjs'
import { loadGateConfig, inferGateConfig, checksForPhase, defaultMaxParallel, fixRoundsForPhase, previewLinks } from './gate-config.mjs'
import { TIERS, inferTier } from './routing.mjs'
import { decideFix } from './fix-loop.mjs'
import { runChecks, aggregateVerdict } from './gate-runner.mjs'
import { renderDigest } from './digest.mjs'
import { generatePhaseWorkflow } from './workflow-gen.mjs'
import { createGit, GitError } from './git.mjs'
import { deriveContext } from './gate-runner.mjs'

const USAGE = `usage: cli.mjs <init-run|gate|digest|claim|unclaim|workflow|complete|fix|record-fix-round> [options]

  init-run <planPath> --run <id> [--root <path>]
  gate     --run <id> --plan <path> [--base <branch>] [--root <path>] [--phase <name>] [--no-fleet] [--results <path>]
  digest   --run <id> [--root <path>]
  claim    --run <id> --task <id> --by <teammate> [--root <path>]
  unclaim  --run <id> --task <id> [--root <path>]
  workflow --run <id> --phase <n> [--root <path>] [--models <json>]
  complete --run <id> --task <id> --plan <path> [--base <branch>] [--root <path>]
  fix      --run <id> --phase <n> --verdict <path> [--root <path>]
  record-fix-round --run <id> --phase <n> --task <id> [--root <path>]`

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
  fix: ['run', 'phase', 'verdict'],
  'record-fix-round': ['run', 'phase', 'task'],
}

// Commands whose `--phase` names a numeric plan phase, not a manifest phase key. `gate` is
// deliberately absent: its `--phase` is a NAME (`default`, `integration`) that selects a
// block of checks from teammates.gate.json.
const NUMERIC_PHASE_COMMANDS = new Set(['workflow', 'fix', 'record-fix-round'])

// A skill branches on this CLI's exit code. A missing argument must produce the usage
// message and exit 2, never an unhandled TypeError and a stack trace.
//
// `flags[f] === true` means the flag was given with no value (parseFlags's boolean-switch
// reading) — for every flag in REQUIRED that takes a value, that is a missing argument,
// not a truthy one. `complete --plan` (value omitted) must not sneak past this check and
// die inside git with a raw diagnostic instead.
//
// `gate --no-fleet` never derives anything from git, so it never reads `--plan` and never
// records anything under `--run` — requiring either would only teach a caller to invent a
// throwaway value to get past this check. Solo drops both from the requirement.
function missingArgs(command, flags, positional) {
  const solo = command === 'gate' && flags['no-fleet'] !== undefined
  const requiredList = solo ? [] : (REQUIRED[command] ?? [])
  const missing = requiredList
    .filter((f) => !flags[f] || flags[f] === true)
    .map((f) => `--${f}`)
  if (command === 'init-run' && !positional[0]) missing.unshift('<planPath>')
  // Unvalidated, a non-numeric `--phase` reaches `fix`'s task filter, selects nothing, and
  // comes back `escalate`/`unattributable` — "halt and ask the user" for what is only a
  // mistyped flag, with a genuine retry lost. `default` is the likeliest mistype of all: it
  // is the exact token `gate --phase` takes when omitted, and an operator carries it across.
  if (NUMERIC_PHASE_COMMANDS.has(command)
    && flags.phase && flags.phase !== true && !Number.isInteger(Number(flags.phase))) {
    missing.push('--phase <integer>')
  }
  // `--results` is optional, so it is not in REQUIRED — but once given it takes a value, and
  // a bare `--results` parses as `true` (parseFlags's boolean-switch reading). Left alone,
  // the gate's own `flags.results !== true` guard skips the whole supplied-results block and
  // the run exits 1 on the still-pending checks with nothing on stdout about the dropped
  // flag. Same treatment every value-taking flag gets from the `=== true` rule above.
  if (command === 'gate' && flags.results === true) missing.push('--results <path>')
  return missing
}

// runId/taskId become path segments under root/.teammates. Without containment, a value
// like `../../ESCAPED` writes state outside the run directory entirely — the same class
// of ref/path-escape primitive the git layer already closes for branch and tag names.
function assertContained(baseDir, segment, flagName) {
  const resolvedBase = path.resolve(baseDir)
  const resolvedTarget = path.resolve(path.join(baseDir, String(segment)))
  const rel = path.relative(resolvedBase, resolvedTarget)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${flagName} ${segment} escapes the run directory`)
  }
}

// Preferring `main` when both `main` and `master` exist is the same ref-creation primitive
// as the tag-shadowing bypass the design closed elsewhere: a teammate creates a branch
// named `main`, the heuristic silently prefers it, mergeBase(main, run) collapses onto the
// run tip, and every downstream diff and commit range becomes vacuous. When both exist and
// the caller did not disambiguate, refuse rather than guess.
async function resolveBaseBranch(git, flag) {
  if (flag) return flag
  const present = []
  for (const candidate of ['main', 'master']) {
    if (await git.branchExists(candidate)) present.push(candidate)
  }
  if (present.length > 1) {
    throw new Error(`ambiguous base branch — both ${present.join(' and ')} exist; pass --base to choose one`)
  }
  if (present.length === 1) return present[0]
  throw new Error('could not determine the base branch — pass --base')
}

// Only the checks the CLI cannot run itself may be supplied. `command`, `fileset` and
// `ownership` are computed, so they are never in this set.
const SUPPLIABLE_KINDS = new Set(['agent', 'mcp'])
// The same vocabulary aggregateVerdict recognises, minus `pending` — supplying "still
// pending" says nothing, and anything outside the set is an error rather than a pass.
const SUPPLIED_STATUSES = new Set(['pass', 'fail', 'skip'])

// `--results` is caller input for one run, never persisted authority. A result for a computed
// check would be a way to hand the gate a passing `fileset`, so those are rejected outright.
//
// Module-private on purpose: this is a trust boundary, every branch below is covered
// end-to-end through `runCli`, and nothing outside this module has any business calling it.
function validateSuppliedResults(supplied, checks) {
  const byName = new Map()
  const duplicated = new Set()
  for (const c of checks) {
    if (byName.has(c.name)) duplicated.add(c.name)
    byName.set(c.name, c)
  }
  for (const r of supplied) {
    // `checksForPhase` does not enforce unique check names, and a name that resolves to more
    // than one check cannot be validated: `byName` would resolve it to exactly one (last
    // wins) while the merge below fills EVERY pending result carrying that name — so a
    // manifest declaring `{name:'test',kind:'command'}` and `{name:'test',kind:'agent'}`
    // would let an `agent` result land on the `command` check. Whether the file was accepted
    // would then depend on declaration order rather than on what gets written. Reject the
    // collision instead of resolving it.
    if (duplicated.has(r?.name)) {
      return `--results names a check declared more than once in this phase's manifest: ${JSON.stringify(r?.name)}`
    }
    const check = byName.get(r?.name)
    if (!check) return `--results names a check not in this phase's manifest: ${JSON.stringify(r?.name)}`
    if (!SUPPLIABLE_KINDS.has(check.kind)) return `--results may not supply a ${check.kind} check: ${check.name}`
    if (!SUPPLIED_STATUSES.has(r.status)) return `--results carries an unrecognized status for ${check.name}: ${JSON.stringify(r.status)}`
  }
  return null
}

// Fills in the pending results only. A check the gate actually ran keeps its computed result,
// so a supplied entry can never overwrite what the CLI itself determined. The merged list is
// then handed to aggregateVerdict, which stays the only producer of a verdict — that is what
// makes a recorded PASS CLI-computed rather than hand-written.
//
// `status`, `output` and `findings` come from the supplied entry — that is what the caller is
// reporting. `optional` is taken from the COMPUTED result and never from the file: `optional`
// is a manifest declaration that a check does not block, so letting a result declare itself
// optional would turn a failing required review advisory by way of the very file reporting
// its failure (PASS, exit 0, the failure demoted into `optionalFailed`).
//
// Each supplied entry is consumed once, so a name appearing twice in the raw results fills
// only the first pending one and any collision is left pending rather than silently passed.
// validateSuppliedResults already rejects duplicate names outright; this keeps the invariant
// local to the function that does the writing.
//
// The `status !== 'pending'` guard is dormant future-proofing rather than dead code: no
// suppliable kind has a runner today, so the gate always leaves `agent`/`mcp` pending. The
// moment one of them does run, a supplied result must not overwrite the computed one.
export function mergeSuppliedResults(rawResults, supplied) {
  const unused = new Map()
  for (const r of supplied) {
    if (!unused.has(r.name)) unused.set(r.name, r)
  }
  return rawResults.map((r) => {
    const s = unused.get(r.name)
    if (!s || r.status !== 'pending') return r
    unused.delete(r.name)
    return {
      name: r.name,
      kind: r.kind,
      status: s.status,
      output: s.output ?? '',
      optional: r.optional,
      findings: s.findings ?? [],
    }
  })
}

async function derive(root, runId, flags) {
  const git = createGit({ cwd: root })
  const runBranch = await git.currentBranch()
  const baseBranch = await resolveBaseBranch(git, flags.base)
  // Every other failure path here fails closed; a plain operator mistake — running the
  // gate while checked out on the base branch itself — must not be the one that fails
  // open. merge-base(X, X) is X's own tip, so every diff and commit range this computes
  // is vacuous and both checks pass trivially with nothing actually verified. This is a
  // name comparison, not a state comparison: it must fire even on a truly fresh run,
  // where the run branch (a distinct branch) has no commits past the base yet — that
  // state is legitimate and is not what this guards against.
  if (runBranch === baseBranch) {
    throw new Error(
      `the run branch and the base branch are both '${runBranch}' — check out the run branch before running the gate, or pass --base to name a different base`,
    )
  }
  try {
    return await deriveContext({ git, runId, runBranch, baseBranch, planPath: flags.plan })
  } catch (err) {
    // deriveContext reads the plan via `git show <anchorSha>:<planPath>`, which fails with
    // raw git stderr ("fatal: bad revision ..."). That is often an adopting project's
    // first interaction with enforcement, so it must name the anchor and say what to check
    // rather than surface git's own diagnostic.
    if (err instanceof GitError && flags.plan && err.message.includes(`:${flags.plan}`)) {
      let anchorSha = 'unknown'
      try {
        const baseSha = await git.resolveRef(`refs/heads/${baseBranch}`)
        const runSha = await git.resolveRef(`refs/heads/${runBranch}`)
        anchorSha = await git.mergeBase(baseSha, runSha)
      } catch { /* best-effort context for the message only */ }
      throw new Error(
        `plan not found at anchor ${anchorSha}: ${flags.plan} — check --plan and confirm the plan is committed on ${baseBranch}`,
      )
    }
    throw err
  }
}

export async function runCli(argv, io = { out: console.log }) {
  const [command, ...rest] = argv
  const { flags, positional } = parseFlags(rest)
  // An empty or whitespace-only --root must never silently fall through to cwd: `??` only
  // catches `undefined`, so `--root ""` survives to become `repoRoot: ''` downstream, which
  // defeats the realpath-based containment checks in the merge preview (realpath('') rejects,
  // so both guarded escape checks in linkInto get skipped instead of enforced). Fail loudly
  // here instead of silently using the wrong root.
  if (typeof flags.root === 'string' && flags.root.trim() === '') {
    io.out(`--root must not be empty\n\n${USAGE}`)
    return 2
  }
  const root = flags.root ?? process.cwd()
  const runId = flags.run

  if (REQUIRED[command]) {
    const missing = missingArgs(command, flags, positional)
    if (missing.length > 0) {
      io.out(`missing required argument: ${missing.join(', ')}\n\n${USAGE}`)
      return 2
    }
  }

  // runId and taskId become path segments under root/.teammates before any command runs.
  // Checked once, here, rather than in each command — a value like `../../ESCAPED` must
  // never reach a filesystem call.
  try {
    if (typeof runId === 'string') assertContained(path.join(root, '.teammates'), runId, '--run')
    if ((command === 'claim' || command === 'unclaim') && typeof flags.task === 'string') {
      assertContained(path.join(root, '.teammates', runId, 'claims'), flags.task, '--task')
    }
  } catch (err) {
    io.out(`${err.message}\n\n${USAGE}`)
    return 2
  }

  if (command === 'init-run') {
    const tasks = assignPhases(parsePlan(await readFile(positional[0], 'utf8')))

    // Every task carries a tier from here on, so no consumer has to re-derive one.
    // `plan-parser.mjs` records a declared tier verbatim and validates nothing; the
    // vocabulary lives in routing.mjs, so this is the single place that checks it. A typo
    // must fail the run at init, not silently route a task to a tier no dispatcher knows.
    for (const task of tasks) {
      if (task.tierSource === 'declared') {
        if (!TIERS.includes(task.tier)) {
          io.out(`${task.id}: unknown model tier '${task.tier}' (expected ${TIERS.join(', ')})`)
          return 2
        }
        continue
      }
      task.tier = inferTier(task, tasks)
      task.tierSource = 'inferred'
    }

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
      // Tier and its source are printed, not just the ids: routing decides what every
      // dispatch in the phase costs, and an operator should see an inference they disagree
      // with before the run starts, while a Model line is still cheap to add.
      const ids = tasks
        .filter((t) => t.phase === p)
        .map((t) => `${t.id} (${t.tier}, ${t.tierSource})`)
        .join(', ')
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

    // Concrete model names never enter this repository or teammates.gate.json — they live
    // in the dispatching skill, which passes its own tier map through here. Absent, the
    // generated agent() calls carry no model and inherit the session's, as before.
    let tierModels
    // `--models` written as a bare switch parses as `true` (parseFlags's boolean-switch
    // reading). Skipping it silently would exit 0 with a model-free workflow — the caller
    // asked for routing and got none, with nothing on stdout to say so. Treated as the
    // missing argument it is, exactly as missingArgs treats `=== true` for required flags.
    if (flags.models === true) {
      io.out('--models needs a value: a JSON object mapping tiers to model names')
      return 2
    }
    if (flags.models !== undefined) {
      try {
        tierModels = JSON.parse(flags.models)
      } catch {
        // A caller branches on this exit code. A malformed map must produce a message and
        // 2, never a raw SyntaxError stack from deep inside JSON.parse.
        io.out('--models must be a JSON object mapping tiers to model names')
        return 2
      }
      if (tierModels === null || typeof tierModels !== 'object' || Array.isArray(tierModels)) {
        io.out('--models must be a JSON object mapping tiers to model names')
        return 2
      }
      // The container being an object is not enough: every value is emitted verbatim into
      // the generated task list AND spread into the agent() options, so a nested object, a
      // number or an empty string becomes a `model` field no dispatcher can act on and no
      // reader can spot. A model name is a non-empty string or it is a mistake.
      for (const [tier, model] of Object.entries(tierModels)) {
        if (typeof model !== 'string' || model.trim() === '') {
          io.out(`--models value for '${tier}' must be a non-empty string model name`)
          return 2
        }
      }
    }

    const src = await generatePhaseWorkflow({
      runId,
      phase,
      tasks: plan.tasks.filter((t) => t.phase === phase),
      maxParallel: config?.maxParallel ?? defaultMaxParallel(),
      tierModels,
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

    // Read once, at the moment of the run. The file is never persisted and never read back
    // from `.teammates/`; it fills in this run's pending checks and nothing else.
    let supplied = []
    // A valueless `--results` never reaches here: missingArgs rejects it as the missing
    // argument it is, rather than letting this guard silently drop the flag.
    if (flags.results) {
      try {
        const parsed = JSON.parse(await readFile(flags.results, 'utf8'))
        supplied = Array.isArray(parsed?.results) ? parsed.results : null
      } catch {
        supplied = null
      }
      if (supplied === null) {
        io.out('--results must be a readable JSON file shaped { "results": [...] }\n')
        return 2
      }
    }

    let ctx = { cwd: root }
    if (!solo) {
      try {
        ctx = { cwd: root, previewLink: previewLinks(config), ...(await derive(root, runId, flags)) }
      } catch (err) {
        io.out(JSON.stringify({ verdict: 'FAIL', failed: ['derive'], error: err.message }, null, 2))
        return 1
      }
    }

    const rawResults = await runChecks(checks, ctx)
    const invalid = validateSuppliedResults(supplied, checks)
    if (invalid) { io.out(`${invalid}\n`); return 2 }
    const results = mergeSuppliedResults(rawResults, supplied)
    const verdict = aggregateVerdict(results)
    const branchShas = Object.assign({}, ...results.map((r) => r.branchShas ?? {}))
    // `phase` is the numeric plan phase derived from git; `phaseName` is the manifest key
    // this gate selected its checks under. They are two different key spaces and the
    // verdict carries both, so `fix` can filter tasks by the number while looking the
    // fix-round budget up under the very key that produced these checks.
    let bound = {
      ...verdict,
      anchorSha: ctx.anchorSha,
      planHash: ctx.planHash,
      branchShas,
      phase: ctx.currentPhase,
      phaseName,
    }

    // Recorded for digests and supervision. Nothing reads this to decide anything.
    //
    // A solo (--no-fleet) verdict never derived an anchor, so it must not land under the
    // same key a real, derived phase record uses — otherwise `--phase 1 --no-fleet`
    // silently overwrites phase 1's real, anchorSha-bearing record with one that carries
    // no anchor at all. Solo records get a `solo:` prefix so the two namespaces cannot
    // collide, however the phase name is spelled.
    const gateKey = solo ? `solo:${phaseName}` : String(ctx.currentPhase ?? phaseName)
    // --run is optional in solo mode (see missingArgs): without it there is no run to
    // record anything against, so skip straight to the exit code.
    //
    // Read BEFORE the verdict is printed. status.json is agent-writable, and a corrupt one
    // is a gate failure, not a footnote: printing a computed `"verdict": "PASS"` and then
    // appending `could not read run state: ...` both contradicts the exit code and leaves
    // stdout unparseable as JSON for the caller that has to read it.
    let status = null
    let stateError = null
    if (typeof runId === 'string') {
      try {
        status = await readState(root, runId, 'status')
      } catch (err) {
        stateError = err.message
      }
    }
    if (stateError) {
      bound = {
        ...bound,
        verdict: 'FAIL',
        failed: [...verdict.failed, 'run-state'],
        error: `could not read run state: ${stateError}`,
      }
      io.out(JSON.stringify({ ...bound, results }, null, 2))
      return 1
    }
    io.out(JSON.stringify({ ...bound, results }, null, 2))

    if (status) {
      status.gates = status.gates ?? {}
      // Object.defineProperty bypasses any inherited setter — notably the legacy
      // `__proto__` accessor on Object.prototype — so a manifest or CLI flag naming a
      // phase "__proto__" creates a real, retrievable own property instead of silently
      // rewriting status.gates's prototype and losing the record.
      Object.defineProperty(status.gates, gateKey, {
        value: { ...bound, recordedAt: Date.now() },
        enumerable: true,
        configurable: true,
        writable: true,
      })
      await writeState(root, runId, 'status', status)
    }
    return verdict.verdict === 'PASS' ? 0 : 1
  }

  if (command === 'complete') {
    const config = await loadGateConfig(root)
    if (!config) { io.out('no gate manifest — cannot verify completion'); return 4 }

    let ctx
    try {
      ctx = { cwd: root, previewLink: previewLinks(config), ...(await derive(root, runId, flags)) }
    } catch (err) {
      io.out(`cannot verify completion: ${err.message}`)
      return 4
    }

    const allChecks = checksForPhase(config, flags.phase ?? 'default')
    const taskKnown = (ctx.tasks ?? []).some((t) => t.id === flags.task)
    if (!taskKnown) { io.out(`no task ${flags.task} in the plan`); return 4 }

    // `complete` verifies the calling task, not the whole phase. Anything that walks every
    // task in the current phase — `runFilesetCheck`, and the merge preview `runChecks`
    // builds — otherwise fails the first teammate to finish on a sibling's missing or
    // non-compliant branch, indistinguishable from "my own work is wrong". The scope is
    // declared once, as an explicit `taskScope` marker on the context, and `gate-runner`
    // honours it in both places. `gate` never sets it, so `gate` stays phase-wide: the
    // full gate remains its job, and phase-gate still runs it before integration, so a
    // phase can never advance without every task passing.
    //
    // `tasks` stays intact. `runOwnershipCheck` must stay run-wide — it explains every
    // commit on the run branch, not just this task's, so narrowing the task list would
    // hide a direct write riding in behind whichever task finishes first. Narrowing
    // `tasks` is exactly what the marker replaces.
    //
    // One `runChecks` call over the combined list, not one per kind: each call builds its
    // own merge preview, so splitting them did the work twice and emitted two results
    // named `merge` that could disagree with each other.
    const taskCtx = { ...ctx, taskScope: flags.task }

    // The gate is recomputed. A PASS recorded in status.json is never consulted, so a
    // stale or forged one buys nothing.
    const results = await runChecks(allChecks, taskCtx)
    const verdict = aggregateVerdict(results)
    if (verdict.verdict !== 'PASS') {
      const names = [...verdict.failed, ...verdict.pending]
      io.out(`gate does not pass for phase ${ctx.currentPhase}: ${names.join(', ')}`)
      for (const r of results) {
        if (names.includes(r.name) && r.output) io.out(`${r.name}: ${r.output}`)
      }
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

  // Every computed decision — `none`, `retry`, and `escalate` alike — exits 0. The caller
  // reads the `decision` field, not the exit code: a retry also has to carry the task list
  // and the tier each task retries at, and an exit code cannot carry that. A non-zero exit
  // here means this command could not compute a decision at all (missing run state, an
  // unreadable verdict), which is a different condition from "the phase must escalate".
  //
  // This command decides nothing about the gate itself. The verdict it reads was computed
  // from git by `gate`; nothing here can turn a FAIL into a PASS.
  if (command === 'fix') {
    const plan = await readState(root, runId, 'plan')
    if (!plan) { io.out(`no plan for run ${runId}`); return 1 }
    const status = await readState(root, runId, 'status')

    let verdict
    try {
      verdict = JSON.parse(await readFile(flags.verdict, 'utf8'))
    } catch (err) {
      io.out(`cannot read verdict at ${flags.verdict}: ${err.message}`)
      return 1
    }

    // Validated as an integer by missingArgs, then normalised: `--phase 01` and `--phase 1`
    // must select the same tasks and read the same round counter, not two disjoint string
    // keys. Every phase comparison below this line is numeric.
    const phase = Number(flags.phase)

    // The verdict names the phase it was computed for. A `--phase` that disagrees with it
    // is an argument error, not a decision: adjudicating phase 3 against phase 1's verdict
    // silently selects the wrong task set and reports `unattributable` for findings that
    // are perfectly attributable to the phase that actually failed.
    if (Number.isInteger(verdict?.phase) && verdict.phase !== phase) {
      io.out(`--phase ${flags.phase} does not match the verdict's phase ${verdict.phase} at ${flags.verdict}\n\n${USAGE}`)
      return 2
    }

    const config = (await loadGateConfig(root)) ?? {}
    // decideFix attributes findings to the tasks that declared the cited files, so it must
    // see only the failing phase's tasks — a file declared by a later phase's task is not
    // this phase's to retry.
    const phaseTasks = (plan.tasks ?? []).filter((t) => Number(t.phase) === phase)
    // Two key spaces meet here. Task selection and the round counter are keyed by the
    // NUMERIC phase; teammates.gate.json is keyed by phase NAME (`default`, `integration`),
    // which is what `gate --phase` selects checks under. The manifest key space wins for
    // the budget, and the gate's own verdict carries the name it used forward as
    // `phaseName` — so the budget comes from the same manifest block that produced these
    // checks instead of missing and silently falling back to the default.
    const budgetKey = typeof verdict?.phaseName === 'string' ? verdict.phaseName : String(phase)
    const decision = decideFix(
      verdict,
      phase,
      phaseTasks,
      // Already the per-phase `{ taskId: count }` map; decideFix does not index it again.
      readFixRounds(status, phase),
      { fixRounds: fixRoundsForPhase(config, budgetKey) },
    )
    io.out(JSON.stringify(decision, null, 2))
    return 0
  }

  // The writer for the counter `fix` reads. Deliberately a separate subcommand rather than a
  // side effect of `fix`: `fix` is a pure read that a caller may re-run freely (to re-inspect
  // a decision, or after an unrelated crash), and a read that writes would double-count every
  // one of those re-runs and burn the budget without a retry ever happening. The caller
  // records a round when it ACTUALLY DISPATCHES a retry — that is the moment a round happens
  // — and keeping the write separate from the decision is what makes it exactly-once.
  if (command === 'record-fix-round') {
    const phase = Number(flags.phase)
    const plan = await readState(root, runId, 'plan')
    if (!plan) { io.out(`no plan for run ${runId}`); return 1 }
    const status = await readState(root, runId, 'status')
    if (!status) { io.out(`no status for run ${runId}`); return 1 }

    // A round is spent against a budget that belongs to one task in one phase, so the pair
    // must exist in the plan. This also keeps an arbitrary caller-supplied string — say
    // `__proto__` — from ever reaching the round map as a key.
    const known = (plan.tasks ?? []).some((t) => t.id === flags.task && Number(t.phase) === phase)
    if (!known) { io.out(`no task ${flags.task} in phase ${phase} of run ${runId}`); return 1 }

    const next = recordFixRound(status, phase, flags.task)
    await writeState(root, runId, 'status', next)
    io.out(`${flags.task} phase ${phase} round ${readFixRounds(next, phase)[flags.task]}`)
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
