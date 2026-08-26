# Purge and teardown

Implements `docs/specs/2026-08-26-purge-and-teardown-design.md`.

## Global Constraints

- Node >= 24.2.0
- Zero dependencies, runtime and dev both; tests use the built-in `node:test` runner
- `npm test` must stay green — 683 passing, 0 failing before this plan; every task adds to that
- Commit messages: single-line, commitlint style, English
- Every new test is verified by mutation: break the thing it covers, watch it fail, restore it
- A guarantee stated in a skill or a code comment states its limit in the same breath

## Destination

When a run ends, nothing it started is still running and nothing it created is still on disk —
and every removal rests on evidence that nothing needs the thing, never on the absence of
evidence that something does.

## Out of Scope

- Sweeping `.teammates/<run-id>/` on an age or size rule — `resume` and `rebuild-state` read
  those directories, so a reaper would delete the only record of a run someone is mid-resume on
- Killing a teammate's own agent processes — this plan bounds what the *gate* spawns; a
  teammate's lifecycle is `fleet-lifecycle`'s `stop`, which already exists
- Replacing the pid-based liveness model with a lock manager — pid recycling is a stated
  residual of the existing design and this plan neither widens nor closes it

## Not Yet Specified

- Should a timed-out command check be retryable by the fix loop, or is a timeout always a
  configuration fault the operator must resolve?
- Does `doctor` want to report leaked claim files whose pid is dead, the way it reports
  worktrees the operator never created?

---

### Task 1: bound a command check with a process-group kill

**Files:**
- Modify: `scripts/gate-runner.mjs`
- Test: `tests/gate-runner.test.mjs`

- [ ] **Step 1:** Add the imports and module constants at the top of `scripts/gate-runner.mjs`,
      directly under the existing `import { spawn } from 'node:child_process'`:

      // 15 minutes. A command check is the project's own suite, so the default has to clear a
      // slow one on a cold cache; what it exists to stop is the check that never returns at all.
      export const COMMAND_TIMEOUT_MS = 15 * 60_000

      // Between SIGTERM and SIGKILL. A suite that traps SIGTERM to write a coverage report gets
      // to finish; one that ignores it does not get to outlive the gate.
      const KILL_GRACE_MS = 5_000

- [ ] **Step 2:** Add the group-kill helper below the constants:

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
        try {
          process.kill(-pid, signal)
        } catch {
          // ESRCH: the group is already gone, which is the outcome this wanted.
        }
      }

- [ ] **Step 3:** Add the exit sweep below `killGroup`:

      // Groups still running, so a Ctrl-C does not leave a suite behind.
      //
      // SIGKILL is deliberately absent and cannot be added: it is untrappable, and the
      // 120-second caller kill that orphans a suite inside a merge preview is exactly a SIGKILL.
      // Nothing in this file can cover that case. What covers it is the claim file in Task 4,
      // which the orphan holds itself instead of depending on its parent surviving.
      const liveGroups = new Set()
      let teardownInstalled = false

      function installTeardown() {
        if (teardownInstalled) return
        teardownInstalled = true
        const sweep = () => { for (const pid of liveGroups) killGroup(pid, 'SIGKILL') }
        process.once('exit', sweep)
        // Installing a handler displaces node's default disposition, so each one exits itself
        // with the conventional 128 + signal code rather than leaving the process running.
        process.once('SIGINT', () => { sweep(); process.exit(130) })
        process.once('SIGTERM', () => { sweep(); process.exit(143) })
      }

- [ ] **Step 4:** Replace the whole body of `defaultExec` with the bounded version. `onSpawn` has
      no caller until Task 4; it is introduced here because the pid is only visible at the spawn
      site:

      export function defaultExec(cmd, cwd, { timeoutMs = COMMAND_TIMEOUT_MS, onSpawn = null } = {}) {
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
          let grace = null
          const timer = setTimeout(() => {
            timedOut = true
            killGroup(child.pid, 'SIGTERM')
            grace = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS)
          }, timeoutMs)
          const done = () => {
            clearTimeout(timer)
            clearTimeout(grace)
            liveGroups.delete(child.pid)
          }
          if (child.pid !== undefined) {
            liveGroups.add(child.pid)
            // Called synchronously, before this promise can yield, so a holder registered here is
            // registered before anything can observe the process it names. A throw propagates:
            // a claim that cannot be written must not read as a check that ran unclaimed.
            if (onSpawn) onSpawn(child.pid)
          }
          child.stdout.on('data', (d) => { output += d })
          child.stderr.on('data', (d) => { output += d })
          child.on('error', (err) => {
            done()
            if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL')
            reject(err)
          })
          child.on('close', (code) => {
            done()
            if (!timedOut) { resolve({ code: code ?? 1, output }); return }
            // A killed child reports code null, which `?? 1` turns into the failure this is.
            const seconds = Math.round(timeoutMs / 1000)
            resolve({
              code: code ?? 1,
              output: `${output}\n— timed out after ${seconds}s; its process group was killed`,
            })
          })
        })
      }

