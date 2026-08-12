import { readFile, writeFile, mkdir, rename, lstat, readdir, unlink } from 'node:fs/promises'
import { livenessRows, renderLiveness, hasStall, hasUnknown, DEFAULT_STALE_MINUTES } from './liveness.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlan } from './plan-parser.mjs'
import { assignPhases } from './phases.mjs'
import { readState, writeState, claimTask, releaseClaim, readFixRounds, recordFixRound, runDir } from './state.mjs'
import { inferGateConfig, checksForPhase, fixRoundsForPhase, previewLinks } from './gate-config.mjs'
import {
  loadConfig, readLayer, writeLayer, validateKey, validateLocal, isEnforcementKey, assertSafeKey,
  getKey, setKey, unsetKey, ensureGitignored, ConfigError,
  GATE_FILE, LOCAL_FILE, ROLES,
} from './config.mjs'
import * as configModule from './config.mjs'
import { TIERS, inferTier } from './routing.mjs'
import { decideFix } from './fix-loop.mjs'
import { runChecks, aggregateVerdict } from './gate-runner.mjs'
import { renderDigest } from './digest.mjs'
import { collectDoctorReport, renderDoctor } from './doctor.mjs'
import { collectReviewResults, printable, printableBlock, reviewFileName, reviewStamp } from './reviews.mjs'
import { generateReviewDispatch } from './review-gen.mjs'
import { resolveTaskBranch, taskBranchName } from './enforce.mjs'
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { validateLinkPaths } from './preview-links.mjs'
import { planDrift, renderDrift } from './plan-drift.mjs'
import { summarizeRun, renderRunSummary, suppliedForPhase, validateSuppliedPhases } from './finish.mjs'
import { selectPrunableWorktrees, renderPrunePlan, leakedPreviews } from './prune.mjs'
import { previewOwnerMarkerPath } from './merge-preview.mjs'
import { rebuildRunState } from './rebuild.mjs'
import { generatePhaseWorkflow } from './workflow-gen.mjs'
import { createGit, GitError, defaultGitExec } from './git.mjs'
import { buildCoupling, neighboursOf, inventory, hotPairs, renderMap } from './codemap.mjs'
import { mapNotesStale, mapNotesPrompt, mapNotesWritable } from './mapnotes.mjs'
import { deriveContext } from './gate-runner.mjs'

// The temp root as GIT would spell it, which is not what `os.tmpdir()` returns.
//
// `git worktree list` reports a worktree's resolved real path. `os.tmpdir()` reports whatever
// TMPDIR/TEMP/TMP holds, and on both non-Linux CI runners those are a DIFFERENT spelling of the
// same directory: macOS `/var` is a symlink to `/private/var`, and a Windows `TEMP` can be an 8.3
// short name (`C:\Users\RUNNER~1\...`) for a path git names in long form. `under()` in prune.mjs
// is a whole-segment string comparison over paths it cannot stat — deliberately, since that
// module is pure — so a disagreeing spelling identified NO preview at all, and every preview test
// went red on macOS and windows-latest while ubuntu passed.
//
// Resolving belongs here, in the caller, because here there is a filesystem to ask.
//
// `.native` and not the JS `realpathSync`: measured on Windows 10, the JS implementation returns
// an 8.3 component unchanged (`...\Temp\LONGDI~1`) while `.native` expands it to the long name
// git reports. `.native` is realpath(3) off Windows, so it resolves the macOS symlink too. The JS
// one would have fixed macOS only, while reading as though it had fixed both.
//
// A failed resolution falls back to the unresolved value rather than throwing. The cost of not
// resolving is that a preview goes UNIDENTIFIED, which leaves it on disk and reports it among the
// refusals — the same non-destructive outcome as before this fix, and never a wider delete.
// Aborting the whole prune because a temp directory could not be statted would be the worse trade.
function resolvedTempRoot() {
  const raw = tmpdir()
  try {
    return realpathSync.native(raw)
  } catch {
    return raw
  }
}

const USAGE = `usage: cli.mjs <init-run|gate|doctor|liveness|digest|claim|unclaim|workflow|complete|fix|record-fix-round|review-dispatch|collect-reviews|preview-check|plan-drift|finish|prune-run|rebuild-state|map|map-notes|config> [options]

  init-run <planPath> --run <id> [--root <path>]
  doctor   --run <id> --plan <path> [--base <branch>] [--run-branch <name>] [--root <path>]
  liveness --run <id> --plan <path> [--stale <minutes>] [--root <path>]
  finish   --run <id> --plan <path> [--base <branch>] [--root <path>] [--results <path>] [--enforcement-only]
  prune-run --run <id> --plan <path> [--base <branch>] [--yes] [--root <path>] [--results <path>] [--enforcement-only]
  rebuild-state --run <id> --plan <path> [--base <branch>] [--force] [--root <path>]
  map      [--files <a,b>] [--commits <n>] [--top <n>] [--root <path>]
  map-notes --run <id> [--root <path>] [--write <path>]
  plan-drift --run <id> --plan <path> [--base <branch>] [--root <path>]
  preview-check [--root <path>]
  review-dispatch --run <id> [--phase <name>] [--models <json>] [--root <path>]
  collect-reviews --run <id> [--phase <name>] [--root <path>]
  gate     --run <id> --plan <path> [--base <branch>] [--root <path>] [--phase <name>] [--no-fleet] [--results <path>]
  digest   --run <id> [--root <path>]
  claim    --run <id> --task <id> --by <teammate> [--root <path>]
  unclaim  --run <id> --task <id> [--root <path>]
  workflow --run <id> --phase <n> [--root <path>] [--models <json>] [--plan <path>] [--base <branch>]
  complete --run <id> --task <id> --plan <path> [--base <branch>] [--root <path>]
  fix      --run <id> --phase <n> --verdict <path> [--root <path>]
  record-fix-round --run <id> --phase <n> --task <id> [--root <path>]
  config   list [--root <path>]
  config   get <key> [--root <path>]
  config   set <key> <value> [--root <path>] [--local]
  config   unset <key> [--root <path>] [--local]`

// A flag followed by nothing, or by another flag, is a boolean switch (e.g. --no-fleet)
// and takes no value. Without this, a boolean flag anywhere but the very last argv
// position swallows the next flag's name as its own value, and at the very last position
// reads as `undefined` — either way `flags['no-fleet'] !== undefined` never sees it.
// Flags that are a switch and nothing else: present or absent, never carrying a value. Their
// presence is the whole signal, so any value written after one is a spelling this CLI cannot
// act on — see the refusal in parseFlags. Kept as a named set so the advice printed for a
// rejected spelling can name a form that actually works, per flag.
const VALUELESS_FLAGS = new Set(['no-fleet', 'local', 'yes', 'force', 'enforcement-only'])

// What to tell a caller who wrote a spelling this CLI does not take. It must never name a form
// that fails — and for `--no-fleet` it must never name one that does the OPPOSITE of what the
// caller was reaching for: someone typing `--no-fleet=false` wants the enforcement checks
// running, and "write `--no-fleet`" would hand them the spelling that switches those checks off.
function spellingAdvice(name) {
  if (name === 'no-fleet') {
    return '`--no-fleet` takes no value: omit it entirely to keep the fileset and ownership'
      + ' checks running, or pass it alone to run without them'
  }
  if (VALUELESS_FLAGS.has(name)) return `\`--${name}\` takes no value: write \`--${name}\` alone`
  return `write \`--${name} <value>\``
}

function parseFlags(argv) {
  const flags = {}
  const positional = []
  // Rejected spellings, reported by the caller before any command runs — never dropped, or the
  // flag would go missing exactly as it did before.
  const rejected = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const token = argv[i].slice(2)
      // `--name=value` is a spelling this CLI does not accept, and it is refused rather than
      // guessed at — in EITHER direction, which is the whole point.
      //
      // Read as a flag name (what happened before any of this), `--local=true` produced a flag
      // literally called `local=true`, leaving `flags.local` undefined, so the write silently
      // landed in the TRACKED enforcement manifest instead of the gitignored layer the caller
      // named. Interpreted as a value (what replaced it) is worse: every switch in this CLI is
      // tested with `!== undefined`, so `--no-fleet=false` READS as negation and DISABLES the
      // fileset and ownership checks — `=false`, `=0`, `=off` alike — while also dropping
      // `--run` and `--plan` from REQUIRED. An argv that says "enforcement is not disabled"
      // would open the entire solo path, which is the one guarantee SECURITY.md makes about a
      // fleet run.
      //
      if (token.includes('=')) {
        rejected.push({ raw: argv[i], name: token.slice(0, token.indexOf('=')) })
        continue
      }
      const name = token
      const next = argv[i + 1]
      // A flag in VALUELESS_FLAGS never consumes the token after it, and never carries a value
      // of its own. `--no-fleet false` reads to a human as "solo mode off" and meant the exact
      // opposite: any value at all left `flags['no-fleet']` defined, which is what both
      // consumers tested, so the fileset and ownership checks were skipped by an argv written
      // to keep them. Refused rather than interpreted, for the same reason `=` is.
      if (VALUELESS_FLAGS.has(name)) {
        if (next !== undefined && !next.startsWith('--')) {
          rejected.push({ raw: `${argv[i]} ${next}`, name })
          i += 1
          continue
        }
        flags[name] = true
        continue
      }
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
  return { flags, positional, rejected }
}

