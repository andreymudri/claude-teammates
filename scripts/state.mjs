import { mkdir, open, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { constants, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
// The single definition of `teammates/<runId>/<taskId>`. Imported rather than restated so the
// branch a record is allowed to name cannot drift from the branch the run actually uses.
// enforce.mjs imports nothing, so this costs the stop-time hook no extra module graph.
import { taskBranchName } from './enforce.mjs'

const NAMES = new Set(['plan', 'status', 'findings'])

// The only bound a keyed lookup needs: one file is read, and this is how much of it. A
// legitimate location record is ~200 bytes. There is deliberately no cap on the NUMBER of
// records — nothing enumerates them, so their count cannot cost a reader anything.
const MAX_RECORD_BYTES = 64 * 1024

// O_NONBLOCK is POSIX-only; on win32 `constants.O_NONBLOCK` is undefined and 0 leaves the open
// flags untouched, which is the correct no-op there (win32 has no FIFO to block on).
const { O_RDONLY } = constants
const O_NONBLOCK = constants.O_NONBLOCK ?? 0

export function runDir(root, runId) {
  return path.join(root, '.teammates', runId)
}

function statePath(root, runId, name) {
  if (!NAMES.has(name)) throw new Error(`unknown state file: ${name}`)
  return path.join(runDir(root, runId), `${name}.json`)
}

export async function readState(root, runId, name) {
  try {
    return JSON.parse(await readFile(statePath(root, runId, name), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export async function writeState(root, runId, name, data) {
  const target = statePath(root, runId, name)
  await mkdir(path.dirname(target), { recursive: true })
  // Unique temp name so concurrent writers never share a scratch file.
  const tmp = `${target}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

export async function claimTask(root, runId, taskId, teammate) {
  const dir = path.join(runDir(root, runId), 'claims')
  await mkdir(dir, { recursive: true })
  const record = JSON.stringify({ taskId, teammate })
  try {
    // 'wx' fails with EEXIST if the file exists — this is the atomicity guarantee.
    await writeFile(path.join(dir, `${taskId}.json`), record, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
}

// ---------------------------------------------------------------------------------------------
// Worktree location records: `.teammates/index/<sha256 of the normalised worktree>.json`.
//
// NOT YET WIRED UP. As of this commit nothing in the repository calls `writeLocation` or
// `findTaskByWorktree` outside tests: the `locate` command that will write a record and the
// SubagentStop handler that will read one are separate tasks in
// docs/plans/2026-08-13-subagent-stop-enforcement.md and do not exist yet. The comments below
// describe the design those callers are being built to — read every "the hook does X" as "the
// hook is specified to do X", not as a description of running code — and the threat model is
// stated in the present tense because the file format is what it constrains, whoever writes it.
//
// The layout is keyed rather than searched, and that is the whole security argument: a reader
// derives one file name from the path it is asking about and opens it. Nothing enumerates the
// store, so the number of records in it — records are never deleted, and nothing deletes them —
// costs a lookup nothing, and no quantity of files anyone can write changes what a reader does.
// The previous scanning layout had no correct bound: every axis that could be capped (records,
// directories, bytes) was chosen by whoever wrote the files, and the order they were visited in
// was chosen by the filesystem, which also made its tests unportable between NTFS, ext4 and APFS.
//
// KNOWN LIMITATION, by design rather than oversight, and narrower than it first looks: the key
// is the hash of the RESOLVED path, so a record is missed after its worktree is deleted ONLY if
// resolving that path used to change it — a symlinked parent, an 8.3 short name, a case
// difference. For an ordinary path realpath simply throws once the directory is gone,
// `normaliseWorktree` falls back to the lexical form, that form is what was hashed at write
// time, and the record is still found. Where it does miss, the lookup returns null and a hook
// fails open — no enforcement rather than enforcement against the wrong task.
// ---------------------------------------------------------------------------------------------

// Trailing separators are noise EXCEPT at a filesystem root, where the separator is part of the
// path: stripping it turns `C:\` into the drive-RELATIVE `C:`, which realpath then expands to the
// process's current directory on that drive. A record claiming `worktree: "C:\\"` would otherwise
// match whichever directory the reader happens to be standing in.
// Only the platform's OWN separators: on win32 both `\` and `/` end a path, but on POSIX a
// backslash is an ordinary filename character, so stripping it there would collapse `/a/foo\`
// and `/a/foo` onto one key — two different directories answered by one record, and the
// reader's key-agreement check would recompute the same collapsed form and agree with it.
const TRAILING_SEPARATORS = process.platform === 'win32' ? /[\\/]+$/ : /\/+$/

function stripTrailingSeparator(p) {
  return path.parse(p).root === p ? p : p.replace(TRAILING_SEPARATORS, '')
}

// Compared, never displayed. One directory has several spellings: what git prints, what the
// harness sends in a hook payload, and what a shell reports differ in separator, in drive-letter
// and path case on Windows, in trailing separators, and — because a worktree can be reached
// through a symlinked parent (/var vs /private/var) or an 8.3 short name — in the identity of
// the directory components themselves. Trailing separator, case and separator style are folded
// lexically; the rest needs the filesystem, so `resolveLinks` resolves the path through realpath.
//
// That branch is a filesystem call, and its cost is bounded by the filesystem, not by this code:
// realpath on a path that does not exist returns quickly, but on win32 an unreachable UNC share
// blocks the calling thread for as long as the network stack takes to give up — 26.8 s measured
// once on this host, synchronously, with the event loop stopped. It is therefore NOT a cheap
// fallback, and callers holding untrusted paths pass `resolveLinks: false` and decide for
// themselves (see `isLocalAbsolute`).
//
// What remains uncovered even with links resolved: a path that no longer exists at compare time
// falls back to its lexical form and so still fails to match a differently-spelled record, and
// two genuinely distinct paths that a bind mount points at one target compare equal. Both cost
// only the early catch — a missed match lets the hook allow the stop, its fail-open default.
export function normaliseWorktree(p, { resolveLinks = true } = {}) {
  if (typeof p !== 'string' || p === '') return ''
  const resolved = stripTrailingSeparator(path.resolve(p))
  let real = resolved
  if (resolveLinks) {
    try {
      // .native canonicalises case and expands 8.3 short names on Windows; both platforms
      // resolve symlinks. It throws for a path that does not exist — compare that lexically.
      real = realpathSync.native(resolved)
    } catch { /* fall back to the lexical form */ }
  }
  const trimmed = stripTrailingSeparator(real)
  return process.platform === 'win32' ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed
}

// Whether a path is safe to hand to realpath. A record's worktree is attacker-supplied — anyone
// with a shell can write a file under `.teammates/` — and a UNC path to an unreachable host is
// the measured stall above. Ten such records would keep every stop inside this lookup for
// minutes, past the hook's own timeout, which switches enforcement off for the whole run at no
// cost to whoever wrote them. A plain local absolute path cannot do that. Residual, stated
// rather than fixed: a drive letter mapped to an unreachable share is a local-looking spelling
// and still pays the stall, and nothing cheap tells the two apart.
//
// Exported so the classification is testable on its own: as a private helper its only witness
// was the shape of its call site, which pins the name and not one decision it makes.
export function isLocalAbsolute(p) {
  if (typeof p !== 'string' || p === '') return false
  if (process.platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p)
  return p.startsWith('/') && !p.startsWith('//')
}

// True when `segment` names a child of `baseDir` directly: not empty, not `.` or `..`, not
// absolute, not climbing out, and not descending either. This is deliberately STRICTER than
// `assertContained` in scripts/cli.mjs, which tests containment only: `a/b` is a contained
// path and that function accepts it, while this one rejects it, because a location record
// lives directly in `worktrees/` and a nested id would only fail later as an ENOENT. The
// error message below was copied from that function to keep the two readable side by side,
// but nothing cross-checks the wording — if cli.mjs is reworded, this text simply stays as
// it is. Treat the match as a convention, not a guarantee.
function relativeInside(baseDir, value) {
  if (typeof value !== 'string' || value === '') return null
  const rel = path.relative(path.resolve(baseDir), path.resolve(path.join(baseDir, value)))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

// Containment only — nesting allowed. This is `assertContained`'s semantics from
// scripts/cli.mjs:591, and it has to be, because `init-run --run 2026/substop` is accepted
// there and creates `.teammates/2026/substop/`. A stricter rule here would throw for a run the
// CLI legitimately made, `locate` would abort, and enforcement would be off for that whole run.
function isContained(baseDir, value) {
  return relativeInside(baseDir, value) !== null
}

// Containment AND single-segment. A taskId names one file in one directory and never descends.
function isSegment(baseDir, value) {
  const rel = relativeInside(baseDir, value)
  return rel !== null && !rel.includes(path.sep)
}

// PATH SAFETY AND TOKEN SAFETY ARE DIFFERENT PROPERTIES, and each id needs both. Containment
// (above) answers "can this value escape the store". What follows answers what containment
// cannot: both ids become a git ref through `taskBranchName`, argv through
// `complete --run <id> --task <id>`, and text in a teammate's stderr.
//
// A CHARSET CANNOT EXPRESS THAT, and the one that used to be here was wrong in both directions.
// Too permissive: `sub/../substop` is contained, because path.join normalises the alias away,
// and passes any class containing `.` and `/` — yet `git check-ref-format` rejects it, the
// returned string carries `..` into anything that joins it onto a path, and because the record's
// author writes both the runId and the branch, the branch equality check compares two values it
// chose and agrees. Too strict: `café` is accepted by init-run and by git, but was refused here,
// which would abort `locate` and take enforcement off that entire run.
//
// THIS IS A SUBSET of `git check-ref-format`, which is the authority. Implemented: no empty
// component, none equal to `.` or `..`, none beginning with `.` or ending with `.lock`, no ASCII
// control byte or DEL, no space, none of `~ ^ : ? * [ \`, no `@{`, no `//`, no trailing `/` or
// `.`. Deliberately NOT implemented, because nothing here generates them: the `refs/` prefix
// rules, the lone-`@` rule, and the `--normalize` / `--allow-onelevel` variants. Two additions
// git does not make and this project needs: no leading `-`, because the id reaches argv, and a
// length bound.
const REF_FORBIDDEN = new RegExp('[\\u0000-\\u001f\\u007f ~^:?*\\[\\\\]')

// Three clauses below are provably redundant, and mutation testing says so rather than my
// judgement: `.` and `..` are already refused by the leading-dot rule, and the empty-component
// rule is what refuses `//`. They are written out anyway because this function's contract is
// "the git rule", and a reader checking it against `git check-ref-format` should find each
// clause rather than have to re-derive which other clause happens to cover it.
function isRefComponent(component) {
  if (component === '' || component === '.' || component === '..') return false
  if (component.startsWith('.') || component.endsWith('.lock')) return false
  if (component.includes('@{')) return false
  return !REF_FORBIDDEN.test(component)
}

function isRefPath(value, { maxLength, allowSeparator }) {
  if (typeof value !== 'string' || value === '') return false
  if (value.length > maxLength) return false
  if (value.startsWith('-')) return false
  if (value.endsWith('/') || value.endsWith('.')) return false
  if (value.includes('//')) return false
  const components = value.split('/')
  if (!allowSeparator && components.length !== 1) return false
  return components.every(isRefComponent)
}

// A run id may nest, because init-run creates nested ones. A task id is exactly one component.
// The trailing-slash shape a single-segment path check cannot see — `T1/` joins to the same
// directory as `T1`, so containment accepts it — is caught by the no-trailing-`/` rule above,
// which means `allowSeparator: false` is itself redundant with `isSegment` here; it stays so the
// predicate reads correctly on its own if the path check beside it ever changes. The bounds are
// this project's choice rather than git's, and are deliberately generous.
const isRunId = (root, runId) => isContained(path.join(root, '.teammates'), runId)
  && isRefPath(runId, { maxLength: 255, allowSeparator: true })
const isTaskId = (root, taskId) => isSegment(path.join(root, '.teammates'), taskId)
  && isRefPath(taskId, { maxLength: 128, allowSeparator: false })

// EVERY interpolation of an untrusted id into a message goes through this, the containment
// messages included: an id crafted to fail containment is precisely the one carrying the escape
// sequence, and while these guards ran in the other order it reached the throw verbatim.
// JSON.stringify quotes and escapes C0; it passes DEL, the C1 block (U+009B is CSI, a control
// introducer needing no ESC), and U+2028/U+2029 through raw, so those are escaped after it.
const UNSAFE_TO_PRINT = new RegExp('[\\u007f-\\u009f\\u2028\\u2029]', 'g')
const shown = (value) => JSON.stringify(String(value))
  .replace(UNSAFE_TO_PRINT, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`)

// Applied inside the writer rather than at each call site, so that any caller added later
// inherits it rather than having to remember it — there is none but the tests yet. The writer
// refuses exactly what the reader refuses: a record that could be written but never read would
// take a worktree's enforcement away silently.
function assertIds(root, runId, taskId) {
  if (!isContained(path.join(root, '.teammates'), runId)) {
    throw new Error(`--run ${shown(runId)} escapes the run directory`)
  }
  if (!isSegment(path.join(root, '.teammates'), taskId)) {
    throw new Error(`--task ${shown(taskId)} escapes the run directory`)
  }
  if (!isRunId(root, runId)) throw new Error(`--run ${shown(runId)} is not a usable run id`)
  if (!isTaskId(root, taskId)) throw new Error(`--task ${shown(taskId)} is not a usable task id`)

}

// The record's address IS its worktree. Hashing the normalised path gives a fixed-length,
// separator-free file name, so the lookup opens one known file instead of searching for it —
// which is what removes the scan, and with it every bound that had to be chosen (records,
// directories, bytes) over input an attacker writes and a filesystem orders.
export function worktreeKey(worktree, options) {
  const normalised = normaliseWorktree(worktree, options)
  if (normalised === '') return ''
  return createHash('sha256').update(normalised).digest('hex')
}

export function indexDir(root) {
  return path.join(root, '.teammates', 'index')
}

// To be written by the teammate at start and read by the stop-time hook; neither exists yet.
// Overwritable on purpose: a teammate that re-enters the same worktree rewrites that worktree's
// record in place. A respawn into a DIFFERENT worktree writes a different key, and the old
// record stays — nothing deletes records, and nothing needs to, because no reader enumerates
// them any more. A stale record is only reachable by asking about the exact directory it names.
export async function writeLocation(root, runId, taskId, { worktree, branch }) {
  assertIds(root, runId, taskId)
  // The SAME predicate the reader applies, on BOTH the value handed in and the value stored.
  // The raw check keeps a reader-dependent spelling (`.`, `relative/x`) from being recorded as
  // whatever directory the writer happened to stand in. The check on the NORMALISED value is
  // the one that matters for readability, and it was missing: a symlink whose target is a UNC
  // share is `isLocalAbsolute` as written, so the write succeeded and returned a path, while
  // the stored `//host/share/...` is not `isLocalAbsolute`, so every later read returned null —
  // written successfully, unreadable forever, which is the exact outcome this guard exists to
  // prevent. Normalising first and re-checking closes it, whatever the link resolves to.
  if (!isLocalAbsolute(worktree)) {
    throw new Error(`--worktree ${shown(worktree)} is not a path a record can name`)
  }
  // Stored normalised, not raw, so the value on disk is the one the key was computed from and
  // the two cannot disagree about which directory this record is for.
  const normalised = normaliseWorktree(worktree)
  if (!isLocalAbsolute(normalised)) {
    throw new Error(`--worktree ${shown(worktree)} resolves to ${shown(normalised)}, which no record can name`)
  }
  const key = worktreeKey(normalised)
  if (key === '') throw new Error(`--worktree ${shown(worktree)} is not a path a record can name`)
  const dir = indexDir(root)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${key}.json`)
  // Unique temp name, then rename: a concurrent reader never sees a half-written record.
  const tmp = `${target}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
  await writeFile(tmp, `${JSON.stringify({ runId, taskId, branch, worktree: normalised })}\n`, 'utf8')
  await rename(tmp, target)
  return target
}

// Returns { runId, taskId, branch } for the location record naming `worktree`, or null.
// Reads exactly one file, whose name is derived from the query, so there is no directory to
// enumerate, nothing to order, and no quantity of records anyone can write that changes the
// cost of a lookup. A missing file is the ordinary answer and is not an error.
//
// Every rejection below returns null rather than throwing: the caller is a hook whose failure
// mode must be "allow the stop", never "crash every agent on this machine".
export async function findTaskByWorktree(root, worktree, { maxRecordBytes = MAX_RECORD_BYTES } = {}) {
  // The query comes from the caller (a hook payload's cwd), and it is the only path this
  // function resolves through the filesystem on trust.
  const key = worktreeKey(worktree)
  // Redundant and kept deliberately: an empty key would build `index/.json`, which does not
  // exist, so the open below already fails to null. Mutation confirms no test can tell the two
  // apart. It stays as a statement of intent — "an unnameable path is not a lookup" — not as a
  // guard anything depends on.
  if (key === '') return null
  let handle
  try {
    // Open once, then fstat and read THROUGH that handle. A stat-then-read pair is a
    // time-of-check/time-of-use race — rename(2) is atomic and the record's author can swap a
    // FIFO in between, and a blocking open(2) on a FIFO with no writer never returns, which is
    // enforcement switched off rather than merely slowed. One descriptor closes it: the file
    // that is fstat'd is the file that is read. O_NONBLOCK keeps the open itself from blocking;
    // it does not exist on win32, where 0 leaves the flags unchanged.
    handle = await open(path.join(indexDir(root), `${key}.json`), O_RDONLY | O_NONBLOCK)
    const info = await handle.stat()
    // NO TEST ON ANY PLATFORM OBSERVES THIS GUARD, and the reason is measured rather than
    // assumed: libuv opens a writer-less FIFO without blocking (node resolves immediately where
    // `cat` hangs), and such a FIFO then fstats to size 0, so the bounded read below reads
    // nothing and `JSON.parse('')` throws into the catch — producing exactly the null this line
    // produces. A directory fails its read for the same reason on both platforms. It stays as
    // defence in depth: it is one field of an fstat already performed, and it is the only thing
    // here that would still hold if a future edit made the read blocking or forgiving. An
    // earlier version of this comment claimed a POSIX test pinned it; that claim was false.
    if (!info.isFile()) return null
    // LOAD-BEARING, unlike the line above, and an earlier comment calling it redundant was
    // wrong: the bounded read only truncates: `{"…valid record…"}` followed by 200 kB of spaces
    // parses perfectly from its first bytes, so without this an oversized file is accepted in
    // full. Rejecting on the fstat'd size is what makes the cap real.
    if (info.size > maxRecordBytes) return null
    // Bounded read, not handle.readFile: readFile drains to EOF regardless of what fstat said,
    // so a file that grows between the two would defeat the size check entirely and the cap
    // would be advisory. Reading a fixed count makes the cap the actual limit; a file that grew
    // is then truncated mid-JSON and fails to parse, which is the same null as any other
    // malformed record.
    const want = Math.min(info.size, maxRecordBytes)
    const buffer = Buffer.alloc(want)
    const { bytesRead } = await handle.read(buffer, 0, want, 0)
    const record = JSON.parse(buffer.toString('utf8', 0, bytesRead))

    // Cheap string validation before anything touches the filesystem again. Both ids now arrive
    // from file CONTENT — runId used to be a directory name and could not lie; under this layout
    // it can — so each is checked for containment AND for being a usable token. They are not
    // checked identically: a run id may nest (`2026/substop`), a task id may not, which is why
    // there are two predicates rather than one applied twice. A failure is a skip, not a throw.
    if (!isRunId(root, record.runId)) return null
    if (!isTaskId(root, record.taskId)) return null

    // The record must name a worktree that hashes back to the file it was found in. This
    // replaces the old filename-equality check and is strictly stronger: a forged record has to
    // name the very directory whose key it was filed under, so it can only ever answer for that
    // one directory — it cannot be planted to answer for someone else's.
    //
    // `isLocalAbsolute` first, because the hash below realpaths a value the record supplies:
    // a UNC path to an unreachable host blocks the thread for tens of seconds, and a relative
    // value — or a win32 `\foo`, which is `path.isAbsolute` yet drive-relative — is completed
    // from the READER's own state, so it would hash back to whatever directory the reader is
    // standing in and answer for it.
    //
    // One comparison, on the RESOLVED form, matching how the key was computed. An earlier
    // version also compared the unresolved form as a disjunction; mutation testing showed no
    // test could distinguish it, and reasoning agrees — the two forms differ only when links
    // are involved, and in that case the resolved form is the one both sides agree on, while a
    // path that does not exist resolves to its own lexical form at both ends anyway.
    if (!isLocalAbsolute(record.worktree)) return null
    if (worktreeKey(record.worktree) !== key) return null

    return {
      runId: record.runId,
      taskId: record.taskId,
      // `branch` is the field that survives an honest taskId and an honest worktree, so nothing
      // cross-checked above constrains it. Unvalidated it is a lever on the caller's git: any
      // existing ref waves past a teammate that created no branch at all, and a rival's ref
      // turns a hook's remediation text into an instruction to force-move another task's
      // branch. A record may name exactly one branch — the one this run gives this task — and
      // anything else drops to null rather than discarding the record, because the record that
      // legitimately carries a non-canonical branch is the teammate that never checked its task
      // branch out, i.e. precisely the do-nothing case the hook exists to catch. Null is what
      // the caller falls back on, and it recomputes the same name from runId and taskId.
      branch: record.branch === taskBranchName(record.runId, record.taskId) ? record.branch : null,
    }
  } catch {
    // ENOENT is the ordinary "no record for this directory" answer and says nothing further.
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

// Returns the task to the pool. Idempotent: releasing an unclaimed or already-released
// task is not an error, so callers never need to check before releasing.
export async function releaseClaim(root, runId, taskId) {
  const target = path.join(runDir(root, runId), 'claims', `${taskId}.json`)
  try {
    await unlink(target)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  return true
}

// Round counts are bookkeeping, not enforcement. status.json is written by the agents the
// gate enforces, so a teammate can reset its own count and buy more retries. That costs
// tokens; it cannot produce a false PASS, because every verdict is recomputed from git.
//
// State the bound precisely, because the obvious phrasing is wrong: the gate does NOT read
// nothing under .teammates/ — `gate` and `complete` both read status.json (scripts/cli.mjs:2722
// and :2814). What holds is the half that matters: no forgery here manufactures a PASS. The
// files under .teammates/ are read for bookkeeping, and a corrupt one fails the run CLOSED —
// non-JSON in status.json makes readState rethrow, and gate then reports FAIL with `run-state`
// among the failures and exits 1 even with every check passing. Denial, not escalation.
//
// The worktree location record above is weaker still,
// and not in the way "a teammate can only hurt itself" would suggest: nothing binds a record to
// a writer. Any teammate in the run can write any record, including one naming a DIFFERENT
// teammate's worktree, and newest-wins then resolves that directory to the forged record — so
// the victim is blocked, or judged against a branch that is not its work, while the author of
// the record pays nothing. What that still cannot do is manufacture a PASS: the gate recomputes
// every verdict from git, so the reachable damage is a wrong or missing early catch, never a
// task that ships unverified.
export function readFixRounds(status, phase) {
  return status?.fixRounds?.[String(phase)] ?? {}
}

export function recordFixRound(status, phase, taskId) {
  const key = String(phase)
  const fixRounds = { ...(status?.fixRounds ?? {}) }
  fixRounds[key] = { ...(fixRounds[key] ?? {}) }
  fixRounds[key][taskId] = (fixRounds[key][taskId] ?? 0) + 1
  return { ...status, fixRounds }
}