- [ ] **Step 5:** Add to `tests/gate-runner.test.mjs`:

      test('a timed-out command check kills the whole process group, not just the shell', async () => {
        const alive = (pid) => { try { process.kill(Number(pid), 0); return true } catch { return false } }
        const { code, output } = await defaultExec('sleep 30 & echo GRANDCHILD=$!; wait', process.cwd(), { timeoutMs: 300 })
        const pid = /GRANDCHILD=(\d+)/.exec(output)?.[1]
        assert.ok(pid, `the command did not report its grandchild pid: ${JSON.stringify(output)}`)
        // The grace timer is 5s; poll rather than sleeping a fixed interval.
        for (let i = 0; i < 60 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 100))
        assert.equal(alive(pid), false, 'the grandchild outlived the timeout, so only the shell was killed')
        assert.notEqual(code, 0)
        assert.match(output, /timed out after 0s; its process group was killed/)
      })

      Mutation: drop `detached` from `defaultExec` and kill `child.pid` instead of `-child.pid` —
      the grandchild survives and this fails. Skip the test on win32 with
      `{ skip: process.platform === 'win32' && 'POSIX process groups' }`, since the command text
      is a POSIX shell line.

- [ ] **Step 6:** Add to `tests/gate-runner.test.mjs`:

      test('a timed-out command check is a fail carrying its reason, never a pass', async () => {
        const result = await runCommandCheck(
          { name: 'slow', kind: 'command', run: 'irrelevant' },
          { cwd: process.cwd(), exec: async () => ({ code: 1, output: 'partial\n— timed out after 900s; its process group was killed' }) },
        )
        assert.equal(result.status, 'fail')
        assert.match(result.output, /timed out after 900s/)
      })

- [ ] **Step 7:** Add to `tests/gate-runner.test.mjs`:

      test('defaultExec hands the spawned pid to onSpawn before the promise resolves', async () => {
        const seen = []
        const { code } = await defaultExec('exit 0', process.cwd(), { onSpawn: (pid) => seen.push(pid) })
        assert.equal(code, 0)
        assert.equal(seen.length, 1)
        assert.ok(Number.isInteger(seen[0]) && seen[0] > 0, `expected a pid, got ${seen[0]}`)
      })

---

### Task 2: validate a per-check `timeoutMs` off the manifest

**Files:**
- Modify: `scripts/gate-runner.mjs`
- Test: `tests/gate-runner.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Add the ceiling and the fault diagnosis to `scripts/gate-runner.mjs`, directly
      below `malformedKindResult`:

      // 60 minutes. A manifest may lower the default; it may not raise it past here.
      const TIMEOUT_CEILING_MS = 60 * 60_000

      // `timeoutMs` is read off an entry of a file any teammate can write, and `validateGate` in
      // scripts/config.mjs checks only that `phases[*].checks` is an ARRAY — the same hole
      // `hasUsableKind` exists to plug, so this takes the same answer: diagnose the entry and
      // fail it. It must never fall back to the default, because a silent fallback is exactly
      // how an edit that disables the bound would look like a bound that held.
      export function timeoutFault(check) {
        const value = check?.timeoutMs
        if (value === undefined) return null
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          return `timeoutMs must be a positive integer of milliseconds, got ${JSON.stringify(value)}`
        }
        if (value > TIMEOUT_CEILING_MS) {
          return `timeoutMs must not exceed ${TIMEOUT_CEILING_MS} (60 minutes), got ${value}`
        }
        return null
      }

      // Built through `checkResult` for the same reason `malformedKindResult` is: `optional` is
      // decided in one place, so a `{"timeoutMs": 0, "optional": true}` entry cannot fail and be
      // waved through at once.
      function malformedTimeoutResult(check, index, fault) {
        const position = `entry #${index} in this phase's check list`
        return checkResult(check, 'fail', `${fault} (${position})`)
      }

- [ ] **Step 2:** In `runCheckList`, immediately after the `if (!hasUsableKind(check))` block and
      **before** the merge-conflict skip, add:

          // Before the conflict skip on purpose: a malformed bound is a configuration fault, and a
          // phase that does not merge is exactly where it would otherwise go unreported until the
          // conflict was fixed and the check finally ran.
          if (check.kind === 'command') {
            const fault = timeoutFault(check)
            if (fault) { results.push(malformedTimeoutResult(check, manifestPosition(ctx, index), fault)); continue }
          }