// `null`, not `{}`, when there is no package.json: `inferGateConfig` distinguishes "a Node
// project with no scripts" from "not a Node project" by the truthiness of this value, and only
// the first should get `preview.link: ["node_modules"]`. Returning an empty object made every
// repo look like a Node one, so a Python or Rust project's inferred manifest named a directory
// it does not have — which then fails the `merge` check on a missing link target.
async function readPackage(root) {
  try {
    return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// Exported so the suite can DERIVE the command list rather than restate it. A hardcoded list
// catches a command REMOVED from these tables and not one ADDED without an entry — and adding is
// the direction that happens, which is how a 21st subcommand could swallow an unknown flag and
// exit 0 with the suite green.
export const REQUIRED = {
  'init-run': ['run'],
  gate: ['run', 'plan'],
  doctor: ['run', 'plan'],
  liveness: ['run', 'plan'],
  // `--phase` is the manifest phase key, not a plan phase number, so it stays out of
  // NUMERIC_PHASE_COMMANDS and defaults to `default` exactly as `gate`'s does.
  'collect-reviews': ['run'],
  'review-dispatch': ['run'],
  // No required flags: it reads the manifest and the working tree, and belongs to no run.
  'preview-check': [],
  'plan-drift': ['run', 'plan'],
  finish: ['run', 'plan'],
  'prune-run': ['run', 'plan'],
  'rebuild-state': ['run', 'plan'],
  // Belongs to no run: it reads git history and the working tree, and answers a question about
  // the repository rather than about a fleet.
  map: [],
  'map-notes': ['run'],
  digest: ['run'],
  claim: ['run', 'task', 'by'],
  unclaim: ['run', 'task'],
  workflow: ['run', 'phase'],
  complete: ['run', 'task', 'plan'],
  fix: ['run', 'phase', 'verdict'],
  'record-fix-round': ['run', 'phase', 'task'],
  // Recorded explicitly as taking no required flags rather than relying on the `?? []`
  // fallthrough: a command absent from this map also skips the whole missing-argument
  // branch, so the omission would read as "not a command" to anyone auditing the table.
  config: [],
}

// Every flag each command actually reads. An unknown flag is refused rather than ignored: a
// swallowed `workflow --commits 5000` exits 0 while the operator believes the coupling window
// widened, which is the silent-wrong-answer class this CLI removes everywhere else. `parseFlags`
// accepts any `--name`, so without this table a mistyped, renamed or hallucinated flag is
// indistinguishable from one the command acts on.
//
// This is a WHITELIST, and a command absent from it is unchecked — so a new command must be
// added here as well as to REQUIRED, or its flags go unvalidated. Every command this CLI
// dispatches is listed, including the ones taking nothing at all.
export const UNIVERSAL_FLAGS = new Set(['root'])
export const KNOWN_FLAGS = {
  'init-run': ['run'],
  gate: ['run', 'plan', 'base', 'phase', 'no-fleet', 'results'],
  doctor: ['run', 'plan', 'base', 'run-branch'],
  liveness: ['run', 'plan', 'stale'],
  digest: ['run'],
  claim: ['run', 'task', 'by'],
  unclaim: ['run', 'task'],
  workflow: ['run', 'phase', 'models', 'plan', 'base'],
  complete: ['run', 'task', 'plan', 'base', 'phase'],
  fix: ['run', 'phase', 'verdict'],
  'record-fix-round': ['run', 'phase', 'task'],
  'review-dispatch': ['run', 'phase', 'models'],
  'collect-reviews': ['run', 'phase'],
  'preview-check': [],
  'plan-drift': ['run', 'plan', 'base'],
  finish: ['run', 'plan', 'base', 'results', 'enforcement-only'],
  'prune-run': ['run', 'plan', 'base', 'yes', 'results', 'enforcement-only'],
  'rebuild-state': ['run', 'plan', 'base', 'force'],
  map: ['files', 'commits', 'top'],
  'map-notes': ['run', 'write'],
  config: ['local'],
}

function unknownFlags(command, flags) {
  const known = KNOWN_FLAGS[command]
  if (!known) return []
  const allowed = new Set([...known, ...UNIVERSAL_FLAGS])
  return Object.keys(flags).filter((f) => !allowed.has(f))
}

// Commands whose `--phase` names a numeric plan phase, not a manifest phase key. `gate` is
// deliberately absent: its `--phase` is a NAME (`default`, `integration`) that selects a
// block of checks from teammates.gate.json.
const NUMERIC_PHASE_COMMANDS = new Set(['workflow', 'fix', 'record-fix-round'])

// Every command that accepts caller-supplied check results. `gate` takes a flat list for the one
// phase it computes; `finish` and `prune-run` recompute every phase, so theirs is keyed by phase.
const RESULTS_COMMANDS = new Set(['gate', 'finish', 'prune-run'])

// `finish` and `prune-run` recompute every phase, and a `command` check is the expensive part of
// every one of them: on a run with three phases and a test suite per phase, `finish` costs three
// full suites to answer "is this run finished", and `prune-run` has timed out at 120s deciding
// whether a directory could be deleted. `--enforcement-only` asks the narrower question those
// two callers usually mean — does the enforcement still hold — and pays only for the checks that
// answer it.
//
// Only `command` checks are dropped. Everything else runs exactly as it otherwise would: the
// always-enforced kinds (`fileset`, `ownership`, and the `merge` result `runChecks` computes for
// itself) are the point of the flag, and a manifest kind with no runner must still land as the
// blocking `pending` it always was rather than disappear from the list.
//
// Every dropped check is recorded as `skip` — never omitted, and never `pass`. `aggregateVerdict`
// collects skips and both callers below print them by name, because a verdict that hides which
// checks did not run is worse than a slow one. It follows that this flag can report PASS where a
// full run would have reported FAIL: that is what it buys, and the printed skip list is the only
// thing that says so.
//
// Two guards keep that trade from becoming a lie, because a `skip` result is still a result and
// `aggregateVerdict` counts it toward the fail-closed "at least one check ran" clause that stops
// a self-generated result reading as a verified phase:
//
//   - `enforcementOnlyRefusal` below refuses the whole invocation for a phase that declares no
//     enforcement check at all. Without it, a manifest of nothing but a failing `command` check
//     produced "phase 1 PASS   skipped: test" and then "the run branch is ready to land", exit 0,
//     where the identical state without the flag exits 1 — a run declared landable having
//     verified nothing.
//   - `prune-run` below refuses to PRUNE any phase whose verdict rests on a check THIS FLAG
//     skipped. A cheap verdict is enough to report; it is never enough to run
//     `git worktree remove --force` over a teammate's uncommitted work.
const ENFORCEMENT_ONLY_SKIP = 'skipped by --enforcement-only: this verdict reports the enforcement checks, not whether the merged tree works'

// Marks a `skip` this flag synthesised, as opposed to one that arrived any other way. Three
// sources produce a `skip`, and they are not the same act:
//
//   - this flag, which drops a check the caller did not ask about and nobody ran;
//   - `--results`, where `skip` is one of the three statuses a caller may supply — a deliberate
//     assertion that the check did not run and that they accept it, which is evidence given, not
//     evidence missing;
//   - `runChecks` itself, which skips `command` checks when the phase does not merge; there the
//     `merge` check fails, so the phase never reaches a PASS to be pruned on anyway.
//
// Only the first is this flag's business. Refusing to prune on any of the three made a supplied
// `skip` unprunable with no remedy the caller could follow — they never passed the flag they were
// told to drop, and the only way forward would have been rewriting their `skip` as a `pass`.
const ENFORCEMENT_ONLY_SKIPPED = Symbol('skipped by --enforcement-only')

// The enforcement kinds a manifest can actually declare. `merge` is deliberately absent even
// though it is enforced: the gate computes it for itself, `aggregateVerdict` excludes it from the
// same "something was verified" clause for exactly that reason, and a manifest entry claiming it
// finds no runner and lands as a blocking pending. So a phase whose only enforced kind were
// `merge` has declared no enforcement, and counting it here would reopen the hole this closes.
const MANIFEST_ENFORCED_KINDS = new Set(['fileset', 'ownership'])

// Returns the refusal message when `--enforcement-only` cannot answer for some phase, or null.
// Checked before a single check runs, so the caller learns the flag is the wrong tool for this
// manifest rather than reading a verdict that was never grounded in anything.
function enforcementOnlyRefusal(config, phases) {
  const barren = phases.filter((p) => !checksForPhase(config, String(p)).some((c) => MANIFEST_ENFORCED_KINDS.has(c.kind)))
  if (barren.length === 0) return null
  return `--enforcement-only cannot answer for phase ${barren.join(', ')}: `
    + `that phase's manifest declares no ${[...MANIFEST_ENFORCED_KINDS].join(' or ')} check, so dropping its command checks would leave nothing verified at all.`
    + ' Re-run without --enforcement-only, or declare an enforcement check for it.'
}

function commandChecks(checks) {
  return checks.filter((c) => c.kind === 'command')
}

async function runPhaseChecks(checks, ctx, enforcementOnly) {
  if (!enforcementOnly) return runChecks(checks, ctx)
  const results = await runChecks(checks.filter((c) => c.kind !== 'command'), ctx)
  return [
    ...results,
    // `optional` is read off the manifest exactly as gate-runner's own `checkResult` reads it, so
    // every result in the list has the same shape whoever built it. It changes no verdict here:
    // `aggregateVerdict` reads `optional` only for `fail` and `pending`, never for `skip`.
    // Set for consistency, not for consequence.
    ...commandChecks(checks).map((c) => ({
      name: c.name,
      kind: c.kind,
      status: 'skip',
      output: ENFORCEMENT_ONLY_SKIP,
      optional: c.optional === true,
      // A symbol, not a string field: `--results` is parsed from JSON, which cannot express one,
      // so no supplied result can ever claim to be a skip this flag synthesised. `aggregateVerdict`
      // reports skips by name only, so the marker is read off the results list directly.
      [ENFORCEMENT_ONLY_SKIPPED]: true,
    })),
  ]
}

// Printed once, before the first check runs, when the command checks are NOT being skipped. An
// operator about to wait several minutes should be told that is what is happening and that a
// cheaper answer exists, rather than watching a silent process and reaching for the timeout.
//
// Two independent conditions, kept separate because they answer different questions:
//
//   - `checkCount === 0` silences the line entirely. It exists to explain a wait, and with
//     nothing to wait for it explained nothing. This is not the "a skipped check is always
//     reported" rule — no check is being hidden here; there is no check.
//   - `recommendEnforcementOnly` decides only the tail. Whether the wait is worth explaining and
//     whether the cheaper route exists are unrelated: a manifest of nothing but `command` checks
//     has a real wait to explain AND is exactly the barren shape `enforcementOnlyRefusal` exits 2
//     on, so it must be told about the wait and not sent to a flag that would refuse it. Gating
//     the recommendation on the count instead only reached manifests with no command checks,
//     which is the one case where the line is never printed at all.
function announceCommandChecks(io, command, checkCount, phaseCount, recommendEnforcementOnly) {
  if (checkCount === 0) return
  io.out(
    `${command}: running ${checkCount} command check${checkCount === 1 ? '' : 's'}`
    + ` across ${phaseCount} phase${phaseCount === 1 ? '' : 's'} — this is the slow part;`
    + (recommendEnforcementOnly
      ? ' pass --enforcement-only to skip them and report the enforcement checks alone'
      : ' --enforcement-only cannot shorten it, because no phase declares an enforcement check to report instead'),
  )
}

// A phase reports the checks it did not run, every time, whatever put them in that state:
// `--enforcement-only` here, and the merge-conflict skip `runChecks` produces on its own.
//
// The name is the manifest's, and `validateGate` checks the SHAPE of a phase and not the
// content of a check — so a check name is an arbitrary agent-written string, exactly like the
// name `complete` already wraps. It reaches a terminal here on the `prune-run` path, which is
// the command whose `--yes` removes worktrees, so the line saying a check did NOT run is the
// last one that should be erasable.
function reportSkipped(io, phase, verdict) {
  for (const name of verdict.skipped ?? []) io.out(`phase ${phase}: skipped: ${printable(name)}`)
}

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
// A window flag written with no value parses as boolean `true`, and `Number(true)` is 1 — so
// `map --commits` would answer, exit 0, and have read a ONE-COMMIT history. Everywhere else in
// this CLI `flags[f] === true` means "the argument is missing" (see missingArgs, and --models);
// this keeps that rule intact by refusing anything that is not a string before coercing, and
// returning NaN so the caller's single positive-integer guard reports it like any other typo.
function numericWindow(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'string') return NaN
  return Number(value)
}

// Newest mtime under a directory, pruning what git says the project ignores and visiting at most
// MAX_WALK_ENTRIES entries. `floored: true` means the cap stopped the walk, so the answer is a
// lower bound on freshness rather than a measurement — `livenessRows` reports such a row as
// `unknown` rather than as either working or stalled.
//
// `ignored` is supplied by the caller from `git.ignoredPaths`, not decided here, and it replaced a
// hardcoded `.git`/`node_modules` pair that was the wrong filter twice over: it missed every other
// generated directory (`dist`, `.next`, `target`, `.venv`), and it named `node_modules` in a
// project that might legitimately track it. A repository with any of those floored every walk, and
// a floored row could never be stalled, so the command's only failure signal was inert on exactly
// the repositories it exists to supervise.
//
// `.git` stays hardcoded because git does not report it as ignored — it is not ignored, it is
// simply not part of the working tree — so nothing in the supplied set can cover it.
//
// Both the cap and this function are exported so the suite walks a real tree of MAX_WALK_ENTRIES+1
// entries rather than being told the flag: a walk that always floors reports no stall ever, while
// every unit test on the synthetic flag stays green. That is not hypothetical — it is how the
// branch was found unpinned.
export const MAX_WALK_ENTRIES = 5000
const WALK_SKIP = new Set(['.git'])

// What each unmeasured row means and what to do about it. `livenessRows` names the reason and this
// supplies the prose, so the pure module stays free of wording and the two cannot be conflated in
// the output — they call for different actions, and "not measured" with no cause named is close to
// useless to whoever is holding the heartbeat.
const UNMEASURED_REASONS = [
  ['walk-capped', `the worktree walk hit its ${MAX_WALK_ENTRIES}-entry cap, so the newest file may be one it never`
    + ' reached. Add the generated directory to the project .gitignore — the walk skips what git ignores.'],
  ['no-worktree-measurement', 'no worktree of that branch could be read, so nothing looked at whether files are'
    + ' being edited. Either none is registered — a teammate dispatched without worktree isolation, or working in'
    + ' the main worktree — or its directory is gone. This is not a stall; look at that teammate directly.'],
]

export async function newestMtime(dir, { ignored = new Set() } = {}) {
  let newest = null
  let visited = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      // A worktree deleted without `git worktree prune` is still listed by git, so this is a state
      // git produces routinely rather than a rare race. It is not an error worth failing the
      // report over; it is the absence of evidence, which the caller already represents as a
      // missing touch record.
      continue
    }
    for (const entry of entries) {
      if (visited >= MAX_WALK_ENTRIES) return { at: newest, floored: true }
      visited += 1
      if (WALK_SKIP.has(entry.name)) continue
      const full = path.join(current, entry.name)
      // git reports ignored paths relative to the worktree root, with forward slashes, and a
      // whole ignored directory carries a trailing slash. Both spellings are tested, because a
      // rule can ignore a single file as easily as a directory.
      const rel = path.relative(dir, full).split(path.sep).join('/')
      if (ignored.has(rel) || ignored.has(`${rel}/`)) continue
      if (entry.isDirectory()) { stack.push(full); continue }
      try {
        const st = await stat(full)
        if (newest == null || st.mtimeMs > newest) newest = st.mtimeMs
      } catch { /* a link whose target is gone, or a file removed mid-walk; same reasoning */ }
    }
  }
  return { at: newest, floored: false }
}

function missingArgs(command, flags, positional) {
  // `=== true`, not `!== undefined`: solo mode is entered only by the one spelling that means
  // it. parseFlags already refuses `--no-fleet <value>` outright, and this is the second half
  // of the same rule — the check that decides whether the enforcement checks run should test
  // for the switch being SET, not merely for something having been written after it.
  const solo = command === 'gate' && flags['no-fleet'] === true
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
  //
  // An EMPTY value is the same missing argument in the other spelling — `--results ""` is what
  // an unset `$RESULTS` templated *quoted* produces, where templated unquoted it produces the
  // bare `--results` above. Only the bare form was caught, so the quoted one fell through to
  // the gate's own `if (flags.results)` truthiness test, which skipped the supplied-results
  // block entirely and exited 1 on the still-pending checks with nothing said about the flag.
  // Both spellings of one mistake now get one answer, exactly as `--root` already does.
  //
  // `finish` and `prune-run` take the same flag, in the same per-phase spelling, so they get the
  // same refusal: three commands reading one flag must not disagree about what a valueless one
  // means, or the two that skip it silently report a run finished on evidence nobody supplied.
  if (RESULTS_COMMANDS.has(command)
    && (flags.results === true || (typeof flags.results === 'string' && flags.results.trim() === ''))) {
    missing.push('--results <path>')
  }
  return missing
}

// The `## Global Constraints` section is plan-wide, so every dispatch in every phase carries
// the same list. It is read from the plan markdown rather than restated per task: a constraint
// that has to be repeated is a constraint that will drift.
//
// The section ends at the next heading of ANY level, not just `##`. A task heading is `###`
// and its file list is a bullet list; terminating only on `##` would sweep every task's files
// into the constraints every teammate is told it must obey. Scanning for the terminator with
// a second exec on the remainder — rather than one regex with a lookahead — keeps the
// end-of-file case honest: JS has no `\Z` anchor, and `\Z` inside a pattern is an identity
// escape matching a literal "Z", which would silently drop a section that ends the file.
export function parseConstraints(markdown) {
  const text = String(markdown ?? '')
  const heading = /^##\s+Global Constraints\s*$/m.exec(text)
  if (!heading) return []
  const rest = text.slice(heading.index + heading[0].length)
  const next = /^#{1,6}\s/m.exec(rest)
  const items = []
  // A bullet wrapped over two lines is one constraint, not a truncated one. Keeping only
  // the first line would hand every teammate the opening clause of a rule and silently
  // drop the rest — the failure is invisible in the brief, which reads as a complete
  // sentence. An indented, non-blank line directly under an item is joined onto it; a
  // blank line closes the item, so a following indented paragraph is not swallowed. A
  // nested bullet matches the bullet pattern first and so stays a standalone constraint.
  //
  // The continuation test excludes an indented line that is itself bullet-shaped (`- ` or a
  // bare `-`), so a line the bullet pattern rejects is dropped rather than appended. Joining
  // it would fuse two unrelated rules into a single constraint that reads as one sentence and
  // says what neither author wrote; a dropped malformed rule is the lesser failure, and the
  // only one that cannot silently misinform a teammate. The lookahead is `-\s|-$` rather than
  // a bare `-`, so a continuation that merely *starts* with a hyphen still joins: `--no-ff`
  // opens a rule's second line in this project's own constraints, and excluding every leading
  // hyphen would truncate it into a sentence that reads complete.
  //
  // Both patterns use `[^\n]` rather than `.`: `.` does not match U+2028/U+2029 while `\s`
  // does, so a bullet whose text contains one failed the bullet pattern entirely and was
  // dropped with no diagnostic — a rule the plan states that reaches no teammate.
  let open = false
  for (const line of (next ? rest.slice(0, next.index) : rest).split('\n')) {
    const bullet = /^\s*-\s+([^\n]*\S)\s*$/.exec(line)
    if (bullet) {
      items.push(bullet[1])
      open = true
    } else if (open && /^\s+(?!-\s|-$)\S/.test(line)) {
      items[items.length - 1] += ` ${line.trim()}`
    } else {
      open = false
    }
  }
  return items
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
// Provenance, not authority: `response` is the reviewer's returned result, `file` is one
// recovered from the findings file it wrote before idling without returning. The distinction
// exists nowhere else — a recovered review and a returned one produce identical verdicts — so
// without carrying it here, "this lens was paid for twice / was nearly lost" is unrecorded.
// Unset means `response`, because that is the ordinary path.
const SUPPLIED_SOURCES = new Set(['response', 'file'])

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
    // `r?.name` goes out through `JSON.stringify`, which escapes a control byte to `\uXXXX`
    // and is sufficient on its own; `check.kind` and `check.name` below are spliced bare into
    // the sentence, so those take `printable`. Both halves are agent-written — the difference
    // is only in how each reaches the line.
    if (duplicated.has(r?.name)) {
      return `--results names a check declared more than once in this phase's manifest: ${JSON.stringify(r?.name)}`
    }
    const check = byName.get(r?.name)
    if (!check) return `--results names a check not in this phase's manifest: ${JSON.stringify(r?.name)}`
    if (!SUPPLIABLE_KINDS.has(check.kind)) return `--results may not supply a ${printable(check.kind)} check: ${printable(check.name)}`
    if (!SUPPLIED_STATUSES.has(r.status)) return `--results carries an unrecognized status for ${printable(check.name)}: ${JSON.stringify(r.status)}`
    if (r.source !== undefined && !SUPPLIED_SOURCES.has(r.source)) {
      return `--results carries an unrecognized source for ${printable(check.name)}: ${JSON.stringify(r.source)} (expected "response" or "file")`
    }
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
      // Provenance travels with the result into the recorded verdict. It is deliberately not
      // read by aggregateVerdict: a review recovered from a file is worth exactly as much as
      // one that was returned — the file is written by the reviewer either way.
      source: s.source ?? 'response',
    }
  })
}

// The per-phase counterpart of `gate`'s `--results` read. Same three answers: no flag means no
// supplied evidence, an unreadable or malformed file is refused BY NAME, and a shape that is not
// `{ phases: { "<n>": { results: [...] } } }` is refused with the shape it expected. Only the
// SHAPE is checked here — which results may be supplied at all is `validateSuppliedResults`'s
// rule, and it is applied per phase against that phase's own manifest block.
const SUPPLIED_REJECTED = Symbol('supplied phase results rejected')

