import { spawn } from 'node:child_process'
import { filesetViolations, ownershipViolations, baseExplainedNote, resolveTaskBranch, derivePhase, planHash, normalizePath } from './enforce.mjs'
import { GitError } from './git.mjs'
import { withMergePreview, conflictPairs } from './merge-preview.mjs'

// 15 minutes. A command check is the project's own suite, so the default has to clear a
// slow one on a cold cache; what it exists to stop is the check that never returns at all.
export const COMMAND_TIMEOUT_MS = 15 * 60_000

// Between SIGTERM and SIGKILL. A suite that traps SIGTERM to write a coverage report gets
// to finish; one that ignores it does not get to outlive the gate.
const KILL_GRACE_MS = 5_000

const TAIL_LINES = 40

// The whole process group, not the direct child. With `shell: true` the direct child is
// `/bin/sh -c`, so killing it alone leaves everything the suite spawned running — measured:
// `spawn('sleep 300 & wait', { shell: true, timeout: 500, killSignal: 'SIGKILL' })` ends
// with the shell dead and the grandchild ALIVE. That is why node's own `timeout` option is
// not what this uses.
function killGroup(pid, signal) {
  if (process.platform === 'win32') {
    // A negative pid is POSIX. On win32 the equivalent is taskkill walking the child tree.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
    return
  }
  // PROBED FIRST, on every signal path there is, because a pgid whose group has emptied is a
  // number the OS has already freed to hand out again.
  if (retireIfGroupGone(pid)) return
  try {
    process.kill(-pid, signal)
  } catch (err) {
    // ESRCH: the group went away between the probe above and here, which is the outcome this
    // wanted, and the pid stops being signalled from now on.
    if (err.code === 'ESRCH') liveGroups.delete(pid)
  }
}

// Whether the GROUP is empty — NOT whether its leader died. A group whose leader has exited
// while members are still running keeps its pgid RESERVED and is still exactly the right thing
// to kill, so `child.exitCode !== null` is not this test: it would drop a live suite from the
// sweep and let it outlive the gate. Retires the pid the first time the group answers ESRCH,
// and answers whether it did.
//
// What this closes: the escaped-grandchild path, which is the case the timeout exists for.
// Measured with a `setsid` run string, the direct child is reaped in about a millisecond and
// Linux frees a pgid as soon as its group has no members — after which the module used to signal
// that number three ways, SIGTERM at the timeout, SIGKILL at the grace, and a SIGKILL from the
// sweep on every Ctrl-C. The `catch` above cannot detect that on its own: once the number is
// reused no ESRCH is raised, because it names something real.
//
// Its limit, stated plainly: this NARROWS the window from the whole timeout to the microseconds
// between the probe and the signal that follows it. Nothing inside a process can close that
// window, because pid reuse is not observable from here.
function retireIfGroupGone(pid) {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return false
  } catch (err) {
    // EPERM says the group exists and is not ours, which is a signal that could not land
    // either way; it stays registered rather than being treated as gone.
    if (err.code !== 'ESRCH') return false
    liveGroups.delete(pid)
    return true
  }
}

// Groups still running, so a Ctrl-C does not leave a suite behind. A pid is retired the first
// time its GROUP is observed empty — at the child's exit, or at the next signal — never merely
// when its leader dies, because a group with surviving members still holds its pgid.
//
// SIGKILL is deliberately absent and cannot be added: it is untrappable, and the
// 120-second caller kill that orphans a suite inside a merge preview is exactly a SIGKILL.
// Nothing in this file can cover that case. What covers it is the claim file the orphan
// holds itself instead of depending on its parent surviving.
const liveGroups = new Set()
let teardownInstalled = false

// A SNAPSHOT of that set, never the set itself — a caller that could mutate it could disarm the
// sweep. A snapshot and nothing more: a pid it lists may have exited between the read and the
// caller's use of it, so this answers "was this registered" and never "is this alive".
export function liveGroupPids() {
  return [...liveGroups]
}

function installTeardown() {
  if (teardownInstalled) return
  teardownInstalled = true
  const sweep = () => { for (const pid of liveGroups) killGroup(pid, 'SIGKILL') }
  process.once('exit', sweep)
  // Installing a handler displaces node's default disposition, so each one exits itself
  // with the conventional 128 + signal code rather than leaving the process running.
  process.once('SIGINT', () => { sweep(); process.exit(130) })
  process.once('SIGTERM', () => { sweep(); process.exit(143) })
  // SIGHUP and SIGQUIT terminate by DEFAULT, and a default disposition runs neither a handler
  // nor the `exit` sweep above — so a closed terminal or a dropped ssh session used to leave the
  // whole check tree orphaned with its timer gone. `detached` made that worse rather than
  // better: setsid() moves the check out of node's session, so the hangup the terminal delivers
  // to node's own group no longer reaches the group node spawned. Measured on that shape: parent
  // dead, grandchild alive in a session of its own.
  //
  // POSIX only. Win32 has no SIGQUIT, its SIGHUP is a console-control event with different
  // semantics, and its teardown is the `taskkill` tree walk rather than a group signal.
  if (process.platform !== 'win32') {
    process.once('SIGHUP', () => { sweep(); process.exit(129) })
    process.once('SIGQUIT', () => { sweep(); process.exit(131) })
  }
}

