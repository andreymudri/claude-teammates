import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
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

// Compared, never displayed. Windows paths differ in case and separator between what git
// prints, what the harness sends in a hook payload, and what a shell reports — three
// spellings of one directory. Normalising at both ends is what makes the lookup total.
export function normaliseWorktree(p) {
  if (typeof p !== 'string' || p === '') return ''
  const resolved = path.resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved
}

// Written by the teammate at start, read by the stop-time hook. Overwritable on purpose:
// a respawned teammate re-enters the same task from a different worktree, and a record
// that could not be updated would point the hook at a directory that no longer exists.
export async function writeLocation(root, runId, taskId, { worktree, branch }) {
  const dir = path.join(runDir(root, runId), 'worktrees')
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${taskId}.json`)
  // Unique temp name, then rename: a concurrent reader never sees a half-written record.
  const tmp = `${target}.${process.pid}.${Math.floor(performance.now() * 1000)}.tmp`
  await writeFile(tmp, `${JSON.stringify({ taskId, worktree, branch })}\n`, 'utf8')
  await rename(tmp, target)
  return target
}

// Returns { runId, taskId, branch } for the location record whose worktree is `worktree`,
// or null. Reads only; a malformed or unreadable record is skipped rather than thrown,
// because the sole caller is a hook whose failure mode must be "allow the stop", never
// "crash every agent on this machine".
export async function findTaskByWorktree(root, worktree) {
  const want = normaliseWorktree(worktree)
  if (want === '') return null
  let runs
  try {
    runs = await readdir(path.join(root, '.teammates'), { withFileTypes: true })
  } catch { return null }
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
        const record = JSON.parse(await readFile(path.join(dir, file), 'utf8'))
        if (normaliseWorktree(record.worktree) === want) {
          return { runId: run.name, taskId: record.taskId, branch: record.branch ?? null }
        }
      } catch { continue }
    }
  }
  return null
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
