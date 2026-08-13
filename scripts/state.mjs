import { mkdir, readdir, readFile, stat, writeFile, rename, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'

const NAMES = new Set(['plan', 'status', 'findings'])

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

// Compared, never displayed. One directory has several spellings: what git prints, what the
// harness sends in a hook payload, and what a shell reports differ in separator, in drive-letter
// and path case on Windows, in trailing separators, and — because a worktree can be reached
// through a symlinked parent (/var vs /private/var) or an 8.3 short name — in the identity of
// the directory components themselves. Trailing separator, case and separator style are folded
// lexically; the rest needs the filesystem, so an existing path is resolved through realpath at
// both ends. What remains uncovered: a path that no longer exists at compare time falls back to
// lexical resolution and so still fails to match a differently-spelled record, and two genuinely
// distinct paths that a bind mount points at one target compare equal. Both directions cost only
// the early catch — a missed match lets the hook allow the stop, which is its fail-open default.
export function normaliseWorktree(p) {
  if (typeof p !== 'string' || p === '') return ''
  const resolved = path.resolve(p).replace(/[\\/]+$/, '')
  let real = resolved
  try {
    // .native canonicalises case and expands 8.3 short names on Windows; both platforms
    // resolve symlinks. It throws for a path that does not exist — compare that lexically.
    real = realpathSync.native(resolved)
  } catch { /* fall back to the lexical form */ }
  const trimmed = real.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed
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
export async function findTaskByWorktree(root, worktree) {
  const want = normaliseWorktree(worktree)
  if (want === '') return null
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
      try {
        const full = path.join(dir, file)
        const record = JSON.parse(await readFile(full, 'utf8'))
        if (normaliseWorktree(record.worktree) !== want) continue
        // taskId comes from file CONTENT, which the writer's guard never saw: any teammate
        // with a shell can write this file directly, and the value is handed to a caller that
        // passes it to `complete --task`. Require it to be a plain segment AND to name the
        // file it was read from, and skip the record otherwise — the same treatment malformed
        // JSON gets, because a hook must degrade to "no match" rather than propagate a path.
        if (!isSegment(dir, record.taskId)) continue
        if (record.taskId !== file.slice(0, -'.json'.length)) continue
        const { mtimeMs } = await stat(full)
        const candidate = {
          mtimeMs,
          file,
          runId: run.name,
          taskId: record.taskId,
          branch: record.branch ?? null,
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
// tokens; it cannot produce a false PASS, because the verdict is recomputed from git every
// round and reads nothing from .teammates/. The worktree location record above sits on the same
// footing: it is written by the teammate it describes, so a teammate can rewrite or delete it,
// and the hook that reads it is only an early catch — the worst that costs is the catch itself,
// because the gate recomputes every verdict from git and reads nothing here either.
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