// `graceMs` overrides KILL_GRACE_MS. It exists so a test can drive the SIGKILL path without
// five seconds of wall clock; production callers pass neither it nor anything but `timeoutMs`
// and `onSpawn`, and shortening it changes only when the second signal is sent, never which
// path runs.
export function defaultExec(cmd, cwd, { timeoutMs = COMMAND_TIMEOUT_MS, onSpawn = null, graceMs = KILL_GRACE_MS } = {}) {
  return new Promise((resolve, reject) => {
    installTeardown()
    const child = spawn(cmd, {
      cwd,
      shell: true,
      // Its own process group, which is the only thing that makes the kill above reach the
      // suite rather than just the shell.
      detached: process.platform !== 'win32',
      // `detached` on win32 otherwise opens a console window.
      windowsHide: true,
    })
    let output = ''
    let timedOut = false
    let timer = null
    let grace = null
    let settled = false

    // Runs on EVERY exit path there is — a normal close, a spawn error, a throw out of
    // `onSpawn`, and the grace expiry that settles without a close — because each of the three
    // things it undoes outlives this promise otherwise. A timer left armed keeps node's event
    // loop alive long after the verdict was reported; a pid left in `liveGroups` is a pid the
    // exit sweep signals after the OS may have recycled it.
    const cleanup = () => {
      clearTimeout(timer)
      clearTimeout(grace)
      if (child.pid !== undefined) liveGroups.delete(child.pid)
    }
    // Our end of the pipes. Dropping them is what stops a process that escaped the group from
    // holding this promise open; the limit is that anything it writes afterwards is lost, which
    // is output from a process the gate has already given up on.
    const dropPipes = () => {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    // FIRST SETTLE WINS, and cleanup happens with it. A timeout that settles on the grace expiry
    // usually DOES see a `close` afterwards — destroying the pipes below tends to produce one —
    // and that must not re-run a cleanup whose `liveGroups.delete` would by then name whatever
    // holds that pid. Stated, not tested: the second `resolve` a missing guard allows is a no-op
    // the promise machinery swallows, and the delete only misfires once the OS has recycled the
    // pid, which no test here can make happen on demand.
    const settle = (fn) => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }
    // `code || 1`, not `code ?? 1`. `?? 1` converts the `null` of a signal-killed child but not
    // a `0` — and a suite that TRAPS SIGTERM and exits cleanly inside the grace, the exact case
    // the grace exists to accommodate, closes with 0. `runCommandCheck` reads `code === 0` as a
    // pass and blanks the output on that branch, taking the timeout notice with it: a green
    // check with no output for a suite that never finished. The price of `||` is that a command
    // which genuinely finished 0 in the race between the timer firing and `close` is reported as
    // a fail — for a gate, that is failing closed, which is the direction to be wrong in.
    const resolveTimedOut = (code) => settle(() => {
      const seconds = Math.round(timeoutMs / 1000)
      resolve({
        code: code || 1,
        output: `${output}\n— timed out after ${seconds}s; its process group was killed`,
      })
    })

    timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid, 'SIGTERM')
      grace = setTimeout(() => {
        killGroup(child.pid, 'SIGKILL')
        // SETTLED ON THE KILL BEING DELIVERED, not on `close`. `close` waits for the stdio
        // pipes rather than for the direct child, and a grandchild that left the group while
        // inheriting them — a `setsid`, or a `spawn(..., { detached: true, stdio: 'inherit' })`
        // — survives everything this can signal and holds them open. Waiting on that is the
        // unbounded check the timeout exists to stop, reachable from an ordinary manifest `run`
        // string. So the bound is timeoutMs + graceMs and nothing here waits past it.
        //
        // The limit: this says the kill was SENT, not that the suite is gone. Nothing in a
        // process can end a process that left its group, and the output that grandchild would
        // still have written is lost with the pipes.
        dropPipes()
        resolveTimedOut(null)
      }, graceMs)
    }, timeoutMs)

    // ATTACHED BEFORE `onSpawn` RUNS. `onSpawn` writes the preview claim file and so can throw
    // on EACCES or ENOSPC; called first, its throw left no `close` or `error` listener attached
    // at all, so nothing ever ran the cleanup — both timers stayed armed, the pid stayed in
    // `liveGroups`, the pipes were never drained, and a later `error` event was an uncaught
    // exception. Measured on that shape: the promise rejected at 9ms and the process stayed
    // alive to 8016ms.
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    child.on('error', (err) => {
      settle(() => {
        if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL')
        reject(err)
      })
    })
    // Retirement at the FIRST moment the group can be observed empty, which for an escaped
    // grandchild is here and not at the timeout: the direct child is gone, its group has no
    // members, and every later signal would aim at a freed number. A group that still has
    // members keeps its pid registered — see `retireIfGroupGone`, which is what makes that
    // distinction rather than the exit code this listener carries.
    child.on('exit', () => {
      if (child.pid !== undefined) retireIfGroupGone(child.pid)
    })
    child.on('close', (code) => {
      if (timedOut) { resolveTimedOut(code); return }
      settle(() => resolve({ code: code ?? 1, output }))
    })

    if (child.pid !== undefined) {
      liveGroups.add(child.pid)
      // Called synchronously, before this promise can yield, so a holder registered here is
      // registered before anything can observe the process it names. A throw propagates — a
      // claim that cannot be written must not read as a check that ran unclaimed — but it
      // propagates through the SAME cleanup an ordinary exit runs, plus the kill, so a gate
      // that reports this failure can still exit and leaves nothing of the child behind.
      try {
        if (onSpawn) onSpawn(child.pid)
      } catch (err) {
        settle(() => {
          killGroup(child.pid, 'SIGKILL')
          dropPipes()
          reject(err)
        })
      }
    }
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

// A CHECK KIND MUST BE A STRING BEFORE ANYTHING IS DECIDED FROM IT.
//
// JavaScript coerces on property lookup and does not coerce in a Set, and a manifest is JSON, so
// `"kind": ["command"]` is expressible and lands on the wrong side of every guard at once:
//
//     ['command'] !== 'command'              true     survives cli.mjs's --enforcement-only filter
//     Object.hasOwn(RUNNERS, ['command'])    true     the guard that looks like a type check
//     RUNNERS[['command']]                   runner   executes
//     ALWAYS_ENFORCED_KINDS.has(['fileset']) false    so `optional: true` is honoured
//
// The consequences were both reached end to end against the merged tree. `["command"]` runs an
// arbitrary shell command through the stop hook — which fires for every subagent on the machine —
// with cwd at the main worktree. `["fileset"] + optional: true` runs the REAL fileset check and
// then declines to block it, producing `{"verdict":"PASS","failed":[],"optionalFailed":["fileset"]}`
// — a forged manifest reaching a false gate PASS, which is a bound this design has claimed since
// phase 1. `teammates.gate.json` is writable by any teammate, so neither needs a further foothold.
//
// The type test lives HERE, at the runner lookup and at the two places `optional` is computed,
// rather than in the callers' filters: `cli.mjs`'s `--enforcement-only` filter is one call site of
// several, and fixing it would close the execution path while leaving the false PASS. The earlier
// prototype-key guard on the line below is a different defect — `'toString'` is a string and was
// always handled; an array is the spelling JSON can express and nothing covered it.
const hasUsableKind = (check) => typeof check?.kind === 'string'