- [ ] **Step 3:** In `runCommandCheck`, resolve the bound and pass it through. Replace the
      signature and the first line of the body:

      export async function runCommandCheck(check, { cwd = process.cwd(), exec = defaultExec } = {}) {
        // `runCheckList` refuses a faulty bound before reaching here, so this guards the EXPORTED
        // api — `runChecks` is called directly from cli.mjs and from tests, and a programmatic
        // caller can pass a shape the manifest path already rejected. Throwing lands as
        // `check threw:` in the list, which is a stated failure rather than a default applied
        // behind the caller's back.
        const fault = timeoutFault(check)
        if (fault) throw new Error(fault)
        const { code, output } = await exec(check.run, cwd, { timeoutMs: check.timeoutMs ?? COMMAND_TIMEOUT_MS })

- [ ] **Step 4:** Add to `tests/gate-runner.test.mjs`:

      test('a command check may lower its own timeout', async () => {
        let seen = null
        await runCommandCheck(
          { name: 'quick', kind: 'command', run: 'true', timeoutMs: 1000 },
          { cwd: process.cwd(), exec: async (_cmd, _cwd, opts) => { seen = opts; return { code: 0, output: '' } } },
        )
        assert.equal(seen.timeoutMs, 1000)
      })

      test('a command check with no timeoutMs gets the default', async () => {
        let seen = null
        await runCommandCheck(
          { name: 'quick', kind: 'command', run: 'true' },
          { cwd: process.cwd(), exec: async (_cmd, _cwd, opts) => { seen = opts; return { code: 0, output: '' } } },
        )
        assert.equal(seen.timeoutMs, COMMAND_TIMEOUT_MS)
      })

- [ ] **Step 5:** Add to `tests/gate-runner.test.mjs`, driving every rejected shape through
      `runChecks` so the manifest path is what is pinned:

      test('a malformed timeoutMs fails its entry and never falls back to the default', async () => {
        for (const bad of ['600000', 0, -1, 1.5, null, true, 60 * 60_000 + 1]) {
          const results = await runChecks(
            [{ name: 'test', kind: 'command', run: 'true', timeoutMs: bad }],
            { cwd: process.cwd(), solo: true, exec: async () => { throw new Error('the check must not run') } },
          )
          assert.equal(results[0].status, 'fail', `timeoutMs ${JSON.stringify(bad)} should not have run`)
          assert.match(results[0].output, /timeoutMs must (?:be a positive integer|not exceed)/)
          assert.match(results[0].output, /entry #0 in this phase's check list/)
        }
      })

      test('a malformed timeoutMs cannot be waved through with optional: true', async () => {
        const results = await runChecks(
          [{ name: 'test', kind: 'command', run: 'true', timeoutMs: 0, optional: true }],
          { cwd: process.cwd(), solo: true },
        )
        assert.equal(aggregateVerdict(results).verdict, 'FAIL')
      })

      Mutation for both: make `timeoutFault` return `null` unconditionally — the first test fails
      on the status, the second on the verdict.

---

### Task 3: give a preview a claim-file path per holder

**Files:**
- Modify: `scripts/merge-preview.mjs`
- Test: `tests/merge-preview.test.mjs`

- [ ] **Step 1:** Add below `previewOwnerMarkerPath` in `scripts/merge-preview.mjs`:

      // A CLAIM is the second kind of holder a preview can have, and it exists because the first
      // kind does not survive its own death.
      //
      // The owner marker answers "which gate created this". A claim answers "is anything still
      // RUNNING in it" — and those come apart exactly when it matters: a SIGKILLed gate runs no
      // `finally`, so its marker survives naming a pid nobody is at, while the suite it spawned
      // is still writing to the tree. Reading the marker alone, the reaper sees an abandoned
      // preview and force-removes it under a live process.
      //
      // ONE FILE PER HOLDER, never one file listing them. A shared file would need
      // read-modify-write to release a holder, and two holders releasing at once is a lost
      // update — the outcome of which is a claim that outlives every process it names, i.e. a
      // preview nothing will ever reap.
      //
      // Named off the owner marker so a claim sorts next to what it claims, and so the reaper
      // derives both from the one thing the two sides share: the preview path git reports.
      export function previewClaimPath(dir, pid) {
        return `${previewOwnerMarkerPath(dir)}.${pid}`
      }

      // What a directory listing has to start with to be a claim on `dir`. The trailing dot is
      // load-bearing: without it this prefix also matches the owner marker itself, and a preview
      // whose owner is dead would be read as holding a live claim by that same dead pid.
      export function previewClaimPrefix(dir) {
        return `${path.basename(previewOwnerMarkerPath(dir))}.`
      }

- [ ] **Step 2:** Add to `tests/merge-preview.test.mjs`:

      test('a claim path is the owner marker plus the pid, and the prefix excludes the marker', () => {
        const dir = path.join(tmpdir(), 'tm-preview-abc123')
        const owner = previewOwnerMarkerPath(dir)
        assert.equal(previewClaimPath(dir, 4242), `${owner}.4242`)
        const prefix = previewClaimPrefix(dir)
        assert.ok(path.basename(previewClaimPath(dir, 4242)).startsWith(prefix))
        assert.equal(path.basename(owner).startsWith(prefix), false)
      })

      Mutation: drop the trailing dot from `previewClaimPrefix` — the last assertion fails.

      Add `previewClaimPath` and `previewClaimPrefix` to the import list at the top of the file,
      and `path` / `tmpdir` if they are not already imported there.

---

### Task 4: hold a claim for as long as a check is running

**Files:**
- Modify: `scripts/gate-runner.mjs`
- Test: `tests/gate-runner.test.mjs`

**Depends:** T1, T2, T3

- [ ] **Step 1:** Extend the imports at the top of `scripts/gate-runner.mjs`:

      import { writeFileSync, unlinkSync } from 'node:fs'
      import { withMergePreview, conflictPairs, previewClaimPath } from './merge-preview.mjs'

      Synchronous on purpose, and the only sync filesystem calls in this file: `onSpawn` is called
      from inside the spawn site before the promise yields, so the claim has to be on disk by the
      time that call returns. An `await` there would put the claim behind an event-loop turn the
      spawned process is already running in.

- [ ] **Step 2:** In `runCommandCheck`, accept the preview directory, hold a claim per spawned
      pid, and release in a `finally`. The full body after Task 2's guard:

      export async function runCommandCheck(check, { cwd = process.cwd(), previewDir = null, exec = defaultExec } = {}) {
        const fault = timeoutFault(check)
        if (fault) throw new Error(fault)
        const claims = []
        // No preview means no claim to hold: a solo run's checks stand in the repository itself,
        // and a claim file written next to it would be litter naming nothing the reaper reads.
        const onSpawn = previewDir === null ? null : (pid) => {
          const claim = previewClaimPath(previewDir, pid)
          writeFileSync(claim, `${pid}\n`, 'utf8')
          claims.push(claim)
        }
        try {
          const { code, output } = await exec(check.run, cwd, { timeoutMs: check.timeoutMs ?? COMMAND_TIMEOUT_MS, onSpawn })
          const passed = code === 0
          return {
            name: check.name,
            kind: 'command',
            status: passed ? 'pass' : 'fail',
            exitCode: code,
            output: passed ? '' : tail(output, TAIL_LINES),
            optional: check.optional === true,
          }
        } finally {
          // Released whatever happened, including a throw. A claim left behind by a check that
          // returned normally is worse than no claim at all: it keeps a preview unreapable until
          // its pid is recycled.
          for (const claim of claims) {
            try { unlinkSync(claim) } catch { /* already gone */ }
          }
        }
      }

- [ ] **Step 3:** Thread the preview directory through `runCheckList`. Change its signature to:

      async function runCheckList(checks, ctx, commandCwd, mergeConflicted, previewDir = null) {

      and the runner dispatch line inside it to:

          results.push(await runner(check, check.kind === 'command' ? { ...ctx, cwd: commandCwd, previewDir } : ctx))

- [ ] **Step 4:** In `runChecks`, pass the preview directory on the clean-merge path only. Replace
      the clean-merge return inside the `withMergePreview` callback with:

              // `path` is the preview, or null when the phase had no branches to merge and the
              // checks stand in the run branch's own tree — which is not a preview and holds no
              // claim. Passed explicitly rather than inferred from the cwd: an explicit null is
              // the difference between "not previewing" and "previewing somewhere this code
              // failed to recognise".
              return [merged, ...await runCheckList(checks, ctx, path ?? ctx.cwd, false, path)]

      Leave the two conflicted call sites — inside the callback's `conflict` branch and in
      `previewFailure` — exactly as they are: they skip every command check, so no process is
      spawned and there is nothing to claim.

- [ ] **Step 5:** Add to `tests/gate-runner.test.mjs`:

      test('a command check holds a claim on the preview while it runs and releases it after', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'tm-preview-'))
        let duringRun = null
        const result = await runCommandCheck(
          { name: 'test', kind: 'command', run: 'true' },
          {
            cwd: dir,
            previewDir: dir,
            exec: async (_cmd, _cwd, { onSpawn }) => {
              onSpawn(999999)
              duringRun = existsSync(previewClaimPath(dir, 999999))
              return { code: 0, output: '' }
            },
          },
        )
        assert.equal(result.status, 'pass')
        assert.equal(duringRun, true, 'the claim must exist while the check is running')
        assert.equal(existsSync(previewClaimPath(dir, 999999)), false, 'the claim must be released')
        await rm(dir, { recursive: true, force: true })
      })

      test('a claim is released even when the check throws', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'tm-preview-'))
        await assert.rejects(runCommandCheck(
          { name: 'test', kind: 'command', run: 'true' },
          {
            cwd: dir,
            previewDir: dir,
            exec: async (_cmd, _cwd, { onSpawn }) => { onSpawn(999998); throw new Error('boom') },
          },
        ))
        assert.equal(existsSync(previewClaimPath(dir, 999998)), false)
        await rm(dir, { recursive: true, force: true })
      })

      test('a check outside a preview writes no claim', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'tm-solo-'))
        let handed
        await runCommandCheck(
          { name: 'test', kind: 'command', run: 'true' },
          { cwd: dir, exec: async (_cmd, _cwd, opts) => { handed = opts.onSpawn; return { code: 0, output: '' } } },
        )
        assert.equal(handed, null)
        await rm(dir, { recursive: true, force: true })
      })

      Mutation: move the `unlinkSync` loop out of the `finally` and into the success path — the
      throwing test fails.

