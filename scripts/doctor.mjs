import { resolveTaskBranch } from './enforce.mjs'
import { GitError } from './git.mjs'
import { mergedParentFiles, landedForFiles, landedForWholeSet } from './gate-runner.mjs'
import { printable } from './reviews.mjs'

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

export async function collectDoctorReport({ git, runId, runBranch, baseBranch, tasks = [], repoRoot = null, anchorSha = null, runSha: passedRunSha = null, mergedFiles: passedMergedFiles = null }) {
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

  // The files each merge on the run branch's own first-parent chain actually carried, indexed
  // by that merge's secondary parent — one walk for the whole report, not one per task, because
  // it is a fact about the run rather than about any single branch. A caller that already has
  // the index passes it in as data and no walk happens here at all. This is the SAME
  // `mergedParentFiles` index `runFilesetCheck` builds in `scripts/gate-runner.mjs`, imported
  // rather than reimplemented, so `doctor` and the gate can no longer read the same tree
  // differently — see the comment on `mergedParentFiles` there for what the walk visits and why.
  //
  // Without an anchor there is no bound for the walk and no landed test to feed, so neither runs.
  let mergedFiles = passedMergedFiles
  if (!mergedFiles && anchorSha && runSha) {
    try {
      mergedFiles = await mergedParentFiles(git, { anchorSha, runSha })
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      // Not a silent empty index: with no answer every integrated task would otherwise be
      // reported as contributing nothing, and the operator would chase ten phantom problems
      // instead of the one real one.
      problems.push(`could not determine which branches ${runBranch} merged in: ${err.message} — every task below is reported as not integrated`)
    }
  }

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
        // phase look broken. What decides it now is the SAME predicate `runFilesetCheck` uses
        // in `scripts/gate-runner.mjs`: whether some merge on the run branch's own first-parent
        // chain, inside `anchor..run`, named this sha as a secondary parent AND that merge's own
        // diff against its own first parent carried at least one of this task's DECLARED files
        // (`landedForFiles`, over the `mergedFiles` index built above). It is no longer a bare
        // membership test — a shared sha used to read as landed for ANY task, which is exactly
        // what let a parked ref piggyback on a sibling's merge; now it must have earned credit
        // for its OWN declared files.
        //
        // Ancestry alone cannot decide it, because "reachable from the run branch" is true of
        // every commit the run branch has ever passed through — the anchor, the current tip,
        // and every intermediate commit a teammate's ref might be parked at. Being named as a
        // merge parent whose diff actually carried this task's files is a fact about the merge
        // that carried the branch, so standing still cannot satisfy it.
        //
        // What this predicate does NOT distinguish, stated as what is true rather than as what
        // would be convenient — the same limits the comment on `landedForFiles` in
        // `scripts/gate-runner.mjs` states, not a second, possibly-drifting list:
        //   - A branch integrated by FAST-FORWARD leaves no merge commit and so no secondary
        //     parent. Its diff is empty too (a fast-forward also makes merge-base(run, branch)
        //     the branch's own tip), so it is reported here as contributing nothing — a message
        //     that names a cause that is not the one, since the work IS on the run branch.
        //     `tm-integrator`'s contract is `--no-ff` for exactly this reason, and no other
        //     check covers the gap — `ownership` explains a fast-forwarded branch's commits by
        //     their ancestry from the task branch, so it reports nothing.
        //   - A SQUASH merge likewise carries no secondary parent. The plugin's integrator
        //     never squashes, so that is a statement about a repository someone else merged
        //     into, not about a run this tool drove.
        //   - The predicate holds only where the task's declared set does NOT intersect what
        //     the integrating merge actually carried. Declared files are disjoint only WITHIN a
        //     phase (`scripts/phases.mjs` enforces that); across phases a later task routinely
        //     modifies a file an earlier task created. When a parked ref's declared set
        //     intersects what the merge that landed a SIBLING's tip actually carried, this
        //     predicate cannot tell the parked ref from the branch that genuinely earned that
        //     credit — sibling-tip self-integration with an overlapping declared set is still
        //     open, in the gate and here alike.
        //
        //   - The run tip itself (`sha === runSha`) is not a key in the index at all, so
        //     `landedForFiles` is structurally false there and would report a genuinely landed
        //     task — one whose ref a fix round re-pointed with `git checkout -B` — as having
        //     done nothing. That one position is answered by `landedForWholeSet` instead, which
        //     asks whether a SINGLE merged secondary parent carried the task's WHOLE declared
        //     set, since the run tip retains nothing to attribute by. Its own residual (a
        //     run-tip ref declaring a SUBSET of a merged sibling's files) is open here and in
        //     the gate alike.
        //
        // `runFilesetCheck` in `scripts/gate-runner.mjs` computes this same test the same way,
        // over the same index, with the same limits — that is the whole point of importing it
        // rather than keeping a second implementation that could silently disagree. That
        // includes the run-tip branch below: were only one of the two files to take it, `doctor`
        // would tell an operator a task landed that the gate fails, or the reverse.
        entry.landed = !anchorSha
          ? false
          : sha === runSha
            ? landedForWholeSet(mergedFiles ?? new Map(), task.files, { exclude: runSha })
            : landedForFiles(mergedFiles ?? new Map(), sha, task.files)
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

// A terminal ACTS on control bytes, and most of what this prints was written by the very
// teammates being diagnosed: a teammate writes its own commit subjects and names its own branches
// and worktrees. A subject carrying `ESC [ 2 K` `ESC [ 1 A` erases the line reporting it and the
// line above, so the report says something other than what this function assembled — and `doctor`
// is the command whose whole purpose is telling an operator that a teammate's `done` was a claim
// rather than evidence.
//
// Neutralised here: the run id and the two branch names in the header, the branch the main
// worktree is on, each worktree's branch and path, each task's id, branch and commit subject, and
// every problem line — one wrap at the point each is spliced in, which covers the values the
// problem sentences embed (branch names, paths, task ids, git error text) without restating them.
// NOT touched: the counts and the fixed words (`MISSING`, `SIDE DOOR`, `integrated`), which this
// module writes itself. `printable`, not `printableBlock`: every one of these renders as a single
// line, and a surviving newline is enough to forge a line without any escape sequence at all.
//
// Wrapping happens only here. `collectDoctorReport` returns the values as git reported them, so a
// caller reading the report as data is unaffected, and no problem, task or exit code changes —
// only how a value renders. This covers the sites in this function and says nothing about others.
export function renderDoctor(report) {
  const lines = [`run ${printable(report.runId)} · run branch ${printable(report.runBranch)} · base ${printable(report.baseBranch)}`]
  lines.push(`main worktree on ${printable(report.mainBranch)}${report.dirty.length ? ` · ${report.dirty.length} dirty path(s)` : ' · clean'}`)

  if (report.worktrees.length) {
    lines.push('worktrees')
    for (const wt of report.worktrees) {
      lines.push(`  ${wt.detached ? '(detached)' : printable(wt.branch ?? '(none)')}  ${printable(wt.path)}`)
    }
  }

  if (report.tasks.length) {
    lines.push('tasks')
    for (const t of report.tasks) {
      if (!t.exists) { lines.push(`  ${printable(t.id)}  ${printable(t.branch)}  MISSING`); continue }
      const files = t.landed
        ? 'integrated'
        : (t.changed.length === 0 ? 'NO CHANGES' : `${t.changed.length} file(s)`)
      lines.push(`  ${printable(t.id)}  ${printable(t.branch)}  ${files}${t.sideDoor ? '  SIDE DOOR' : ''}`)
      lines.push(`      ${printable(t.tip)}`)
    }
  }

  if (report.problems.length === 0) {
    lines.push('no problems found')
  } else {
    lines.push(`${report.problems.length} problem${report.problems.length === 1 ? '' : 's'}`)
    for (const p of report.problems) lines.push(`  - ${printable(p)}`)
  }
  return lines.join('\n')
}