// The position `malformedKindResult` reports must locate the entry in `teammates.gate.json`, and
// the list this module is handed is not always that file's list — `cli.mjs` narrows it in more
// than one place, and counting the surviving entries then names a different entry than the message
// tells the operator to fix.
//
// `ctx.checkPositions[i]` is the manifest position of the i-th entry of the list as handed over.
// Where it is absent this falls back to the list's own index, which is correct only if nothing was
// filtered out — so the fallback is a default, not a guarantee, and this cannot detect a caller
// that filtered and stayed silent. What keeps callers right is on the cli.mjs side: narrowing goes
// through `narrowChecks`, which returns the list and its positions together.
function manifestPosition(ctx, index) {
  const positions = ctx?.checkPositions
  return Array.isArray(positions) && Number.isInteger(positions[index]) ? positions[index] : index
}

// A FAIL rather than a pending or a skip: a manifest this file cannot understand is a
// configuration fault, so it must not run and must not be capable of passing.
//
// Built through `checkResult` rather than as its own object literal, so that `optional` is decided
// in exactly ONE place — and the entry's OWN `kind` and `optional` are handed over unchanged, so
// the decision `checkResult` makes is a real one. An earlier version passed a synthesized literal
// with no `optional` at all; `checkResult`'s `hasUsableKind` clause then had nothing to refuse, and
// restoring that shape and deleting the clause leaves tests/gate-runner.test.mjs fully green
// (measured) — the unpinned-guard-that-reads-as-load-bearing shape this review has rejected
// repeatedly. Now `{"kind":["fileset"],"optional":true}` reaches that clause carrying
// `optional: true`, and deleting the clause alone turns the false-PASS test red.
//
// `index` is the entry's position in the manifest's check list (see `manifestPosition`), and it is
// the whole point of this function's diagnosis. A malformed entry frequently has no `name` —
// `null` and `"just a string"` are both reachable from a hand-written manifest — and `name` is the
// only field `aggregateVerdict` reports, so two such entries both surfaced as `{"failed":[null]}`
// while the text told the operator to fix a `kind` on an entry they could not identify. The
// position is put in BOTH the message and the fallback `name`, so the verdict line alone locates
// the entry.
//
// The `try` is not reachable from a manifest: that file is `JSON.parse`-only, so the kinds it can
// express are exactly the JSON value shapes and `JSON.stringify` serialises all of them. It guards
// the EXPORTED api instead — `runChecks` is called directly from `cli.mjs` and from tests, and a
// programmatic caller can pass a `10n`, which is what the bigint test pins. Its scope is that one
// serialisation and nothing wider: the reads that reach the entry's own fields happen outside the
// `try`, so a throwing GETTER on the entry throws out of `runChecks` with no verdict recorded. No
// manifest can express a getter, so that is programmatic callers only.
function malformedKindResult(check, index) {
  const position = `entry #${index} in this phase's check list`
  let shown
  try {
    shown = JSON.stringify(check?.kind)
  } catch {
    // A BigInt, or any other value `JSON.stringify` refuses: it still has to be reportable.
    shown = String(check?.kind)
  }
  // Only `name`, `kind` and `optional` are read out of this; `kind` and `optional` are passed
  // through unchanged so that `checkResult`'s own `hasUsableKind` clause — not a second copy of
  // the rule here — is what forces `optional: false`.
  return checkResult(
    { name: typeof check?.name === 'string' ? check.name : position, kind: check?.kind, optional: check?.optional },
    'fail',
    `check kind must be a string, got ${shown} (${position})`
    + ' — a manifest entry this gate cannot understand is a configuration fault, not a check.'
    + ' Fix the `kind` in teammates.gate.json.',
  )
}

export function describePendingCheck(check) {
  return {
    name: check.name,
    kind: check.kind,
    status: 'pending',
    // An always-enforced kind cannot buy its way out here either. `pending` blocks only while
    // it is non-optional, so a manifest entry of an enforced kind that found no runner —
    // `{ "kind": "merge", "optional": true }`, the computed check a manifest must not be able
    // to supply or suppress — would otherwise land as a pending that waves the phase through.
    // A non-string kind is forced non-optional here too. `Set.has` does not coerce, so without
    // this an unusable kind would slip past the always-enforced forcing and honour `optional`.
    optional: !hasUsableKind(check) || ALWAYS_ENFORCED_KINDS.has(check.kind) ? false : check.optional === true,
    check,
  }
}

function checkResult(check, status, output) {
  const optional = !hasUsableKind(check) || ALWAYS_ENFORCED_KINDS.has(check.kind)
    ? false
    : check.optional === true
  return { name: check.name, kind: check.kind, status, output, optional }
}