---

### Task 5: read claim files when deciding whether a preview is live

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T3

- [ ] **Step 1:** Extend the imports in `scripts/cli.mjs`:

      import { previewOwnerMarkerPath, previewClaimPrefix } from './merge-preview.mjs'

      and make sure `readdir` from `node:fs/promises` and `path` from `node:path` are imported;
      add whichever is missing.

- [ ] **Step 2:** Replace the body of `livePreviewPaths` with the version that reads both kinds of
      holder. The injectable `list` is there for the same reason `read` and `probe` are: a failing
      `readdir` is on the destructive path and has to be pinned on its own.

      export async function livePreviewPaths(previewPaths, {
        read = (p) => readFile(p, 'utf8'),
        list = (dir) => readdir(dir),
        // Signal 0 sends nothing: it only asks whether the pid can be signalled at all.
        probe = (pid) => process.kill(pid, 0),
      } = {}) {
        const live = new Set()
        // One listing per parent directory, reused across every candidate under it. `null` is
        // recorded for a listing that FAILED, which is not the same as an empty one.
        const listings = new Map()
        const listingFor = async (dir) => {
          if (!listings.has(dir)) {
            try { listings.set(dir, await list(dir)) } catch { listings.set(dir, null) }
          }
          return listings.get(dir)
        }

        for (const dir of previewPaths) {
          // Every holder's marker contents, and whether anything about them is UNKNOWN. The rule
          // the whole reaper rests on is unchanged and now applies to both kinds: only ENOENT and
          // ESRCH — the two answers that positively mean "no owner" — let a preview through.
          const holders = []
          let unknown = false
          try {
            holders.push(await read(previewOwnerMarkerPath(dir)))
          } catch (err) {
            if (err?.code !== 'ENOENT') unknown = true
          }
          const parent = path.dirname(dir)
          const names = await listingFor(parent)
          if (names === null) {
            // The directory could not be listed, so whether a claim exists is unknown, so the
            // preview is live. An unreaped preview costs a directory; a followed junction costs
            // the repository's build inputs.
            unknown = true
          } else {
            const prefix = previewClaimPrefix(dir)
            for (const name of names) {
              if (!name.startsWith(prefix)) continue
              try {
                holders.push(await read(path.join(parent, name)))
              } catch (err) {
                // A claim released between the listing and this read is ENOENT and means exactly
                // what it says. Anything else leaves that holder unknown.
                if (err?.code !== 'ENOENT') unknown = true
              }
            }
          }
          if (unknown) { live.add(dir); continue }
          for (const raw of holders) {
            const pid = Number.parseInt(String(raw).trim(), 10)
            if (!Number.isInteger(pid) || pid <= 0) { live.add(dir); break }
            try {
              probe(pid)
              live.add(dir)
              break
            } catch (err) {
              if (err?.code !== 'ESRCH') { live.add(dir); break }
            }
          }
        }
        return live
      }