async function readSuppliedPhases(flags, io) {
  // A valueless or empty `--results` never reaches here: missingArgs rejects it as the missing
  // argument it is, rather than letting this truthiness test silently drop the flag.
  if (!flags.results) return null
  let parsed
  try {
    parsed = JSON.parse(await readFile(flags.results, 'utf8'))
  } catch (err) {
    // Node embeds a slice of the parsed input in a JSON parse error, so this message carries
    // bytes out of the agent-written file it failed on. `printable`, for the reason every other
    // quoted value here goes through it: see its definition in `reviews.mjs`.
    io.out(`--results ${printable(flags.results)} could not be read as JSON: ${printable(err.message)}`)
    return SUPPLIED_REJECTED
  }
  const invalid = validateSuppliedPhases(parsed)
  if (invalid) {
    io.out(invalid)
    return SUPPLIED_REJECTED
  }
  return parsed
}

// A supplied block keyed to a phase the run does not have is read by NOBODY: evidence is looked
// up with `suppliedForPhase(supplied, phase)` for phases taken from the plan, so a key naming no
// real phase is never consulted — including one carrying a `command` result, which under a real
// phase is refused with exit 2. An operator with a typo'd phase key would otherwise get a pending
// report and no hint their evidence was discarded.
//
// Reported, never refused. Dropping the block is already the safe direction — unmatched evidence
// changes no verdict — so this exists only so the output stops lying by omission.
//
// The keys are printed BARE, and that is safe only because of a constraint stated elsewhere:
// `validateSuppliedPhases` in `scripts/finish.mjs` refuses any key for which
// `String(Number(key)) !== key`, so every key that reaches here is the canonical decimal form of
// an integer and can carry no control byte. Both callers run that validator first —
// `readSuppliedPhases` returns SUPPLIED_REJECTED on its refusal and both return 2 on it — so a
// key with bytes in it never gets this far. That refusal is pinned by 'a numeric phase key that
// is not its own canonical form is refused' in `tests/finish.test.mjs`; if it is ever loosened,
// these keys need `printable` like every other quoted value here. The `phases` half of the
// sentence is a list of integers `assignPhases` computed, never read from anything.
function reportUnmatchedSuppliedPhases(io, supplied, phases) {
  const byPhase = supplied?.phases
  if (!byPhase || typeof byPhase !== 'object') return
  const real = new Set(phases.map((p) => String(p)))
  const unmatched = Object.keys(byPhase).filter((key) => !real.has(key))
  if (unmatched.length === 0) return
  io.out(
    `--results supplies evidence for phase ${unmatched.join(', ')}, which this run does not have`
    + ` (its phases are ${phases.join(', ') || 'none'}) — that evidence was not used`,
  )
}

// How deep the link sweep below will walk. A `preview.link` entry is a repo-relative directory
// path, so a handful of segments covers every shape the manifest can declare; reaching the limit
// means a tree this cannot vouch for, and it THROWS rather than returning quietly — a partial
// sweep followed by a removal is the exact failure the sweep exists to prevent.
const PREVIEW_LINK_MAX_DEPTH = 12

// Remove the links a merge preview was provisioned with, before the worktree itself is removed.
//
// `git worktree remove --force` FOLLOWS a junction: verified against a throwaway fixture on
// Windows — a junction created inside a worktree with fs.symlink(target, link, 'junction'), which
// is exactly what scripts/preview-links.mjs creates, exits 0 and deletes THE CONTENTS OF THE LINK
// TARGET. On an operator's machine that target is the repository's real `node_modules`, wiped by
// `prune-run --yes`. `rm -rf` has the same behaviour and is no safer.
//
// This is not a rare shape. A leaked preview is BY CONSTRUCTION one whose `teardownLinks` never
// ran — scripts/merge-preview.mjs runs it in a `finally`, which a SIGKILL skips — so a leaked
// preview is precisely the case most likely to still hold its junctions.
//
// The sweep is the caller's own: it never follows a link (every entry is `lstat`ed, and only a
// real directory is descended into), so nothing outside the preview tree is ever read or written.
// Any failure propagates, and the caller must leave that worktree in place: an unremovable link
// is a reason not to remove the worktree, never a footnote under a removal that happened anyway.
async function unlinkPreviewLinks(dir, depth = 0) {
  if (depth > PREVIEW_LINK_MAX_DEPTH) {
    throw new Error(`nested deeper than ${PREVIEW_LINK_MAX_DEPTH} levels at ${dir}, so its links cannot be accounted for`)
  }
  let removed = 0
  for (const name of await readdir(dir)) {
    const entry = path.join(dir, name)
    // lstat, never stat: a junction or symlink must be seen as itself. `stat` reports the TARGET's
    // type, which is how a link to a directory reads as a directory and gets descended into.
    const info = await lstat(entry)
    if (info.isSymbolicLink()) {
      await unlink(entry)
      removed += 1
      continue
    }
    if (info.isDirectory()) removed += await unlinkPreviewLinks(entry, depth + 1)
  }
  return removed
}

// Which of these previews an owner is still HOLDING.
//
// scripts/merge-preview.mjs writes a marker BESIDE the preview directory before it calls
// `git worktree add`, and releases it only after `removeWorktree` has deregistered the worktree.
// Git registers a worktree at the START of the add and deregisters it at the end of the removal,
// so the span over which the marker is held contains the span over which the preview is
// observable here — which is what makes this different in kind from an mtime or a registration
// age. Those are sampled by the reaper and only narrow the window; this is held by the owner, so
// there is no instant at which a living owner reads as absent.
//
// THREE FAIL-SAFE BRANCHES, all deliberate, all saying the same thing: an owner that cannot be
// RULED OUT is an owner.
//
//   1. A marker that cannot be READ for any reason other than ENOENT — EACCES, EBUSY, EIO. The
//      file is there and could not be opened, so its pid is unknown.
//   2. A marker that will not PARSE as a positive integer.
//   3. A probe that fails with anything other than ESRCH — EPERM means the pid exists and
//      belongs to another OS user, which is a gate this process may not signal, not one that
//      is gone.
//
// An unreaped preview costs the operator a directory; a followed junction costs them their
// repository's build inputs. Only ENOENT and ESRCH — the two answers that positively mean "no
// owner" — let a preview through.
//
// `read` and `probe` are injectable because two of those three branches cannot be staged end to
// end: EPERM needs a process owned by another user, and EACCES needs a file this user cannot
// read. Exported for the same reason `isMissingPreviewRoot` is — each branch is on the
// destructive path and has to be pinned on its own.
export async function livePreviewPaths(previewPaths, {
  read = (p) => readFile(p, 'utf8'),
  // Signal 0 sends nothing: it only asks whether the pid can be signalled at all.
  probe = (pid) => process.kill(pid, 0),
} = {}) {
  const live = new Set()
  for (const dir of previewPaths) {
    let raw
    try {
      raw = await read(previewOwnerMarkerPath(dir))
    } catch (err) {
      // ENOENT is the only "no marker": a preview from before markers existed, or one whose
      // owner has already released it. Every other failure leaves the owner unknown.
      if (err?.code !== 'ENOENT') live.add(dir)
      continue
    }
    const pid = Number.parseInt(String(raw).trim(), 10)
    if (!Number.isInteger(pid) || pid <= 0) { live.add(dir); continue }
    try {
      probe(pid)
      live.add(dir)
    } catch (err) {
      if (err?.code !== 'ESRCH') live.add(dir)
    }
  }
  return live
}

// "The preview root is not there at all", told apart from every other sweep failure.
//
// It is a state that really occurs: scripts/merge-preview.mjs removes the directory after
// `git.removeWorktree(dir).catch(() => {})`, so a removal that failed leaves the worktree
// registered with its directory gone, and a temp cleaner produces the same state unaided.
// `git worktree list --porcelain` still reports that path, so it still enters `plan.previews`,
// and the sweep's `readdir` then throws ENOENT. Treated as a failed sweep, that deadlocks:
// `prune-run --yes` exits 1 on every subsequent run and the stale registration — which
// `git worktree remove --force` clears happily, missing directory and all — can never be
// cleared. The printed reason would be false as well: a directory that is not there holds no
// links to sweep, so nothing is being left in place to protect a link target.
//
// Narrow on purpose, and BOTH clauses carry weight — each is on the destructive path, because a
// `true` here skips the `continue` and lets `git worktree remove --force` run with the preview's
// junctions still in place, which deletes the CONTENTS of their targets:
//
//   - only ENOENT. An EACCES, EPERM or EBUSY `readdir` on the preview root is a directory that IS
//     there and could not be read, so its links are unaccounted for and it must block.
//   - only on the ROOT the sweep was asked to walk. An ENOENT deeper in the tree is a directory
//     disappearing mid-sweep — exactly the concurrent mutation a worktree must not be removed on
//     top of — and it says nothing about whether the root's own links were swept.
//
// Exported so each clause can be pinned on its own. The end-to-end tests can only construct a
// sweep failure that trips one clause at a time by accident (the depth guard's plain Error has no
// `.path`; an ENOENT deep in the tree is a race no test can stage deterministically), so deleting
// either clause left the whole suite green — a test passing for the wrong reason.
export function isMissingPreviewRoot(err, dir) {
  return Boolean(err)
    && err.code === 'ENOENT'
    && typeof err.path === 'string'
    && path.resolve(err.path) === path.resolve(dir)
}

// The task branches of a phase, resolved to the shas they stand at right now. This is what a
// review stamp names: findings describe a diff, and a diff is only identified by its tips.
function tasksOfPhase(plan, phaseName) {
  // `--phase` names the MANIFEST key, as it does for `gate`. When it is also a plan phase number
  // the branches narrow to that phase; when it is not, every task branch of the run is in scope,
  // which is the honest reading of "this manifest phase's diff".
  const phaseNumber = Number(phaseName)
  return Number.isInteger(phaseNumber)
    ? (plan.tasks ?? []).filter((t) => t.phase === phaseNumber)
    : (plan.tasks ?? [])
}

async function resolveBranchShas(git, tasks, runId) {
  const branchShas = {}
  for (const task of tasks) {
    const branch = resolveTaskBranch(task, runId)
    // Through refs/heads/, so a tag named like a branch cannot stand in for one — the same
    // resolution rule deriveContext uses for the anchor.
    if (branch && await git.branchExists(branch)) branchShas[branch] = await git.resolveRef(`refs/heads/${branch}`)
  }
  return branchShas
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

// Everything this CLI can say about a failed config operation, or null for an error that is
// not one — a real bug must still crash rather than be reported as a config problem.
//
// A ConfigError is a stated rejection and carries its own wording. A Node system error is a
// layer file that exists but cannot be read or written (a directory created in its place, a
// permission error): left alone it escapes as an unhandled rejection with a raw stack and exit
// 1, which a skill branching on this CLI's exit code reads as neither a pass nor a stated
// failure. `syscall` is what distinguishes an fs error from an ordinary Error carrying a
// `code` property.
// Both messages quote the manifest back. A ConfigError names the key it rejected, and a phase
// key, an `agents.<role>` field name and an unknown role are all arbitrary strings out of the
// file; the JSON parse error is worse still, because Node embeds a slice of the RAW FILE BYTES
// in `err.message`. That is the same hazard `readSuppliedPhases` wraps for a `--results` file,
// arriving through the manifest instead, and it reaches almost every subcommand at exit 2.
// Wrapped at this single boundary rather than at each `throw` in `config.mjs`, so a message
// added there is covered on the day it is added.
function configFailureMessage(err) {
  if (err instanceof ConfigError) return printable(err.message)
  if (typeof err?.syscall === 'string') return `could not access the config layers: ${printable(err.message)}`
  return null
}

// The single reader. `loadConfig` validates the LOCAL layer and, until T9 lands, keeps the
// tracked one as `(readLayer ?? {})` — so `teammates.gate.json` holding `[]` resolved every key
// to its default at exit 0 while the same body on the local side exited 2. Both layers are
// validated here, on the way out, so a reader and a writer cannot disagree about a file and the
// two layers cannot disagree with each other. Every read path in this module goes through it.
async function loadValidatedConfig(root) {
  const config = await loadConfig(root)
  validateGateLayer(config.gate)
  return config
}

// `loadValidatedConfig` throws on a malformed or over-reaching layer, and every command below
// branches on this CLI's exit code. Resolving through here turns that into the message-and-2
// the rest of the CLI already guarantees, instead of a stack trace from whichever command
// happened to read the layer first. `null` means "already reported, exit 2".
// Shared by `workflow` and `review-dispatch`: both hand a tier→model map straight into a
// generated dispatch, so both need the same refusals. Kept as one function rather than two
// copies, because a copy that drifts turns "a model name is a non-empty string" into a rule
// that holds for implementers and not for the reviewer grading their work.
const TIER_MODELS_REJECTED = Symbol('tier models rejected')

function parseTierModels(flags, io) {
  // `--models` written as a bare switch parses as `true` (parseFlags's boolean-switch
  // reading). Skipping it silently would exit 0 with a model-free dispatch — the caller
  // asked for routing and got none, with nothing on stdout to say so. Treated as the
  // missing argument it is, exactly as missingArgs treats `=== true` for required flags.
  if (flags.models === true) {
    io.out('--models needs a value: a JSON object mapping tiers to model names')
    return TIER_MODELS_REJECTED
  }
  if (flags.models === undefined) return undefined

  let tierModels
  try {
    tierModels = JSON.parse(flags.models)
  } catch {
    // A caller branches on this exit code. A malformed map must produce a message and
    // 2, never a raw SyntaxError stack from deep inside JSON.parse.
    io.out('--models must be a JSON object mapping tiers to model names')
    return TIER_MODELS_REJECTED
  }
  if (tierModels === null || typeof tierModels !== 'object' || Array.isArray(tierModels)) {
    io.out('--models must be a JSON object mapping tiers to model names')
    return TIER_MODELS_REJECTED
  }
  // The container being an object is not enough: every value is emitted verbatim into
  // the generated task list AND spread into the agent() options, so a nested object, a
  // number or an empty string becomes a `model` field no dispatcher can act on and no
  // reader can spot. A model name is a non-empty string or it is a mistake.
  for (const [tier, model] of Object.entries(tierModels)) {
    if (typeof model !== 'string' || model.trim() === '') {
      io.out(`--models value for '${tier}' must be a non-empty string model name`)
      return TIER_MODELS_REJECTED
    }
  }
  return tierModels
}

async function resolveConfig(root, io) {
  try {
    return (await loadValidatedConfig(root)).resolved
  } catch (err) {
    const message = configFailureMessage(err)
    if (message === null) throw err
    io.out(message)
    return null
  }
}

// `gate`, `complete` and `fix` read the manifest through `loadGateConfig`, which parses and does
// not validate — a third reader alongside `loadConfig` and the write path, covered by neither
// validator. It fails CLOSED (a body of `[]` yields zero checks and `aggregateVerdict` returns
// FAIL on its `verified.length > 0` guard), so this was never a hole. It was a diagnostics one:
// the operator saw a failing gate and nothing naming the file, and `{"phases":{"default":
// {"checks":"nope"}}}` crashed with a TypeError whose stdout is not the JSON a skill parses.
//
// Validated here, at the consumer, rather than inside `loadGateConfig` — that function is also
// the plain reader `self-gate` and the gate-config tests use, and the tripwire test in
// tests/config.test.mjs pins it staying that way. Read through `readLayer` so a manifest that is
// not valid JSON is a ConfigError like everywhere else, instead of a SyntaxError escaping raw.
const GATE_CONFIG_REJECTED = Symbol('gate manifest rejected')

async function resolveGateConfig(root, io) {
  try {
    const raw = await readLayer(root, GATE_FILE, { missing: ABSENT })
    // `null` means no manifest, which each of the three callers answers on its own terms —
    // `gate` infers one and exits 3, `complete` refuses at 4, `fix` falls back to defaults.
    // Only a manifest that is PRESENT and broken is this function's business.
    return raw === ABSENT ? null : validateGateLayer(raw)
  } catch (err) {
    const message = configFailureMessage(err)
    if (message === null) throw err
    io.out(message)
    return GATE_CONFIG_REJECTED
  }
}

// Every key this CLI can resolve, as a single field. `set` gets this check from `validateKey`,
// which needs a value; `get` and `unset` have none to give it, and without an equivalent
// `config unset totallyBogus` created the file, gitignored it, reported `wrote …` and exited 0
// having removed nothing, while `config get agents.implementer` printed `[object Object]`.
const CONFIG_KEYS = [
  'maxParallel',
  'caveman',
  ...ROLES.flatMap((role) => [`agents.${role}.tier`, `agents.${role}.effort`]),
]

// `unset` may also name one role's entry — `agents.implementer` is a real subtree of the layer
// and removing it removes exactly the fields this layer knows about. The bare segment `agents`
// is NOT in this set, and that is the point: it is a prefix of every role including the
// reviewer's, `isEnforcementKey('agents')` is false, so `config unset agents --local` walked
// straight past the enforcement guard and wiped the reviewer's tier and effort along with
// everyone else's. A key that can reach an enforcement field is not an ergonomics key.
const UNSETTABLE_KEYS = [...CONFIG_KEYS, ...ROLES.map((role) => `agents.${role}`)]

// One rejection wording for all three subcommands: a key nothing reads is the same answer
// whether the caller asked to read it, write it or remove it.
function assertKnownKey(dotted, allowed) {
  if (!allowed.includes(dotted)) throw new ConfigError(`unknown config key: ${dotted}`)
}

// Both layers, symmetrically. `readLayer` parses but does not validate, and the `?? {}` that
// follows it only replaces a NULLISH body — a layer whose whole body is `[]` or `"text"`
// survives it, `setKey` then writes a property `JSON.stringify` drops (a silent no-op reported
// as `wrote …`, exit 0) or dies with a raw TypeError. `config list` already exits 2 on both of
// those bodies, so leaving the write path unchecked had one CLI giving two answers about one
// file.
//
// The gate layer's check is `validateGate` from scripts/config.mjs the moment that export
// exists: T9 adds it and is merging into this phase alongside this task, but at the commit this
// branch is based on it is not there, and creating it would mean editing a file outside this
// task's declared set. Resolved once, here, so this path runs exactly one validator either way
// — never a local copy competing with T9's stricter one.
const validateGateLayer = configModule.validateGate ?? ((gate) => {
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) {
    throw new ConfigError(`${GATE_FILE} must contain a JSON object`)
  }
  return gate
})