// The files a merge commit M in `anchor..run` actually carried, indexed by every one of its
// NON-first parents that is ITSELF a commit inside `anchor..run` — built once, shared by
// `deriveContext`'s own integration credit and `runFilesetCheck`'s empty-diff test, which each
// build their own copy (a phase-gate invocation and a `complete` invocation neither owns the
// other's cache).
//
// Three earlier designs asked a different question — "is this sha suspicious" — by classifying
// a shared sha as parked or benign from properties of the sha alone: shared-by-anyone,
// not-the-run-tip, a member of `git.mergedBranchTips`. Every one of them was wrong, because a
// sha's innocence depends on how a ref CAME to point at it, which a sha carries no trace of.
// Concretely: `git.mergedBranchTips` answers "is this sha a secondary parent of some merge in
// range" — but a teammate that runs `git merge --no-ff run-branch` on ITS OWN branch, to pick
// up a sibling's interfaces, makes the OLD run tip a secondary parent of that sync merge too,
// poisoning `mergedBranchTips` for every idle ref that happened to be dispatched at that old
// tip. The REF was never merged; the COMMIT it points at can be, for reasons that have nothing
// to do with that ref.
//
// The question this check actually needs answered is narrower and per-task: when a branch
// reads as "landed" (its own diff off the run branch is empty because it is already on the run
// branch), did the merge that put it there actually carry THIS TASK's declared files? A parked
// ref's sha is named by a merge, but that merge carried the SIBLING's files, never the parked
// task's own declared set — so filtering by the merge's own diff against its own first parent,
// rather than by sha membership alone, is what actually tells a parked ref from a genuine one,
// and it does so without needing to reason about any OTHER ref at all: `landedForFiles` takes
// only this task's own sha and this task's own declared files, so a sibling moving its OWN ref
// off the shared sha in a later fix round changes nothing — the merge that already landed is
// unaffected by where any ref currently points.
//
// Built by walking only the run branch's OWN first-parent chain — from `runSha` back through
// `parents[0]` until `anchorSha` — not every commit in `anchor..run`. Those chain commits are
// the integrator's own merges, the only ones that actually integrate a branch; a merge commit
// reachable from `run` but NOT on that chain is one a TASK made on its own branch (a sync merge,
// `git merge --no-ff run-branch`, run to pick up an earlier phase's interface) and must never
// grant credit.
//
// An earlier version of this walk visited every commit in `anchor..run` and attributed a
// merge's ENTIRE first-parent diff to every one of its secondary parents. That double-credited a
// sync merge's target: the sync names the run tip it synced FROM as a secondary parent, and that
// merge's first-parent diff is whatever the sync's own branch changed relative to where the sync
// branch itself forked — which can include files the SYNCED-FROM commit merely carried, not
// originated. Executed repro: T1 (phase 1) creates `a.mjs`, merged. T2 (phase 2) declares
// `a.mjs` and never commits — its ref sits at the post-T1 run tip. T3 (phase 2) forks earlier,
// commits `c.mjs`, then runs `git merge --no-ff run-branch` on its OWN branch to pick up T1's
// interface, and is then integrated normally. The old walk keyed the post-T1 tip (T2's sha) with
// `{a.mjs}` — from T3's sync merge, not from anything T1's own integrating merge did — and T2
// read landed with nothing written. `gate does not credit an idle ref parked on a run tip that
// only a sibling's own sync merge later named` pins the fix.
//
// For each chain commit with more than one parent, and for each of its secondary parents still
// passing the in-range filter below, the value indexed is that secondary parent's OWN
// contribution since it diverged from the chain's prior tip —
// `changedFiles({ base: parents[0], branch: parent })`, which `changedFiles` itself computes as
// a three-dot diff against `mergeBase(parents[0], parent)` (see `scripts/git.mjs:125-126`), not
// the merge commit's own tree. This is the same call shape as before; only WHAT is walked (the
// chain, not every commit) and WHOSE tree the diff reads (the parent's own, not the merge
// commit's) changed. A legitimately integrated branch is unaffected: the integrator's own merge
// still names that branch's tip as a secondary parent, and the three-dot diff from the run
// branch's prior tip still gives exactly that branch's own committed files.
//
// The in-range filter is unchanged, and still answers the same question over the same set built
// from a single `commitsBetween` call:
//
//   - The parent must be in range. A plan amendment merges the BASE branch into the run branch,
//     naming the base tip as a secondary parent — and for a run whose amendment has landed, the
//     anchor IS that base tip. Unfiltered, a task ref parked at the anchor would be keyed here,
//     landed for whatever files that one amendment merge happened to touch. In practice an
//     amendment rarely names a file that collides with a task's own declared set, so the
//     existing real-repo parked-at-anchor test stays green with or without this filter — it is
//     the declared-files predicate itself, not this filter, that defends the common case.
//     The filter is confirmed load-bearing for the narrower, coincidental-filename case: pinned
//     directly against `mergedParentFiles`'s output by
//     `runFilesetCheck does not read a ref parked at the anchor as landed even when a
//     coincidental filename matches`, which goes red without it.
//
// A sha can be named by more than one chain commit (a stale parked position, plus an unrelated
// later sync that happens to reuse the same commit as a parent). The file sets found are unioned
// per sha rather than kept per-merge — pinned by
// `mergedParentFiles unions file sets across two merges naming the same sha, rather than
// keeping only the first` — because "does some merge naming this sha carry a declared file" and
// "does the declared set intersect the union of every merge naming this sha" are the same
// existence claim: a file is in the union exactly when it is in at least one member set.
export async function mergedParentFiles(git, { anchorSha, runSha }) {
  const commits = await git.commitsBetween({ from: anchorSha, to: runSha })
  const inRange = new Set(commits)
  const filesBySha = new Map()
  // The run branch's own first-parent chain can visit at most `commits.length` distinct
  // commits before reaching the anchor: every commit on that chain, short of the anchor
  // itself, is by construction one of the commits `commitsBetween` already returned. Bounded
  // explicitly rather than trusting `cursor` to reach `anchorSha` exactly — a git double whose
  // mocked first-parent chain never passes through the anchor (a test bug, not a real-repo
  // shape) would otherwise walk forever, calling `commitParents` on an ever-changing cursor.
  // Confirmed reachable, not hypothetical: an unbounded version of this loop OOM'd the test
  // process outright.
  let cursor = runSha
  let steps = 0
  while (cursor !== anchorSha && steps <= commits.length) {
    const parents = await git.commitParents(cursor)
    if (parents.length === 0) break
    if (parents.length >= 2) {
      const firstParent = parents[0]
      for (const parent of parents.slice(1)) {
        if (!inRange.has(parent)) continue
        const changed = await git.changedFiles({ base: firstParent, branch: parent })
        let set = filesBySha.get(parent)
        if (!set) { set = new Set(); filesBySha.set(parent, set) }
        for (const file of changed) set.add(file)
      }
    }
    cursor = parents[0]
    steps += 1
  }
  return filesBySha
}