- [ ] **Step 3:** Add to `tests/cli.test.mjs`:

      test('a preview whose owner is dead but whose claim is live is not reaped', async () => {
        const dir = path.join(tmpdir(), 'tm-preview-live')
        const live = await livePreviewPaths([dir], {
          read: async (p) => (p.endsWith('.4242') ? '4242\n' : '999999\n'),
          list: async () => [path.basename(previewOwnerMarkerPath(dir)), `${path.basename(previewOwnerMarkerPath(dir))}.4242`],
          probe: (pid) => { if (pid !== 4242) { const e = new Error('no such process'); e.code = 'ESRCH'; throw e } },
        })
        assert.equal(live.has(dir), true)
      })

      test('a preview whose owner and every claim are dead is reaped', async () => {
        const dir = path.join(tmpdir(), 'tm-preview-dead')
        const live = await livePreviewPaths([dir], {
          read: async () => '999999\n',
          list: async () => [path.basename(previewOwnerMarkerPath(dir)), `${path.basename(previewOwnerMarkerPath(dir))}.999998`],
          probe: () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e },
        })
        assert.equal(live.has(dir), false)
      })

      test('an unreadable claim file leaves the preview live', async () => {
        const dir = path.join(tmpdir(), 'tm-preview-eacces')
        const live = await livePreviewPaths([dir], {
          read: async (p) => {
            if (!p.endsWith('.4242')) { const e = new Error('no such file'); e.code = 'ENOENT'; throw e }
            const e = new Error('permission denied'); e.code = 'EACCES'; throw e
          },
          list: async () => [`${path.basename(previewOwnerMarkerPath(dir))}.4242`],
          probe: () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e },
        })
        assert.equal(live.has(dir), true)
      })

      test('a listing that fails leaves the preview live', async () => {
        const dir = path.join(tmpdir(), 'tm-preview-list-fails')
        const live = await livePreviewPaths([dir], {
          read: async () => { const e = new Error('no such file'); e.code = 'ENOENT'; throw e },
          list: async () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e },
          probe: () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e },
        })
        assert.equal(live.has(dir), true)
      })

      Mutation for the first: make `listingFor` return `[]` unconditionally — no claim is found,
      the dead owner decides, and the preview is reaped. Mutation for the last: swallow the
      listing failure as an empty array instead of `null`.

      Import `previewOwnerMarkerPath` and `tmpdir` into the test file if they are not already
      there.

