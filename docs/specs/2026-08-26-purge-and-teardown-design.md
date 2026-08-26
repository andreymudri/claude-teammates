# Purge and teardown — killing what a run started, and removing what it left

## Destination

When a run ends, the things it created are gone: no process still running, no worktree still
registered, no scratch branch still holding refs — and every one of those removals rests on
evidence that nothing needs it, never on the absence of evidence that something does.

## Why

An audit of the teardown paths found five gaps. Two are hazards, three are omissions.

**1. Nothing bounds a command check.** `scripts/gate-runner.mjs:10` is
`spawn(cmd, { cwd, shell: true })` with no `timeout`, no `killSignal`, no process group, and
`child.on('error', reject)` rejects without killing anything. A hung suite hangs the gate
forever. `scripts/subagent-stop.mjs:326` already passes `timeout: 60_000`; the gate's exec is
the outlier.

**2. That orphans processes, and the orphan then races the reaper.** `scripts/cli.mjs:298`
records `prune-run` exceeding a 120-second caller timeout. When the caller SIGKILLs the gate:
the `sh -c` child and the suite beneath it survive — no process group — and the preview's
`finally` never runs, so `.tm-preview-owner` stays on disk naming the *dead* gate.
`livePreviewPaths` (`scripts/cli.mjs:1398`) probes that pid, gets ESRCH, and classifies the
preview leaked. `prune-run --yes` then runs `unlinkPreviewLinks` and
`git worktree remove --force` on a tree an orphaned suite is still writing to. The residuals
listed at `scripts/cli.mjs:2836` cover pid recycling — dead reading as live, which costs a
directory. This is the other direction, and it is the one that destroys.

**3. Teammate branches are never deleted.** No `git branch -d` or `-D` exists anywhere in
`scripts/` or `skills/`. `skills/finishing-a-development-branch/SKILL.md:71` calls them
"disposable the moment it merges" and `:82` says "even after their branch has merged and the
branch itself is deleted" — both presuming a step that does not exist. Every run leaves N
permanent `teammates/<runId>/<taskId>` refs.

**4. Cleanup is in neither flow, and the two skills disagree.** `parallel-execution` ends at
step 4 (integrate); `prune-run` appears only in its reference section below.
`finishing-a-development-branch:80-93` — the skill that actually closes a run — hand-rolls
`git worktree list` and `git worktree remove <path>`, bypassing the recomputed-gate evidence
that makes `prune-run` safe. The careful command is in neither numbered flow.

**5. `.teammates/<run-id>/` grows without bound** and nothing says whether that is deliberate.

## 1. Bounded command checks

`defaultExec` gains a timeout and a process group.

    export function defaultExec(cmd, cwd, { timeoutMs = COMMAND_TIMEOUT_MS, onSpawn = null } = {})

- `detached: true`, so the child is a process-group leader with pgid == pid, and
  `windowsHide: true`, because `detached` on win32 otherwise means a console window.
- On expiry: `process.kill(-pid, 'SIGTERM')`, then `process.kill(-pid, 'SIGKILL')` after a
  5-second grace. On win32, where negative pids are not a thing, `taskkill /pid <pid> /T /F`.
- The result resolves rather than rejects, carrying the output collected so far, a non-zero
  code, and a final line: `— timed out after <n>s; its process group was killed`.
  `runCommandCheck` turns that into an ordinary `fail`, so a hang becomes a stated verdict.

**Node's own `timeout` option is not sufficient, and this was measured rather than assumed.**
`spawn('sleep 300 & …', { shell: true, timeout: 500, killSignal: 'SIGKILL' })` leaves the
grandchild alive — the option kills the direct child, which is the shell. The same shape with
`detached: true` and `process.kill(-pid)` leaves neither alive. That difference is the whole
mechanism, and a test pins it.

Groups still running are tracked module-level and killed on `SIGINT`, `SIGTERM` and exit.
**Stated limit, in the code and here: this does nothing about SIGKILL,** which cannot be
trapped, and the 120-second caller kill is exactly a SIGKILL. Part 2 is what covers that case;
this handler covers an operator's Ctrl-C and an ordinary crash.

### The manifest key

`COMMAND_TIMEOUT_MS` defaults to 15 minutes. A `command` check may override it with
`timeoutMs`.

`teammates.gate.json` is teammate-writable and its check *fields* are unvalidated —
`validateGate` in `scripts/config.mjs:146` checks only that `phases[*].checks` is an array, which
is the hole `hasUsableKind` exists to plug. So `timeoutMs` is validated the same way and in the
same place: a positive integer no greater than a hard 60-minute ceiling, or the entry lands as a
`fail` diagnosing itself by `manifestPosition`, exactly like `malformedKindResult`. It never
silently falls back to the default, and a manifest cannot raise the ceiling — above it is
malformed, not honoured.

## 2. Preview claim files

The owner marker at `scripts/merge-preview.mjs:29` stays exactly as it is: one file, the gate's
pid, held across a span that contains the whole span over which the preview is observable. What
it cannot express is a *second* holder — the suite the gate spawned, which outlives it.

Added alongside it: one claim file per holder.

    .tm-preview-owner-<name>          the gate           (unchanged)
    .tm-preview-owner-<name>.<pid>    one per live child (new)

Written by `runCommandCheck` through the `onSpawn` callback, removed in its `finally`. One file
per pid means no read-modify-write, so concurrent holders never race — and it is the same
sibling-path trick, for the same reason `previewOwnerMarkerPath` gives: a file inside the
preview cannot be written before `git worktree add` registers it.