// True when some merge in range named `sha` as a secondary parent AND that merge's own diff
// against its first parent carried at least one of `declaredFiles`. Paths are normalized the
// same way `filesetViolations` normalizes them (backslashes, a leading `./`, a leading `/`),
// so a declared `a.mjs` matches a merge diff reporting `./a.mjs` alike — pinned by
// `runFilesetCheck matches a declared path against a differently-normalized merge diff path`,
// since removing the normalization leaves the suite green otherwise (plans are hand-authored on
// Windows and may declare `./scripts/a.mjs` against a diff reporting `scripts/a.mjs`).
//
// The precondition this predicate actually needs, stated precisely rather than by example: the
// PARKED task's declared set must not intersect what the integrating merge actually carried.
// Within one phase that always holds — `scripts/phases.mjs` assigns two tasks to the same phase
// only when their declared files are disjoint — but declared sets routinely overlap ACROSS
// phases, because a later task modifies a file an earlier task created. When they do overlap,
// this predicate cannot tell a parked ref from a genuine one: both read `landedForFiles` true
// from the identical, real intersection. This is the irreducible case named in the spec's "Not
// defended against" list as sibling-tip self-integration, and it is NOT closed — see the LIMIT
// test below.
//
// What this test has been confirmed to give, by executing each shape below against a real
// repository — not asserted from the design alone. The test named is where each is pinned:
//   - T3 commits `c.mjs`, is merged `--no-ff`, T2 parks on T3's tip, and T2's declared file
//     (`b.mjs`) does NOT intersect what that merge carried (`c.mjs`): `landedForFiles` for T2 is
//     false. `gate fails when a task ref is parked at a merged SIBLING's tip`. This is the
//     disjoint case; the SAME shape with an overlapping declared set is the open LIMIT below.
//   - The same, after T3 makes a further fix-round commit that moves T3's OWN ref off the
//     shared sha: the merge that already named the sha still only ever carried `c.mjs` — this
//     test does not depend on where T3's ref currently sits, only on what that one merge
//     carried, so T2 is still false. This is the shape every earlier design left open once a
//     sibling's ref moved: entry counts, membership sets and run-tip comparisons all keyed on
//     TWO refs sharing something right now, and stopped applying the moment only one of them
//     still did. `gate still fails a parked ref after the sibling it parked on makes a further
//     fix-round commit`.
//   - Two idle refs sharing an old run tip that an UNRELATED merge turned into a secondary
//     parent — a plan amendment merging the base in, or a third task's own
//     `git merge --no-ff run-branch` picking up a sibling's interfaces — where neither idle
//     task's declared file intersects what that merge actually carried: both idle refs read
//     `landedForFiles` false, and fail on the ordinary, true "contributes no file changes"
//     message below — nothing is accused of parking, nothing goes null.
//     `gate does not treat two idle siblings as parked when an unrelated commit moves the run
//     tip past them`; `gate does not credit an idle ref parked on a run tip that only a
//     sibling's own sync merge later named`.
//   - A near-sibling — an empty commit built one commit above a merged sibling's tip, itself
//     later merged under its own name: that merge's own diff against its own first parent is
//     EMPTY (it brings in nothing new), so it can never intersect a non-empty declared set
//     however many merges name the sha. Closed as a side effect of the predicate, not by
//     design intent. `gate fails a ref built one empty commit above a merged sibling's tip, even
//     merged under its own name`.
//   - A legitimately merged branch: the merge naming it carried exactly its own declared files.
//     True. `a compliant two-phase run passes phase 1 ... then derives and passes phase 2`.
export function landedForFiles(filesBySha, sha, declaredFiles) {
  const carried = filesBySha.get(sha)
  if (!carried) return false
  const declared = new Set((declaredFiles ?? []).map(normalizePath))
  for (const file of carried) {
    if (declared.has(normalizePath(file))) return true
  }
  return false
}

// Credit for task refs sitting exactly at the run tip, where `landedForFiles` cannot help: the
// run tip is never keyed in `mergedParentFiles` (that index holds only the NON-FIRST parents the
// chain walk meets), so a sha there carries no attribution at all and the predicate is
// structurally false. That false is correct for a no-op teammate and wrong for a genuinely
// landed task whose ref a fix round re-pointed with the brief's own `git checkout -B <task>
// <run branch>` — and both look identical from the sha.
//
// What separates them is not the position but SCARCITY. A merged secondary parent is a
// contribution that was earned exactly once. If a task's ref points AT such a parent, that task
// has already spent it, and no ref parked at the run tip may be credited with the same one. So a
// run-tip ref is credited only by being matched to a merged parent that (a) carried its WHOLE
// declared set and (b) no other task ref already points at, with at most one run-tip task per
// parent — a bipartite matching, not a containment test.
//
// That distinction is the whole point, and it is what the reverted `f6e2191` lacked. Executed,
// the shape that closure passed and this one fails: T1 (phase 1) declares and merges `a.mjs`
// plus `b.mjs`; T2 (phase 2) declares only `a.mjs` and writes nothing, its ref left at the run
// tip by `checkout -B`. Containment alone credits T2, because T1's merge carried a superset of
// T2's declared set — and a phase-2 task that only MODIFIES files phase 1 created has that
// superset by construction, so it is the routine shape, not a corner. Here T1's own ref still
// points at that parent, so the parent is spent and T2 matches nothing. Two refs both re-pointed
// to the run tip with one parent between them fail for the same reason: the matching is capped
// at the number of distinct parents, so one of them is always left unmatched and its phase does
// not read as integrated.
//
// Attributing by the merge SUBJECT was considered and rejected: no such convention is enforced
// anywhere in this repo, and `tm-integrator` writes that subject while being one of the enforced
// parties — the `status.json` mistake this whole design exists to avoid.
//
// `spent` is supplied by the caller (see `spentParents`) and carries the SPARE-parent closure: a
// task integrated more than once — an initial merge plus a fix round's own merge — leaves parents
// in the index that no ref points AT, and an unclaimed leftover was matchable by a run-tip ref.
// Without a `spent` set this falls back to direct ref positions only, which is what the unit tests
// exercise; the callers that gate a real repository always pass one.
export function creditRunTipTasks({ tasks, shaByTask, runSha, mergedFiles, spent }) {
  // A parent is spent when some task ref points directly at it. Refs at the run tip spend
  // nothing — that is exactly the position with no attribution behind it.
  const claimed = new Set(spent ?? [])
  for (const sha of shaByTask.values()) {
    if (sha !== runSha && mergedFiles.has(sha)) claimed.add(sha)
  }
  const free = [...mergedFiles.keys()].filter((p) => p !== runSha && !claimed.has(p))

  const runTip = tasks.filter((t) => shaByTask.get(t.id) === runSha)
  const candidates = new Map()
  for (const t of runTip) {
    const declared = (t.files ?? []).map(normalizePath)
    // A task declaring nothing is never creditable from the run tip: the empty set is contained
    // in every parent, so without this guard it would match the first free one.
    if (declared.length === 0) { candidates.set(t.id, []); continue }
    candidates.set(t.id, free.filter((p) => {
      const carried = new Set([...mergedFiles.get(p)].map(normalizePath))
      return declared.every((file) => carried.has(file))
    }))
  }

  // Kuhn's augmenting-path matching. Greedy assignment is not enough: an early task can take the
  // only parent a later one could have used, when a different assignment would have satisfied
  // both. Order of `tasks` and of the index decides ties, so the result is deterministic.
  const heldBy = new Map()
  const assign = (taskId, seen) => {
    for (const parent of candidates.get(taskId) ?? []) {
      if (seen.has(parent)) continue
      seen.add(parent)
      const holder = heldBy.get(parent)
      if (holder === undefined || assign(holder, seen)) {
        heldBy.set(parent, taskId)
        return true
      }
    }
    return false
  }
  for (const t of runTip) assign(t.id, new Set())
  return new Set(heldBy.values())
}

