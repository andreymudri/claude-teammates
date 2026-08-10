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
  // Lazily built, then shared by every task branch of every phase: for each merge commit on
  // the run branch since the anchor, the first parent of that merge, indexed by each of its
  // NON-first parents that is ITSELF a commit inside anchor..run. Only a branch already on the
  // run branch needs it (see `ownWorkBase`), so a run whose branches all still carry unmerged
  // work never pays for the walk, and a run that does pays for it once.
  //
  // Both filters are load-bearing, and this index answers the same question `mergedBranchTips`
  // answers over the same set, so it applies the same two filters for the same reasons:
  //
  //   - Non-first parents only. The first parent is the run branch's own prior history, so
  //     treating it as "the branch this merge carried" would let any commit already on the run
  //     branch vouch for itself — the same reason `runOwnershipCheck` slices it off.
  //   - The parent must be in range. The range bounds which merge commits are WALKED; it does
  //     not filter the parents they print. This plugin's plan-amendment procedure merges the
  //     BASE branch into the run branch, so the base tip is printed as a secondary parent of a
  //     merge inside the range — and for a run whose amendments have landed, the anchor IS that
  //     base tip. Unfiltered, a task ref parked at the anchor is keyed here, gets a fork point
  //     from BEFORE the anchor, and its diff fills with the base branch's own commits: it reads
  //     as work it never did, its phase reads integrated, and `runFilesetCheck` returns the
  //     vacuous pass this whole change exists to stop reaching. Reproduced end to end; pinned by
  //     `a task branch parked at the anchor does not read as integrated after a plan amendment`.
  //
  // Every parent of a commit on the run branch is reachable from the run branch by construction,
  // so "inside anchor..run" is exactly "not reachable from the anchor" — the filter expressed as
  // a bound rather than as an isAncestor call per parent, which is how `mergedBranchTips` states
  // it too. That helper returns only the parent set, with no way to ask which merge carried a
  // given parent, so the mapping is rebuilt here rather than shared; the filter is duplicated
  // deliberately, and `scripts/git.mjs:270-287` is where its reasoning is set out at length.
  let mergeFirstParents = null
  const firstParentOfMergeNaming = async (sha) => {
    if (!mergeFirstParents) {
      mergeFirstParents = new Map()
      const commits = await git.commitsBetween({ from: anchorSha, to: runSha })
      const inRange = new Set(commits)
      for (const commit of commits) {
        const parents = await git.commitParents(commit)
        if (parents.length < 2) continue
        for (const parent of parents.slice(1)) {
          if (!inRange.has(parent)) continue
          if (!mergeFirstParents.has(parent)) mergeFirstParents.set(parent, parents[0])
        }
      }
    }
    return mergeFirstParents.get(sha) ?? null
  }

  // The base a branch's own work is measured from, which is never the run anchor. The anchor
  // is fixed at the start of the whole run, so from phase 2 onward it sits behind everything
  // earlier phases merged, and an anchor-based diff credits a branch with THOSE files.
  // Confirmed: a phase-2 branch created by `git checkout -B <task> <run branch>` and never
  // committed to reads as "changed a.mjs" once a sibling's merge moves the run tip past it,
  // the phase reads integrated, `derivePhase` advances past it, and `runFilesetCheck` takes
  // its `currentPhase === null` fast path — so the landed test never runs for that task at all.
  //
  // Before the branch is on the run branch, its fork point off that branch is the answer, and
  // it is the same base `runFilesetCheck` diffs from, so the two stop disagreeing about what a
  // branch contributed. Once the branch IS on the run branch, merge-base(run, branch) is the
  // branch's own tip and every diff from it is empty however much work the branch carried; the
  // base that still answers "what did THIS branch contribute" is the fork point the branch had
  // at the moment it was merged, i.e. merge-base(first parent of the merge that named it,
  // branch). A branch on the run branch that no merge names is left measuring against itself,
  // which reads as no work — that is the parked-branch case, and it must read that way.
  const ownWorkBase = async (sha) => {
    const forkPoint = await git.mergeBase(runSha, sha)
    if (forkPoint !== sha) return forkPoint
    const firstParent = await firstParentOfMergeNaming(sha)
    if (!firstParent) return sha
    return await git.mergeBase(firstParent, sha)
  }

  // Run-wide, the same set `runFilesetCheck` builds for the same reason: the sha a commit
  // carries is a fact about the whole run, not about one phase, and a parked ref's sibling is
  // usually in an earlier, already-integrated phase. A sha shared by more than one task's
  // branch cannot be independently confirmed as ANY of those tasks' own work — it is one commit,
  // so at most one of the refs pointing at it did the work, and this mechanism cannot tell
  // which. Both are held back from `integratedPhases` rather than guessed at.
  const allTaskShas = await runWideTaskShas(git, tasks, runId)
  const shaCounts = new Map()
  for (const [, rec] of allTaskShas) shaCounts.set(rec.sha, (shaCounts.get(rec.sha) ?? 0) + 1)

  const integratedPhases = []
  for (const [phase, phaseTasks] of byPhase) {
    const states = []
    for (const t of phaseTasks) {
      const branch = resolveTaskBranch(t, runId)
      if (!branch || !(await git.branchExists(branch))) { states.push(false); continue }
      const sha = await git.resolveRef(`refs/heads/${branch}`)
      if ((shaCounts.get(sha) ?? 0) > 1) { states.push(false); continue }
      // isAncestor(sha, runSha) alone is trivially true for a branch with zero commits past
      // the anchor: a branch created at the anchor, or created by pointing at the run tip
      // itself, is an ancestor by reflexivity or by definition, with no work required.
      // Confirmed: a teammate can create every task branch at the run tip, commit nothing
      // anywhere, and every phase reads integrated. Counting commits is not enough either —
      // confirmed separately: a single `git commit --allow-empty` satisfies "has a commit"
      // while changing no file at all. Requiring at least one *file* changed between the
      // branch's own work base and the branch means "integrated" implies "did work", not just
      // "points at something already on the run branch" or "has a commit".
      //
      // Both of those attacks are still defeated once the base is the fork point rather than
      // the anchor, and the second is defeated MORE completely than before: a branch created
      // at the run tip measures against its own tip and shows nothing, and a branch of empty
      // commits measures against the fork point it was merged from and still shows nothing.
      // What the fork-point base adds is that "did work" now means the branch's OWN work,
      // rather than anything that was already on the run branch when the branch was created.
      //
      // It also closes two variants the anchor base left open: a ref pointed at a run TIP that
      // already carries someone ELSE'S real commits, and a ref parked at the ANCHOR after a plan
      // amendment merged the base in. Both used to show commits they had no part in as their own
      // work; both now measure against a base that yields nothing.
      //
      // One variant remains fully open, and one is now only PARTLY open. An earlier version of
      // this comment named only the first, which is how the second went unrecorded:
      //   - A teammate that does the integrator's job — creating task branches that each carry
      //     real work and merging them itself. Indistinguishable here from legitimate
      //     integration, because at this level it IS the same shape. Still fully open.
      //   - A ref parked at a merged SIBLING'S tip. Reproduced: T3 commits `c.mjs` and is merged
      //     `--no-ff`; T2's ref is then pointed at T3's tip. T2's sha is a genuine secondary
      //     parent of that merge and genuinely in range, so it is keyed in the index above, and
      //     `ownWorkBase` would hand back T3's fork point — crediting T2 with `c.mjs` while T2's
      //     own declared file never reaches the run branch. The range filter cannot help: the sha
      //     really was merged, just not as this task. `runFilesetCheck` had the symmetric hole
      //     through `mergedBranchTips`, which asks the same membership question.
      //
      //     Closed at the shared-sha step just above, for both this function and
      //     `runFilesetCheck`: two task refs of one run resolving to the identical sha can be
      //     confirmed at most one of them's own work, and this mechanism cannot tell which, so
      //     neither reads as integrated here and `runFilesetCheck`'s duplicate rule rejects both
      //     while the phase is still open. What remains open is the NEAR-sibling variant: a
      //     distinct sha one empty commit above the sibling's tip does not trip the shared-sha
      //     count here or `runFilesetCheck`'s duplicate rule, and whether either test still
      //     catches it depends on the shape of what got merged where — see
      //     `tests/adversarial.test.mjs`'s LIMIT (near-sibling) test for the case that survives.
      //
      // The spec's "Not defended against" list still records the shared-sha shape as open; this
      // function and `tests/adversarial.test.mjs` are the more current source for what remains.
      //
      // A branch integrated by FAST-FORWARD leaves no merge commit to name it, so it measures
      // against its own tip and reads as no work even though the work is on the run branch.
      // That is the same limit `runFilesetCheck` states for the same reason, and it fails
      // closed: `tm-integrator`'s contract is `--no-ff`, so the state is out-of-contract.
      const ownChanges = await git.changedFiles({ base: await ownWorkBase(sha), branch: sha })
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

// Run-wide, deliberately, and the asymmetry is the point: the SUBJECT of the duplicate rule is
// the phase under check, but the COMPARISON SET is every task ref in the run. A ref parked at a
// merged sibling's tip is the shape the empty-diff test below cannot see — the sibling's sha
// genuinely is a merge parent in range, so `mergedBranchTips` vouches for it — and the sibling
// is usually in an earlier phase, so a phase-wide comparison set would never meet it.
//
// Widening the SUBJECT instead, by asking this of every task in the run, would fail a phase for
// two not-yet-started refs of a LATER phase both sitting exactly where `git checkout -B <task>
// <run branch>` put them. That is not a violation of anything, which is why this does not live
// in `runOwnershipCheck` despite ownership being the run-wide check.
async function runWideTaskShas(git, tasks, runId) {
  const shas = new Map()
  for (const task of tasks ?? []) {
    const branch = resolveTaskBranch(task, runId)
    if (!branch) continue
    if (!(await git.branchExists(branch))) continue
    shas.set(branch, { sha: await git.resolveRef(`refs/heads/${branch}`), taskId: task.id })
  }
  return shas
}

export async function runFilesetCheck(check, ctx = {}) {
  const { git, runId, runSha, anchorSha, currentPhase, phaseError } = ctx
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

  let allTaskShas
  try {
    allTaskShas = await runWideTaskShas(git, ctx.tasks ?? [], runId)
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return checkResult(check, 'fail', `could not resolve this run's task refs: ${err.message}`)
  }

  const problems = []
  const branchShas = {}
  // One walk for the whole phase, and only if some branch's diff comes up empty: the set is a
  // fact about the run, not about any single branch, and a phase where every branch carries work
  // never needs it. Memoised rather than hoisted so a phase that does not need it does not pay
  // for it, and so a walk that fails is reported against the task that asked for it.
  let mergedTips = null
  const landedTips = async () => {
    if (!mergedTips) mergedTips = await git.mergedBranchTips({ runSha, anchorSha })
    return mergedTips
  }
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
        // Scoped to the empty-diff branch, and checked before the landed-tips test below. A
        // branch whose diff is NON-empty cannot be the parked ref — it carries real content of
        // its own, whatever its sha shares with another branch — so running this unconditionally
        // failed the honest branch too: phase 2 has siblings T2 and T3, T3 commits `c.mjs`, T2's
        // ref is pointed at T3's tip, and T3's own `complete` run hit this test before its diff
        // was even computed and read as "credited with work it did not do" about T3 itself.
        // Two task refs of one run resolving to the identical sha, while the diff is empty, has
        // no legitimate shape once the phase is being gated: one of them was moved onto the
        // other, and the one WITH the empty diff is the one that moved.
        const twin = [...allTaskShas].find(([name, rec]) => name !== branch && rec.sha === sha)
        if (twin) {
          problems.push(`${task.id}: branch ${branch} and ${twin[0]} (task ${twin[1].taskId}) are both at commit ${sha} — one is parked at the other's tip and would be credited with work it did not do`)
          continue
        }
        // Only meaningful BEFORE the branch lands. Once it is on the run branch,
        // merge-base(run, branch) is the branch's own tip, so the diff is empty however much
        // work the branch carried — re-verifying an integrated phase (what `finish` does) would
        // otherwise fail every one of them. What the branch contributed after integration is
        // `ownership`'s question, and it asks it of every commit on the run branch, every run.
        //
        // What decides it is whether the run branch MERGED THIS BRANCH: whether a merge commit
        // past the anchor names this sha as a parent other than its first, AND that sha is
        // itself past the anchor. `mergedBranchTips` enforces the second half — it returns only
        // parents inside the anchor..run range — so this reads as a single membership test. The
        // second half is not decoration: a plan amendment merges the BASE into the run branch,
        // which names the base tip as a secondary parent, and for a run whose amendments have
        // landed the anchor IS the base tip. Anything that weakens that filter puts the anchor
        // back in the set and re-opens the parked-at-the-anchor hole below.
        //
        // Ancestry alone cannot decide it, and each exclusion bolted onto ancestry left the next
        // hole. "On the run branch" is satisfied by a branch parked at the anchor — a teammate
        // that committed on the harness's own branch and left the conventional ref where it
        // started. Adding "past the anchor" is satisfied, from phase 2 onward, by a branch left
        // exactly where `git checkout -B <task> <run branch>` put it. Adding "not the run tip"
        // is still satisfied by a branch parked at an INTERMEDIATE post-anchor commit, which is
        // what a branch becomes as soon as the integrator merges a sibling and the run tip moves
        // past it. All three carry no work, and none can be reached by standing still: being
        // named as a merge parent is a fact about the merge that carried the branch, and the
        // range filter keeps the amendment merges from vouching for the first of them.
        //
        // What this does NOT distinguish, stated as what is true rather than as what would be
        // convenient:
        //   - A branch integrated by FAST-FORWARD leaves no merge commit and so no secondary
        //     parent. Its diff is empty too (a fast-forward also makes merge-base(run, branch)
        //     the branch's own tip), so it reaches this test and fails it — with a message that
        //     names a cause that is not the one, since the work IS on the run branch. Nothing
        //     here can separate that branch from one merely parked at the same commit: both are
        //     post-anchor commits on the run branch that no merge names. `tm-integrator`'s
        //     contract is `--no-ff` for exactly this reason, and no other check covers the gap
        //     — `ownership` explains a fast-forwarded branch's commits by their ancestry from
        //     the task branch, so it reports nothing. Failing closed is the intended direction;
        //     the misleading wording is the price.
        //   - A SQUASH merge likewise carries no secondary parent. The plugin's integrator
        //     never squashes, so that is a statement about a repository someone else merged
        //     into, not about a run this tool drove.
        //   - Two branches with an empty diff whose tips are the identical sha are rejected
        //     before this test runs, by the duplicate-ref rule just above. That rule sees the
        //     WHOLE run, not just this phase, so it still fires after the legitimate sibling has
        //     been merged: `deriveContext`'s `integratedPhases` computation applies the same
        //     shared-sha exclusion (see the comment at its own `ownWorkBase` loop) before this
        //     function ever runs, so a phase containing a parked ref never falsely reads as fully
        //     integrated and this loop keeps reaching it. Pinned as a FAIL in
        //     `tests/adversarial.test.mjs` both while the sibling's phase is still open and after
        //     its legitimate half has been merged. What that rule does NOT reject is a
        //     NEAR-sibling: an empty commit on top of the sibling's tip is a distinct sha, so
        //     neither the shared-sha exclusion nor the duplicate test fires, and whether this
        //     test fires depends on whether that commit is itself a merge parent in range —
        //     pinned as a LIMIT (near-sibling) test in the same file. Narrow, open, and recorded
        //     here rather than rediscovered.
        //
        // `scripts/doctor.mjs` computes this same test the same way, over the same set, with
        // the same limits.
        const landed = (await landedTips()).has(sha)
        if (!landed) {
          problems.push(`${task.id}: branch ${branch} contributes no file changes past its fork point ${forkPoint} — the work is not on the conventional ref, and merging this task would be a no-op`)
        }
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
