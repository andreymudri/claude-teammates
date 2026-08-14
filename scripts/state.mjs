import { mkdir, readdir, readFile, stat, writeFile, rename, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
// The single definition of `teammates/<runId>/<taskId>`. Imported rather than restated so the
// branch a record is allowed to name cannot drift from the branch the run actually uses.
// enforce.mjs imports nothing, so this costs the stop-time hook no extra module graph.
import { taskBranchName } from './enforce.mjs'

const NAMES = new Set(['plan', 'status', 'findings'])

// Bounds on what one worktree lookup will read. A legitimate location record is ~200 bytes and
// a run holds one per task, so these are generous by orders of magnitude and exist only to stop
// a hand-written record from turning a stop-time hook into a timeout. Both are overridable per
// call so the behaviour can be exercised without writing thousands of files.
const MAX_RECORD_BYTES = 64 * 1024
const MAX_RECORDS = 5000

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

// Trailing separators are noise EXCEPT at a filesystem root, where the separator is part of the
// path: stripping it turns `C:\` into the drive-RELATIVE `C:`, which realpath then expands to the
// process's current directory on that drive. A record claiming `worktree: "C:\\"` would otherwise
// match whichever directory the reader happens to be standing in.
function stripTrailingSeparator(p) {
  return path.parse(p).root === p ? p : p.replace(/[\\/]+$/, '')
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
function isSegment(baseDir, segment) {
  if (typeof segment !== 'string' || segment === '') return false
  const rel = path.relative(path.resolve(baseDir), path.resolve(path.join(baseDir, segment)))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep)
}

// Applied inside the writer rather than at each call site so every caller inherits it.
// A taskId is a single path segment and nothing else: `--task ../claims/T5` would otherwise
// plant a claim file that makes T5 unclaimable for the rest of the run — the phase then
// finishes with T5 silently unimplemented — and `--task ../status` would overwrite
// status.json, while more `..` escapes the repository.
function assertSegment(baseDir, segment, flagName) {
  if (!isSegment(baseDir, segment)) {
    throw new Error(`${flagName} ${segment} escapes the run directory`)
  }
}

// Written by the teammate at start, read by the stop-time hook. Overwritable on purpose:
// a respawned teammate re-enters the same task from a different worktree, and a record
// that could not be updated would point the hook at a directory that no longer exists.
export async function writeLocation(root, runId, taskId, { worktree, branch }) {
  assertSegment(path.join(root, '.teammates'), runId, '--run')
  const dir = path.join(runDir(root, runId), 'worktrees')
  assertSegment(dir, taskId, '--task')
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${taskId}.json`)
  // Unique temp name, then rename: a concurrent reader never sees a half-written record.
  const tmp = `${target}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
  await writeFile(tmp, `${JSON.stringify({ taskId, worktree, branch })}\n`, 'utf8')
  await rename(tmp, target)
  return target
}

// A total order over matching records: newest write first, then the later run id, then the
// later file name. Every key is needed for totality — mtime alone ties on a coarse filesystem
// clock (FAT 2s, ext3 and HFS+ 1s, some overlay mounts), and run id alone still ties for two
// records written inside ONE run, which is exactly the respawn-into-a-reused-worktree case
// this lookup exists for. With the file name as the last key no pair compares equal, so the
// answer never falls through to readdir order.
function laterThan(a, b) {
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs
  if (a.runId !== b.runId) return a.runId > b.runId
  return a.file > b.file
}

// Returns { runId, taskId, branch } for the location record whose worktree is `worktree`,
// or null. Reads only; a malformed or unreadable record is skipped rather than thrown,
// because the sole caller is a hook whose failure mode must be "allow the stop", never
// "crash every agent on this machine".
//
// Records are never deleted, and the harness reuses `agent-<hash>` worktree paths, so one
// directory can match records from several runs at once. Returning the first match would
// resolve that in readdir order — alphabetically — and enforce a finished run's task against
// the teammate living there now. The newest record wins instead: it is the one a `locate` at
// checkout just wrote. See `laterThan` for how equal mtimes are settled.
export async function findTaskByWorktree(
  root,
  worktree,
  { maxRecords = MAX_RECORDS, maxRecordBytes = MAX_RECORD_BYTES } = {},
) {
  // The query comes from the caller (a hook payload's cwd), not from a record, so it is the one
  // path worth resolving through the filesystem — once, here, rather than per record. Records
  // are then compared against both its spellings, which is what lets the common case decide
  // lexically and never touch the filesystem with a value a record supplied.
  //
  // This early return and the `lexical === ''` check below are mutually redundant on purpose,
  // and neither is individually load-bearing: an empty query cannot match a record, because a
  // record's worktree must be absolute, and an empty record worktree cannot match a query,
  // because the query is non-empty by the time the loop runs. Deleting either one alone is
  // therefore safe; the pair exists so that a later change to one side cannot open the other.
  const wantReal = normaliseWorktree(worktree)
  if (wantReal === '') return null
  const wantLexical = normaliseWorktree(worktree, { resolveLinks: false })
  let examined = 0
  let runs
  try {
    runs = await readdir(path.join(root, '.teammates'), { withFileTypes: true })
  } catch { return null }
  let best = null
  for (const run of runs) {
    if (!run.isDirectory()) continue
    const dir = path.join(root, '.teammates', run.name, 'worktrees')
    let files
    try {
      files = await readdir(dir)
    } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      // The read below is the one unbounded cost left, and it is bounded here rather than
      // trusted: 20,000 four-kilobyte records took 3.88 s on this host and one 512 MB record
      // took 619 MB of RSS, both linear in what an author chooses to write, and either one
      // scaled up puts a stop past the hook's 60 s timeout — which the harness treats as a
      // non-blocking error, switching enforcement off run-wide. Giving up entirely past the
      // cap keeps that outcome independent of directory order: no partial answer, no readdir
      // dependence, just the fail-open the hook already defaults to.
      examined += 1
      if (examined > maxRecords) return null
      try {
        const full = path.join(dir, file)
        // stat before read, and reused for the ordering key below. Size caps a record at a
        // sane multiple of what one legitimately holds (~200 bytes).
        //
        // isFile() is worth naming honestly, because deleting it changes nothing observable on
        // win32: a directory named `T1.json` makes readFile throw EISDIR, which the catch below
        // already turns into a skip. Its unique value is the POSIX FIFO — opening one blocks
        // until a writer appears, and a hook that blocks forever is enforcement switched off.
        // That vector is UNVERIFIED on this host (win32 has no FIFO to test it with) and is
        // pinned only by a POSIX-only test that skips here. The guard is one cheap stat field,
        // so it stays on the strength of the argument rather than of a local measurement.
        const info = await stat(full)
        if (!info.isFile()) continue
        if (info.size > maxRecordBytes) continue
        const record = JSON.parse(await readFile(full, 'utf8'))
        // ORDER MATTERS. Everything below that can reject a record on string comparison alone
        // runs before any filesystem call on a value the record supplies. A record that fails
        // these costs one stat and one bounded read; put the worktree resolution first instead
        // and a record needs no valid taskId to make this lookup stall (see `isLocalAbsolute`).
        //
        // taskId comes from file CONTENT, which the writer's guard never saw: any teammate
        // with a shell can write this file directly, and the value is handed to a caller that
        // passes it to `complete --task`. Require it to be a plain segment AND to name the
        // file it was read from, and skip the record otherwise — the same treatment malformed
        // JSON gets, because a hook must degrade to "no match" rather than propagate a path.
        if (!isSegment(dir, record.taskId)) continue
        if (record.taskId !== file.slice(0, -'.json'.length)) continue
        // A relative worktree is a wildcard, not a location: path.resolve would resolve it
        // against the READER's cwd, so `"worktree": "."` matches whoever is asking without
        // naming any victim. The hook runs in the session directory — the cwd a subagent that
        // is NOT worktree-isolated reports, including this plugin's own read-only reviewer —
        // so such a record would blame an agent that has no task at all. A record must name an
        // absolute path or it names nothing.
        if (typeof record.worktree !== 'string' || !path.isAbsolute(record.worktree)) continue
        const lexical = normaliseWorktree(record.worktree, { resolveLinks: false })
        if (lexical === '') continue
        let matched = lexical === wantReal || lexical === wantLexical
        if (!matched && isLocalAbsolute(record.worktree)) {
          const real = normaliseWorktree(record.worktree)
          matched = real === wantReal || real === wantLexical
        }
        if (!matched) continue
        const mtimeMs = info.mtimeMs
        const candidate = {
          mtimeMs,
          file,
          runId: run.name,
          taskId: record.taskId,
          // `branch` is the field that survives an HONEST taskId and an HONEST worktree, so no
          // amount of cross-checking those two constrains it. Unvalidated it is a lever on the
          // caller's git: any existing ref waves past a teammate that created no branch at all,
          // and a rival's ref turns the hook's own remediation text into an instruction to
          // force-move another task's branch. A record may name exactly one branch — the one
          // this run gives this task — and anything else is dropped to null rather than
          // discarding the record, because the record that legitimately carries a non-canonical
          // branch is the teammate that never checked its task branch out, i.e. precisely the
          // do-nothing case the hook exists to catch. Null is what the caller already falls
          // back on, and it recomputes the same name from runId and taskId.
          branch: record.branch === taskBranchName(run.name, record.taskId) ? record.branch : null,
        }
        if (best === null || laterThan(candidate, best)) best = candidate
      } catch { continue }
    }
  }
  return best === null ? null : { runId: best.runId, taskId: best.taskId, branch: best.branch }
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