// Which merged parents are already accounted for by a task that is NOT sitting at the run tip.
// This is what closes the spare-parent residual `creditRunTipTasks` was first shipped with.
//
// Pointing AT a parent is not the only way to have earned it. A task integrated twice — merged,
// then merged again after a fix round — leaves the first merge's parent behind as an ancestor of
// its current tip, claimed by nobody, and a run-tip ref whose declared set that leftover happens
// to contain in full could match it. So a parent counts as spent when it is an ancestor of some
// task ref AND the files it carried intersect that task's own declared set.
//
// Both halves are load-bearing, and dropping either was measured, not reasoned about:
//
//   - Without the ANCESTOR half, only direct positions are spent and the spare parent stays
//     matchable — the residual this closes.
//   - Without the DECLARED-SET half, ancestry alone spends far too much and reintroduces the
//     original false FAIL. A phase-2 task legitimately forks from the run tip after phase 1 was
//     merged, so phase 1's merged parent is an ancestor of that phase-2 ref. If phase 1's own ref
//     is then re-pointed at the run tip by a fix round, its parent would already read as spent by
//     an unrelated later task and the genuinely landed phase-1 task would fail again. Requiring
//     the carried files to intersect that task's OWN declared set keeps a later task from
//     spending a parent it did not earn.
//
// Run-tip refs spend nothing, here as everywhere: that position carries no attribution, which is
// the whole reason `creditRunTipTasks` exists.
export async function spentParents(git, { tasks, shaByTask, runSha, mergedFiles }) {
  const spent = new Set()
  const byId = new Map((tasks ?? []).map((t) => [t.id, t]))
  for (const [taskId, sha] of shaByTask) {
    if (sha === runSha) continue
    const declared = new Set(((byId.get(taskId)?.files) ?? []).map(normalizePath))
    if (declared.size === 0) continue
    for (const [parent, carried] of mergedFiles) {
      if (spent.has(parent) || parent === runSha) continue
      const intersects = [...carried].some((file) => declared.has(normalizePath(file)))
      if (!intersects) continue
      if (parent === sha || await git.isAncestor(parent, sha)) spent.add(parent)
    }
  }
  return spent
}

