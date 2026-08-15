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
  // `!input` carries this line; the type half is defence in depth and is NOT load-bearing
  // today — measured, by weakening it to `!input` alone and finding the suite still green.
  // A bare number or string parses fine and reaches here, but it has no `cwd` property, so
  // the guard below already answers it. Kept because every later line reads properties off
  // this object, and cheap; described exactly so nobody reads the cases below as pinning it.
  if (!input || typeof input !== 'object') return ALLOW

  // The harness caps consecutive blocks at 8 and asks Stop/SubagentStop handlers to return
  // success while this is set. Honouring it makes one stop cost one forced retry: the
  // teammate gets the failure text, works again, and is not blocked a second time for the
  // same stop. The count lives in the harness process, so unlike anything under
  // .teammates/ the teammate cannot reset it.
  if (input.stop_hook_active === true) return ALLOW

  const cwd = typeof input.cwd === 'string' ? input.cwd : ''
  if (cwd === '') return ALLOW

  // One git call in the common case, answering three questions at once. A cwd outside any
  // repository stops here.
  const dirs = git([
    'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel',
  ], cwd)
  if (!dirs) return ALLOW
  const [commonDir, gitDir, toplevel] = dirs.split('\n').map((line) => line.trim())
  // An unexpected output shape means this git does not answer the question the way the checks
  // below read it, and a guess either way is worse than not enforcing.
  if (!commonDir || !gitDir || !toplevel) return ALLOW
  // `--git-common-dir` is `<main>/.git` for a linked worktree and the repository's own `.git`
  // otherwise, so its parent is the MAIN worktree in both cases — which is where the run's
  // state lives, and the only root at which a teammate's record can be found. Both halves are
  // covered: a case runs the handler from inside a real linked worktree, because that is the
  // only configuration a dispatched teammate is ever in, and `--git-dir` — the plausible
  // wrong answer — resolves there to `<main>/.git/worktrees/<name>`, under which no record is
  // ever found and every teammate in the run would stop unchallenged.
  const root = path.dirname(commonDir)

  // A stop ANYWHERE IN the MAIN worktree is never a teammate's. Teammates are dispatched into
  // their own worktrees, so the only things that stop here are the orchestrator's own subagents
  // — a reviewer, a helper — which have no task, no brief, and no business being handed a
  // branch name to commit to. Without this, a record aimed at a directory in the main worktree
  // (writable directly, which no guard on `locate` can prevent) makes the next unrelated
  // subagent to stop there the victim: it is blocked and told to commit to a ref the record
  // chose, and `fileset` and `ownership` then read those commits as that task's work.
  //
  // The test is the pair of directories git just printed, not a path comparison. Measured at
  // four depths: in the main worktree, and in ANY subdirectory of it, `--git-common-dir` and
  // `--git-dir` are the same path; in a linked worktree, and in any subdirectory of one, the
  // second is `<common>/worktrees/<name>`. Comparing `cwd` to the root instead — which is what
  // this line did first — closes the root and nothing below it, so a session started with
  // `cd packages/app && claude`, which is ordinary use, was still a victim.
  //
  // Containment is NOT the test and must not be substituted for it: this plugin puts teammate
  // worktrees at `<main>/.claude/worktrees/agent-*`, inside the main worktree, so "cwd under
  // root" would answer yes for every teammate and switch enforcement off everywhere.
  //
  // The trade-off, stated rather than hidden: in a run dispatched WITHOUT worktree isolation
  // every teammate shares the main worktree, and this makes enforcement inert for that run.
  // That configuration already misresolves — one record per directory means the last teammate
  // to run `locate` answers for all of them — so this turns "enforced against the wrong task"
  // into "not enforced", which is the safer of the two. It is not free, and it is not nothing.
  if (commonDir === gitDir) return ALLOW

  // The pair being unequal is necessary and NOT sufficient, because a `.git` FILE makes any
  // directory report a foreign git dir. Measured: writing `<main>/packages/app/.git`
  // containing `gitdir: <main>/.git/worktrees/agent-1` — an ALREADY EXISTING teammate's
  // metadata, so nothing inside `.git` is written — makes that subdirectory of the main
  // worktree answer like a linked worktree, and a record aimed there brings back exactly the
  // block round 2 was meant to close. Planted under a directory with tracked content it is
  // also invisible: git does not treat it as a nested repo, so `git status` and `ownership`
  // report nothing.
  //
  // The confirmation is the link git itself maintains in the other direction. A real linked
  // worktree's metadata holds a `gitdir` file naming the `.git` of the worktree it belongs
  // to, so requiring it to name THIS toplevel's `.git` is a round trip the planter cannot
  // complete without writing inside `.git`. Measured true for a sibling worktree, a worktree
  // nested under the main one, and any subdirectory of either; false for the plant, whose
  // pointer names the real teammate's `.git` while its toplevel is the planted directory.
  // `git worktree add` refuses a path that already exists, so the plant cannot be legitimised
  // by creating the worktree properly either — also measured.
  //
  // What it buys, stated as narrowly as it is true: the plant must move from a tracked
  // directory, where nothing in git reports it, to INSIDE `.git`, where the same writer could
  // instead edit refs or drop a hook and stop bothering with this handler at all. It raises
  // the floor; it is not a barrier against a writer who already owns the repository, and no
  // stop-time check could be. The check above is what answers the main worktree, and it is
  // load-bearing for exactly this reason: `<main>/.git/gitdir` naming `<main>/.git` closes
  // this round trip honestly, so without that earlier line the main worktree itself would
  // pass here. Measured, and pinned by a case.
  let pointer
  try {
    pointer = readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim()
  } catch {
    return ALLOW
  }
  if (normaliseWorktree(pointer) !== normaliseWorktree(path.join(toplevel, '.git'))) return ALLOW

  // Looked up by the worktree's TOP LEVEL, not by the raw payload cwd. `locate` records the
  // top level, so a teammate that stops with its cwd in a subdirectory of its own worktree
  // would otherwise resolve to nothing and be waved through — enforcement silently off for
  // that stop. Whether the harness can deliver such a cwd is not something this file can
  // observe; using the top level removes the dependence rather than betting on it, and it is
  // free here because git printed the value in the same call.
  const found = await findTaskByWorktree(root, toplevel)
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
    //
    // A teammate that is legitimately `blocked` before creating its branch reaches this too,
    // and that is correct as designed rather than a case to exclude: this handler cannot tell
    // "did nothing" from "could not proceed", the two are indistinguishable from outside, and
    // the cost is bounded at one forced retry because `stop_hook_active` allows the next stop.
    // What it must not do is tell that teammate to commit work it does not have, so the text
    // names the other way out. Saying so costs nothing that is not already available — the
    // second stop is allowed whatever the teammate does — and a message that fits only one of
    // the two readers is how a truthful "blocked" gets turned into a fabricated commit.
    process.stderr.write(
      `Task ${found.taskId} has no branch ${branch}. Your work is not on a branch this run can `
      + `merge, so nothing you did is visible to the gate. Your brief names the branch for this `
      + `task and the step that creates it; follow that step, commit your work there, then `
      + `finish. If you have no work to commit because you are blocked, report status "blocked" `
      + `with the reason and stop again — this check does not run twice for one stop.\n`,
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
  // What this handler does is the whole of what it promises: read one integer, block on 3.
  // It has no way to tell an honest rejection from a rejection produced by the wrong base, so
  // the meaning of these codes is `complete`'s to keep, and the note below is an observation
  // about a neighbour rather than a property relied on here.
  //
  // OBSERVED IN THE MERGE, not guaranteed by this file: `complete` derives the run branch from
  // whatever the MAIN worktree has checked out, which is wrong whenever the operator is on
  // another branch. Run against a tree parked on an unrelated branch it exits 4 —
  // "cannot verify completion: this repository has hotfix checked out, not run r1's branch" —
  // and this handler allows the stop. The mechanism is `complete`'s: `init-run` records the
  // run branch, `--enforcement-only` compares it to HEAD, and an absent record counts as
  // cannot-confirm. An earlier version of this comment claimed the opposite outcome and named
  // it a live hazard; that was measured against a tree where the fix had not yet landed, and
  // restating it after the merge would have left the only in-repo record of a residual that
  // no longer exists.
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