---

### Task 6: `git.deleteBranch`

**Files:**
- Modify: `scripts/git.mjs`
- Test: `tests/git.test.mjs`

- [ ] **Step 1:** Add to the accessor returned by `createGit`, directly below `removeWorktree`:

          // -D, not -d. `-d` measures "merged" against whatever HEAD the caller's worktree has
          // checked out, which is not the run branch whenever the operator has wandered onto
          // another branch — so it refuses branches that ARE merged and accepts branches that are
          // not, depending on where the caller happens to stand. The proof belongs to the caller
          // (`isAncestor` against the run branch) and this deletes what the caller proved.
          //
          // No `qualifyBranch` here, deliberately: `git branch -D` resolves its argument in
          // refs/heads only, so the tag-precedence hazard that helper exists for cannot apply.
          async deleteBranch(name) {
            if (!isNonEmptyString(name)) {
              throw new GitError(`deleteBranch requires a non-empty branch name, got ${JSON.stringify(name)}`)
            }
            await run(['branch', '-D', '--end-of-options', name])
            return true
          },

- [ ] **Step 2:** Add to `tests/git.test.mjs`:

      test('deleteBranch removes a branch and reports a name that is not there', async () => {
        const repo = await tempRepo()
        const git = createGit({ cwd: repo })
        await git.deleteBranch('scratch')
        assert.equal(await git.branchExists('scratch'), false)
        await assert.rejects(() => git.deleteBranch('scratch'), (err) => err instanceof GitError)
      })

      test('deleteBranch refuses an empty name without asking git', async () => {
        const git = createGit({ cwd: '.', exec: async () => { throw new Error('git must not be called') } })
        await assert.rejects(() => git.deleteBranch(''), (err) => err instanceof GitError)
      })

      Use whatever helper `tests/git.test.mjs` already has for building a temporary repository,
      and create the `scratch` branch through it before the first assertion. Mutation: drop the
      `isNonEmptyString` guard — the second test's rejection becomes a git failure, not a
      `GitError` raised before the call.

---

### Task 7: delete a pruned task's branch once it is provably merged

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T5, T6

