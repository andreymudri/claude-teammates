import { spawn } from 'node:child_process'
import { filesetViolations, ownershipViolations, resolveTaskBranch, derivePhase, planHash } from './enforce.mjs'
import { GitError } from './git.mjs'

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

export function describePendingCheck(check) {
  return {
    name: check.name,
    kind: check.kind,
    status: 'pending',
    optional: check.optional === true,
    check,
  }
}

// `optional: true` is meaningful on a `command` check — "this lint is advisory". On an
// enforcement check (`fileset`, `ownership`) it would mean "detect the violation and ship
// anyway", which is never coherent to want. Both are forced non-optional here, at the point
// the result is built, so an uncommitted manifest cannot disable enforcement while appearing
// to record it.
const ALWAYS_ENFORCED_KINDS = new Set(['fileset', 'ownership'])

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

export async function runFilesetCheck(check, ctx = {}) {
  const { git, runId, runSha, tasks, currentPhase, phaseError } = ctx
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
      for (const task of tasks ?? []) {
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

  const phaseTasks = (tasks ?? []).filter((t) => t.phase === currentPhase)
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
  const { git, runId, runBranch, anchorSha, runSha, tasks } = ctx
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

    const commits = await git.commitsBetween({ from: anchorSha, to: runSha })
    const unexplained = []
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
          for (const parent of secondaryParents) {
            let owned = false
            for (const branchSha of shas) {
              if (await git.isAncestor(parent, branchSha)) { owned = true; break }
            }
            if (!owned) { allParentsOwned = false; break }
          }
          if (allParentsOwned) {
            explained = await mergeContentExplainedByParents(git, firstParent, secondaryParents, sha)
          }
        }
      }
      if (!explained) unexplained.push(sha)
    }

    const violations = ownershipViolations({
      runBranch,
      taskBranches: branches,
      unexplainedCommits: unexplained,
      dirty: await git.isDirty(),
    })
    return violations.length === 0
      ? checkResult(check, 'pass', '')
      : checkResult(check, 'fail', violations.join('\n'))
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return checkResult(check, 'fail', err.message)
  }
}

const RUNNERS = Object.assign(Object.create(null), {
  command: runCommandCheck,
  fileset: runFilesetCheck,
  ownership: runOwnershipCheck,
})

export async function runChecks(checks, ctx = {}) {
  const results = []
  for (const check of checks) {
    // Bare property access would resolve a kind of "toString" to Object.prototype.toString
    // and call it as a runner. Confirmed reachable from a hand-written manifest.
    const runner = Object.hasOwn(RUNNERS, check.kind) ? RUNNERS[check.kind] : null
    if (!runner) { results.push(describePendingCheck(check)); continue }
    try {
      results.push(await runner(check, ctx))
    } catch (err) {
      // A throwing check previously propagated out of the CLI, so no verdict was recorded
      // and the previous phase's PASS stood.
      results.push(checkResult(check, 'fail', `check threw: ${err.message}`))
    }
  }
  return results
}

const RECOGNIZED = new Set(['pass', 'fail', 'skip', 'pending'])

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
  const passed = results.length > 0 && failed.length === 0 && pending.length === 0
  return { verdict: passed ? 'PASS' : 'FAIL', failed, optionalFailed, skipped, pending }
}