// The local layer's own rules (no enforcement keys, no unknown keys) sit ON TOP of the same
// shape check the gate layer gets — validateLocal already rejects a non-object body itself.
function validateLayer(file, layer) {
  return file === LOCAL_FILE ? validateLocal(layer) : validateGateLayer(layer)
}

// Tells a missing file apart from one whose whole body is `null`; readLayer's default answer is
// the same `null` for both.
const ABSENT = Symbol('absent layer')

// Every READER validates both layers through `loadValidatedConfig`; the write path validated
// only the layer it was writing. So `config set maxParallel 3 --local` exited 0 against a repo
// whose `teammates.gate.json` was malformed, while `config list` on that same repo exited 2 —
// one CLI, two answers about one repository. The same shape as the layer-and-spelling asymmetries
// fixed in the read path and in `loadConfig`: a guard applied to one side and not its counterpart.
//
// Gate first, then local, which is `loadConfig`'s own order — a repo broken in both layers must
// name the same file whichever command the operator reached for. The layer being written is
// validated from the object already in hand rather than re-read, so this adds one read, not two.
async function validateBothLayers(root, targetFile, targetLayer) {
  for (const file of [GATE_FILE, LOCAL_FILE]) {
    if (file === targetFile) {
      validateLayer(file, targetLayer)
      continue
    }
    const raw = await readLayer(root, file, { missing: ABSENT })
    // An absent counterpart is the ordinary case, never a failure: a project with no manifest
    // must still be able to write a local override, and vice versa.
    if (raw !== ABSENT) validateLayer(file, raw)
  }
}

// `.gitignore` has no effect on a path git already tracks: the entry is written, the file goes
// on being committed, and the trust split the "added …" message claims — this layer is
// untracked, so a teammate cannot change it without leaving the dirty worktree `fileset` and
// `ownership` detect — silently does not hold. Reported rather than claimed.
//
// Any failure means no answer, which is reported as "not tracked": outside a git repository
// there is nothing to be tracked by, and this must never be the thing that fails a write.
async function isTracked(root, file) {
  try {
    const { code } = await defaultGitExec(['ls-files', '--error-unmatch', '--', file], root)
    return code === 0
  } catch {
    return false
  }
}

// `git ls-files` reports paths relative to the CURRENT DIRECTORY, while `git log --name-only`
// reports them relative to the REPOSITORY ROOT. `map` reads both and keys one against the other,
// so run anywhere below the root the two halves stopped being the same namespace: a file 100%
// coupled by history was reported as "no coupled files found", and the overview printed
// root-relative pairs beside cwd-relative directory rows. The prefix that reconciles them is what
// git itself calls it — `rev-parse --show-prefix` — and everything cwd-relative, including the
// caller's own --files argument, is lifted through it before any key is compared.
//
// This lives here rather than in scripts/git.mjs deliberately: it is a fix to how `map` composes
// two existing primitives, not a new primitive.
async function repoPrefix(root) {
  const { code, stdout, stderr } = await defaultGitExec(['rev-parse', '--show-prefix'], root)
  if (code !== 0) {
    throw new GitError(`git rev-parse --show-prefix failed: ${stderr.trim() || `exit ${code}`}`)
  }
  // Exactly one trailing newline is git's framing; a directory name may legally end in
  // whitespace, so nothing else is trimmed.
  return stdout.replace(/\n$/, '')
}

