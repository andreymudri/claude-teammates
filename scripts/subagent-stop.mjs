#!/usr/bin/env node
// SubagentStop handler. Runs the cheap enforcement checks on a teammate's own task at the
// point it tries to stop. Exit 0 allows the stop; exit 2 blocks it and the harness feeds
// stderr back to the teammate as the reason to keep working.
//
// It fires for EVERY subagent on this machine — a reviewer in an unrelated project, this
// plugin's own read-only tm-reviewer, any agent in a repo with no run at all. Everything
// below is arranged so those cases cost one `git rev-parse` and exit 0; the count is pinned
// by a test that traces the git processes this handler starts, because a cost claim nothing
// measures is prose, and every subagent on the machine pays whatever it actually costs.
import { readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findTaskByWorktree, normaliseWorktree, readState } from './state.mjs'

// This handler's own exit statuses, which the harness reads.
const ALLOW = 0
const BLOCK = 2

// The exit status `complete --enforcement-only` returns when a TASK-SCOPED enforcement check
// rejects, and the only status this handler blocks on. It is a DIFFERENT vocabulary from
// ALLOW/BLOCK above, which happens to share small integers with it: REJECTED is a code this
// process reads, BLOCK is a code this process returns. See the contract at the spawn below.
const REJECTED = 3

function payload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return null
  }
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim()
  } catch {
    return null
  }
}