- [ ] **Step 1:** In the `prune-run` handler, add a `continue` to the removal loop's catch so a
      worktree that could not be removed does not fall through to its branch, and add the deletion
      below it. Replace the whole `for (const w of plan.prunable)` loop with:

          for (const w of plan.prunable) {
            try {
              await git.removeWorktree(w.path)
              io.out(`removed ${w.path}`)
            } catch (err) {
              if (!(err instanceof GitError)) throw err
              failed += 1
              io.out(`could not remove ${w.path}: ${err.message}`)
              // Its branch is still checked out in a worktree git still knows about, so the
              // deletion below could not succeed anyway — and a branch whose worktree survived is
              // one an operator may still be looking at.
              continue
            }
            // The worktree is gone; its branch is scratch, but only once that is PROVED. A task
            // branch that is not an ancestor of the run branch carries commits that are in no
            // other ref, and `-D` would be the last thing that ever saw them. The refusal is
            // reported by name, like every other refusal this command makes.
            try {
              if (await git.isAncestor(w.branch, ctx.runBranch)) {
                await git.deleteBranch(w.branch)
                io.out(`deleted ${w.branch}`)
              } else {
                io.out(`left ${w.branch} in place: it is not an ancestor of ${printable(ctx.runBranch)}, so deleting it would drop commits that are in no other branch`)
              }
            } catch (err) {
              if (!(err instanceof GitError)) throw err
              failed += 1
              io.out(`could not delete ${w.branch}: ${err.message}`)
            }
          }

- [ ] **Step 2:** Update the dry-run line in the same handler so it states what `--yes` would do
      now, rather than describing only half of it:

          if (flags.yes !== true) {
            io.out('dry run: nothing was removed. Re-run with --yes to remove the worktrees listed as prunable and delete each one\'s branch where it is already an ancestor of the run branch.')
            return 0
          }

- [ ] **Step 3:** Add to `tests/cli.test.mjs`, following the shape of the existing
      `prune-run reports a leaked merge preview and removes it with --yes` test for repository
      setup:

      test('prune-run --yes deletes a pruned task branch that is merged into the run branch', async () => {
        // Build a run whose phase 1 passes, with T1's branch merged into the run branch.
        // After the command: the worktree is gone, and so is teammates/r1/T1.
        assert.match(io.text(), /deleted teammates\/r1\/T1/)
        assert.equal(await git.branchExists('teammates/r1/T1'), false)
      })

      test('prune-run --yes leaves an unmerged task branch in place and says why', async () => {
        // Same run, but T1's branch carries a commit the run branch does not.
        assert.match(io.text(), /left teammates\/r1\/T1 in place: it is not an ancestor of/)
        assert.equal(await git.branchExists('teammates/r1/T1'), true)
      })

      test('prune-run without --yes deletes no branch', async () => {
        assert.equal(await git.branchExists('teammates/r1/T1'), true)
        assert.doesNotMatch(io.text(), /deleted teammates/)
      })

      Fill each test's setup from the existing prune-run tests in the file — same run id, plan
      fixture and gate manifest they use. Mutation: replace the `isAncestor` call with `true` —
      the second test fails; remove the `flags.yes` guard's early return — the third fails.

---

### Task 8: give `parallel-execution` a cleanup step

**Files:**
- Modify: `skills/parallel-execution/SKILL.md`
- Test: `tests/skill-contracts.test.mjs`

**Depends:** T7

- [ ] **Step 1:** Add a new `## 5. Clean up the phase` section immediately after
      `## 4. Gate, then integrate` and before `### Import coupling across tasks` — which moves
      down with its parent section. The new section reads:

      ## 5. Clean up the phase

      Once the phase has a recorded PASS and its branches are merged, remove what it left:

          node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" prune-run --run <runId> --plan <planPath> --root <project root> --yes

      This is the only supported way to clean up after a phase. It recomputes each phase's gate
      rather than reading `status.gates`, removes only this run's worktrees whose phase passes,
      deletes each removed worktree's branch where `git merge-base --is-ancestor` proves it is
      already in the run branch, and names every worktree and branch it left alone with the
      reason. Do not remove a worktree or delete a teammate branch by hand: `git worktree remove`
      run from the wrong place takes a teammate's uncommitted work, and `git branch -D` measures
      "merged" against whatever branch you are standing on rather than against the run branch.

      Without `--yes` it removes nothing and prints the same plan, which is what to run when you
      only want to see what is outstanding.