function toRepoPath(prefix, p) {
  const joined = `${prefix}${String(p).replace(/\\/g, '/')}`
  if (joined === '') return joined
  const normalized = path.posix.normalize(joined)
  return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

// A directory name taken from the repository is attacker-controlled data — a branch, a PR, a
// vendored dependency can all introduce one — and `map-notes` interpolates it into a prompt under
// the line "dispatch an Explore agent with exactly this prompt". Unlike the implementer brief,
// nothing downstream bounds what that agent then does, so the hint is restricted to what a
// directory name in a normal repository actually looks like: '/'-separated plain path segments.
// A name carrying a newline, a control character, quoting, or the whitespace and punctuation that
// let it read as a new instruction is DROPPED rather than escaped — the hint is orientation, and
// orientation is worth exactly nothing next to a prompt-injection foothold. Surviving names still
// render, so the signal is narrowed, never removed.
const PLAIN_SEGMENT = /^[A-Za-z0-9._+@-]+$/
export function promptSafeDirectories(dirs = []) {
  return dirs.filter((dir) => {
    if (typeof dir !== 'string' || dir === '' || dir.length > 120) return false
    const segments = dir.split('/')
    return segments.length <= 8 && segments.every((s) => PLAIN_SEGMENT.test(s))
  })
}

export async function runCli(argv, io = { out: console.log }) {
  // Two channels, not one. `io.out` carries the ANSWER a command was asked for — and for
  // `workflow` that answer is a JavaScript module a caller redirects into a file. Anything
  // that is commentary about how the answer was produced has to leave by another door, or a
  // single advisory line becomes the first statement of the generated source and the command
  // that promised never to fail the dispatch is what fails it. A caller supplying only `out`
  // keeps working: `err` defaults to console.error, exactly as `out` defaults to console.log.
  io = { err: console.error, ...io }
  const [command, ...rest] = argv
  const { flags, positional, rejected } = parseFlags(rest)
  // Refused before EVERYTHING else — before the required-argument check, before any command
  // body. A rejected spelling must not be able to reach a guard that tests the flag it was
  // meant to set: `gate --no-fleet=false` has to exit here, not after `missingArgs` has
  // already decided that a solo run needs neither --run nor --plan.
  if (rejected.length > 0) {
    const advice = rejected.map(({ raw, name }) => `\`${raw}\` — ${spellingAdvice(name)}`)
    io.out(`unsupported flag spelling: ${advice.join('; ')}\n\n${USAGE}`)
    return 2
  }
  // An empty or whitespace-only --root must never silently fall through to cwd: `??` only
  // catches `undefined`, so `--root ""` survives to become `repoRoot: ''` downstream, which
  // defeats the realpath-based containment checks in the merge preview (realpath('') rejects,
  // so both guarded escape checks in linkInto get skipped instead of enforced). Fail loudly
  // here instead of silently using the wrong root. A bare `--root` with no value at all (e.g.
  // last on the argv, or immediately followed by another flag) is the same orchestrator
  // mistake in a different guise: an unset `$PROJECT_ROOT` templated *unquoted* makes the
  // argument vanish entirely rather than become empty, so parseFlags maps it to `true`
  // instead of a string. That `true` would otherwise reach path.join() downstream and throw
  // a raw TypeError with no verdict, which must never happen.
  if (typeof flags.root !== 'undefined' && (typeof flags.root !== 'string' || flags.root.trim() === '')) {
    io.out(`--root must not be empty\n\n${USAGE}`)
    return 2
  }
  const root = flags.root ?? process.cwd()
  const runId = flags.run

  // Before the required-argument check and before any command body, for the same reason the
  // rejected spellings are: a flag this command does not read must never reach a guard that
  // acts on a DIFFERENT flag. Reported by name, so the caller sees which of its arguments the
  // command was never going to act on rather than a bare usage dump.
  const strays = unknownFlags(command, flags)
  if (strays.length > 0) {
    io.out(`${command} does not take ${strays.map((f) => `--${f}`).join(', ')}`)
    io.out(USAGE)
    return 2
  }

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
          // The tier is the value being refused, and it was never validated: `plan-parser.mjs`
          // records `**Model:**` verbatim with `(.+?)`. A refusal is the line most worth
          // forging — the command exits 2 while the operator reads a pass — so it goes through
          // `printable` exactly as the phase listing below does.
          io.out(`${printable(task.id)}: unknown model tier '${printable(task.tier)}' (expected ${TIERS.join(', ')})`)
          return 2
        }
        continue
      }
      task.tier = inferTier(task, tasks)
      task.tierSource = 'inferred'
      // Kept alongside the tier a configured one may replace below. Without it, removing the
      // configured tier leaves nothing to fall back to, and plan.json keeps a tier the run is
      // no longer dispatching at — which is the tier `fix` would go on escalating from.
      task.inferredTier = task.tier
    }

    const totalPhases = tasks.reduce((max, t) => Math.max(max, t.phase), 0)
    // The resolved value, not the manifest's: the gitignored local layer is an ergonomics
    // surface, and a parallelism it sets must actually take effect where it is consumed.
    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2

    // A configured implementer tier is an explicit operator decision and outranks inferTier's
    // guess. Applied HERE, before plan.json is written, for two reasons the in-memory override
    // in `workflow` cannot serve. First, `fix` escalates from the RECORDED tier: with the
    // record left inferred, a retry after a failure at a configured `capable` was dispatched
    // at `mid` — below the tier that just failed. Second, the tier this command prints is the
    // run's only operator-facing routing report, and it has to name what will be dispatched.
    // A declared `**Model:**` still wins: it names a task the operator already reasoned about.
    const roleTier = resolved.agents.implementer.tier
    if (roleTier) {
      for (const task of tasks) {
        if (task.tierSource !== 'declared') {
          task.tier = roleTier
          task.tierSource = 'configured'
        }
      }
    }

    await writeState(root, runId, 'plan', { runId, totalPhases, tasks })
    // Recorded for reporting only. The gate derives the anchor, the phase, and every
    // verdict from git; nothing here decides anything.
    //
    // Re-running init-run must not erase what the gate recorded. `gates` and `fixRounds` are
    // the run's only history of what passed and what it cost; a plan amendment mid-run is a
    // normal reason to re-init, and it must not silently discard them — without this, "never
    // report a phase done without a recorded PASS" becomes unsatisfiable after any re-init.
    // The spreads are conditional so a fresh run emits neither key rather than an empty
    // object, which anything testing only for presence would read as a recorded one.
    const previous = await readState(root, runId, 'status')
    await writeState(root, runId, 'status', {
      runId,
      phase: previous?.phase ?? 1,
      totalPhases,
      maxParallel: resolved.maxParallel,
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, state: 'pending' })),
      ...(previous?.gates ? { gates: previous.gates } : {}),
      ...(previous?.fixRounds ? { fixRounds: previous.fixRounds } : {}),
    })
    for (let p = 1; p <= totalPhases; p += 1) {
      // Tier and its source are printed, not just the ids: routing decides what every
      // dispatch in the phase costs, and an operator should see an inference they disagree
      // with before the run starts, while a Model line is still cheap to add.
      const ids = tasks
        .filter((t) => t.phase === p)
        // Same as `rebuild`'s listing: the id and the tier are read out of the plan file.
        .map((t) => `${printable(t.id)} (${printable(t.tier)}, ${printable(t.tierSource)})`)
        .join(', ')
      io.out(`phase ${p}: ${ids}`)
    }
    return 0
  }

  if (command === 'digest') {
    const status = await readState(root, runId, 'status')
    if (!status) { io.out(`no status for run ${runId}`); return 1 }
    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2
    io.out(renderDigest(status, Date.now(), resolved.caveman))
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
    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2

    // Concrete model names never enter this repository or teammates.gate.json — they live
    // in the dispatching skill, which passes its own tier map through here. Absent, the
    // generated agent() calls carry no model and inherit the session's, as before.
    const tierModels = parseTierModels(flags, io)
    if (tierModels === TIER_MODELS_REJECTED) return 2

    // Both are optional: omitted, the brief renders without a plan pointer and falls back to
    // its no-base variant rather than failing. A bare `--plan`/`--base` parses as `true`
    // (parseFlags's boolean-switch reading), which is the value missing, not a value — coerced
    // through it would render the literal `true` as a plan path or a branch name.
    const planPath = flags.plan === true ? '' : (flags.plan ?? '')
    const baseBranch = flags.base === true ? '' : (flags.base ?? '')

    // Read from git at the anchor, never from the working tree. `gate` and `complete` both
    // read the plan with `git show <anchor>:<planPath>` precisely so a teammate cannot widen
    // its own file set by editing the checked-out copy. Reading it here from disk left the two
    // disagreeing: the constraints injected into every brief came from mutable, uncommitted
    // markdown while the gate enforced the committed plan, so a working-tree edit between
    // phases would hand every teammate instruction text with no record in git.
    //
    // The consequence is that an uncommitted plan now fails rather than generating. That is
    // the honest outcome: a brief must not carry rules the run cannot show a reader.
    //
    // A --plan pointing at nothing is a mistake worth an exit code. Swallowing the read error
    // and generating a constraint-free brief would hand every teammate in the phase a dispatch
    // missing the very rules the caller asked to carry, with exit 0 and nothing on stdout.
    let planMarkdown = ''
    if (planPath) {
      const git = createGit({ cwd: root })
      let anchorSha
      try {
        const runBranch = await git.currentBranch()
        const baseBranch = await resolveBaseBranch(git, flags.base)
        const runSha = await git.resolveRef(`refs/heads/${runBranch}`)
        const baseSha = await git.resolveRef(`refs/heads/${baseBranch}`)
        anchorSha = await git.mergeBase(baseSha, runSha)
        // `git show <sha>:<path>` takes a repo-relative path and rejects an absolute one, but
        // --plan is commonly given as absolute (every caller that builds it from a root does).
        // Normalising here keeps both spellings working; the brief still points at the path the
        // caller wrote, since that is what a reader of the dispatch will recognise.
        const relPath = path.isAbsolute(planPath)
          ? path.relative(root, planPath).split(path.sep).join('/')
          : planPath
        planMarkdown = await git.fileAtCommit(anchorSha, relPath)
      } catch (err) {
        const where = anchorSha ? ` at anchor ${anchorSha}` : ''
        io.out(
          `--plan ${planPath} could not be read from git${where}: ${err instanceof GitError ? err.message : err.message}`
          + ' — the plan must be committed on the base branch, which is where the gate reads it from',
        )
        return 2
      }
    }

    // `init-run` already applied any configured implementer tier, so this normally changes
    // nothing. It stays because the config can change between the two commands, and a per-task
    // `**Model:**` stays authoritative over both — it names a specific task the operator
    // already reasoned about, which a blanket role setting knows nothing about.
    //
    // The result is written back to plan.json rather than kept in memory: `fix` escalates from
    // the recorded tier, so a dispatch at a tier the record does not carry means a retry can be
    // sent BELOW the tier that just failed.
    // Reverting matters exactly as much as applying, and for the same reason: gated on
    // `if (roleTier)` alone, a task stamped `configured` kept that tier forever once the
    // operator removed the setting — plan.json naming a tier the run no longer dispatches at,
    // and `fix` escalating from it. `inferredTier` is what init-run keeps for this. A task
    // whose plan.json predates that record is left alone rather than guessed at.
    const roleTier = resolved.agents.implementer.tier
    const phaseTasks = plan.tasks.filter((t) => t.phase === phase)
    let retier = false
    for (const task of phaseTasks) {
      if (task.tierSource === 'declared') continue
      if (roleTier) {
        if (task.tier === roleTier && task.tierSource === 'configured') continue
        task.tier = roleTier
        task.tierSource = 'configured'
        retier = true
      } else if (task.tierSource === 'configured' && task.inferredTier) {
        task.tier = task.inferredTier
        task.tierSource = 'inferred'
        retier = true
      }
    }
    if (retier) await writeState(root, runId, 'plan', plan)

    // Coupling is recomputed here rather than read from anywhere: it is a statistic about the
    // repository as it stands, and a stored one would be a second source of truth about a number
    // nobody can check. A failure to read history is not a failure to dispatch — a brief without
    // a blast radius is the brief this command emitted until now, so it degrades to that and says so.
    const neighbours = {}
    try {
      const coupling = buildCoupling(await createGit({ cwd: root }).commitFileSets({ limit: 500 }))
      for (const task of phaseTasks) {
        const near = neighboursOf(coupling, task.files ?? [], { top: 5 })
        if (near.length > 0) neighbours[task.id] = near
      }
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      // stderr, not stdout: stdout is the generated workflow source, and a caller redirects it
      // straight into a file it then runs. A notice printed there would be a syntax error in the
      // dispatch — turning "a history failure never fails the dispatch" into its exact opposite.
      io.err(`could not compute the blast radius (${err.message}); briefs will carry no coupling section`)
    }

    const src = await generatePhaseWorkflow({
      runId,
      phase,
      tasks: phaseTasks,
      neighbours,
      maxParallel: resolved.maxParallel,
      tierModels,
      planPath,
      baseBranch,
      constraints: parseConstraints(planMarkdown),
      caveman: resolved.caveman,
      effort: resolved.agents.implementer.effort ?? '',
    })
    io.out(src)
    return 0
  }

  if (command === 'doctor') {
    const git = createGit({ cwd: root })
    // The plan is read from the WORKING TREE here, not from the anchor commit the gate reads
    // it at. The gate's reason for reading it from git — the enforced party must not choose
    // what is enforced — does not apply to a report that enforces nothing, and a diagnostic
    // that cannot run until the plan is committed is useless at exactly the moment a run is
    // going wrong.
    let tasks = []
    try {
      tasks = assignPhases(parsePlan(await readFile(path.resolve(root, flags.plan), 'utf8')))
    } catch (err) {
      io.out(`cannot read the plan at ${flags.plan}: ${err.message}`)
      return 2
    }

    // `--run-branch` exists because the failure most worth diagnosing is the one where the
    // main worktree was moved off the run branch: in that state `currentBranch` reports the
    // wrong branch, and every task diff computed from it would be nonsense. Default to the
    // current branch, which is right whenever nothing moved it.
    const runBranch = typeof flags['run-branch'] === 'string' && flags['run-branch'] !== ''
      ? flags['run-branch']
      : await git.currentBranch()

    // The anchor is what tells an INTEGRATED branch from an empty one: both have an empty diff
    // against their own fork point. What separates them is the same predicate the gate's fileset
    // check applies — whether a merge on the run branch's own first-parent chain, inside
    // anchor..run, named this branch's sha as a secondary parent AND that merge's own diff
    // carried at least one of the task's DECLARED files. Bare membership in `mergedBranchTips` is
    // no longer the test on either side: a sha shared with a sibling used to read as landed for
    // any task that pointed at it. Building that index needs both the anchor and the run sha, and
    // without these two arguments `collectDoctorReport` leaves `landed` false for every task, so
    // every merged branch is reported as NO CHANGES — the report's loudest problem, on the run's
    // healthiest state.
    //
    // Taken from `derive`, so this reads the same anchor the gate enforces at rather than a
    // second computation that could disagree with it. It is allowed to FAIL: `doctor` must keep
    // working in the states the gate refuses to run in — the main worktree parked on the base
    // branch, a plan not committed at the anchor — which are exactly the moments an operator
    // needs it. When it fails, the report degrades to its previous behaviour and says so; a
    // silent degradation would leave the reader believing an integrated branch carries nothing.
    let anchorSha = null
    let derivedRunSha = null
    let anchorNote = null
    const relPlan = path.isAbsolute(flags.plan)
      ? path.relative(root, flags.plan).split(path.sep).join('/')
      : flags.plan
    try {
      const derived = await derive(root, runId, { ...flags, plan: relPlan })
      // `--run-branch` names a branch that may not be the one `derive` computed from, and an
      // anchor for a different branch is not this report's anchor. Refused rather than mixed.
      if (derived.runBranch === runBranch) {
        anchorSha = derived.anchorSha
        derivedRunSha = derived.runSha
      } else {
        anchorNote = `the report is about ${runBranch} but the main worktree is on ${derived.runBranch}`
      }
    } catch (err) {
      anchorNote = err.message
    }

    let report
    try {
      report = await collectDoctorReport({
        git,
        runId,
        runBranch,
        baseBranch: await resolveBaseBranch(git, flags.base),
        tasks,
        repoRoot: root,
        anchorSha,
        runSha: derivedRunSha,
      })
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`doctor could not read the repository: ${err.message}`)
      return 2
    }
    io.out(renderDoctor(report))
    if (anchorNote) {
      io.out(
        `note: could not derive the run anchor (${anchorNote}) — an integrated branch is reported`
        + ' above as having no changes, because without the anchor nothing tells the two apart',
      )
    }
    // 1 on problems, mirroring the gate, so a caller can branch on the exit code. It is still
    // a report: nothing is recorded, and no verdict is issued or implied.
    return report.problems.length === 0 ? 0 : 1
  }

  if (command === 'liveness') {
    const git = createGit({ cwd: root })
    // Same reasoning as `doctor`: the plan is read from the working tree, because a report that
    // enforces nothing has no reason to read it at the anchor, and a diagnostic that needs a
    // committed plan is useless at the moment a run is going wrong.
    let tasks = []
    try {
      tasks = assignPhases(parsePlan(await readFile(path.resolve(root, flags.plan), 'utf8')))
    } catch (err) {
      io.out(`cannot read the plan at ${flags.plan}: ${err.message}`)
      return 2
    }

    const staleMinutes = numericWindow(flags.stale, DEFAULT_STALE_MINUTES)
    if (!Number.isFinite(staleMinutes) || staleMinutes <= 0) {
      io.out(`--stale takes a positive number of minutes, got ${JSON.stringify(flags.stale)}`)
      return 2
    }

    // Existence only, never the contents. The constraint that no CHECK may read `.teammates/`
    // binds the checks whose verdict must not be influenced by the agents they enforce; this is a
    // report that records nothing and decides nothing, and the state it reads is a directory name
    // the orchestrator created, not a claim a teammate wrote. The exception is stated here rather
    // than left to look like an oversight.
    //
    // Without it a mistyped run id is the quietest failure this command has: `--run r11` for a run
    // named `r1` matches no branch and no worktree, so every row takes the not-started path and
    // the heartbeat reads as an all-clear for a run nothing ever looked at.
    try {
      await stat(runDir(root, runId))
    } catch {
      io.out(
        `run ${runId} has no directory under .teammates — check --run, because a run id that`
        + ' matches nothing produces a report about no teammate at all',
      )
      return 2
    }

    // The current phase's tasks only. An earlier phase's teammates have returned, and a later
    // phase's have not been dispatched; reporting either as stalled would be noise on every run.
    //
    // There is deliberately no fallback to "every task in the run". Three states reach here with
    // no phase to name, and rows for all of them is what made a finished run print a full board of
    // stalls and exit 1 — the supervision skill's signal that a teammate has HUNG, raised on a run
    // whose teammates all returned. None of the three is a hang, so each is stated instead:
    //
    //   - the derivation FAILED (the main worktree parked on the base branch, a plan absent from
    //     the anchor). Surfaced the way `doctor` surfaces the same failure, not swallowed: without
    //     it the output was byte-identical to a real stall report.
    //   - `derivePhase` refused to name a phase (`phaseError`: phases integrated out of order, a
    //     plan parsing to zero tasks at the anchor).
    //   - every phase is integrated, which is a finished run and not a stall.
    //
    // The first two exit 2 — this report could not be produced — rather than 0 or 1, because both
    // of those are assertions about teammates that nothing here measured.
    let derived = null
    let deriveError = null
    try {
      derived = await derive(root, runId, { ...flags, plan: flags.plan })
    } catch (err) {
      deriveError = err.message
    }
    const phaseProblem = deriveError ?? derived?.phaseError ?? null
    if (phaseProblem) {
      io.out(
        `liveness could not derive the current phase: ${phaseProblem}`
        + ' — without a current phase this report cannot tell a hung teammate from a finished one,'
        + ' so it reports nothing rather than raising a stall it has not measured',
      )
      return 2
    }
    if (derived.currentPhase == null) {
      io.out(`every phase of run ${runId} is integrated — no teammate of this run is expected to be working`)
      return 0
    }
    const subject = tasks.filter((t) => t.phase === derived.currentPhase)
    // The phase is derived from the plan at the ANCHOR; these rows come from the plan in the
    // WORKING TREE. Amending a plan mid-run is a documented procedure in this plugin — `plan-drift`
    // exists because it happens — and an amendment that drops the derived phase's tasks left this
    // printing a bare header at exit 0: an all-clear covering nobody. Same class as the three
    // states above, so it gets the same answer.
    if (subject.length === 0) {
      io.out(
        `the plan in the working tree has no task in phase ${derived.currentPhase}, which is the`
        + ` phase derived from the plan at the anchor — reporting nothing rather than an all-clear`
        + ' covering no teammate. Run plan-drift to see what changed.',
      )
      return 2
    }

    // Worktree paths come from git rather than from `.teammates/`, which is written by the very
    // teammates being reported on. This is NOT a claim that the path is trustworthy: `git worktree
    // list` reports whatever path was passed to `git worktree add`, so the directory is still the
    // teammate's choice, and `liveness.mjs`'s header concedes both signals are forgeable anyway.
    // What it buys is narrower and worth stating exactly — the report follows the directory git
    // has checked out for that branch right now, so redirecting it means moving a real worktree
    // rather than editing a JSON file the teammate already owns.
    const byBranch = new Map()
    for (const wt of await git.worktrees()) {
      if (wt.branch) byBranch.set(wt.branch, wt.path)
    }

    const tips = {}
    const touches = {}
    for (const task of subject) {
      const branch = taskBranchName(runId, task.id)
      if (await git.branchExists(branch)) {
        const sha = await git.resolveRef(`refs/heads/${branch}`)
        tips[task.id] = { branch, at: await git.commitTime(sha) }
      }
      const dir = byBranch.get(branch)
      if (dir) {
        // The project's own ignore rules prune the walk. A failure here is not fatal: an empty set
        // walks everything, which can only floor the row into `unknown` — the honest answer — and
        // never invent freshness. The likeliest cause is the worktree directory being gone, which
        // the walk itself already treats as no measurement.
        const ignored = new Set(await git.ignoredPaths(dir).catch(() => []))
        const walked = await newestMtime(dir, { ignored })
        touches[task.id] = { branch, at: walked.at, floored: walked.floored }
      }
    }

    const rows = livenessRows({ tasks: subject, tips, touches, now: Date.now(), staleMinutes })
    io.out(renderLiveness(rows, { staleMinutes }))

    // Said before the exit code is decided, and independently of it: precedence chooses the code,
    // never what the operator is told. A board carrying both a stall and an unmeasured row reports
    // both.
    for (const [reason, explanation] of UNMEASURED_REASONS) {
      const names = rows.filter((row) => row.unknownReason === reason).map((row) => row.taskId)
      if (names.length > 0) io.out(`freshness was not measured for ${names.join(', ')}: ${explanation}`)
    }

    // Precedence is deliberate, and the two codes answer different questions. A stall is a
    // MEASUREMENT and the one thing a supervisor must act on, so it wins outright: masking a
    // measured hang behind an unrelated unmeasured row would lose the signal this command exists
    // for. Every row and every explanation is printed either way, so the ordering hides nothing.
    //
    // Exit 1 on a stall mirrors `doctor`. It remains a report: it records nothing, and no verdict
    // is issued or implied.
    if (hasStall(rows)) return 1
    // Freshness that was never measured is not an all-clear. Exit 2 is what this command already
    // returns wherever it could not measure, rather than 0, which would say every teammate is fine
    // on the strength of something nobody looked at.
    if (hasUnknown(rows)) return 2
    return 0
  }

  if (command === 'rebuild-state') {
    // Refused by default: the gate history is the one thing git cannot vouch for, so replacing
    // a live run's status would destroy the only record of what passed and what it cost.
    // Recovery is the case this serves, and recovery starts from a run whose files are gone.
    const existing = await readState(root, runId, 'status')
    if (existing && flags.force !== true) {
      io.out(`run ${runId} already has state; rebuilding would discard its gate history, which cannot be reconstructed from git. Pass --force if that is what you want.`)
      return 2
    }

    let ctx
    try {
      ctx = await derive(root, runId, flags)
    } catch (err) {
      io.out(`cannot rebuild the state: ${err.message}`)
      return 2
    }

    const resolved = await resolveConfig(root, io)
    if (!resolved) return 2

    const git = createGit({ cwd: root })
    const info = {}
    for (const task of ctx.tasks ?? []) {
      const branch = resolveTaskBranch(task, runId)
      const entry = { exists: false, contributes: false, merged: false }
      if (branch && await git.branchExists(branch)) {
        entry.exists = true
        const sha = await git.resolveRef(`refs/heads/${branch}`)
        // Merged means landed: on the run branch AND past the anchor. The same pair of
        // questions `fileset` asks, for the same reason — a branch parked at the anchor is an
        // ancestor of the run branch without ever having carried anything.
        entry.merged = await git.isAncestor(sha, ctx.runSha) && !(await git.isAncestor(sha, ctx.anchorSha))
        const forkPoint = await git.mergeBase(ctx.runSha, sha)
        entry.contributes = (await git.changedFiles({ base: forkPoint, branch: sha })).length > 0
      }
      info[task.id] = entry
    }

    const { plan, status } = rebuildRunState({
      runId,
      tasks: ctx.tasks ?? [],
      info,
      maxParallel: resolved.maxParallel,
      currentPhase: ctx.currentPhase,
    })
    await writeState(root, runId, 'plan', plan)
    await writeState(root, runId, 'status', status)

    // Task ids come from the plan file a planning agent wrote; `printable` keeps a crafted id
    // from redrawing this listing.
    for (const t of status.tasks) io.out(`${printable(t.id)}  ${printable(t.state)}`)
    io.out('rebuilt from git: no gate history, so every phase must be gated again before anything is reported done')
    return 0
  }

  if (command === 'prune-run') {
    const config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    if (!config) { io.out(`no ${GATE_FILE} — without a gate there is no passing phase, so nothing is prunable`); return 4 }

    // The same evidence `finish` takes, for the same reason: a phase whose only outstanding check
    // is a review no runner can run would otherwise never be prunable, however many times it was
    // actually reviewed.
    const supplied = await readSuppliedPhases(flags, io)
    if (supplied === SUPPLIED_REJECTED) return 2

    let ctx
    try {
      ctx = { cwd: root, previewLink: previewLinks(config), ...(await derive(root, runId, flags)) }
    } catch (err) {
      io.out(`cannot decide what is prunable: ${err.message}`)
      return 4
    }

    // Which phases hold a passing gate is RECOMPUTED, never read from `status.gates`. That file
    // is written by the agents whose worktrees are about to be removed, and a phase marked PASS
    // there is exactly how a fix round would lose the context it still needs.
    const enforcementOnly = flags['enforcement-only'] === true
    const phases = [...new Set((ctx.tasks ?? []).map((t) => t.phase))].sort((a, b) => a - b)
    reportUnmatchedSuppliedPhases(io, supplied, phases)
    // Computed either way: it decides whether the flag is refused, and — when it was not passed —
    // whether the announcement should recommend it at all.
    const refusal = enforcementOnlyRefusal(config, phases)
    if (enforcementOnly) {
      if (refusal) { io.out(refusal); return 2 }
    } else {
      const total = phases.reduce((n, p) => n + commandChecks(checksForPhase(config, String(p))).length, 0)
      announceCommandChecks(io, 'prune-run', total, phases.length, refusal === null)
    }

    const passedPhases = []
    for (const phase of phases) {
      const checks = checksForPhase(config, String(phase))
      const forPhase = suppliedForPhase(supplied, phase)
      const invalid = validateSuppliedResults(forPhase, checks)
      if (invalid) { io.out(`phase ${phase}: ${invalid}`); return 2 }
      const results = mergeSuppliedResults(await runPhaseChecks(checks, { ...ctx, currentPhase: phase }, enforcementOnly), forPhase)
      const verdict = aggregateVerdict(results)
      // This command reports a verdict only as a phase's presence in the prune plan below, so
      // without this the checks that did not run would leave no trace in the output at all.
      reportSkipped(io, phase, verdict)
      // A PASS resting on a check THIS FLAG dropped does not authorise a deletion. `--yes` below
      // runs `git worktree remove --force`, which discards whatever a teammate has not committed
      // and removes the worktree a `retry` needs to resume that teammate — and unlike a wrong
      // report, that is not recoverable by running the command again with better flags. The same
      // rule that makes this command recompute rather than read `status.gates` (see above)
      // applies to its own cheap mode: prune on evidence, never on an absence of it.
      //
      // Scoped to this flag's own skips, and to nothing else. A `skip` supplied through
      // `--results` is evidence the caller gave deliberately, and blocking on it offered a remedy
      // they could not follow — see ENFORCEMENT_ONLY_SKIPPED for the three sources and why only
      // one of them is this command's business.
      if (verdict.verdict !== 'PASS') continue
      const flagSkipped = results.filter((r) => r[ENFORCEMENT_ONLY_SKIPPED] === true).map((r) => r.name)
      if (flagSkipped.length > 0) {
        io.out(
          `phase ${phase} is not prunable: --enforcement-only left ${flagSkipped.length} check(s) unrun`
          + ` (${flagSkipped.map(printable).join(', ')}), and a worktree is removed only on checks that ran.`
          + ' Re-run without --enforcement-only to prune it.',
        )
        continue
      }
      passedPhases.push(phase)
    }

    const git = createGit({ cwd: root })
    const worktrees = await git.worktrees()
    // Liveness is read here and handed to the pure module as data. The candidates have to be
    // identified before their markers can be read, so `leakedPreviews` is called twice: once
    // with no live set to learn which paths are preview-shaped, and once inside
    // `selectPrunableWorktrees` with the answer. The first call is what decides which
    // directories are opened at all — no path outside a detached, branchless tm-preview-* under
    // the temp root is ever read.
    //
    // ONE root for both calls, resolved once. The two passes are the same identification run
    // twice, so disagreeing on the temp root is not a narrower result — it is the destructive
    // one. With the raw spelling here and the resolved one below, the candidate list came back
    // EMPTY on macOS and Windows, so no marker was read, so the live set was empty, and then the
    // resolved pass identified the preview and found nothing claiming it: a preview whose owner
    // is alive was reaped with its junctions still in place. Resolving in only one of the two
    // places is strictly worse than resolving in neither.
    const tempRoot = resolvedTempRoot()
    const previewCandidates = leakedPreviews(worktrees, { tempRoot }).map((p) => p.path)
    const livePreviews = await livePreviewPaths(previewCandidates)
    const plan = selectPrunableWorktrees({
      runId,
      worktrees,
      livePreviews,
      // git lists the main worktree first, always. Naming it explicitly beats matching it
      // against `root`, which can differ by symlink, drive-letter case, or trailing separator.
      mainWorktree: worktrees[0]?.path ?? null,
      taskPhases: Object.fromEntries((ctx.tasks ?? []).map((t) => [t.id, t.phase])),
      passedPhases,
      // The module stays pure and takes no view of where the system temp directory is, so the
      // caller supplies the root it observed. Without it, NOTHING is identified as a leaked
      // preview — a `tm-preview-*` worktree an operator keeps elsewhere on disk is theirs.
      // Resolved, not raw: git reports real paths, and the raw spelling misses every preview on
      // macOS and Windows. See resolvedTempRoot. The SAME value the candidate pass above used.
      tempRoot,
    })
    io.out(renderPrunePlan(plan))

    // Removing a worktree is not reversible from here, so the default is to say what would
    // happen. `--yes` is the caller stating the intent, in the same spelling every other
    // valueless flag in this CLI uses.
    if (flags.yes !== true) {
      io.out('dry run: nothing was removed. Re-run with --yes to remove the worktrees listed as prunable.')
      return 0
    }

    let failed = 0
    for (const w of plan.prunable) {
      try {
        await git.removeWorktree(w.path)
        io.out(`removed ${w.path}`)
      } catch (err) {
        if (!(err instanceof GitError)) throw err
        failed += 1
        io.out(`could not remove ${w.path}: ${err.message}`)
      }
    }

    // The leaked merge previews, reaped last and by a different route. They are NOT in `prunable`
    // — the `continue` in selectPrunableWorktrees that keeps them out is a deliberate second
    // barrier, so that a bug in this loop can never reach a worktree holding a task branch.
    //
    // Every one is stripped of its provisioned links FIRST. `git worktree remove --force` follows
    // a junction into its target and deletes the contents (see unlinkPreviewLinks), and a leaked
    // preview is exactly the one whose own teardown never ran, so it is exactly the one still
    // holding those junctions. A preview whose links cannot be removed is LEFT IN PLACE and
    // reported: an accumulated worktree costs disk, and the alternative costs the operator their
    // repository's build inputs.
    //
    // WHAT THIS SWEEP DOES AND DOES NOT CLOSE. It closes the junction hazard for a preview whose
    // owner is DEAD — the links it finds are the ones a killed gate's `finally` never tore down,
    // and they are gone before anything is removed. For a LIVE preview the sweep alone could
    // never close it, because a junction the owner creates in the window BETWEEN this sweep and
    // the removal below would still be followed. What closes that window is that a live preview
    // does not reach this loop at all: `livePreviewPaths` above found the marker its owner holds
    // from before `git worktree add` registers the preview until after `removeWorktree`
    // deregisters it, and the preview is excluded from `plan.previews` and reported as owned
    // instead. The teardown is inside that span, not after it: a preview mid-teardown still
    // holds its junctions, and reading it as unowned there would follow them.
    //
    // THE RESIDUALS, stated as what is true rather than as what would be convenient.
    //
    //   - A pid can be RECYCLED. A marker naming a pid an unrelated process has since taken
    //     makes a dead preview read as live. That direction only leaves a directory on disk; it
    //     never destroys data, and `prune-run` can be run again once the pid is free.
    //   - A preview created by a gate from BEFORE this marker existed carries none, and is
    //     reaped as leaked. That is the pre-existing hazard, unchanged and no worse.
    //   - The worktree list and the markers are read once, above, and acted on here. A preview
    //     that appears in between is not in the list at all, so it cannot be reaped; a preview
    //     already in the list cannot acquire an owner, because its owner would have had to write
    //     the marker before the add that put it there.
    //
    // The destructive direction — a live preview read as dead — is closed by construction rather
    // than narrowed, because the marker is HELD across a span that contains the whole span over
    // which the preview is observable, instead of being sampled at one instant.
    //
    // WHAT THE PATTERN MATCHES, since the reaper is force-removing directories nobody named:
    // every detached, branchless worktree registered in this repository whose path lies under
    // the system temp root and whose final segment begins `tm-preview-`. That includes one an
    // operator created deliberately and left uncommitted work in — the leaf name is the whole
    // test. The dry run is the default and the plan is printed before anything is removed, so
    // the operator sees each path before `--yes`.
    for (const p of plan.previews ?? []) {
      try {
        await unlinkPreviewLinks(p.path)
      } catch (err) {
        // Registered but not on disk: no links exist to sweep, and the removal below is what
        // clears the registration. Blocking on it would deadlock the command forever — see
        // isMissingPreviewRoot.
        if (!isMissingPreviewRoot(err, p.path)) {
          failed += 1
          io.out(
            `left ${p.path} in place: its provisioned links could not be removed (${err.message}),`
            + ' and `git worktree remove --force` deletes the CONTENTS of a junction\'s target',
          )
          continue
        }
        io.out(`${p.path} is registered but its directory is gone: nothing to sweep, clearing the registration`)
      }
      try {
        await git.removeWorktree(p.path)
        io.out(`removed leaked preview ${p.path}`)
      } catch (err) {
        if (!(err instanceof GitError)) throw err
        failed += 1
        io.out(`could not remove ${p.path}: ${err.message}`)
      }
    }
    return failed > 0 ? 1 : 0
  }

  if (command === 'finish') {
    const config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    if (!config) { io.out(`no ${GATE_FILE} — there is nothing to verify a phase against`); return 4 }

    // Read once, before any phase is computed, so a malformed file is refused before minutes of
    // check-running rather than after. Never persisted and never read back from `.teammates/`:
    // it fills in this run's pending checks and nothing else.
    const supplied = await readSuppliedPhases(flags, io)
    if (supplied === SUPPLIED_REJECTED) return 2

    let ctx
    try {
      ctx = { cwd: root, previewLink: previewLinks(config), ...(await derive(root, runId, flags)) }
    } catch (err) {
      io.out(`cannot verify the run: ${err.message}`)
      return 4
    }

    // Phases come from the plan at the anchor, not from `status.gates`. The recorded keys are
    // written by the agents being enforced, so a phase deleted from that file would simply not
    // be verified — the check would report on whatever remained and call the run finished.
    const phases = [...new Set((ctx.tasks ?? []).map((t) => t.phase))].sort((a, b) => a - b)
    reportUnmatchedSuppliedPhases(io, supplied, phases)

    const enforcementOnly = flags['enforcement-only'] === true
    // Computed either way: it decides whether the flag is refused, and — when it was not passed —
    // whether the announcement should recommend it at all.
    const refusal = enforcementOnlyRefusal(config, phases)
    if (enforcementOnly) {
      // Before any check runs, and before any phase reaches the summary below: a phase with no
      // enforcement check left to run would otherwise be summarised PASS on nothing but its own
      // skips, and reported as "ready to land".
      if (refusal) { io.out(refusal); return 2 }
    } else {
      const total = phases.reduce((n, p) => n + commandChecks(checksForPhase(config, String(p))).length, 0)
      announceCommandChecks(io, 'finish', total, phases.length, refusal === null)
    }

    const phaseResults = []
    for (const phase of phases) {
      // Every phase is computed as if it were current. `deriveContext` sets `currentPhase` to
      // the first UN-integrated phase, which is the right answer for a gate deciding whether to
      // advance and the wrong one here: an already-integrated phase would otherwise be skipped
      // by `fileset`, and skipping is what "verify the whole run" must never do.
      const phaseCtx = { ...ctx, currentPhase: phase }
      const checks = checksForPhase(config, String(phase))
      // Per phase, against that phase's own manifest block — evidence for phase 1 can never
      // satisfy phase 3, and a supplied result still may not name a computed check.
      const forPhase = suppliedForPhase(supplied, phase)
      const invalid = validateSuppliedResults(forPhase, checks)
      if (invalid) { io.out(`phase ${phase}: ${invalid}`); return 2 }
      const results = mergeSuppliedResults(await runPhaseChecks(checks, phaseCtx, enforcementOnly), forPhase)
      // `supplied` is carried into the summary so a reader can tell a recomputed pass from a
      // reported one. It changes no verdict: aggregateVerdict stays the only producer of those.
      phaseResults.push({ phase, supplied: forPhase.length > 0, verdict: aggregateVerdict(results) })
    }

    // `renderRunSummary` builds a multi-line table and splices each failed, pending and skipped
    // CHECK NAME into it, so the manifest's strings arrive already inside the rendered block.
    // The block form is what fits a table: it neutralises the escape sequences with which a
    // name could erase a row, and keeps the newlines that are the table itself.
    //
    // Stated exactly: `printableBlock` keeps every newline it is given, including a value's own,
    // so on its own it stops a name from redrawing the table but not from adding a row that reads
    // like a row this CLI wrote. That second half is closed where the table is BUILT —
    // `renderRunSummary` in `scripts/finish.mjs` puts each name through `printable`, so no name
    // still carries a newline by the time it reaches this wrap.
    io.out(printableBlock(renderRunSummary(runId, phaseResults)))
    const summary = summarizeRun(phaseResults)
    if (summary.complete) return 0
    // 1 for a phase that was verified and failed; 4 for one that was never verified at all.
    // Same split the output makes, so a caller branching on the code and a human reading the
    // table reach the same conclusion.
    //
    // `--enforcement-only` cannot reach here with a phase in the second state wearing the first
    // state's answer: the refusal above exits 2 unless every phase still has an enforcement check
    // to run, so a phase summarised below always had something actually verify it.
    return summary.failedPhases.length > 0 ? 1 : 4
  }

  if (command === 'plan-drift') {
    let ctx
    try {
      // The same derive `gate` uses: the anchored plan is read with `git show <anchor>:<path>`,
      // and the phases come from branch ancestry. Reading it any other way would compare the
      // working tree against something other than what the gate actually enforces.
      ctx = await derive(root, runId, flags)
    } catch (err) {
      io.out(`cannot read the anchored plan: ${err.message}`)
      return 2
    }

    let currentTasks
    try {
      currentTasks = assignPhases(parsePlan(await readFile(path.resolve(root, flags.plan), 'utf8')))
    } catch (err) {
      io.out(`cannot read the working-tree plan at ${flags.plan}: ${err.message}`)
      return 2
    }

    const report = planDrift({
      anchored: ctx.tasks,
      current: currentTasks,
      integratedPhases: ctx.integratedPhases,
    })
    io.out(renderDrift(report))
    // 1 only for drift against an integrated phase. Amending a task nobody has implemented is
    // how a plan is meant to evolve mid-run, and exiting 1 for it would train a caller to
    // ignore the exit code for the case that actually costs something.
    return report.tooLate.length > 0 ? 1 : 0
  }

  if (command === 'map') {
    const git = createGit({ cwd: root })
    // Both windows are validated the same way and for the same reason: `Number('lots')` is NaN,
    // and NaN reaching either `--max-count` or `slice` produces a plausible-looking answer to a
    // question nobody asked. A typo must exit, never quietly change the result.
    const limit = numericWindow(flags.commits, 500)
    if (!Number.isInteger(limit) || limit <= 0) {
      io.out('--commits takes a positive whole number of commits to read')
      return 2
    }
    const top = numericWindow(flags.top, 5)
    if (!Number.isInteger(top) || top <= 0) {
      io.out('--top takes a positive whole number of files to report')
      return 2
    }
    // `--files` written with no value is `true`, not a string — the same orchestrator mistake
    // `--commits` and `--top` already refuse, and refused here for a stronger reason than theirs:
    // falling through, it asked git a question with `flags.files.split` and died with a raw
    // TypeError, and once that was guarded by truthiness alone it fell through to the WHOLE-
    // REPOSITORY OVERVIEW and exited 0. A caller that asked "what does my file set put at risk"
    // must never be answered with a repository summary and a success code.
    let requestedFiles = null
    if (typeof flags.files !== 'undefined') {
      requestedFiles = typeof flags.files === 'string'
        ? flags.files.split(',').map((f) => f.trim()).filter(Boolean)
        : []
      if (requestedFiles.length === 0) {
        io.out('--files takes a comma-separated list of paths to report the blast radius for')
        return 2
      }
    }
    let sets
    let paths
    let prefix
    try {
      sets = await git.commitFileSets({ limit })
      prefix = await repoPrefix(root)
      paths = (await git.listFiles()).map((p) => toRepoPath(prefix, p))
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`cannot read the repository: ${err.message}`)
      return 2
    }
    const coupling = buildCoupling(sets)

    // A file set turns this from an overview into the one question an implementer has: what does
    // my change put at risk. Answered for the whole set at once, because that is what a task holds.
    if (requestedFiles !== null) {
      // Lifted into the same repo-root namespace the coupling keys live in, so a path the caller
      // wrote relative to --root still matches the history when --root is not the repository root.
      const files = requestedFiles.map((f) => toRepoPath(prefix, f))
      const near = neighboursOf(coupling, files, { top })
      if (near.length === 0) {
        io.out(`no coupled files found for ${files.join(', ')} in the last ${limit} commits — new files, or a shallow history`)
        return 0
      }
      for (const n of near) io.out(`${String(Math.round(n.confidence * 100)).padStart(3)}%  ${n.path}`)
      return 0
    }

    io.out(renderMap({ inventory: inventory(paths), hotPairs: hotPairs(coupling), usedCommits: coupling.usedCommits }))
    return 0
  }

  if (command === 'map-notes') {
    const git = createGit({ cwd: root })
    const notesPath = path.join(runDir(root, runId), 'map.md')
    let sha
    try {
      sha = await git.headSha()
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`cannot read the repository: ${err.message}`)
      return 2
    }

    // The orchestrator's half of the inverted map-notes contract: the dispatched agent is
    // read-only and RETURNS the map, the caller saves that text somewhere, and this is the one
    // path that turns it into `.teammates/<runId>/map.md`. Without it the orchestrator writes
    // that file by hand and `mapNotesWritable` — the validator that exists precisely so the
    // stamped file can be vouched for — is never called by anything.
    //
    // Still not a path by which this CLI authors a map: it copies text an agent produced, after
    // checking the header the agent was handed still names this run and this commit. A map that
    // fails that check must not land at all, because every later reader treats the header as
    // provenance, and a file written past a failed validation would manufacture exactly the
    // fact this design refuses to fake.
    if (flags.write !== undefined) {
      // Valueless `--write` is the missing argument it looks like, not a request to write
      // nothing. Same rule as everywhere else in this CLI: `flags[f] === true` means the value
      // was omitted. REQUIRED cannot express "required only when present", so it is checked here.
      if (flags.write === true) {
        io.out('--write takes the path of the file holding the map the agent returned')
        return 2
      }
      const source = path.resolve(root, flags.write)
      let returned
      try {
        returned = await readFile(source, 'utf8')
      } catch (err) {
        io.out(`cannot read the returned map at ${source}: ${err.code ?? err.message}`)
        return 4
      }
      const refusal = mapNotesWritable(returned, { runId, sha })
      // Verbatim, and nothing is written. The reason names the mismatch it found — which commit,
      // which run, or a missing body — and that is what tells the caller whether to re-dispatch
      // the agent or to re-save what it already returned.
      // `printable`, because the refusal quotes the header line out of the file the agent
      // returned — `run=` and `sha=` are matched as `\S+`, and ESC is not whitespace, so a
      // returned map can carry an escape sequence into this sentence.
      if (refusal) { io.out(printable(refusal)); return 4 }
      // Written through a uniquely-named temp file and renamed, the same way `writeState` writes
      // every other file under `.teammates/`: a reader must never find a half-written map under
      // a header that vouches for the whole of it.
      const tmp = `${notesPath}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
      try {
        await mkdir(path.dirname(notesPath), { recursive: true })
        await writeFile(tmp, returned, 'utf8')
        await rename(tmp, notesPath)
      } catch (err) {
        // The destination can be unwritable for the same reasons the read path two blocks below
        // already handles deliberately — map.md is a directory (EISDIR, and EPERM out of
        // `rename`), permissions (EACCES) — and from the caller's side they are one situation:
        // the map did not land. Left to throw, this produced an unhandled-rejection stack and
        // exit 1, a code this CLI's documented 0/2/4 contract does not include.
        //
        // The temp file goes with it. It is scaffolding for an operation that did not happen,
        // and leaving it in the run directory hands a later reader a file it cannot interpret.
        await unlink(tmp).catch(() => {})
        io.out(`the map notes at ${notesPath} could not be written (${err.code ?? err.message}), so nothing was written`)
        return 4
      }
      io.out(`wrote the returned map to ${notesPath} for run ${runId} at commit ${sha}`)
      return 0
    }

    // ENOENT is the ordinary case — no notes yet. But every other read failure (map.md is a
    // directory: EISDIR; permissions: EACCES) is the SAME situation from the caller's side:
    // there are no notes it can use. Rethrowing produced a raw stack and exit 1, which is not a
    // code any caller branches on, so an unusable file has to arrive as the documented 4 with
    // the prompt — naming the read failure, so an operator can tell it from an empty file.
    let text = null
    let readFailure = null
    try {
      text = await readFile(notesPath, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') readFailure = `the map notes at ${notesPath} could not be read (${err.code ?? err.message}), so nothing says which commit they describe`
    }

    const stale = readFailure ?? mapNotesStale(text, { runId, sha })
    if (!stale) { io.out(`current map notes: ${notesPath}`); return 0 }

    // 4, matching `complete` and `collect-reviews`: this cannot verify what it was asked about.
    // The prompt is printed so the caller dispatches an Explore agent rather than writing prose
    // itself — and a teammate never writes this file.
    // Same reason as the write path's refusal above: the reason names the header the agent wrote.
    io.out(printable(stale))
    io.out('')
    io.out('dispatch an Explore agent with exactly this prompt:')
    io.out('')
    let topDirectories = []
    try {
      topDirectories = promptSafeDirectories(inventory(await git.listFiles(), { top: 8 }).rows.map((r) => r.dir))
    } catch (err) {
      if (!(err instanceof GitError)) throw err
    }
    io.out(mapNotesPrompt({ runId, sha, notesPath, topDirectories }))
    return 4
  }

  if (command === 'preview-check') {
    const config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    if (!config) { io.out(`no ${GATE_FILE} — nothing to check`); return 4 }

    const links = previewLinks(config)
    if (links.length === 0) {
      // Not a failure: a project whose checks need nothing but tracked content is the normal
      // case for this repository itself. Said out loud, because silence here would read as
      // "checked, all good" to a project that meant to declare something and did not.
      io.out(`no preview.link declared — the merge preview will contain tracked content only`)
      return 0
    }

    // The same validator the merge check runs, so a manifest that passes here cannot fail there
    // for a reason this command could have named first.
    const invalid = validateLinkPaths(links)
    if (invalid) { io.out(invalid); return 1 }

    // `validateLinkPaths` above rejects a non-string, an empty string, an absolute path, a `..`
    // and a duplicate, and quotes what it rejected through `JSON.stringify` — but it does not
    // screen control bytes, and `"a\u001b[2K"` is a legal relative path by every one of those
    // rules. So each entry is wrapped again on its way into the sentences below, including the
    // success line, which is the one printed on a manifest that passed every validator.
    const git = createGit({ cwd: root })
    const problems = []
    for (const entry of links) {
      const target = path.resolve(root, entry)
      try {
        const info = await stat(target)
        if (!info.isDirectory()) problems.push(`${printable(entry)}: exists but is not a directory`)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
        problems.push(`${printable(entry)}: does not exist — the preview would be missing it, and every command check would fail on a tree that is otherwise fine`)
        continue
      }
      try {
        // Linking over a path the merge produced would shadow the merged result, which is the
        // one thing the preview exists to measure.
        if (await git.tracks(entry)) {
          problems.push(`${printable(entry)}: is tracked by the repository — linking over it would shadow the merged result`)
        }
      } catch (err) {
        if (!(err instanceof GitError)) throw err
        problems.push(`${printable(entry)}: ${printable(err.message)}`)
      }
    }

    if (problems.length === 0) {
      io.out(`preview.link is usable: ${links.map(printable).join(', ')}`)
      return 0
    }
    for (const p of problems) io.out(p)
    return 1
  }

  if (command === 'review-dispatch') {
    // The TRACKED manifest, not the resolved config: the reviewer grades the diff, so letting
    // the gitignored local layer choose its tier would let the party being judged pick its own
    // judge. `config.mjs` already refuses `agents.reviewer` in the local layer; reading the
    // manifest directly here means this command does not depend on that refusal holding.
    const config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    if (!config) { io.out('no gate manifest — cannot tell which lenses to dispatch'); return 4 }

    const phaseName = flags.phase ?? 'default'
    const agentChecks = checksForPhase(config, phaseName).filter((c) => c.kind === 'agent')
    if (agentChecks.length !== 1) {
      io.out(`this phase declares ${agentChecks.length} agent checks; review-dispatch handles exactly one`)
      return 4
    }
    const check = agentChecks[0]

    const tierModels = parseTierModels(flags, io)
    if (tierModels === TIER_MODELS_REJECTED) return 2

    const plan = await readState(root, runId, 'plan')
    if (!plan) { io.out(`no plan for run ${runId}`); return 4 }

    const git = createGit({ cwd: root })
    // Resolved to shas as well as names: the stamp each reviewer carries back names the tips it
    // judged, and `collect-reviews` compares that against the tips as they stand then.
    const branchShas = await resolveBranchShas(git, tasksOfPhase(plan, phaseName), runId)
    const branches = Object.keys(branchShas)
    if (branches.length === 0) {
      // Refused rather than emitted: reviewers dispatched over branches that do not exist grade
      // an empty diff and report no findings, which is indistinguishable from a clean review.
      io.out(`no task branch of phase ${phaseName} exists yet — there is no diff to review`)
      return 4
    }

    // Which command check is the suite, chosen by a stated rule rather than by position. The
    // first command check in the list is NOT it: `inferGateConfig` emits typecheck, lint, test,
    // build in that order, and that inferred config is what `gate` prints for an operator to
    // save — so positionally the claims reviewer would baseline on `npm run typecheck`, which
    // survives deleting a filter or widening a guard, and every probed claim would read as
    // unpinned. The rule is: the check named `test` if there is exactly one; otherwise the sole
    // command check if there is exactly one; otherwise no choice is made here.
    //
    // This comes from `teammates.gate.json` in the WORKING TREE — `resolveGateConfig` reads it
    // through `readLayer`, not out of the index — so an enforced agent can edit it. Reading the
    // manifest rather than the resolved config keeps the gitignored local layer out of the
    // choice; it does not make the value trusted. Nothing screens the run string: containment is
    // structural, and `generateReviewDispatch` emits it as a JSON literal in a DATA block that
    // sits below every instruction, so no value of it can become one.
    const commandChecks = checksForPhase(config, phaseName).filter((c) => c.kind === 'command')
    const namedTest = commandChecks.filter((c) => c.name === 'test')
    const commandCheck = namedTest.length === 1
      ? namedTest[0]
      : (namedTest.length === 0 && commandChecks.length === 1 ? commandChecks[0] : null)
    // Refused, not guessed — and only for the lens that actually runs the command, since no
    // other lens reads this value and blocking their dispatch over it would answer a question
    // they never ask. Zero command checks is not ambiguity: it falls through to
    // `generateReviewDispatch`, whose message says the phase declares no command check.
    //
    // The two ambiguous shapes get different sentences because they have different remedies, and
    // one message covering both told an operator with two checks named `test` to name one of them
    // `test` — a fix already applied, so the only instruction offered was a no-op.
    if (!commandCheck && commandChecks.length > 1 && (check.lens ?? []).includes('claims')) {
      const preamble = 'the claims lens needs one command check to baseline against and this phase declares'
      io.out(namedTest.length > 1
        // The duplicates, not every command check: enumerating all of them printed a third name
        // under a count of two, and the extra name is the one an operator told to "rename the one
        // that is not the suite" would reach for, which would change nothing.
        ? `${preamble} ${namedTest.length} command checks named "test": `
          + `${namedTest.map((c) => printable(c.name)).join(', ')}. Rename the one that is not the suite`
        : `${preamble} ${commandChecks.length} with none named "test": `
          + `${commandChecks.map((c) => printable(c.name)).join(', ')}. `
          + 'Name the one that runs the suite "test", or drop the claims lens from this phase')
      return 4
    }
    const testCommand = commandCheck?.run ?? ''
    const testCommandName = commandCheck?.name ?? ''
    // The same paths the merge preview links in, for the same reason: a scratch worktree has no
    // untracked build inputs, and the suite cannot run without them. `previewLinks` normalises a
    // non-array to []; `config.mjs`'s `preview` validator has already refused one by here, so
    // that normalisation is a second net rather than the one that catches it.
    const linkPaths = previewLinks(config)

    let spec
    try {
      spec = generateReviewDispatch({
        runId,
        phaseName,
        checkName: check.name,
        lenses: check.lens,
        blockOn: check.blockOn ?? ['high'],
        // The fixed reviewer tier is `capable`; only the tracked manifest replaces it.
        tier: config.agents?.reviewer?.tier ?? 'capable',
        effort: config.agents?.reviewer?.effort ?? '',
        tierModels,
        runBranch: await git.currentBranch(),
        branches,
        findingsDir: `.teammates/${runId}/reviews`,
        scratchRoot: tmpdir(),
        testCommand,
        testCommandName,
        linkPaths,
        branchShas,
      })
    } catch (err) {
      io.out(err.message)
      return 4
    }
    // Emitted exactly as generated. Nothing is appended here: the claims prompt ends with a DATA
    // block whose banner says nothing below it is an instruction, and appending anything after it
    // made that banner false in the one prompt whose containment depends on it. The stamp
    // requirement the reviewers used to receive from here is now emitted by the generator, above
    // that block.
    io.out(JSON.stringify(spec, null, 2))
    return 0
  }

  if (command === 'collect-reviews') {
    const config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    // 4, matching `complete`: this cannot verify what it was asked about. Inferring a manifest
    // here would invent the lens list, which is the one thing this command must not guess —
    // the lens list is what decides whether a review is complete.
    if (!config) { io.out('no gate manifest — cannot tell which lenses were dispatched'); return 4 }

    const phaseName = flags.phase ?? 'default'
    const checks = checksForPhase(config, phaseName)
    const agentChecks = checks.filter((c) => c.kind === 'agent')
    if (agentChecks.length !== 1) {
      io.out(`this phase declares ${agentChecks.length} agent checks; collect-reviews handles exactly one`)
      return 4
    }
    const check = agentChecks[0]

    const dir = path.join(runDir(root, runId), 'reviews')
    const files = []
    const unreadable = []
    for (const lens of check.lens) {
      let name
      try {
        name = reviewFileName(phaseName, lens)
      } catch (err) {
        io.out(err.message)
        return 4
      }
      try {
        const parsed = JSON.parse(await readFile(path.join(dir, name), 'utf8'))
        // A reviewer returns an array of findings; the file it writes may carry that array
        // directly or wrap it. Both are accepted, and anything else is unreadable rather than
        // an empty review — the distinction this whole command exists to preserve.
        const found = Array.isArray(parsed) ? parsed : parsed?.findings
        if (!Array.isArray(found)) { unreadable.push(name); continue }
        // The stamp travels with the findings. A file that carries none is not "probably
        // current" — `reviewStale` refuses it, which is the whole point of stamping.
        // `unableToVerify` and `unprobed` travel with the findings too: one decides whether this
        // lens is a review at all, the other bounds it. Read off the wrapped form only — a bare
        // array carries findings and nothing else.
        files.push({
          lens,
          findings: found,
          stamp: Array.isArray(parsed) ? undefined : parsed?.stamp,
          unableToVerify: Array.isArray(parsed) ? undefined : parsed?.unableToVerify,
          unprobed: Array.isArray(parsed) ? undefined : parsed?.unprobed,
        })
      } catch (err) {
        // ENOENT is a missing lens, reported below by name. Anything else is a file that
        // exists and cannot be trusted, which must never be read as "no findings".
        if (err.code !== 'ENOENT') unreadable.push(name)
      }
    }

    if (unreadable.length > 0) {
      io.out(`unreadable findings file(s): ${unreadable.map(printable).join(', ')} — a file that exists and cannot be parsed is not an empty review`)
      return 4
    }

    // What the findings must have judged: the phase's task branches as they stand NOW. A fix
    // round moves a branch, and findings about the old tree are not findings about this one —
    // during run `codemap` that was worked around three times by deleting the files by hand
    // between rounds.
    const plan = await readState(root, runId, 'plan')
    if (!plan) {
      io.out(`no plan for run ${runId} — nothing says which branch tips this phase is at, and a findings file that cannot be vouched for is not a review`)
      return 4
    }
    let branchShas
    try {
      branchShas = await resolveBranchShas(createGit({ cwd: root }), tasksOfPhase(plan, phaseName), runId)
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`cannot read this phase's task branches: ${err.message}`)
      return 4
    }
    if (Object.keys(branchShas).length === 0) {
      // The mirror of `review-dispatch`'s refusal: with no branch there was no diff to review,
      // so any file claiming to have reviewed one describes something else entirely.
      io.out(`no task branch of phase ${phaseName} exists — there was no diff to review`)
      return 4
    }
    const expected = reviewStamp({ phase: phaseName, lens: null, branchShas })

    const collected = collectReviewResults({
      checkName: check.name,
      lenses: check.lens,
      files,
      blockOn: check.blockOn ?? ['high'],
      // `lens` is filled in per file by collectReviewResults; phase and branches are the run's.
      expected: { phase: phaseName, branches: expected.branches },
    })
    if (collected.stale.length > 0) {
      // Reported the way `missing` is, and for the same reason: a stale review is a review this
      // phase does not have. Recording a pass on it would be a verdict about another tree.
      //
      // The reason quotes a reviewer's own file, and this line is read in a terminal. `printable`
      // neutralises the control bytes with which a value could otherwise erase this refusal and
      // draw a passing gate in its place; see its definition in `reviews.mjs`.
      for (const s of collected.stale) {
        io.out(`stale findings for lens ${printable(s.lens)}: ${printable(s.reason)} — respawn that review rather than recording a pass`)
      }
      return 4
    }
    // Every unaccounted-for lens is reported before anything returns. These are three different
    // reasons a review is not here, they can hold at once across different lenses, and returning
    // on the first one costs a full respawn-and-re-run to discover the second.
    //
    // `u.reason` is the reviewer's own `unableToVerify` string, straight out of its file, so it
    // goes through `printable` for the same reason the stale reason above does.
    for (const u of collected.unverified) {
      io.out(`lens ${printable(u.lens)} could not verify anything: ${printable(u.reason)} — that review did not happen; respawn that lens rather than recording a pass`)
    }
    for (const m of collected.malformed) {
      // Deliberately not "respawn": the reviewer may have done all its work and written the key
      // in a shape this command does not read. What needs fixing is the file, or whatever wrote it.
      io.out(`lens ${printable(m.lens)} has a findings file this command cannot read: ${printable(m.reason)} — fix the file rather than recording a pass or respawning the review`)
    }
    if (collected.unexpected.length > 0) {
      io.out(`ignored findings file(s) for lens(es) this phase did not dispatch: ${collected.unexpected.map(printable).join(', ')}`)
    }
    // A lens already reported above is also in `missing`, and calling its review lost would send
    // the operator looking for a file that is sitting right there. Only the genuinely absent ones
    // are named here.
    const explained = new Set([...collected.unverified, ...collected.malformed].map((e) => e.lens))
    const lost = collected.missing.filter((lens) => !explained.has(lens))
    if (lost.length > 0) {
      io.out(`no findings file for lens(es): ${lost.map(printable).join(', ')} — those reviews are lost, not empty; respawn them rather than recording a pass`)
    }
    if (lost.length > 0 || explained.size > 0) return 4
    io.out(JSON.stringify({ results: collected.results }, null, 2))
    return 0
  }

  if (command === 'gate') {
    let config = await resolveGateConfig(root, io)
    if (config === GATE_CONFIG_REJECTED) return 2
    if (!config) {
      const pkg = await readPackage(root)
      config = inferGateConfig(pkg)
      io.out('inferred gate manifest — review, then save as teammates.gate.json:')
      io.out(JSON.stringify(config, null, 2))
      // `preview.link` is inferred only for a Node project, because `node_modules` is the one
      // build input this CLI can name without guessing. Every other ecosystem gets a manifest
      // with no preview field at all, links nothing into the merge preview — which holds
      // tracked content only — and fails every command check on a tree that is fine. The
      // manifest cannot carry the warning (JSON has no comment, and an empty link list means
      // "link nothing", which is both wrong as advice and indistinguishable from a considered
      // choice), so it is printed beside it, and only where it applies.
      if (!pkg) {
        io.out('')
        io.out('no package.json: the merge preview is built with `git worktree add`, which materializes tracked files only. If this project\'s test runner is itself a dependency — a virtualenv, `target/`, `vendor/` — name those directories or the gate will fail every command check on a tree that is fine:')
        io.out('    "preview": { "link": ["<dir>", "..."] }')
      }
      return 3
    }
    const phaseName = flags.phase ?? 'default'
    const all = checksForPhase(config, phaseName)
    // `=== true`, matching missingArgs: the two must agree about what counts as solo, or one
    // of them drops --run and --plan from the requirements while the other still runs the
    // enforcement checks, or vice versa.
    const solo = flags['no-fleet'] === true

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
    const config = await resolveGateConfig(root, io)
    // 2, not 4: a broken manifest is a config failure like every other one in this CLI, and
    // `cannot verify completion` would send a teammate looking at its own branch instead.
    if (config === GATE_CONFIG_REJECTED) return 2
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
      // The names come from the gate manifest, which is a file in the worktree this command is
      // run from — the same source as `r.name` below, which already goes through `printable`.
      // The summary line was the half that did not, so a check name could erase this refusal.
      io.out(`gate does not pass for phase ${ctx.currentPhase}: ${names.map(printable).join(', ')}`)
      // A check's output is a block with its own line structure — a captured command output, a
      // fileset check enumerating branch and file names an enforced teammate chose — so it takes
      // the block form: escape sequences are neutralised, the line breaks it legitimately
      // contains are kept.
      for (const r of results) {
        if (names.includes(r.name) && r.output) io.out(`${printable(r.name)}: ${printableBlock(r.output)}`)
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
      // The verdict file is written by the agent that ran the gate — `skills/phase-gate/SKILL.md`
      // instructs it to — and Node embeds a slice of the parsed input in a JSON parse error, so
      // this message carries bytes out of that file. `printable` on both halves, exactly as
      // `readSuppliedPhases` does for a `--results` file: see its definition in `reviews.mjs`.
      io.out(`cannot read verdict at ${printable(flags.verdict)}: ${printable(err.message)}`)
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
      // `verdict.phase` is a real integer by the guard above. The other two are not: `flags.phase`
      // is the STRING that was typed, and `missingArgs` admits it on `Number.isInteger(Number(x))`
      // — which `Number` reaches through leading and trailing whitespace, so `\r1`, `\n1` and
      // ` 1` are all accepted and would put that byte on this line. Only whitespace can
      // arrive that way, never attacker-chosen text, but a line break here is still a line this
      // CLI did not mean to draw. Both it and the path are wrapped, for the same reason the
      // parse-error line above wraps what it quotes.
      io.out(`--phase ${printable(flags.phase)} does not match the verdict's phase ${verdict.phase} at ${printable(flags.verdict)}\n\n${USAGE}`)
      return 2
    }

    const gateConfig = await resolveGateConfig(root, io)
    if (gateConfig === GATE_CONFIG_REJECTED) return 2
    // A broken manifest must not reach here as `{}`: the fix budget would silently become the
    // default, which is the outcome an operator reading `budget-exhausted` cannot tell from a
    // budget they actually set.
    const config = gateConfig ?? {}
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

  // Reads the subcommand and key from `positional`, targets a layer with `--local`, and maps
  // every ConfigError to exit 2 with the message on stdout — a skill branches on this exit
  // code, so a validation failure must never surface as a stack trace.
  if (command === 'config') {
    const [sub, key, rawValue] = positional
    // `=== true`, not `!== undefined`: `--local` is in VALUELESS_FLAGS, so it is the only value
    // the parser can produce for it, and testing identity keeps `--local false` from reading as
    // "select the local layer" the way any-defined-value did.
    const local = flags.local === true
    const file = local ? LOCAL_FILE : GATE_FILE
    try {
      if (sub === 'list') {
        const { resolved, sources } = await loadValidatedConfig(root)
        io.out(`maxParallel  ${resolved.maxParallel}  (${sources.maxParallel})`)
        io.out(`caveman      ${resolved.caveman}  (${sources.caveman})`)
        for (const role of ROLES) {
          const entry = resolved.agents[role]
          // Provenance is per FIELD, not per role: a role whose tier comes from the tracked
          // manifest and whose effort comes from the local file must not report one layer for
          // both. `sources` is keyed as `agents.<role>.<field>` for exactly this reason.
          io.out(`agents.${role}.tier    ${entry.tier ?? '-'}  (${sources[`agents.${role}.tier`]})`)
          io.out(`agents.${role}.effort  ${entry.effort ?? '-'}  (${sources[`agents.${role}.effort`]})`)
        }
        return 0
      }
      if (sub === 'get') {
        if (!key) { io.out('config get needs a key'); return 2 }
        // The same two guards, in the same order, as `set` and `unset` below. `getKey` does
        // re-check the key itself, but only AFTER the layers have been read, and the known-key
        // check has to come between the two — so the order is stated here rather than inherited
        // from whichever callee happens to run first. Without the known-key check,
        // `config get agents.implementer` printed `[object Object]` and exited 0.
        assertSafeKey(key)
        assertKnownKey(key, CONFIG_KEYS)
        const { resolved } = await loadValidatedConfig(root)
        const value = getKey(resolved, key)
        if (value === undefined) { io.out(`unset: ${key}`); return 2 }
        io.out(String(value))
        return 0
      }
      if (sub === 'set' || sub === 'unset') {
        if (!key) { io.out(`config ${sub} needs a key`); return 2 }
        // assertSafeKey runs for BOTH set and unset, and before anything reads or writes a
        // layer. `unset` reaches the same object walk as `set`, so a key guarded on only one
        // of the two leaves the other as a live path to Object.prototype.
        assertSafeKey(key)
        if (local && isEnforcementKey(key)) {
          io.out(`${key} is an enforcement key; it may only be set in ${GATE_FILE}`)
          return 2
        }
        // ABSENT rather than readLayer's default `null`, which it also returns for a file
        // whose whole body is `null`. Collapsed together, an absent file and a `null` one
        // would both become `{}` here — and a `null` body is a layer every READER already
        // exits 2 on, so writing it into shape would be the same file answering two ways
        // again, one layer down.
        const raw = await readLayer(root, file, { missing: ABSENT })
        const layer = raw === ABSENT ? {} : raw
        // Whichever layer this is. `readLayer` parses but does not validate, and `?? {}` only
        // catches a nullish body: a file holding `[]` or `"text"` reached `setKey`, which set
        // a property `JSON.stringify` then dropped — reported as `wrote …` at exit 0 — or
        // threw a raw TypeError. Both layers get the check, in the one place that writes them,
        // and the counterpart layer gets it too so this command agrees with every reader about
        // the repository it is writing into.
        await validateBothLayers(root, file, layer)
        if (sub === 'set') {
          if (rawValue === undefined) { io.out('config set needs a value'); return 2 }
          let parsed
          // JSON first so numbers and `false` arrive as themselves; a bare word that is not
          // valid JSON is the string the caller typed, so `set agents.implementer.tier capable`
          // works without shell quoting.
          try { parsed = JSON.parse(rawValue) } catch { parsed = rawValue }
          setKey(layer, key, validateKey(key, parsed))
        } else {
          assertKnownKey(key, UNSETTABLE_KEYS)
          unsetKey(layer, key)
        }
        await writeLayer(root, file, layer)
        io.out(`wrote ${file}`)
        if (local) {
          const added = await ensureGitignored(root, LOCAL_FILE)
          if (await isTracked(root, LOCAL_FILE)) {
            io.out(
              `${LOCAL_FILE} is tracked by git — the .gitignore entry has no effect on it;`
              + ` run \`git rm --cached ${LOCAL_FILE}\` to keep this layer out of commits`,
            )
          } else if (added) {
            io.out(`added ${LOCAL_FILE} to .gitignore`)
          }
        }
        return 0
      }
      io.out('usage: config <list|get|set|unset>')
      return 2
    } catch (err) {
      const message = configFailureMessage(err)
      if (message === null) throw err
      io.out(message)
      return 2
    }
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