// Resolves every task ref in the run to a sha, skipping tasks whose branch cannot be resolved or
// does not exist. Shared so `deriveContext` and `runFilesetCheck` build the SAME map that
// `creditRunTipTasks` reads — the scarcity argument only holds when every ref in the run is
// accounted for, so a caller passing only the current phase's tasks would over-credit.
export async function resolveTaskShas(git, { tasks, runId }) {
  const shaByTask = new Map()
  for (const task of tasks) {
    const branch = resolveTaskBranch(task, runId)
    if (!branch) continue
    if (!(await git.branchExists(branch))) continue
    shaByTask.set(task.id, await git.resolveRef(`refs/heads/${branch}`))
  }
  return shaByTask
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
  // Built once, shared by every task branch of every phase below — see the comment on
  // `mergedParentFiles` above this function for what it answers and why.
  const mergedFiles = await mergedParentFiles(git, { anchorSha, runSha })
  // Run-wide, never per-phase: a phase-1 ref pointing at its own merged parent is what makes
  // that parent spent for a phase-2 ref parked at the run tip.
  const shaByTask = await resolveTaskShas(git, { tasks, runId })
  const runTipCredited = creditRunTipTasks({
    tasks,
    shaByTask,
    runSha,
    mergedFiles,
    spent: await spentParents(git, { tasks, shaByTask, runSha, mergedFiles }),
  })

  const integratedPhases = []
  for (const [phase, phaseTasks] of byPhase) {
    const states = []
    for (const t of phaseTasks) {
      const branch = resolveTaskBranch(t, runId)
      if (!branch || !(await git.branchExists(branch))) { states.push(false); continue }
      const sha = await git.resolveRef(`refs/heads/${branch}`)
      const forkPoint = await git.mergeBase(runSha, sha)
      if (forkPoint !== sha) {
        // Not yet on the run branch: an ordinary "did this branch do its own work" check
        // against its own fork point. isAncestor(sha, runSha) alone is trivially true for a
        // branch with zero commits past the anchor: a branch created at the anchor, or created
        // by pointing at the run tip itself, is an ancestor by reflexivity or by definition,
        // with no work required. Confirmed: a teammate can create every task branch at the run
        // tip, commit nothing anywhere, and every phase reads integrated. Counting commits is
        // not enough either — confirmed separately: a single `git commit --allow-empty`
        // satisfies "has a commit" while changing no file at all. Requiring at least one *file*
        // changed between the fork point and the branch means "integrated" implies "did work".
        const ownChanges = await git.changedFiles({ base: forkPoint, branch: sha })
        states.push(ownChanges.length > 0 && await git.isAncestor(sha, runSha))
        continue
      }
      // Already on the run branch: a diff from `sha` to itself is always empty, so whether
      // this reads as integrated depends entirely on whether some merge in `anchor..run` that
      // named this sha as a secondary parent actually carried task t's own declared files —
      // `landedForFiles`, exactly the predicate `runFilesetCheck`'s empty-diff test applies
      // below. See the comment on `mergedParentFiles`, above this function, for what this
      // closes and what it has been confirmed to give.
      //
      // A branch integrated by FAST-FORWARD leaves no merge commit to name it at all, so it is
      // not a key in `mergedFiles` and reads as not-landed even though the work IS on the run
      // branch. `tm-integrator`'s contract is `--no-ff` for exactly this reason; the state is
      // out-of-contract, and failing closed is the intended direction. Confirmed against a real
      // fast-forward: `deriveContext does not read a fast-forward-integrated branch as
      // integrated (real repo)`.
      //
      // What remains open:
      //   - A teammate that does the integrator's job itself — creating task branches that each
      //     carry real work and merging them itself — is indistinguishable here from legitimate
      //     integration, because at this level it IS the same shape. Unchanged from every
      //     earlier design.
      //   - Sibling-tip self-integration with an OVERLAPPING declared set. Declared files are
      //     disjoint only WITHIN a phase (`scripts/phases.mjs` enforces that); across phases a
      //     later task routinely modifies a file an earlier task created. When a parked ref's
      //     declared set intersects what the integrating merge actually carried, this predicate
      //     cannot tell it apart from the branch that genuinely earned that credit — both read
      //     `landedForFiles` true from the identical, real intersection. Executed: `T1: Create
      //     a.mjs`, `T2: Modify a.mjs, Create b.mjs`; T2 writes nothing and its ref is pointed
      //     at T1's own merged tip; verdict PASS, `b.mjs` never exists. Recorded in the spec's
      //     "Not defended against" list as sibling-tip self-integration; pinned as a LIMIT in
      //     `tests/adversarial.test.mjs`.
      //
      // CLOSED, kept as history because two attempts at it failed in instructive ways:
      //   - `ownWorkBase`: a fix round that re-points an ALREADY-INTEGRATED task's branch onto
      //     the run branch's own current tip — exactly what the brief's own recommended
      //     `git checkout -B teammates/<runId>/<taskId> <run branch>` step does — USED TO read as
      //     having done no work, even though the task's files are genuinely already on the run
      //     branch. `sha` then equals `runSha`, `forkPoint` above also equals `sha` (the
      //     "already on the run branch" branch is taken), and `landedForFiles` looks the sha up
      //     in `mergedFiles`, which is keyed only by the NON-FIRST parents `mergedParentFiles`
      //     visits while walking the chain — the run tip itself is never a value indexed there
      //     unless some LATER merge happens to name it as a secondary parent. Executed: T1's
      //     branch is merged `--no-ff` into `run`, then re-pointed with `git branch -f
      //     teammates/r1/T1 run` (the same tip `checkout -B` would produce); `deriveContext`
      //     then reads T1 as not integrated, `currentPhase` reopens phase 1, and
      //     `runFilesetCheck` fails it with "contributes no file changes past its fork point"
      //     for a task that is genuinely, fully landed. The declared-files predicate does not
      //     resolve this — it was built to tell a parked ref from a merged one by what a merge
      //     carried, and a ref sitting exactly at the run tip is not named by any merge at all.
      //     That was the state until `creditRunTipTasks` and `spentParents` below; the paragraph
      //     above describes the defect, not current behaviour.
      //
      //     One closure was tried and REVERTED (`f6e2191`, reverted by `227abf2`) — recorded so
      //     it is not re-attempted. It asked, for `sha === runSha` only, whether a SINGLE merged
      //     secondary parent carried the task's WHOLE declared set, on the reasoning that full
      //     containment substitutes for the attribution the run tip does not carry. It does not:
      //     the gate for phase N runs BEFORE any phase-N branch is merged, so every phase-N ref
      //     created by the brief's own `git checkout -B <task> <run branch>` and never committed
      //     to sits exactly at `runSha`. Executed: T1 (phase 1) declares and merges `a.mjs` plus
      //     `b.mjs`; T2 (phase 2) declares only `a.mjs`, writes nothing; T1's merge carried a
      //     superset of T2's declared set, so the gate returned PASS with "every phase in the
      //     plan is integrated" and `a.mjs` was never modified. A phase-2 task that only MODIFIES
      //     files phase 1 created has a declared set contained in that merge by construction, so
      //     this is the routine shape, not a corner — it traded the no-op-teammate case the check
      //     exists for against one convenience case. Attributing by the merge SUBJECT instead was
      //     considered and rejected on the same grounds as `status.json`: `tm-integrator` writes
      //     that subject, and it is one of the enforced parties. Failing closed here costs a
      //     misleading message on a genuinely landed re-pointed ref; passing open costs the check.
      //     Closed since, by scarcity rather than containment — see `creditRunTipTasks` above for
      //     what separates the two and which shape each verdict falls on.
      const landed = sha === runSha
        ? runTipCredited.has(t.id)
        : landedForFiles(mergedFiles, sha, t.files)
      states.push(landed && await git.isAncestor(sha, runSha))
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

  let mergedFiles
  try {
    mergedFiles = await mergedParentFiles(git, { anchorSha, runSha })
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return checkResult(check, 'fail', `could not walk this run's merge history: ${err.message}`)
  }

  // Built from EVERY task in the run, not `phaseTasks`: a ref outside this phase pointing at a
  // merged parent is what spends it, so scoping this to the gated phase would hand a parked ref
  // a parent its real owner already claimed.
  let runTipCredited
  try {
    const allTasks = ctx.tasks ?? []
    const shaByTask = await resolveTaskShas(git, { tasks: allTasks, runId })
    runTipCredited = creditRunTipTasks({
      tasks: allTasks,
      shaByTask,
      runSha,
      mergedFiles,
      spent: await spentParents(git, { tasks: allTasks, shaByTask, runSha, mergedFiles }),
    })
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    return checkResult(check, 'fail', `could not resolve this run's task refs: ${err.message}`)
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
        // What decides it is whether some merge in `anchor..run` that names this sha as a
        // secondary parent actually carried THIS TASK's declared files — `landedForFiles`, over
        // the shared `mergedFiles` index built above. See the comment on `mergedParentFiles`
        // and `landedForFiles` themselves (above `deriveContext`, this file's first export) for
        // the full reasoning, what this closes, and what has been confirmed against it.
        //
        // Three earlier designs asked instead whether this sha was suspicious on its own terms
        // — shared by any other ref, not the run tip, or merely a member of
        // `git.mergedBranchTips` — and each produced a real, executed regression: withholding
        // credit from a legitimate branch sharing a sha with a parked one; failing two entirely
        // idle siblings the moment anything else landed on the run branch; and failing two
        // entirely idle siblings again when an unrelated task's OWN sync merge
        // (`git merge --no-ff run-branch` on its own branch) made an old run tip a secondary
        // parent of an in-range merge that carried neither idle task's files. `landedForFiles`
        // is per-task and reads only the merge's own diff, so none of those three shapes can
        // reach it — a fact confirmed by executing each of them, not asserted from the design
        // alone.
        //
        // A branch integrated by FAST-FORWARD leaves no merge commit and so no secondary
        // parent, so it is not a key in `mergedFiles` and reaches this test and fails it — with
        // a message that names a cause that is not the one, since the work IS on the run
        // branch. `tm-integrator`'s contract is `--no-ff` for exactly this reason, and no other
        // check covers the gap: `ownership` explains a fast-forwarded branch's commits by their
        // ancestry from the task branch, so it reports nothing. Failing closed is the intended
        // direction; the misleading wording is the price. A SQUASH merge likewise carries no
        // secondary parent, and this plugin's integrator never squashes.
        //
        // The NEAR-sibling shape every earlier design left open — an empty commit built on top
        // of a merged sibling's tip — is closed here too, not by design intent but as a
        // consequence of the predicate: whether that near-sibling commit is left unmerged (not
        // a key in `mergedFiles` at all) or later merged under its own name (a key, but its
        // merge's own diff against its own first parent is empty, since it carries nothing new),
        // `landedForFiles` reads false either way — an empty carried-file set can never
        // intersect a non-empty declared set. Confirmed by executing the merged-under-its-own-
        // name construction; not asserted from the design alone. Pinned as a defended test —
        // no longer a LIMIT — in `tests/adversarial.test.mjs`.
        //
        // What remains open:
        //   - A teammate that does the integrator's job itself — creating branches that each
        //     carry real work and merging them itself — is indistinguishable here from
        //     legitimate integration, because at this level it IS the same shape; unchanged
        //     from every earlier design and was never claimed to be closed.
        //   - Sibling-tip self-integration with an OVERLAPPING declared set: declared files are
        //     disjoint only WITHIN a phase, not across phases, and when a parked ref's declared
        //     set intersects what the integrating merge actually carried, this predicate cannot
        //     tell the parked ref from the branch that genuinely earned that credit. See the
        //     comment on `landedForFiles` above `deriveContext`, and the LIMIT test in
        //     `tests/adversarial.test.mjs`, for the executed repro.
        //
        // NOT open, and listed here only because it is the other branch of the test below: the
        // run-tip position (`sha === runSha`) is answered by `creditRunTipTasks`, which matches
        // such a ref to a merged parent that carried its whole declared set and that is not
        // already spent — spent meaning pointed at by another task ref, or (see `spentParents`)
        // an ancestor of one whose declared set the parent's files intersect. `landedForFiles`
        // cannot answer it at all: the run tip is not a key in the index, so it reads false for a
        // genuinely landed task whose ref a fix round re-pointed. See those two functions for why
        // containment alone was not enough.
        const landed = sha === runSha
          ? runTipCredited.has(task.id)
          : landedForFiles(mergedFiles, sha, task.files)
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
// Content AND mode, as one comparable value. Mode is part of it because a chmod is a change
// that carries no bytes: comparing bytes alone reports "this parent never touched the file"
// for a file the diff did list, which leaves the merge with no explained source and fails an
// honest integration. Joined on a NUL, which cannot occur in a six-digit mode, so no
// content can spoof a mode boundary.
async function contentAt(git, sha, filePath) {
  try {
    const content = await git.fileAtCommit(sha, filePath)
    const mode = await git.fileModeAtCommit(sha, filePath)
    return `${mode ?? ''}\u0000${content}`
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
  // Counted rather than `checks.entries()`, which would narrow this loop from any iterable to an
  // array and yield `[value, value]` for a Set.
  let index = -1
  for (const check of checks) {
    index += 1
    // BEFORE THE RUNNER LOOKUP at the bottom of this loop, which is the ordering that carries the
    // security property: that lookup coerces (`RUNNERS[['command']]` resolves to a real runner),
    // so an unusable kind reaching it executes. That ordering is pinned: delete this block and the
    // array-spelled execution and false-PASS tests in tests/gate-runner.test.mjs both fail.
    //
    // Its order relative to the merge-conflict skip below matters too, but NOT for the reason a
    // previous version of this comment gave. That version said a non-string kind "slips past" the
    // skip and could be reported as a benign skip; it cannot, because the skip compares
    // `kind === 'command'` strictly and no non-string value satisfies a strict comparison. What
    // the skip actually does is dereference `check.kind` UNGUARDED. Of the entry shapes
    // `teammates.gate.json` can express, exactly one throws there: `null`. A string, number, array
    // or boolean entry evaluates `check.kind` to `undefined` harmlessly and is caught below for the
    // ordinary reason, and `undefined` itself throws but JSON has no literal for it, so it can only
    // arrive from a programmatic caller. That one shape is enough — a `null` entry throws a
    // TypeError out of this loop and out of `runChecks`, recording no verdict at all. Pinned: move
    // this block below the skip and the nameless-entry test fails on that throw.
    // See `hasUsableKind`.
    if (!hasUsableKind(check)) {
      results.push(malformedKindResult(check, manifestPosition(ctx, index)))
      continue
    }
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
