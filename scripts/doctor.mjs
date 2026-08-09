import { resolveTaskBranch } from './enforce.mjs'
import { GitError } from './git.mjs'

// Read-only diagnosis of a run, computed entirely from git.
//
// `digest` renders `status.json`, which the teammates being diagnosed write; every question this
// module asks is put to git instead, so a wrong answer needs a wrong repository rather than a
// wrong file. It decides nothing — the gate stays the only thing that issues a verdict — and it
// deliberately reports states the gate would refuse to run in at all (the main worktree parked on
// the base branch, for one), because those are precisely the moments an operator needs to see
// what is going on.
//
// Every problem it reports has been a real incident: a teammate committing on the harness's own
// `worktree-agent-*` branch and leaving the conventional ref empty; a reviewer's scratch worktree
// created inside the repository, failing `ownership` for a whole run; the main worktree left off
// the run branch; task branches merged into the base by a side door.

const HARNESS_BRANCH = /^worktree-agent-/
const HARNESS_DIR = /[\\/]\.claude[\\/]/

function insideRepo(worktreePath, repoRoot) {
  if (!repoRoot) return false
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const root = norm(repoRoot)
  const target = norm(worktreePath)
  return target !== root && target.startsWith(`${root}/`)
}

export async function collectDoctorReport({ git, runId, runBranch, baseBranch, tasks = [], repoRoot = null, anchorSha = null, runSha: passedRunSha = null }) {
  const problems = []

  const mainBranch = await git.currentBranch()
  if (mainBranch !== runBranch) {
    problems.push(`main worktree is on ${mainBranch}, not the run branch ${runBranch} — a teammate or reviewer that ran git checkout here moved it, and the gate reads the current branch to decide what it is protecting`)
  }

  const dirty = await git.dirtyPaths()
  for (const entry of dirty) {
    problems.push(`main worktree is dirty: ${entry.status} ${entry.path} — teammates work only in their own worktrees, and ownership fails on any of this`)
  }

  const worktrees = await git.worktrees()
  for (const wt of worktrees) {
    if (wt.branch && HARNESS_BRANCH.test(wt.branch)) {
      problems.push(`worktree ${wt.path} holds ${wt.branch} — a commit landing there instead of on teammates/<runId>/<taskId> leaves the conventional ref empty, and the task merges as a no-op`)
    }
    if (insideRepo(wt.path, repoRoot) && !HARNESS_DIR.test(`${wt.path}/`)) {
      problems.push(`worktree ${wt.path} is inside the repository — anything but the harness's own .claude/ directory shows up as untracked content in the main worktree and fails ownership for the whole run`)
    }
  }

  // Resolved once, and only if it exists: a run whose base branch is gone still deserves a
  // report about everything else rather than a single failure standing in for all of it.
  let baseSha = null
  if (baseBranch && await git.branchExists(baseBranch)) baseSha = await git.resolveRef(`refs/heads/${baseBranch}`)
  const runSha = passedRunSha ?? (await git.branchExists(runBranch) ? await git.resolveRef(`refs/heads/${runBranch}`) : null)

  const taskReports = []
  for (const task of tasks) {
    const branch = resolveTaskBranch(task, runId)
    const entry = { id: task.id, branch, exists: false, tip: null, changed: [], sideDoor: false, landed: false }
    try {
      if (!branch || !(await git.branchExists(branch))) {
        problems.push(`${task.id}: branch ${branch} does not exist — the work is not where the gate looks for it`)
        taskReports.push(entry)
        continue
      }
      entry.exists = true
      const sha = await git.resolveRef(`refs/heads/${branch}`)
      entry.tip = await git.commitSubject(`refs/heads/${branch}`)
      // The branch's OWN fork point, never tip against tip: a branch forked before a later
      // amendment shows unrelated files in a tip-vs-tip diff, which reads as a catastrophe and
      // is not one. What a merge would contribute is what this diff shows.
      if (runSha) {
        const forkPoint = await git.mergeBase(runSha, sha)
        entry.changed = await git.changedFiles({ base: forkPoint, branch: sha })
        // A landed branch's fork point IS its tip, so its diff is empty however much work it
        // carried — reporting that as a problem makes every re-inspection of an integrated
        // phase look broken. "On the run branch" alone is not enough: the anchor and everything
        // before it are ancestors too, so a branch parked at the anchor — a teammate that
        // committed elsewhere and left the conventional ref where it started — would read as
        // landed and escape the very check this is.
        entry.landed = anchorSha
          ? (await git.isAncestor(sha, runSha)) && !(await git.isAncestor(sha, anchorSha))
          : false
        if (entry.changed.length === 0 && !entry.landed) {
          problems.push(`${task.id}: branch ${branch} has no file changes past its fork point — the work landed on another ref and this task would merge as a no-op`)
        }
        if (baseSha && await git.isAncestor(sha, baseSha) && !(await git.isAncestor(sha, runSha))) {
          entry.sideDoor = true
          problems.push(`${task.id}: branch ${branch} is on base branch ${baseBranch} but not on the run branch — this run's work reached the base by a route other than the run branch, with no gate verdict behind it`)
        }
      }
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      problems.push(`${task.id}: ${err.message}`)
    }
    taskReports.push(entry)
  }

  return { runId, runBranch, baseBranch, mainBranch, dirty, worktrees, tasks: taskReports, problems }
}

export function renderDoctor(report) {
  const lines = [`run ${report.runId} · run branch ${report.runBranch} · base ${report.baseBranch}`]
  lines.push(`main worktree on ${report.mainBranch}${report.dirty.length ? ` · ${report.dirty.length} dirty path(s)` : ' · clean'}`)

  if (report.worktrees.length) {
    lines.push('worktrees')
    for (const wt of report.worktrees) {
      lines.push(`  ${wt.detached ? '(detached)' : wt.branch ?? '(none)'}  ${wt.path}`)
    }
  }

  if (report.tasks.length) {
    lines.push('tasks')
    for (const t of report.tasks) {
      if (!t.exists) { lines.push(`  ${t.id}  ${t.branch}  MISSING`); continue }
      const files = t.landed
        ? 'integrated'
        : (t.changed.length === 0 ? 'NO CHANGES' : `${t.changed.length} file(s)`)
      lines.push(`  ${t.id}  ${t.branch}  ${files}${t.sideDoor ? '  SIDE DOOR' : ''}`)
      lines.push(`      ${t.tip}`)
    }
  }

  if (report.problems.length === 0) {
    lines.push('no problems found')
  } else {
    lines.push(`${report.problems.length} problem${report.problems.length === 1 ? '' : 's'}`)
    for (const p of report.problems) lines.push(`  - ${p}`)
  }
  return lines.join('\n')
}
