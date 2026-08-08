import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePlan } from './plan-parser.mjs'
import { assignPhases } from './phases.mjs'
import { readState, writeState, claimTask, releaseClaim, readFixRounds, recordFixRound } from './state.mjs'
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
import { generatePhaseWorkflow } from './workflow-gen.mjs'
import { createGit, GitError, defaultGitExec } from './git.mjs'
import { deriveContext } from './gate-runner.mjs'

const USAGE = `usage: cli.mjs <init-run|gate|doctor|digest|claim|unclaim|workflow|complete|fix|record-fix-round|config> [options]

  init-run <planPath> --run <id> [--root <path>]
  doctor   --run <id> --plan <path> [--base <branch>] [--run-branch <name>] [--root <path>]
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
const VALUELESS_FLAGS = new Set(['no-fleet', 'local'])

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

const REQUIRED = {
  'init-run': ['run'],
  gate: ['run', 'plan'],
  doctor: ['run', 'plan'],
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
  if (command === 'gate'
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
    if (duplicated.has(r?.name)) {
      return `--results names a check declared more than once in this phase's manifest: ${JSON.stringify(r?.name)}`
    }
    const check = byName.get(r?.name)
    if (!check) return `--results names a check not in this phase's manifest: ${JSON.stringify(r?.name)}`
    if (!SUPPLIABLE_KINDS.has(check.kind)) return `--results may not supply a ${check.kind} check: ${check.name}`
    if (!SUPPLIED_STATUSES.has(r.status)) return `--results carries an unrecognized status for ${check.name}: ${JSON.stringify(r.status)}`
    if (r.source !== undefined && !SUPPLIED_SOURCES.has(r.source)) {
      return `--results carries an unrecognized source for ${check.name}: ${JSON.stringify(r.source)} (expected "response" or "file")`
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
function configFailureMessage(err) {
  if (err instanceof ConfigError) return err.message
  if (typeof err?.syscall === 'string') return `could not access the config layers: ${err.message}`
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

export async function runCli(argv, io = { out: console.log }) {
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
        .map((t) => `${t.id} (${t.tier}, ${t.tierSource})`)
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

    const src = await generatePhaseWorkflow({
      runId,
      phase,
      tasks: phaseTasks,
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

    let report
    try {
      report = await collectDoctorReport({
        git,
        runId,
        runBranch,
        baseBranch: await resolveBaseBranch(git, flags.base),
        tasks,
        repoRoot: root,
      })
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      io.out(`doctor could not read the repository: ${err.message}`)
      return 2
    }
    io.out(renderDoctor(report))
    // 1 on problems, mirroring the gate, so a caller can branch on the exit code. It is still
    // a report: nothing is recorded, and no verdict is issued or implied.
    return report.problems.length === 0 ? 0 : 1
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
