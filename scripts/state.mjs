import { mkdir, open, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { constants, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
// The single definition of `teammates/<runId>/<taskId>`. Imported rather than restated so the
// branch a record is allowed to name cannot drift from the branch the run actually uses.
// enforce.mjs imports nothing, so this costs the stop-time hook no extra module graph.
import { taskBranchName } from './enforce.mjs'

const NAMES = new Set(['plan', 'status', 'findings'])

// EVERY BOUND IN THIS FILE IS UTF-8 BYTES, measured with Buffer.byteLength, and that uniformity
// is the point rather than a detail. While the field bounds counted UTF-16 code units and the
// record bound counted bytes, they did not compose: `'C:/' + '日'.repeat(32000)` is 32,003 code
// units — inside a 32,767 "length" bound — and serialises to about 96 KB, past the record bound.
// Three separate notes claimed the record guard was subsumed on arithmetic that silently mixed
// the two units. In one unit the arithmetic is checkable: 255 + 128 + 512 + 32,767 plus JSON
// overhead is under 34 KB, comfortably inside the 64 KB below.
const MAX_RECORD_BYTES = 64 * 1024

// A branch name is a refname; git's own limit is the filesystem's, and this is far above any
// real one. The canonical maximum this project generates is 394 bytes.
const MAX_BRANCH_BYTES = 512

// Above any real path: win32 extended-length paths stop at 32,767 and POSIX PATH_MAX is
// typically 4096. This exists because `isLocalAbsolute` checks a prefix and nothing else.
const MAX_WORKTREE_BYTES = 32_767

// An id is a label a human types; these are generous. Bytes, so a non-ASCII id is bounded by
// what it costs on disk rather than by how JavaScript happens to count its characters.
const MAX_RUN_ID_BYTES = 255
const MAX_TASK_ID_BYTES = 128

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
// cost to whoever wrote them. What this predicate buys is that the obvious network spellings —
// `//host/share` and `\\host\share` — never reach realpath at all.
//
// RESIDUAL, stated rather than fixed, and NOT win32-only, which an earlier version of this
// comment implied by naming only the win32 case and claiming "a plain local absolute path
// cannot do that". Any path that merely looks local while resolving over the network still pays
// the stall: on win32 a drive letter mapped to an unreachable share, and on POSIX an automounter
// path such as `/net/<host>/wt`, or any autofs or NFS mount point, which is an ordinary absolute
// path by every syntactic test. Nothing cheap separates those from local directories, and
// rejecting them by prefix would reject ordinary paths, so the residual stands on both platforms.
// UNVERIFIED on the POSIX side: this host is win32 with no autofs, so that half is reasoned from
// how autofs behaves rather than measured. Confirming it needs a Linux host with an autofs map
// pointing at an unreachable server, then timing `normaliseWorktree('/net/<unreachable>/wt')`.
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

// AN ALLOWLIST, NOT A BLOCKLIST — and this is the fourth attempt at these rules, so the reason
// for the change of shape matters more than the rules themselves.
//
// Every blocklist here was incomplete in a way nobody could see by reading it. The last one used
// `Default_Ignorable_Code_Point`, which is NOT the authority on "invisible": its derivation
// subtracts the prepended-concatenation marks and the Egyptian format controls, so 29 `Cf` code
// points still passed — U+0600-0605, U+06DD, U+070F, U+0890, U+0891, U+08E2, U+110BD, U+110CD
// and U+13430-1343F — each of which makes a git ref that sits beside the honest one and renders
// identically. Worse than being invisible: because a forged record supplies BOTH the ids and the
// branch, the canonicality check compares the forgery against itself and confirms it. The same
// list also let U+2800 and all 16 `Zs` separators through while refusing ASCII space, and was
// simultaneously too strict — ZWJ, ZWNJ and variation selectors are default-ignorable but
// functional, so an emoji run id that `init-run` and `check-ref-format` both accept was refused
// here, costing that run its enforcement.
//
// An allowlist ends the class instead of patching it again: letters, marks, digits, and the
// three punctuation characters these ids actually use. It rejects every one of the 29 above, and
// every future addition to `Cf`, without naming any of them.
//
// TWO CONSEQUENCES, deliberate and stated rather than left to be discovered:
//
// 1. It refuses ZWJ and ZWNJ, which a Persian or Devanagari run id may legitimately need. The
//    reasoning is Unicode's own: UAX #31 allows `Join_Control` in general identifiers and
//    excludes it from the RESTRICTED profile meant for security-sensitive ones. These ids become
//    git refs and terminal output, where invisibility is the attack, so restricted is the right
//    profile. `\p{M}` still admits U+FE0F, so a variation selector on a LETTER is fine — but an
//    emoji id is not, and it was wrong to say otherwise: an emoji base is a Symbol (`So`), which
//    this allowlist does not admit at all, so `emoji<heart><VS16>` stays refused whatever the
//    selector does. Measured, after a test written to assert the opposite failed.
//
// 2. It refuses `;`, which `init-run` currently accepts. That divergence is real and is not
//    closed here: THE STORE'S RULE IS AUTHORITATIVE, and `init-run` (scripts/cli.mjs, a later
//    task's file) has to adopt it. Until it does, a run id containing `;` is creatable by the
//    CLI and unrecordable here, which costs that run its enforcement — the cost is visible and
//    on the CLI's side of the line rather than hidden in a record nobody can read.
const ID_COMPONENT = /^[\p{L}\p{M}\p{N}._-]+$/u

const INVISIBLE = new RegExp('\\p{Default_Ignorable_Code_Point}', 'u')
const VARIATION_SELECTOR = new RegExp('^[\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}]$', 'u')

// THE ALLOWLIST ALONE IS NOT ENOUGH, and a test written for this round found why: three
// invisible code points are classified as LETTERS and so pass `\p{L}` — U+115F and U+3164
// (Hangul fillers) and U+FFA0 (halfwidth filler). They render as nothing, which is exactly the
// twin-branch attack the allowlist was adopted to end, so "the allowlist rejects every
// Default_Ignorable point" is false and this clause is what makes it true.
//
// The carve-out is variation selectors, kept deliberately: they are default-ignorable but
// functional, and dropping them would refuse an emoji id that `init-run` and git both accept —
// the over-strictness half of the same finding. So the rule is: allowlisted characters, minus
// anything invisible, plus variation selectors. ZWJ and ZWNJ stay refused (UAX #31's restricted
// profile), which is the stated cost for Persian and Devanagari ids.
function isIdComponent(component) {
  if (component === '.' || component === '..') return false
  // The id is spent as argv, so no component may look like an option.
  if (component.startsWith('-')) return false
  if (!ID_COMPONENT.test(component)) return false
  return ![...component].some((c) => INVISIBLE.test(c) && !VARIATION_SELECTOR.test(c))
}

// `..` is checked over the WHOLE value, not per component: it is revision-range syntax, so
// `a..b` inside one component matters as much as a `..` component does.
//
// `allowSeparator: false` is NOT covered by `isSegment` beside the call, and saying it was is a
// mistake this comment has made before. For `./b`, `path.relative` resolves the `.` away and
// `isSegment` returns TRUE. The shapes it must cover are `./b` and `./-b`, and what rejects them
// is this clause TOGETHER WITH the `.`-component rule above: remove either alone and the other
// still refuses both shapes, so neither dies alone under mutation — measured on win32 and on
// Linux, not assumed. That is the same jointly-load-bearing shape declared elsewhere in this
// file, and it is named here so the next reader does not mistake the survivor for dead code.
function isIdPath(value, { maxBytes, allowSeparator }) {
  if (typeof value !== 'string' || value === '') return false
  // Bytes, not code units, because every other bound in this file is bytes — see the record
  // guard in writeLocation. Mixing the two is how a 32,003-character worktree serialised to
  // 96 KB while passing a 32,767 "length" check.
  if (Buffer.byteLength(value, 'utf8') > maxBytes) return false
  if (value.includes('..')) return false
  const components = value.split('/')
  if (!allowSeparator && components.length !== 1) return false
  // An empty component — from a leading, trailing or doubled separator — fails ID_COMPONENT,
  // which requires one character or more. No separate clause is needed for it.
  return components.every(isIdComponent)
}

// A run id may nest, because init-run creates nested ones. A task id is exactly one component.
const isRunId = (root, runId) => isContained(path.join(root, '.teammates'), runId)
  && isIdPath(runId, { maxBytes: MAX_RUN_ID_BYTES, allowSeparator: true })
const isTaskId = (root, taskId) => isSegment(path.join(root, '.teammates'), taskId)
  && isIdPath(taskId, { maxBytes: MAX_TASK_ID_BYTES, allowSeparator: false })

// OUTPUT ESCAPING, deliberately INDEPENDENT of the id rule above. The two answer different
// questions — "may this be an id" versus "is this safe to print" — and `shown` is also used on
// values that are not ids, such as a worktree path. Keeping them separate means a later
// relaxation of the id rule cannot silently make the printer unsafe. This one stays a blocklist
// because that is the right shape for output: anything invisible or control-like is escaped, and
// being over-broad here costs nothing but an escape sequence in an error message.
const UNPRINTABLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]|\\p{Cf}|\\p{Default_Ignorable_Code_Point}', 'gu')
const shown = (value) => JSON.stringify(String(value))
  .replace(UNPRINTABLE, (c) => `\\u{${c.codePointAt(0).toString(16)}}`)

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
  // whatever directory the writer happened to stand in, and is pinned by test.
  //
  // The check on the NORMALISED value is the one that matters, and it IS reachable: a directory
  // symlink whose target is a UNC path has a raw spelling that looks local and a resolved one
  // that does not, so without this the write succeeds and every later read of that record
  // returns null — written successfully, unreadable forever. `fs.symlinkSync(target, link,
  // 'dir')` with `\\wsl.localhost\Ubuntu\tmp` or `\\localhost\C$\Users` reproduces it, and the
  // test does exactly that. A previous version of this comment claimed the line was unreachable
  // on the strength of a measurement that was wrong: the UNC target string had lost its
  // backslashes to shell escaping, so realpath was resolving a dangling drive-relative path and
  // throwing ENOENT. The lesson is cheap to state and was expensive twice: build Windows path
  // literals in code, never through a shell argument.
  if (!isLocalAbsolute(worktree)) {
    throw new Error(`--worktree ${shown(worktree)} is not a path a record can name`)
  }
  // Stored normalised, not raw, so the value on disk is the one the key was computed from and
  // the two cannot disagree about which directory this record is for.
  const normalised = normaliseWorktree(worktree)
  // `isLocalAbsolute` only inspects the prefix, so without this a worktree is unbounded: a
  // 70,000-character path resolves lexically (realpath throws for a path that does not exist)
  // and writes a record no read can ever return. Well above any real path limit — win32
  // extended paths stop at 32,767 and POSIX PATH_MAX is typically 4096.
  const worktreeBytes = Buffer.byteLength(normalised, 'utf8')
  if (worktreeBytes > MAX_WORKTREE_BYTES) {
    throw new Error(`--worktree is ${worktreeBytes} bytes, over the ${MAX_WORKTREE_BYTES} allowed`)
  }
  if (!isLocalAbsolute(normalised)) {
    throw new Error(`--worktree ${shown(worktree)} resolves to ${shown(normalised)}, which no record can name`)
  }
  const key = worktreeKey(normalised)
  if (key === '') throw new Error(`--worktree ${shown(worktree)} is not a path a record can name`)
  // `branch` was the one field with no bound, and it is enough on its own to defeat every other
  // check here: a 70 KB branch string writes a record the size cap then refuses on every read,
  // which is the "written successfully, unreadable forever" asymmetry the guards above exist to
  // prevent. It is not required to be canonical — a teammate that never created its task branch
  // legitimately records the harness's own branch, and that is the case the hook exists to
  // catch — so only its type and length are constrained here; the reader decides what it means.
  if (branch !== null && branch !== undefined && typeof branch !== 'string') {
    throw new Error(`--branch ${shown(branch)} is not a branch name`)
  }
  if (typeof branch === 'string' && Buffer.byteLength(branch, 'utf8') > MAX_BRANCH_BYTES) {
    throw new Error(`--branch ${shown(branch.slice(0, 40))}... is longer than ${MAX_BRANCH_BYTES} bytes`)
  }
  const dir = indexDir(root)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${key}.json`)
  const serialised = `${JSON.stringify({ runId, taskId, branch, worktree: normalised })}\n`
  // The general form of the same rule: whatever the fields are, refuse to write a record this
  // module's own reader would reject on size.
  //
  // An earlier note called this unreachable by adding up the other bounds. That arithmetic left
  // out `worktree`, which had NO length bound at all: `isLocalAbsolute` is a prefix test, and
  // when realpath throws — which it does for a path that does not exist — `normaliseWorktree`
  // falls back to the lexical form, so `'C:\' + 'a'.repeat(70000)` reached the serialiser and
  // this guard was the only thing that stopped it. It is now bounded above, which returns this
  // check to being a backstop for a field added later; mutation confirms nothing distinguishes
  // it once the field bounds hold, and that is the accurate claim rather than "unreachable".
  if (Buffer.byteLength(serialised, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error(`record for ${shown(taskId)} is larger than ${MAX_RECORD_BYTES} bytes and could never be read back`)
  }
  // Unique temp name, then rename: a concurrent reader never sees a half-written record.
  const tmp = `${target}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
  await writeFile(tmp, serialised, 'utf8')
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
    // NO TEST ON ANY PLATFORM OBSERVES THIS PARTICULAR LINE, and the reason is measured rather
    // than assumed: libuv opens a writer-less FIFO without blocking (node resolves immediately
    // where `cat` hangs), and such a FIFO then fstats to size 0, so the bounded read below reads
    // nothing and `JSON.parse('')` throws into the catch — producing exactly the null this line
    // produces. A directory fails its read for the same reason on both platforms. It stays as
    // defence in depth: it is one field of an fstat already performed, and it is the only thing
    // here that would still hold if a future edit made the read blocking or forgiving. As for
    // `O_NONBLOCK` above: whether IT is pinned depends on the node version — measured failing
    // the FIFO test after ~5 s on node 24.18.0 and surviving on 18.19.1, both on WSL Ubuntu —
    // so neither flag is claimed here as pinned on every runtime.
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