- [ ] **Step 2:** Add to `tests/skill-contracts.test.mjs`, in the parallel-execution section of
      the file and following the `assertClaim` usage already there:

      test('parallel-execution makes prune-run the only supported cleanup', async () => {
        const doc = parseDoc(await readFile(new URL('parallel-execution/SKILL.md', dir), 'utf8'), 'parallel-execution')
        const cleanup = doc.section(/^5\. Clean up the phase$/)
        assertClaim(cleanup, {
          label: 'cleanup command',
          claim: /^This is the only supported way to clean up after a phase\.$/i,
          subject: /prune-run|by hand|git worktree remove|git branch -D/i,
          allow: [
            /^Do not remove a worktree or delete a teammate branch by hand: `git worktree remove` run from the wrong place takes a teammate's uncommitted work, and `git branch -D` measures "merged" against whatever branch you are standing on rather than against the run branch\.$/i,
            /^Without `--yes` it removes nothing and prints the same plan, which is what to run when you only want to see what is outstanding\.$/i,
          ],
        })
      })

      Use whatever section accessor `tests/skill-contracts.test.mjs` already uses on a `parseDoc`
      result; match its spelling rather than inventing one. Mutation: delete the "only supported
      way" sentence — the claim is not stated and the test fails.

---

### Task 9: replace the hand-rolled cleanup in `finishing-a-development-branch`

**Files:**
- Modify: `skills/finishing-a-development-branch/SKILL.md`
- Test: `tests/skill-finishing-branch.test.mjs`

**Depends:** T7

- [ ] **Step 1:** Replace the whole `## Worktree cleanup` section — from its heading through
      "If a worktree has uncommitted changes `remove` will refuse — look before forcing anything."
      — with:

      ## Worktree and branch cleanup

      A finished run leaves a worktree and a scratch branch per task. Remove both with the command
      that knows which phases passed:

          node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" prune-run --run <runId> --plan <planPath> --root <project root> --yes

      It touches only this run's worktrees, never the main worktree and never another run's, and
      it deletes a task branch only where `git merge-base --is-ancestor` proves the run branch
      already contains it. Everything it declines to remove is printed with the reason.

      Do not sweep by hand. `git worktree remove --force` follows a junction and deletes the
      contents of its target, and `git branch -D` measures "merged" against whatever branch you
      have checked out, which is not the run branch whenever you have moved off it.

      What this does not clean up: `.teammates/<run-id>/` stays on disk on purpose — `resume` and
      `rebuild-state` read it, and it is gitignored. Delete it yourself when you no longer want
      the record.

- [ ] **Step 2:** Update the branch taxonomy sentence at the top of the "Branch taxonomy" section
      so it names what now does the deleting. Replace:

      "and that branch is disposable the moment it merges into the run branch."

      with:

      "and that branch is deleted by `prune-run` once the run branch provably contains it."

- [ ] **Step 3:** In `tests/skill-finishing-branch.test.mjs`, replace the existing
      `covers cleaning up teammate worktrees` test with:

      test('routes worktree and branch cleanup through prune-run rather than by hand', async () => {
        const b = await body()
        assert.match(b, /prune-run --run/)
        assert.match(b, /Do not sweep by hand/)
        assert.match(b, /merge-base --is-ancestor/)
      })

      test('says .teammates is kept deliberately and is the operator\'s to delete', async () => {
        const b = await body()
        assert.match(b, /\.teammates\/<run-id>\/ stays on disk on purpose/)
        assert.match(b, /rebuild-state/)
      })

      Mutation: delete the "Do not sweep by hand" paragraph — the first test fails.

---

### Task 10: state the retention rule and the branch clause in the README

**Files:**
- Modify: `README.md`
- Test: `tests/packaging.test.mjs`

**Model:** cheap

- [ ] **Step 1:** In the Housekeeping list, replace the `prune-run` entry with:

      - `prune-run --run <id> --plan <path>` — remove this run's worktrees, but only where the phase's gate
        recomputes to PASS, and delete each removed worktree's branch where the run branch already
        contains it. Dry run unless `--yes`

- [ ] **Step 2:** Add a new entry directly below the `rebuild-state` entry in the same list:

      - `.teammates/<run-id>/` is never removed by any command. `resume` and `rebuild-state` read it,
        it is gitignored, and deleting it is the operator's call — an age-based sweep would take the
        only record of a run someone is in the middle of resuming

- [ ] **Step 3:** Add to `tests/packaging.test.mjs`:

      test('the README states that run state is never swept automatically', async () => {
        const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
        assert.match(readme, /`\.teammates\/<run-id>\/` is never removed by any command/)
        assert.match(readme, /delete each removed worktree's branch where the run branch already/)
      })

      Use the file's existing README-reading helper if it has one. Mutation: remove either
      sentence from the README — the test fails.