async function main() {
  const input = payload()
  if (!input || typeof input !== 'object') return ALLOW

  // The harness caps consecutive blocks at 8 and asks Stop/SubagentStop handlers to return
  // success while this is set. Honouring it makes one stop cost one forced retry: the
  // teammate gets the failure text, works again, and is not blocked a second time for the
  // same stop. The count lives in the harness process, so unlike anything under
  // .teammates/ the teammate cannot reset it.
  if (input.stop_hook_active === true) return ALLOW

  const cwd = typeof input.cwd === 'string' ? input.cwd : ''
  if (cwd === '') return ALLOW

  // One git call in the common case. A cwd outside any repository stops here.
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  if (!commonDir) return ALLOW
  // `--git-common-dir` is `<main>/.git` for a linked worktree and the repository's own `.git`
  // otherwise, so its parent is the MAIN worktree in both cases — which is where the run's
  // state lives, and the only root at which a teammate's record can be found. Both halves are
  // covered: a case runs the handler from inside a real linked worktree, because that is the
  // only configuration a dispatched teammate is ever in, and `--git-dir` — the plausible
  // wrong answer — resolves there to `<main>/.git/worktrees/<name>`, under which no record is
  // ever found and every teammate in the run would stop unchallenged.
  const root = path.dirname(commonDir)

  // A stop in the MAIN worktree is never a teammate's. Teammates are dispatched into their own
  // worktrees, so the only things that stop here are the orchestrator's own subagents — a
  // reviewer, a helper — which have no task, no brief, and no business being handed a branch
  // name to commit to. Without this, a record aimed at the main root (writable directly, which
  // no guard on `locate` can prevent) makes the next unrelated subagent to stop the victim: it
  // is blocked and told to commit to a ref the record chose, and `fileset` and `ownership`
  // then read those commits as that task's work.
  //
  // Checked on `cwd` rather than on the record because the two are the same question: the
  // store is keyed by the normalised worktree and the reader requires the record to name the
  // directory it is filed under, so a record found for this `cwd` necessarily names it.
  //
  // The trade-off, stated rather than hidden: in a run dispatched WITHOUT worktree isolation
  // every teammate shares the main worktree, and this makes enforcement inert for that run.
  // That configuration already misresolves — one record per directory means the last teammate
  // to run `locate` answers for all of them — so this turns "enforced against the wrong task"
  // into "not enforced", which is the safer of the two. It is not free, and it is not nothing.
  if (normaliseWorktree(cwd) === normaliseWorktree(root)) return ALLOW

  const found = await findTaskByWorktree(root, cwd)
  if (!found) return ALLOW

  // Recorded by `init-run`. Without it `complete` cannot run, and a teammate must never be
  // blocked by state it did not write. Deliberately NOT wrapped in a local catch: a plan.json
  // that is unreadable or malformed is also state the teammate did not write, and the terminal
  // handler at the bottom of this file turns any throw into an allow. One fail-open path,
  // tested through this one.
  const plan = await readState(root, found.runId, 'plan')
  const planPath = plan?.planPath
  if (typeof planPath !== 'string' || planPath === '') return ALLOW

  // The cheap precheck: a missing task branch is the do-nothing case, and it is the reason
  // resolution goes through the location record rather than the checked-out branch. It is
  // decided before anything more expensive runs.
  const branch = found.branch ?? `teammates/${found.runId}/${found.taskId}`
  if (!git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root)) {
    // The text NAMES the missing ref and directs the teammate to its brief. It deliberately
    // carries no command and interpolates nothing into one: a ref derived from a record is
    // only as trustworthy as the record, and the record's runId and taskId are chosen by
    // whoever wrote it, so the honest construction above can resolve to ANOTHER task's
    // branch. A teammate that obeyed a create-and-commit instruction would put its commits
    // there, where `fileset` and `ownership` read them as that task's work. The brief carries
    // the branch name from the dispatch, which is the source that cannot be planted.
    process.stderr.write(
      `Task ${found.taskId} has no branch ${branch}. Your work is not on a branch this run can `
      + `merge, so nothing you did is visible to the gate. Your brief names the branch for this `
      + `task and the step that creates it; follow that step, commit your work there, then `
      + `finish.\n`,
    )
    return BLOCK
  }

  // --enforcement-only on purpose: fileset, ownership and merge answer "did you stray
  // outside your file set, is your branch empty, will this merge" in seconds. The full
  // gate's command checks are the project's test suite, and running that inside a stop
  // hook means the usual outcome is a timeout — which is a non-blocking error, i.e.
  // enforcement that looks installed and does nothing. The phase gate still runs it all.
  //
  // Block on REJECTED and on nothing else, because a stop may only be refused over something
  // this teammate did and can fix from its own worktree. The contract `complete` is being
  // built to, which this file consumes and does not implement:
  //
  //   3  a TASK-SCOPED check rejected — fileset, merge. This teammate's own work.
  //   4  cannot-verify, OR a run-wide check that failed for reasons outside this task.
  //   2  a malformed manifest or an argv error.
  //
  // The split matters in one direction: several run-wide conditions are indistinguishable
  // from a task rejection at the level of "did the checks pass" — a manifest typo leaving a
  // non-optional check pending, uncommitted changes in the MAIN worktree failing `ownership`,
  // someone committing straight to the run branch. Blocking on those tells a compliant
  // teammate to fix something it does not own and cannot reach. Blocking on 2 costs it a turn
  // for the orchestrator's typo. So 3 is the only code that may cost a teammate a turn, and
  // it is narrowed on the `complete` side to mean exactly that.
  //
  // One further case lands in 4 and misfires in the safe direction: `complete` derives the run
  // branch from whatever the MAIN worktree has checked out, so with the operator on another
  // branch it cannot verify. The stop is allowed and the phase gate recomputes every verdict
  // later, which is the whole reason this handler is a backstop rather than the gate.
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs')
  const result = spawnSync(process.execPath, [
    cli, 'complete',
    '--run', found.runId,
    '--task', found.taskId,
    '--plan', planPath,
    '--root', root,
    '--enforcement-only',
  ], { encoding: 'utf8', timeout: 60_000 })

  if (result.status === REJECTED) {
    process.stderr.write(`${(result.stdout || '').trim()}\n`)
    return BLOCK
  }
  return ALLOW
}

// Nothing may escape as an unhandled rejection: a handler that crashes is a hook that fails,
// and this one fails open.
main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(ALLOW))
