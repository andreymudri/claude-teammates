import { spawn } from 'node:child_process'
import { filesetViolations, ownershipViolations, baseExplainedNote, resolveTaskBranch, derivePhase, planHash } from './enforce.mjs'
import { GitError } from './git.mjs'
import { withMergePreview, conflictPairs } from './merge-preview.mjs'

const TAIL_LINES = 40

export function defaultExec(cmd, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, shell: true })
    let output = ''
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

function tail(text, n) {
  const lines = text.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

export async function runCommandCheck(check, { cwd = process.cwd(), exec = defaultExec } = {}) {
  const { code, output } = await exec(check.run, cwd)
  const passed = code === 0
  return {
    name: check.name,
    kind: 'command',
    status: passed ? 'pass' : 'fail',
    exitCode: code,
    output: passed ? '' : tail(output, TAIL_LINES),
    optional: check.optional === true,
  }
}

// `optional: true` is meaningful on a `command` check — "this lint is advisory". On an
// enforcement check (`fileset`, `ownership`, `merge`) it would mean "detect the violation and
// ship anyway", which is never coherent to want. All three are forced non-optional here, at
// the point the result is built, so an uncommitted manifest cannot disable enforcement while
// appearing to record it.
const ALWAYS_ENFORCED_KINDS = new Set(['fileset', 'ownership', 'merge'])

export function describePendingCheck(check) {
  return {
    name: check.name,
    kind: check.kind,
    status: 'pending',
    // An always-enforced kind cannot buy its way out here either. `pending` blocks only while
    // it is non-optional, so a manifest entry of an enforced kind that found no runner —
    // `{ "kind": "merge", "optional": true }`, the computed check a manifest must not be able
    // to supply or suppress — would otherwise land as a pending that waves the phase through.
    optional: ALWAYS_ENFORCED_KINDS.has(check.kind) ? false : check.optional === true,
    check,
  }
}

function checkResult(check, status, output) {
  const optional = ALWAYS_ENFORCED_KINDS.has(check.kind) ? false : check.optional === true
  return { name: check.name, kind: check.kind, status, output, optional }
}

// Takes no `status` argument by design. Three earlier versions of this system were defeated
// by trusting a file the enforced agents can write.
export async function deriveContext({ git, runId, runBranch, baseBranch, planPath }) {
  // Both refs are resolved to shas before mergeBase ever sees them. A bare name resolves
  // through refs/tags/ before refs/heads/ — confirmed bypass: a teammate plants tags named
  // like the base and run branches, mergeBase silently resolves against the tagged (attacker)
  // commits, and the anchor, the plan read at that anchor, and the ownership commit range are
  // all computed against the wrong tree.
  const baseSha = await git.resolveRef(`refs/heads/${baseBranch}`)
  const runSha = await git.resolveRef(`refs/heads/${runBranch}`)
  const anchorSha = await git.mergeBase(baseSha, runSha)
  const planMarkdown = await git.fileAtCommit(anchorSha, planPath)
  const { parsePlan } = await import('./plan-parser.mjs')
  const { assignPhases } = await import('./phases.mjs')
  const tasks = assignPhases(parsePlan(planMarkdown))

  // A phase is integrated when every one of its task branches is an ancestor of the run
  // branch. Resolved through refs/heads/ so a tag cannot stand in for a branch.
  const byPhase = new Map()
  for (const task of tasks) {
    if (!byPhase.has(task.phase)) byPhase.set(task.phase, [])
    byPhase.get(task.phase).push(task)
  }
  const integratedPhases = []
  for (const [phase, phaseTasks] of byPhase) {
    const states = []
    for (const t of phaseTasks) {
      const branch = resolveTaskBranch(t, runId)
      if (!branch || !(await git.branchExists(branch))) { states.push(false); continue }
      const sha = await git.resolveRef(`refs/heads/${branch}`)
      // isAncestor(sha, runSha) alone is trivially true for a branch with zero commits past
      // the anchor: a branch created at the anchor, or created by pointing at the run tip
      // itself, is an ancestor by reflexivity or by definition, with no work required.
      // Confirmed: a teammate can create every task branch at the run tip, commit nothing
      // anywhere, and every phase reads integrated. Counting commits is not enough either —
      // confirmed separately: a single `git commit --allow-empty` satisfies "has a commit"
      // while changing no file at all. Requiring at least one *file* changed between the
      // anchor and the branch means "integrated" implies "did work", not just "points at
      // something already on the run branch" or "has a commit". This does not close
      // self-integration in general — a phantom branch pointed at a run tip that already
      // carries someone else's real commits still passes this check — that remains the
      // documented, accepted limitation (see the spec's "Not defended against" list).
      const ownChanges = await git.changedFiles({ base: anchorSha, branch: sha })
      states.push(ownChanges.length > 0 && await git.isAncestor(sha, runSha))
    }
    if (states.length > 0 && states.every(Boolean)) integratedPhases.push(phase)
  }

  // An empty task list is not a run with nothing to check — it means the plan path or the
  // plan itself is wrong (a directory anchor renders a tree listing that parses to zero
  // tasks; `derivePhase` would otherwise return `{phase: null}` with no error, which
  // `runFilesetCheck` reads as "every phase is integrated" and passes vacuously). Surfaced
  // as a phaseError, which both fileset and ownership already honour, naming what was read
  // and from where so the operator can see the mistake.
  if (tasks.length === 0) {
    return {
      git, runId, runBranch, baseBranch, anchorSha, runSha,
      planHash: planHash(planMarkdown),
      tasks,
      currentPhase: null,
      phaseError: `plan at ${planPath} (anchor ${anchorSha}) parsed to zero tasks`,
      integratedPhases,
    }
  }

  const derived = derivePhase({ tasks, integratedPhases })
  return {
    git, runId, runBranch, baseBranch, anchorSha, runSha,
    planHash: planHash(planMarkdown),
    tasks,
    currentPhase: derived.phase ?? null,
    phaseError: derived.error ?? null,
    integratedPhases,
  }
}

// `complete` verifies the calling task, not the whole phase, and marks that with
// `ctx.taskScope: <task id>`. `gate` never sets it, so `taskScope == null` is the phase-wide
// path every gate invocation has always taken, byte for byte.
//
// The narrowing travels as a marker rather than as a pre-filtered `ctx.tasks` on purpose:
// `runOwnershipCheck` must stay run-wide. It explains every commit on the run branch, not just
// this task's, so handing it a filtered task list would let a direct write ride in behind
// whichever task happens to finish first. A marker narrows exactly the two consumers that
// should narrow and leaves ownership reading the full list.
function scopedTasks(ctx) {
  const tasks = ctx.tasks ?? []
  return ctx.taskScope == null ? tasks : tasks.filter((t) => t.id === ctx.taskScope)
}

// The phase's tasks, then the scope. A `taskScope` naming a task outside the current phase
// therefore narrows to zero, which the callers' existing "selected no tasks" guard fails —
// fail-closed, never a vacuous pass.
function scopedPhaseTasks(ctx) {
  return scopedTasks(ctx).filter((t) => t.phase === ctx.currentPhase)
}

export async function runFilesetCheck(check, ctx = {}) {
  const { git, runId, runSha, currentPhase, phaseError } = ctx
  if (!git) return checkResult(check, 'fail', 'fileset check has no git access')
  if (phaseError) return checkResult(check, 'fail', phaseError)
  if (currentPhase == null) {
    // Every phase is integrated: there is no in-progress phase whose declared file set is
    // still being written to, so there is nothing left to diff. Re-diffing every historical
    // branch on every gate invocation would repeat work this check already did while each
    // phase was in progress, without adding signal beyond what runOwnershipCheck re-verifies
    // on every invocation regardless of phase (every commit on the run branch since the
    // anchor is reachable from a task branch, and a merge commit contributes nothing beyond
    // what its parents already established). Branch shas are still recorded here, though,
    // so a branch that moves after this verdict is issued is caught by verdictCoversTree
    // even though this path performs no diff of its own.
    const branchShas = {}
    try {
      // Scoped too: a task-scoped verdict must not claim to cover a sibling's branch, or a
      // sibling moving its branch would invalidate this task's verdict via verdictCoversTree.
      for (const task of scopedTasks(ctx)) {
        const branch = resolveTaskBranch(task, runId)
        if (branch && await git.branchExists(branch)) {
          branchShas[branch] = await git.resolveRef(`refs/heads/${branch}`)
        }
      }
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      return checkResult(check, 'fail', err.message)
    }
    return { ...checkResult(check, 'pass', 'every phase in the plan is integrated'), branchShas }
  }

  const phaseTasks = scopedPhaseTasks(ctx)
  // Zero tasks is not "nothing to check" — the run and the plan disagree, and an earlier
  // version returned a clean pass for exactly this state.
  if (phaseTasks.length === 0) {
    return checkResult(check, 'fail', `phase ${currentPhase} selected no tasks from the plan`)
  }

  const problems = []
  const branchShas = {}
  for (const task of phaseTasks) {
    const branch = resolveTaskBranch(task, runId)
    if (!branch) { problems.push(`${task.id}: no branch could be resolved`); continue }
    try {
      if (!(await git.branchExists(branch))) {
        problems.push(`${task.id}: branch ${branch} does not exist`)
        continue
      }
      const sha = await git.resolveRef(`refs/heads/${branch}`)
      branchShas[branch] = sha
      // Diffed against the branch's actual fork point off the run branch, not the run
      // anchor fixed at the start of the whole run. A phase-2 branch legitimately forks
      // from the run branch after phase 1 has already been merged into it, so a diff
      // against the anchor would blame phase 2 for phase 1's files. Three-dot notation
      // against the anchor does not help either — once the anchor is an ancestor of the
      // branch (true for every phase after the first), merge-base(anchor, branch) is just
      // the anchor again, so it degenerates to the same wrong diff.
      const forkPoint = await git.mergeBase(runSha, sha)
      const changed = await git.changedFiles({ base: forkPoint, branch: sha })
      // An existing branch that changes nothing is not a vacuous pass. A teammate that skips
      // its `git checkout -B teammates/<runId>/<taskId>` commits on whatever branch it was
      // handed — the harness's own worktree branch — and leaves the conventional ref sitting
      // at the run tip with no work on it. The ref exists, filesetViolations of an empty list
      // is empty, and the task then merges as a no-op while its result says `done`. The
      // branch is resolved by convention precisely so the enforced party cannot redirect the
      // check; emptiness is what that redirection looks like from here.
      if (changed.length === 0) {
        problems.push(`${task.id}: branch ${branch} contributes no file changes past its fork point ${forkPoint} — the work is not on the conventional ref, and merging this task would be a no-op`)
        continue
      }
      const violations = filesetViolations(changed, task.files)
      if (violations.length > 0) problems.push(`${task.id}: outside declared set — ${violations.join(', ')}`)
    } catch (err) {
      if (!(err instanceof GitError)) throw err
      problems.push(`${task.id}: ${err.message}`)
    }
  }
  const result = problems.length === 0
    ? checkResult(check, 'pass', '')
    : checkResult(check, 'fail', problems.join('\n'))
  return { ...result, branchShas }
}

// git show <sha>:<path> fails when the path does not exist at that commit — a real absence,
// not a git failure. `null` is a sentinel distinct from any real file content; every caller
// compares it against another call of this same function, so the sentinel only ever meets
// itself or real content.
async function contentAt(git, sha, filePath) {
  try {
    return await git.fileAtCommit(sha, filePath)
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return null
  }
}

// The rule, stated once so it is predictable regardless of merge order or which side
// conflicts: a file is accepted when the first parent's own content at the point of
// divergence is unchanged (a clean, verifiable single-side contribution) OR when more than
// one parent's history touched it there (an unverifiable but honest multi-way conflict);
// it is rejected only when the merge's content for that file has no such source at all.
//
// True when every byte that differs between the merge commit and its first parent is
// attributable to one of the merge's *other* parents (the caller has already confirmed
// every one of those is itself an ancestor of one of this run's task branches). For each
// file the merge changed relative to its first parent:
//
//   - A secondary parent "touched" the file when its content differs from the pairwise
//     merge-base with the first parent — the file's actual point of divergence, regardless
//     of how many other phases have since landed on the run branch.
//   - Exactly one clean toucher (the first parent's own content at that same base is
//     unchanged): a clean merge takes that side verbatim, so the merge's content must equal
//     it byte for byte. Matching filename with different bytes — the confirmed attack this
//     closes — fails right here.
//   - The first parent's content at that base *also* differs (a genuine two-way conflict),
//     or more than one secondary parent independently disagrees: git itself would have
//     required a hand resolution here, which cannot be verified byte-for-byte without
//     re-implementing the merge algorithm. Accepted — the ancestry check already confirmed
//     every contributor is an honest task branch, so this is a conflict between legitimate
//     contributions, not smuggled content.
//   - No parent touched the file at all: content with no legitimate source. Fails, even
//     under a name that matches nothing suspicious.
//
// Every secondary parent is checked for every file — nothing here stops at the first parent
// that explains part of the commit, which is what let content hide in the gap between two
// parents' contributions in an octopus merge.
//
// The candidate file list is the *union* of what changed between the first parent and the
// merge commit, and what each secondary parent itself changed relative to the first parent —
// not just the former. A file a secondary parent added and the merge commit then deleted
// (`git rm` after `--no-ff --no-commit`, before completing the commit) shows zero diff
// between the first parent and the merge commit — added, then removed, nets to invisible —
// so it would never reach the check at all if only that one diff were consulted. Deletion is
// a content change with no legitimate source, exactly like a fabricated addition; the merge
// commit must still explain why a file its own second parent introduced is now gone.
async function mergeContentExplainedByParents(git, firstParent, secondaryParents, mergeSha) {
  const mergedFiles = new Set(await git.changedFiles({ base: firstParent, branch: mergeSha }))
  for (const parent of secondaryParents) {
    for (const file of await git.changedFiles({ base: firstParent, branch: parent })) mergedFiles.add(file)
  }
  for (const file of mergedFiles) {
    const mergeContent = await contentAt(git, mergeSha, file)
    let genuineConflict = false
    const cleanContributions = new Set()
    for (const parent of secondaryParents) {
      const base = await git.mergeBase(firstParent, parent)
      const baseContent = await contentAt(git, base, file)
      const parentContent = await contentAt(git, parent, file)
      if (parentContent === baseContent) continue // this parent never touched the file
      const firstContentAtBase = await contentAt(git, firstParent, file)
      if (firstContentAtBase !== baseContent) { genuineConflict = true; break }
      cleanContributions.add(parentContent)
    }
    if (genuineConflict) continue
    if (cleanContributions.size === 0) return false
    if (cleanContributions.size === 1 && mergeContent !== [...cleanContributions][0]) return false
    // size > 1: independent secondary parents disagree without the first parent being
    // involved — git itself would have flagged this as a conflict too. Accepted, for the
    // same reason a genuine conflict is: not verifiable byte-for-byte, but every contributor
    // is already a confirmed task branch.
  }
  return true
}

export async function runOwnershipCheck(check, ctx = {}) {
  const { git, runId, runBranch, baseBranch, anchorSha, runSha, tasks } = ctx
  if (!git) return checkResult(check, 'fail', 'ownership check has no git access')

  try {
    const branches = []
    const shas = []
    for (const task of tasks ?? []) {
      const branch = resolveTaskBranch(task, runId)
      if (branch && await git.branchExists(branch)) {
        branches.push(branch)
        shas.push(await git.resolveRef(`refs/heads/${branch}`))
      }
    }

    // Tolerated when it cannot be resolved: a run configured without a base branch, or with
    // one that no longer exists, keeps today's behaviour rather than failing this check for a
    // brand-new reason it was never meant to report.
    let baseSha = null
    if (baseBranch && await git.branchExists(baseBranch)) {
      baseSha = await git.resolveRef(`refs/heads/${baseBranch}`)
    }

    const commits = await git.commitsBetween({ from: anchorSha, to: runSha })
    const unexplained = []
    // Every commit this check admitted only because of base ancestry. Reported on the pass —
    // see `baseExplainedNote`, which also records why no base sha from run start is consulted.
    const baseExplained = []
    for (const sha of commits) {
      let explained = false
      for (const branchSha of shas) {
        if (await git.isAncestor(sha, branchSha)) { explained = true; break }
      }
      if (!explained) {
        const parents = await git.commitParents(sha)
        const firstParent = parents[0]
        // Only *non-first* parents can explain a commit this way. The first parent is the
        // run branch's own prior history; letting it vouch for a commit would let any commit
        // reachable through a fast-forward onto a task branch (first parent == that branch's
        // tip) trivially explain itself via isAncestor(X, X) — exactly how a direct write
        // riding a fast-forward would be waved through. Confirmed via mutation testing:
        // scanning `parents` instead of `parents.slice(1)` leaves the suite green while
        // silently accepting that write.
        const secondaryParents = parents.slice(1)
        if (firstParent && secondaryParents.length > 0) {
          // Every secondary parent must itself be an ancestor of one of this run's task
          // branches — an octopus merge with one legitimate parent and one rogue parent
          // must not be waved through because the legitimate one matched. Confirmed gap in
          // an earlier version: the scan broke on the first matching parent, so content
          // riding in behind a second, unowned parent was never inspected.
          let allParentsOwned = true
          let usedBase = false
          for (const parent of secondaryParents) {
            let owned = false
            for (const branchSha of shas) {
              if (await git.isAncestor(parent, branchSha)) { owned = true; break }
            }
            // A merge of the base into the run branch is how a mid-run plan amendment reaches
            // the anchor. Its secondary parent is the base, never a task branch, so without
            // this a legitimate base advance is indistinguishable from a direct write. Base
            // content is already trusted: the anchor is computed from it and `changedFiles`
            // diffs against it, so accepting base ancestry adds no new trust. It is still
            // per-parent — a rogue parent riding alongside a base parent fails the loop.
            if (!owned && baseSha && await git.isAncestor(parent, baseSha)) { owned = true; usedBase = true }
            if (!owned) { allParentsOwned = false; break }
          }
          if (allParentsOwned) {
            explained = await mergeContentExplainedByParents(git, firstParent, secondaryParents, sha)
            if (explained && usedBase) baseExplained.push(sha)
          }
        }
      }
      if (!explained) unexplained.push(sha)
    }

    // Asked of every task branch of the run, not just the current phase's: a branch merged
    // into the base by a side door is a violation whenever it is noticed, and an earlier
    // phase's branch is exactly the one most likely to have been "helpfully" landed already.
    // Skipped entirely when the base could not be resolved — the same tolerance the
    // base-ancestry clause above applies, for the same reason.
    const sideDoor = []
    if (baseSha) {
      for (let i = 0; i < shas.length; i += 1) {
        if (await git.isAncestor(shas[i], baseSha) && !(await git.isAncestor(shas[i], runSha))) {
          sideDoor.push(branches[i])
        }
      }
    }

    const violations = ownershipViolations({
      runBranch,
      baseBranch,
      sideDoorBranches: sideDoor,
      taskBranches: branches,
      unexplainedCommits: unexplained,
      dirty: await git.isDirty(),
    })
    return violations.length === 0
      ? checkResult(check, 'pass', baseExplainedNote({ baseBranch, commits: baseExplained }))
      : checkResult(check, 'fail', violations.join('\n'))
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return checkResult(check, 'fail', err.message)
  }
}

// `merge` is deliberately absent: the gate builds the merge preview itself, once, around the
// whole check list. A manifest entry claiming that kind finds no runner and lands as pending,
// which blocks — an editable manifest must not be able to supply or suppress a computed check.
const RUNNERS = Object.assign(Object.create(null), {
  command: runCommandCheck,
  fileset: runFilesetCheck,
  ownership: runOwnershipCheck,
})

const MERGE_CHECK = { name: 'merge', kind: 'merge' }

const CONFLICT_SKIP = 'the phase does not merge cleanly; no merged tree exists to test'

async function runCheckList(checks, ctx, commandCwd, mergeConflicted) {
  const results = []
  for (const check of checks) {
    // A `command` check exists to answer "does the integrated tree work". Without a merged
    // tree there is no honest answer, and running it against the run branch's own tree would
    // answer a different question while looking like the one that was asked. Skipped, with
    // the reason — the block comes from the `merge` check, which fails.
    if (check.kind === 'command' && mergeConflicted) {
      results.push(checkResult(check, 'skip', CONFLICT_SKIP))
      continue
    }
    // Bare property access would resolve a kind of "toString" to Object.prototype.toString
    // and call it as a runner. Confirmed reachable from a hand-written manifest.
    const runner = Object.hasOwn(RUNNERS, check.kind) ? RUNNERS[check.kind] : null
    if (!runner) { results.push(describePendingCheck(check)); continue }
    try {
      // Only `command` checks are relocated. `fileset` and `ownership` read git, not a
      // working tree, and must keep reading the real repository.
      results.push(await runner(check, check.kind === 'command' ? { ...ctx, cwd: commandCwd } : ctx))
    } catch (err) {
      // A throwing check previously propagated out of the CLI, so no verdict was recorded
      // and the previous phase's PASS stood.
      results.push(checkResult(check, 'fail', `check threw: ${err.message}`))
    }
  }
  return results
}

// A preview that could not be built at all — a merge that failed without leaving unmerged
// paths (unset user.email, a branch deleted mid-run, unrelated histories), or a worktree that
// could not be created — is neither a clean tree nor a reportable conflict. It is reported as
// a failing `merge` check carrying git's own reason, with the `command` checks skipped: they
// must never run against the unmerged tree, and `aggregateVerdict` blocks on the fail.
async function previewFailure(checks, ctx, reason) {
  return [checkResult(MERGE_CHECK, 'fail', reason), ...await runCheckList(checks, ctx, ctx.cwd, true)]
}

export async function runChecks(checks, ctx = {}) {
  // A solo (--no-fleet) run has no run branch, no task branches and no git in context: there
  // is nothing to preview, so the checks run where the caller stands.
  if (!ctx.git || ctx.solo) return runCheckList(checks, ctx, ctx.cwd, false)

  // The same notion of "this phase's branches" the fileset check uses — same
  // resolveTaskBranch call, same branchExists guard, same phase filter, and the same
  // `taskScope` narrowing. Two different ones in one file would drift.
  //
  // Scoping matters here for the same reason it matters for fileset: with the phase-wide set,
  // the first teammate of a 3-task phase to run `complete` gets every sibling's branch merged
  // into its preview, so a sibling's stray commit — or a sibling branch that does not exist
  // yet — fails the preview and reads to that teammate as "my own work is broken".
  const phaseTasks = scopedPhaseTasks(ctx)
  const branches = []
  try {
    for (const task of phaseTasks) {
      const branch = resolveTaskBranch(task, ctx.runId)
      if (branch && await ctx.git.branchExists(branch)) branches.push(branch)
    }
  } catch (err) {
    return previewFailure(checks, ctx, `merge preview could not resolve the phase's branches: ${err.message}`)
  }

  // Set as soon as the callback runs, so the catch below can tell "the preview was never
  // built" (re-run the list against no merged tree) from the theoretical case of the callback
  // itself throwing after some checks already ran — which must never re-run them.
  let previewed = false
  try {
    return await withMergePreview({
      git: ctx.git,
      base: ctx.runBranch,
      branches,
      link: ctx.previewLink ?? [],
      repoRoot: ctx.cwd,
      // Every check runs inside this callback, so the worktree is alive for all of them and
      // removed exactly once, after the last one. The merge check cannot be the thing holding
      // the worktree open — by the time a later check ran, the directory would be gone.
      run: async ({ path, conflict }) => {
        previewed = true
        if (conflict) {
          const pairs = conflictPairs(branches, conflict)
          const merged = { ...checkResult(MERGE_CHECK, 'fail', JSON.stringify(pairs, null, 2)), pairs }
          return [merged, ...await runCheckList(checks, ctx, ctx.cwd, true)]
        }
        const merged = checkResult(MERGE_CHECK, 'pass', '')
        // `path` is null only when the phase has no branches to merge: nothing to preview, so
        // the run branch's own tree is the tree integration would produce.
        return [merged, ...await runCheckList(checks, ctx, path ?? ctx.cwd, false)]
      },
    })
  } catch (err) {
    const reason = `merge preview failed: ${err.message}`
    if (previewed) {
      // Unreachable in practice — runCheckList catches every per-check throw. Kept so a
      // future edit inside the callback can never produce a second, duplicate run of the
      // checks, nor a verdict-less crash out of the CLI.
      return [checkResult(MERGE_CHECK, 'fail', reason), ...checks.map((c) => checkResult(c, 'fail', reason))]
    }
    return previewFailure(checks, ctx, reason)
  }
}

const RECOGNIZED = new Set(['pass', 'fail', 'skip', 'pending'])

// Kinds the gate computes for itself rather than reading from the manifest. They are real
// results — they fail, they block, they are reported — but they are not evidence that anything
// the manifest asked for was actually verified, so they do not satisfy the fail-closed
// "some check ran" clause below.
const GATE_COMPUTED_KINDS = new Set(['merge'])

export function aggregateVerdict(results) {
  // An unrecognized or missing status is a failure, never a pass. This function is the
  // single source of truth for whether a phase proceeds; it must never fail open.
  // The verdict is the AND of all non-optional checks — an optional check that fails
  // is still surfaced, in optionalFailed, but never blocks the gate on its own.
  const unrecognized = results.filter((r) => !RECOGNIZED.has(r.status)).map((r) => r.name)
  const failed = [
    ...results.filter((r) => r.status === 'fail' && !r.optional).map((r) => r.name),
    ...unrecognized,
  ]
  const optionalFailed = results.filter((r) => r.status === 'fail' && r.optional).map((r) => r.name)
  const skipped = results.filter((r) => r.status === 'skip').map((r) => r.name)
  const pending = results.filter((r) => r.status === 'pending' && !r.optional).map((r) => r.name)
  // "At least one check ran" is decided over the manifest-supplied results only. `runChecks`
  // prepends the gate's own `merge` result to every fleet check list, so counting `results`
  // wholesale would read a check list of one self-generated pass as a verified phase — which is
  // exactly what an enforced agent buys by emptying the working-tree manifest, the same edit
  // that stops `fileset` and `ownership` from running. Confirmed reachable: the working tree's
  // manifest is loaded with plain `fs` and never compared against the committed copy. A
  // manifest entry that merely *claims* a gate-computed kind is excluded here too; it lands as
  // a non-optional pending and blocks on its own, so exclusion only ever fails closed.
  const verified = results.filter((r) => !GATE_COMPUTED_KINDS.has(r.kind))
  const passed = verified.length > 0 && failed.length === 0 && pending.length === 0
  return { verdict: passed ? 'PASS' : 'FAIL', failed, optionalFailed, skipped, pending }
}