`runChecks` already knows whether the checks run in a preview or in `ctx.cwd`, so the preview
directory is passed down `runCheckList` explicitly as a new argument. It is deliberately not
sniffed from `cwd`: an explicit null is the difference between "not previewing" and "previewing
somewhere this code failed to recognise".

`livePreviewPaths` reads the owner marker **and** the claim siblings — one `readdir` of the temp
root per invocation, filtered by prefix — and calls the preview live if *any* named pid answers.
Its existing rule is preserved for both kinds: only ENOENT and ESRCH, the two answers that
positively mean "no owner", let a preview through. A `readdir` that fails is not an answer, so
every candidate reads as live.

A SIGKILLed gate leaves its orphaned suite's claim file naming a **live** pid, so the preview is
unreapable until that orphan exits. Closed by construction, not narrowed.

### What this does not close

- **Pid recycling**, unchanged in kind and now in one more place: a claim file naming a pid an
  unrelated process has taken makes a dead preview read live. That direction leaves a directory
  on disk and never destroys data, and `prune-run` can be run again.
- **A preview from before claim files existed** carries none, and is classified exactly as it is
  today. No worse, no better.
- **A check that spawns and is SIGKILLed between spawn and the claim write** leaves a live
  process with no claim. The window is one `writeFile` wide and it is real; the marker is
  written before the process it names is useful, not after, but this is not a span-containment
  guarantee like the owner marker's, and it is not claimed as one.

## 3. Branch deletion in `prune-run`

`git.mjs` gains `deleteBranch(name)` — `git branch -D --end-of-options <name>`, verified
supported on the git this repo targets.

In `prune-run`, after a worktree removal **succeeds**, the branch it held is deleted only when
`isAncestor(branch, runBranch)` proves every commit on it is already in the deliverable.
Anything else is left in place and reported by name with that reason, like every other refusal
in that command. `-d` alone is not enough: its notion of "merged" is relative to whatever the
main worktree has checked out, which is not the run branch whenever the operator has wandered.

Ordering is load-bearing — a branch checked out in a live worktree cannot be deleted, so the
removal has to land first. The dry run lists what it would delete, on the same terms as the
worktrees.

## 4. Cleanup in the flows

Skills only; no new code path.

- `parallel-execution` gains a numbered **step 5, Clean up**, calling `prune-run` after the
  phase's PASS. The Worktree mechanics section stays where it is, as reference.
- `finishing-a-development-branch`'s hand-rolled worktree section is replaced by the same call,
  and the two sentences at `:71` and `:82` that presume branch deletion become true once part 3
  lands.
- `README.md`'s `prune-run` line gains the branch clause.

Per CONTRIBUTING, a change to what a skill promises needs a contract test pinning the new claim,
and every guarantee states its limit in the same breath.

## 5. `.teammates/` growth

Documented, not swept. Run directories are kept deliberately: `resume` and `rebuild-state` read
them, they are gitignored, and they are the operator's to delete. No age-based reaper — it would
delete the only record of a run someone is in the middle of resuming, which is a worse failure
than a directory nobody removed.

## Tests

Each pinned by mutation, per CONTRIBUTING — break the thing, watch it fail, restore it.

`tests/gate-runner.test.mjs`

- A check whose command backgrounds a grandchild: after the timeout, **both** pids are gone.
  Mutation: drop `detached` and kill the bare pid — the grandchild survives and the test fails.
- A timed-out check reports `fail`, its output tail, and the timeout reason. It is never `pass`
  and never `skip`.
- `timeoutMs` accepted as a positive integer; rejected as a string, zero, negative, `NaN`, and
  above the ceiling — each landing as a `fail` naming its manifest position, not the default.
- The claim file exists while an injected `exec` holds `onSpawn`, and is gone after it returns —
  including when the check throws.

`tests/cli.test.mjs`

- A preview whose owner pid is dead but which carries a claim file naming a live pid is **not**
  reaped, and is reported as owned.
- All-dead claims plus a dead owner: reaped, as today.
- An unreadable claim file, and a failing `readdir`, both read as live.

`tests/prune.test.mjs` / `tests/cli.test.mjs`

- A branch that is an ancestor of the run branch is deleted after its worktree is removed.
- One that is not is left alone and named, with the ancestry as the stated reason.
- The dry run deletes nothing.

`tests/skill-contracts.test.mjs` — the new cleanup step in `parallel-execution`.
`tests/skill-finishing-branch.test.mjs` — the replaced worktree section in
`finishing-a-development-branch`. Both through the helpers in `tests/md-contract.mjs`, whose
header documents what they can and cannot detect.

## Files touched

    scripts/gate-runner.mjs    timeout, process group, timeoutMs validation, claim files
    scripts/merge-preview.mjs  claim-file path helper alongside previewOwnerMarkerPath
    scripts/cli.mjs            livePreviewPaths reads claims; prune-run deletes branches
    scripts/git.mjs            deleteBranch
    skills/parallel-execution/SKILL.md
    skills/finishing-a-development-branch/SKILL.md
    README.md
    tests/gate-runner.test.mjs, tests/cli.test.mjs, tests/prune.test.mjs,
    tests/skill-contracts.test.mjs, tests/skill-finishing-branch.test.mjs

## Operational note

The plugin runs from its cache snapshot, so none of this takes effect for a live fleet until
`claude plugin update` and a restart.
