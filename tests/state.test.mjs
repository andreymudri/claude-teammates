import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
// Spawned inside a test body, never at module load, and never bash: `fsutil` is the only way to
// create a deterministic 8.3 short name on a volume where auto-generation is disabled.
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  runDir,
  readState,
  writeState,
  claimTask,
  releaseClaim,
  readFixRounds,
  recordFixRound,
  normaliseWorktree,
  isLocalAbsolute,
  worktreeKey,
  writeLocation,
  findTaskByWorktree,
} from '../scripts/state.mjs'

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-'))
  try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('runDir places state under .teammates/<runId>', () => {
  assert.equal(runDir('/repo', 'abc'), path.join('/repo', '.teammates', 'abc'))
})

test('readState returns null when the file does not exist', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await readState(root, 'r1', 'plan'), null)
  })
})

test('writeState then readState round-trips', async () => {
  await withTempRoot(async (root) => {
    await writeState(root, 'r1', 'plan', { tasks: [{ id: 'T1' }] })
    assert.deepEqual(await readState(root, 'r1', 'plan'), { tasks: [{ id: 'T1' }] })
  })
})

test('writeState overwrites an existing file completely', async () => {
  await withTempRoot(async (root) => {
    await writeState(root, 'r1', 'status', { a: 1, b: 2 })
    await writeState(root, 'r1', 'status', { a: 9 })
    assert.deepEqual(await readState(root, 'r1', 'status'), { a: 9 })
  })
})

test('claimTask succeeds once and fails for a second claimant', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-a'), true)
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-b'), false)
  })
})

test('claimTask allows different tasks to be claimed independently', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-a'), true)
    assert.equal(await claimTask(root, 'r1', 'T2', 'impl-b'), true)
  })
})

test('releasing a claim then re-claiming the task succeeds', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-a'), true)
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-b'), false)
    await releaseClaim(root, 'r1', 'T1')
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-b'), true)
  })
})

test('releasing a nonexistent claim is not an error', async () => {
  await withTempRoot(async (root) => {
    await assert.doesNotReject(releaseClaim(root, 'r1', 'never-claimed'))
    assert.equal(await releaseClaim(root, 'r1', 'never-claimed'), true)
  })
})

test('concurrent claims on one task produce exactly one winner', async () => {
  await withTempRoot(async (root) => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimTask(root, 'r1', 'T1', `impl-${i}`)),
    )
    assert.equal(results.filter(Boolean).length, 1)
  })
})

/// Location records are addressed by the hash of their normalised worktree, so these tests are
// about one directory having several spellings — what git prints, what a hook payload carries,
// what a shell reports — all hashing to one key, and about a record being unable to answer for
// any directory but the one it is filed under.

const recordPath = (root, worktree) => path.join(root, '.teammates', 'index', `${worktreeKey(worktree)}.json`)

// Writes a record byte-for-byte, bypassing writeLocation, the way a teammate with a shell can.
async function plant(root, keyFor, contents) {
  const dir = path.join(root, '.teammates', 'index')
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${worktreeKey(keyFor)}.json`)
  await writeFile(target, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  return target
}

test('writeLocation files a record under the hash of its worktree', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const written = await writeLocation(root, 'r1', 'T1', { worktree, branch: 'teammates/r1/T1' })
    assert.equal(written, recordPath(root, worktree))
    assert.match(path.basename(written), /^[0-9a-f]{64}\.json$/)
    assert.deepEqual(JSON.parse(await readFile(written, 'utf8')), {
      runId: 'r1',
      taskId: 'T1',
      branch: 'teammates/r1/T1',
      worktree,
    })
    assert.deepEqual(await findTaskByWorktree(root, worktree), {
      runId: 'r1',
      taskId: 'T1',
      branch: 'teammates/r1/T1',
    })
  })
})

test('rewriting one worktree overwrites in place, and a second worktree gets its own record', async () => {
  await withTempRoot(async (root) => {
    const first = path.join(root, 'wt', 'agent-1')
    const second = path.join(root, 'wt', 'agent-2')
    await writeLocation(root, 'r1', 'T1', { worktree: first, branch: 'teammates/r1/T1' })
    // Same worktree, re-recorded: one file, updated.
    await assert.doesNotReject(writeLocation(root, 'r1', 'T2', { worktree: first, branch: 'teammates/r1/T2' }))
    assert.deepEqual(await findTaskByWorktree(root, first), {
      runId: 'r1',
      taskId: 'T2',
      branch: 'teammates/r1/T2',
    })
    // A respawn into a different worktree writes a different key. The old record survives and
    // still answers for the old directory — nothing deletes records, and nothing needs to,
    // because a stale record is only reachable by asking about the exact path it names.
    await writeLocation(root, 'r1', 'T2', { worktree: second, branch: 'teammates/r1/T2' })
    assert.equal((await findTaskByWorktree(root, second)).taskId, 'T2')
    assert.equal((await findTaskByWorktree(root, first)).taskId, 'T2')
    assert.notEqual(recordPath(root, first), recordPath(root, second))
  })
})

test('findTaskByWorktree matches a trailing separator against a record written without one', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    await writeLocation(root, 'r1', 'T7', { worktree, branch: 'teammates/r1/T7' })
    assert.deepEqual(await findTaskByWorktree(root, `${worktree}${path.sep}`), {
      runId: 'r1',
      taskId: 'T7',
      branch: 'teammates/r1/T7',
    })
  })
})

test('findTaskByWorktree on win32 matches across drive-letter case and separator style', {
  skip: process.platform !== 'win32' ? 'win32 only' : false,
}, async () => {
  await withTempRoot(async (root) => {
    const worktree = path.resolve(path.join(root, 'wt', 'agent-1'))
    const upper = worktree[0].toUpperCase() + worktree.slice(1)
    await writeLocation(root, 'r1', 'T4', { worktree: upper, branch: 'teammates/r1/T4' })
    const expected = { runId: 'r1', taskId: 'T4', branch: 'teammates/r1/T4' }
    assert.deepEqual(await findTaskByWorktree(root, upper.replace(/\\/g, '/')), expected)
    assert.deepEqual(await findTaskByWorktree(root, upper[0].toLowerCase() + upper.slice(1)), expected)
    assert.deepEqual(
      await findTaskByWorktree(root, `${upper[0].toLowerCase()}${upper.slice(1).replace(/\\/g, '/')}/`),
      expected,
    )
  })
})

test('normaliseWorktree collapses the spellings it compares and rejects non-strings', () => {
  assert.equal(normaliseWorktree(''), '')
  assert.equal(normaliseWorktree(null), '')
  assert.equal(normaliseWorktree(undefined), '')
  assert.equal(normaliseWorktree(42), '')
  const base = path.resolve(path.join('some', 'where'))
  assert.equal(normaliseWorktree(base), normaliseWorktree(`${base}${path.sep}`))
  if (process.platform === 'win32') {
    assert.equal(normaliseWorktree(base), normaliseWorktree(base.replace(/\\/g, '/')))
    assert.equal(normaliseWorktree(base), normaliseWorktree(base.toUpperCase()))
  }
})

test('worktreeKey is empty for a path it cannot name, and stable for one it can', () => {
  assert.equal(worktreeKey(''), '')
  assert.equal(worktreeKey(null), '')
  assert.equal(worktreeKey(undefined), '')
  const base = path.resolve(path.join('some', 'where'))
  assert.equal(worktreeKey(base), worktreeKey(`${base}${path.sep}`))
  assert.notEqual(worktreeKey(base), worktreeKey(path.join(base, 'else')))
  assert.match(worktreeKey(base), /^[0-9a-f]{64}$/)
})

test('findTaskByWorktree returns null for an unknown worktree and for an empty query', async () => {
  await withTempRoot(async (root) => {
    await writeLocation(root, 'r1', 'T1', {
      worktree: path.join(root, 'wt', 'agent-1'),
      branch: 'teammates/r1/T1',
    })
    assert.equal(await findTaskByWorktree(root, path.join(root, 'wt', 'nobody')), null)
    assert.equal(await findTaskByWorktree(root, ''), null)
    assert.equal(await findTaskByWorktree(root, undefined), null)
    assert.equal(await findTaskByWorktree(root, 42), null)
  })
})

test('findTaskByWorktree returns null when there is no index at all', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await findTaskByWorktree(root, path.join(root, 'wt', 'agent-1')), null)
  })
})

test('findTaskByWorktree returns null for a malformed record and does not throw', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    await plant(root, worktree, 'not json at all')
    await assert.doesNotReject(findTaskByWorktree(root, worktree))
    assert.equal(await findTaskByWorktree(root, worktree), null)
    // Rewriting it honestly makes it findable, so the skip was the content and nothing else.
    await writeLocation(root, 'r1', 'T3', { worktree, branch: 'teammates/r1/T3' })
    assert.deepEqual(await findTaskByWorktree(root, worktree), {
      runId: 'r1',
      taskId: 'T3',
      branch: 'teammates/r1/T3',
    })
  })
})

test('findTaskByWorktree reports a null branch for a record that carries none', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-4')
    await plant(root, worktree, { runId: 'r1', taskId: 'T5', worktree })
    assert.deepEqual(await findTaskByWorktree(root, worktree), {
      runId: 'r1',
      taskId: 'T5',
      branch: null,
    })
  })
})

// A taskId reaches writeLocation from `locate --task`, i.e. from the teammate. It is a single
// path segment and nothing else: the traversals below are the ones that do real damage.

test('writeLocation refuses a taskId that is not a single path segment', async () => {
  await withTempRoot(async (root) => {
    const args = { worktree: path.join(root, 'wt', 'agent-1'), branch: 'b' }
    for (const taskId of [
      '../claims/T5',
      '..\\claims\\T5',
      '../status',
      '../../../../escaped',
      'nested/T1',
      '..',
      // `.` used to write `..json`, whose stem equalled its own taskId; it is refused at the
      // writer for the same reason every other traversal is.
      '.',
      path.join(root, 'absolute'),
    ]) {
      await assert.rejects(
        writeLocation(root, 'r1', taskId, args),
        /escapes the run directory/,
        `taskId ${taskId} was not refused`,
      )
    }
    // Nothing was created anywhere: not the claim that would make T5 unclaimable forever,
    // not an overwritten status.json, not a file outside the run directory.
    assert.equal(await readState(root, 'r1', 'status'), null)
    assert.equal(await claimTask(root, 'r1', 'T5', 'impl-a'), true)
  })
})

test('writeLocation refuses a runId that climbs out of .teammates', async () => {
  await withTempRoot(async (root) => {
    const args = { worktree: path.join(root, 'wt', 'agent-1'), branch: 'b' }
    for (const runId of ['../..', '../escaped', 'nested/r1', '..', '.']) {
      await assert.rejects(writeLocation(root, runId, 'T1', args), /escapes the run directory/)
    }
  })
})

test('writeLocation refuses a worktree it cannot name', async () => {
  await withTempRoot(async (root) => {
    for (const worktree of ['', null, undefined, 42]) {
      await assert.rejects(
        writeLocation(root, 'r1', 'T1', { worktree, branch: 'b' }),
        /is not a path a record can name/,
      )
    }
  })
})

test('writeLocation still accepts an ordinary task and run id after the guard', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const written = await writeLocation(root, 'run-1_x', 'T10', { worktree, branch: 'b' })
    assert.equal(written, recordPath(root, worktree))
  })
})

test('findTaskByWorktree matches a worktree reached through a symlinked parent', async (t) => {
  await withTempRoot(async (root) => {
    const real = path.join(root, 'real', 'agent-1')
    await mkdir(real, { recursive: true })
    const link = path.join(root, 'linked')
    try {
      await symlink(path.join(root, 'real'), link, 'junction')
    } catch (err) {
      t.skip(`symlinks unavailable here: ${err.code}`)
      return
    }
    // Recorded as git prints it (the real path); queried as the harness reports it (through
    // the link). Both hash the resolved path, so both name one record.
    await writeLocation(root, 'r1', 'T1', { worktree: real, branch: 'teammates/r1/T1' })
    assert.deepEqual(await findTaskByWorktree(root, path.join(link, 'agent-1')), {
      runId: 'r1',
      taskId: 'T1',
      branch: 'teammates/r1/T1',
    })
    // And the other way round: recorded through the link, queried by the real path.
    await writeLocation(root, 'r1', 'T2', {
      worktree: path.join(link, 'agent-1'),
      branch: 'teammates/r1/T2',
    })
    assert.equal((await findTaskByWorktree(root, real)).taskId, 'T2')
  })
})

// TWO junctions to one target: recorded under one spelling, queried under the other, with the
// real path never used by either side. This is the case a conjunction of the lexical and
// resolved comparisons would break — the spellings differ, only the resolved forms agree.
test('findTaskByWorktree matches across two different links to one worktree', async (t) => {
  await withTempRoot(async (root) => {
    const real = path.join(root, 'real', 'agent-1')
    await mkdir(real, { recursive: true })
    const linkA = path.join(root, 'linked-a')
    const linkB = path.join(root, 'linked-b')
    try {
      await symlink(path.join(root, 'real'), linkA, 'junction')
      await symlink(path.join(root, 'real'), linkB, 'junction')
    } catch (err) {
      t.skip(`symlinks unavailable here: ${err.code}`)
      return
    }
    const spellingA = path.join(linkA, 'agent-1')
    const spellingB = path.join(linkB, 'agent-1')
    assert.notEqual(normaliseWorktree(spellingA, { resolveLinks: false }), normaliseWorktree(spellingB, { resolveLinks: false }))
    await writeLocation(root, 'r1', 'T1', { worktree: spellingA, branch: 'teammates/r1/T1' })
    assert.deepEqual(await findTaskByWorktree(root, spellingB), {
      runId: 'r1',
      taskId: 'T1',
      branch: 'teammates/r1/T1',
    })
  })
})

// The 8.3 spelling is the case plain realpathSync does NOT resolve: it returns `SHORTN~1`
// unchanged, while realpathSync.native expands it to the long name. Auto-generation of short
// names is off on many volumes, so the test sets one explicitly and skips when it cannot.
test('normaliseWorktree maps a Windows 8.3 short name onto its long spelling', {
  skip: process.platform !== 'win32' ? 'win32 only' : false,
}, async (t) => {
  await withTempRoot(async (root) => {
    const long = path.join(root, 'a very long worktree directory name')
    await mkdir(long, { recursive: true })
    const short = path.join(root, 'SHORTN~1')
    try {
      execFileSync('fsutil', ['file', 'setshortname', long, 'SHORTN~1'], { stdio: 'ignore' })
    } catch (err) {
      t.skip(`8.3 short names unavailable on this volume: ${err.code ?? err.message}`)
      return
    }
    assert.notEqual(short.toLowerCase(), long.toLowerCase())
    assert.equal(normaliseWorktree(short), normaliseWorktree(long))
    await writeLocation(root, 'r1', 'T1', { worktree: long, branch: 'teammates/r1/T1' })
    assert.deepEqual(await findTaskByWorktree(root, short), {
      runId: 'r1',
      taskId: 'T1',
      branch: 'teammates/r1/T1',
    })
  })
})

// The read side validates content, because content is what a teammate with a shell controls.
// The file NAME is now a hash of the worktree, so the binding it enforces is stronger than the
// old stem equality: a record must name the very directory whose key it is filed under.

test('findTaskByWorktree ignores a record filed under a key it does not name', async () => {
  await withTempRoot(async (root) => {
    const victim = path.join(root, 'wt', 'victim')
    const other = path.join(root, 'wt', 'somewhere-else')
    // Filed under the victim's key, but naming a different directory: the forgery a planted
    // record would need, and the one the key binding refuses.
    await plant(root, victim, { runId: 'r1', taskId: 'T1', branch: 'teammates/r1/T1', worktree: other })
    assert.equal(await findTaskByWorktree(root, victim), null)
    // Naming its own directory, it answers normally.
    await plant(root, victim, { runId: 'r1', taskId: 'T1', branch: 'teammates/r1/T1', worktree: victim })
    assert.deepEqual(await findTaskByWorktree(root, victim), {
      runId: 'r1',
      taskId: 'T1',
      branch: 'teammates/r1/T1',
    })
  })
})

test('findTaskByWorktree skips a record whose taskId is a traversal', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    for (const taskId of [
      '../../../escaped',
      '..\\..\\escaped',
      'nested/T1',
      '..',
      '.',
      '',
      path.join(root, 'absolute'),
      42,
      null,
      { id: 'T1' },
    ]) {
      await plant(root, worktree, { runId: 'r1', taskId, worktree, branch: 'b' })
      assert.equal(
        await findTaskByWorktree(root, worktree),
        null,
        `a record carrying taskId ${JSON.stringify(taskId)} was returned rather than skipped`,
      )
    }
  })
})

// A task id is spent as `complete --task <id>`. A segment check alone lets through ids that a
// parser reads as options, so the charset guard is what keeps `--force` out of an argv.
test('findTaskByWorktree skips a taskId that could be read as an option or is overlong', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    for (const taskId of ['--force', '-rf', '--', '-', 'T1 --force', 'a b', 'T1;rm', 'T1\n', 'x'.repeat(65)]) {
      await plant(root, worktree, { runId: 'r1', taskId, worktree, branch: 'b' })
      assert.equal(
        await findTaskByWorktree(root, worktree),
        null,
        `taskId ${JSON.stringify(taskId)} reached the caller`,
      )
    }
    // The ids a run actually uses still pass, so the guard is not merely refusing everything.
    for (const taskId of ['T1', 'T10', 'task_1', 'task.a', 'a-b', 'x'.repeat(64)]) {
      await plant(root, worktree, { runId: 'r1', taskId, worktree, branch: 'b' })
      assert.equal((await findTaskByWorktree(root, worktree)).taskId, taskId)
    }
  })
})

// runId used to be a directory name and could not lie. Under a keyed layout it comes from file
// content like everything else, so it is validated like everything else.
test('findTaskByWorktree skips a record whose runId is not a plain segment', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    for (const runId of ['../..', '../escaped', 'nested/r1', '..', '.', '', 42, null, { id: 'r1' }]) {
      await plant(root, worktree, { runId, taskId: 'T1', worktree, branch: 'b' })
      assert.equal(
        await findTaskByWorktree(root, worktree),
        null,
        `a record carrying runId ${JSON.stringify(runId)} was returned rather than skipped`,
      )
    }
  })
})

// `branch` is the field a forged record can carry while its ids and worktree are entirely
// honest, so nothing cross-checked above constrains it. A record may name exactly one branch.
test('findTaskByWorktree drops a branch the record could not legitimately name', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-2')
    for (const branch of [
      'teammates/r1/T5', // a rival task's ref: the hook would tell T2 to force-move it
      'master', // any existing ref: waves past a teammate that created no branch at all
      'refs/heads/teammates/r1/T2', // fully-qualified: not the name the run uses
      'teammates/r2/T2', // right task, wrong run
      'teammates/r1/T2 --force', // the right name with an argument stapled on
      42,
      null,
    ]) {
      await plant(root, worktree, { runId: 'r1', taskId: 'T2', worktree, branch })
      assert.deepEqual(
        await findTaskByWorktree(root, worktree),
        { runId: 'r1', taskId: 'T2', branch: null },
        `branch ${JSON.stringify(branch)} reached the caller`,
      )
    }
    // The one branch it may name survives untouched, so this narrows the field rather than
    // blanking it: a caller can still tell a recorded task branch from an absent one.
    await plant(root, worktree, { runId: 'r1', taskId: 'T2', worktree, branch: 'teammates/r1/T2' })
    assert.deepEqual(await findTaskByWorktree(root, worktree), {
      runId: 'r1',
      taskId: 'T2',
      branch: 'teammates/r1/T2',
    })
  })
})

// The classification itself, not the shape of its call site. Everything realpath must never see
// has to be rejected here, because this predicate is the only thing standing between a record's
// worktree and a synchronous network timeout inside the hook.
test('isLocalAbsolute accepts only plain local absolute paths', () => {
  for (const p of ['//unreachable-host/share/w', '\\\\host\\share\\w', 'relative/path', '.', '..', '', null, undefined, 42, {}]) {
    assert.equal(isLocalAbsolute(p), false, `${JSON.stringify(p)} was classified as local`)
  }
  assert.equal(isLocalAbsolute(process.platform === 'win32' ? 'C:/x' : '/x'), true)
  assert.equal(isLocalAbsolute(process.platform === 'win32' ? 'C:\\x' : '/x/y'), true)
  if (process.platform === 'win32') {
    assert.equal(isLocalAbsolute('z:\\mapped'), true) // the stated residual: a mapped drive passes
    assert.equal(isLocalAbsolute('C:relative'), false) // drive-relative is not absolute
  }
})

// A UNC path must never be realpath'd — an unreachable host blocks the event loop for tens of
// seconds — so a record naming one is refused before it can be resolved, and a worktree on a
// network share is simply not identifiable. The hook fails open there.
test('findTaskByWorktree does not match a record whose worktree is UNC', async () => {
  await withTempRoot(async (root) => {
    const unc = '\\\\nonexistent-host-for-tests\\share\\wt\\agent-1'
    await plant(root, unc, { runId: 'r1', taskId: 'T1', worktree: unc, branch: 'teammates/r1/T1' })
    assert.equal(await findTaskByWorktree(root, unc), null)
  })
})

// A worktree that is not reader-independent is a wildcard, not a location: `"."` resolves
// against whoever is reading. The hook runs in the session directory — the cwd a subagent that
// is NOT worktree-isolated reports, including this plugin's own read-only reviewer.
test('findTaskByWorktree ignores a record whose worktree is relative', async () => {
  await withTempRoot(async (root) => {
    for (const worktree of ['.', '', 'relative/path', './wt/agent-1', '..', '\\tm-probe-victim\\agent-1']) {
      // Filed under the key the reader's own cwd hashes to, which is the best case for such a
      // record: even then it must not answer.
      await plant(root, process.cwd(), { runId: 'r1', taskId: 'T1', worktree, branch: 'b' })
      assert.equal(
        await findTaskByWorktree(root, process.cwd()),
        null,
        `a record with worktree ${JSON.stringify(worktree)} matched the reader's own directory`,
      )
    }
  })
})

test('normaliseWorktree honours resolveLinks: false by leaving the link spelling alone', async (t) => {
  await withTempRoot(async (root) => {
    const real = path.join(root, 'real', 'agent-1')
    await mkdir(real, { recursive: true })
    const link = path.join(root, 'linked')
    try {
      await symlink(path.join(root, 'real'), link, 'junction')
    } catch (err) {
      t.skip(`symlinks unavailable here: ${err.code}`)
      return
    }
    const through = path.join(link, 'agent-1')
    // The option is the whole difference between touching the filesystem and not, so the two
    // results must differ: resolved collapses onto the real path, unresolved keeps the link.
    assert.notEqual(
      normaliseWorktree(through, { resolveLinks: false }),
      normaliseWorktree(through),
      'resolveLinks: false still resolved the link',
    )
    assert.equal(normaliseWorktree(through), normaliseWorktree(real))
  })
})

// `path.resolve('C:\\')` is `C:\`; stripping that separator leaves the drive-RELATIVE `C:`,
// which realpath expands to the process's cwd on that drive — so the record matches the reader.
test('normaliseWorktree keeps a filesystem root distinct from the current directory', async () => {
  await withTempRoot(async (root) => {
    const driveRoot = process.platform === 'win32' ? `${process.cwd().slice(0, 2)}\\` : '/'
    assert.notEqual(normaliseWorktree(driveRoot), normaliseWorktree(process.cwd()))
    assert.notEqual(worktreeKey(driveRoot), worktreeKey(process.cwd()))
    // And through the lookup: a record claiming the drive root must not answer a query for the
    // directory the reader happens to be standing in.
    await plant(root, driveRoot, { runId: 'r1', taskId: 'T1', worktree: driveRoot, branch: 'teammates/r1/T1' })
    assert.equal(await findTaskByWorktree(root, process.cwd()), null)
    assert.deepEqual(await findTaskByWorktree(root, driveRoot), {
      runId: 'r1',
      taskId: 'T1',
      branch: 'teammates/r1/T1',
    })
  })
})

test('findTaskByWorktree skips a record larger than the size cap', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    // Valid JSON and a perfectly honest record — only its size disqualifies it.
    await plant(root, worktree, {
      runId: 'r1', taskId: 'T1', branch: 'teammates/r1/T1', worktree, pad: 'x'.repeat(200_000),
    })
    assert.equal(await findTaskByWorktree(root, worktree), null)
    // Raising the cap for this call finds it, so the skip is the cap and not a parse failure.
    assert.deepEqual(await findTaskByWorktree(root, worktree, { maxRecordBytes: 1_000_000 }), {
      runId: 'r1',
      taskId: 'T1',
      branch: 'teammates/r1/T1',
    })
  })
})

test('findTaskByWorktree skips a record path that is not a regular file', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    // A directory named like a record. Note what this does NOT pin: on win32 the read would
    // fail anyway, so deleting the isFile() guard leaves this green. The FIFO test below is the
    // one that pins the guard, and it runs only on POSIX.
    await mkdir(recordPath(root, worktree), { recursive: true })
    await assert.doesNotReject(findTaskByWorktree(root, worktree))
    assert.equal(await findTaskByWorktree(root, worktree), null)
  })
})

// The vector isFile() actually exists for. Opening a FIFO with no writer blocks in open(2), so
// without the guard the lookup would hang forever — no timeout of ours, no stop, no
// enforcement. win32 has no FIFO, so this can only run on POSIX.
test('findTaskByWorktree does not block on a FIFO in place of a record', {
  skip: process.platform === 'win32' ? 'POSIX only: win32 has no FIFO' : false,
}, async (t) => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const target = recordPath(root, worktree)
    await mkdir(path.dirname(target), { recursive: true })
    try {
      execFileSync('mkfifo', [target], { stdio: 'ignore' })
    } catch (err) {
      t.skip(`mkfifo unavailable: ${err.code ?? err.message}`)
      return
    }
    // Raced against a timer: a regression here does not fail, it HANGS. Losing the race is the
    // assertion — and then the FIFO is opened for writing, which releases the blocked open(2)
    // so the process can exit and the runner reports this failure instead of a job timeout.
    const timer = new Promise((resolve) => { setTimeout(() => resolve('timed out'), 5_000).unref() })
    const result = await Promise.race([findTaskByWorktree(root, worktree), timer])
    if (result === 'timed out') {
      const writer = await open(target, 'w')
      await writer.close()
    }
    assert.notEqual(result, 'timed out', 'the lookup blocked on a FIFO instead of skipping it')
    assert.equal(result, null)
  })
})

// Two properties of the single-file read that no behavioural test can reach, pinned against the
// source the way the tmp+rename is. The first is ordering: a record's ids are validated before
// anything resolves a path the record supplied, and getting it wrong costs a stall only an
// unreachable network host could reproduce. The second is the bounded read: `handle.readFile`
// drains to EOF regardless of the fstat'd size, so using it would make the size cap advisory,
// and the only way to observe the difference is to win a race against a growing file.
test('findTaskByWorktree validates ids before resolving paths, and reads a bounded count', async () => {
  const source = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'state.mjs'),
    'utf8',
  )
  const start = source.indexOf('export async function findTaskByWorktree')
  assert.notEqual(start, -1, 'findTaskByWorktree is no longer declared under that name')
  const body = source.slice(start, source.indexOf('\n}', start))
  const idsAt = body.indexOf('isSegment(indexDir(root), record.taskId)')
  const resolveAt = body.indexOf('worktreeKey(record.worktree)')
  assert.notEqual(idsAt, -1, 'the taskId segment check is gone')
  assert.notEqual(resolveAt, -1, 'the record worktree is no longer hashed')
  assert.equal(idsAt < resolveAt, true, 'ids must be validated before a record-supplied path is resolved')
  assert.match(body, /isLocalAbsolute\(record\.worktree\)/, 'realpath must stay behind the guard')
  assert.match(body, /handle\.read\(buffer, 0, want, 0\)/, 'the read must be bounded by the cap')
  // Comment lines dropped first: this file explains in prose why readFile is not used, and an
  // assertion that cannot tell the explanation from the call would fail on the explanation.
  const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(code, /handle\.readFile/, 'readFile drains to EOF and makes the size cap advisory')
  assert.match(body, /await handle\?\.close\(\)/, 'the handle must be closed on every path')
})

// A cross-file source assertion, not a behavioural one. Observing a torn read requires winning
// a race against a write that finishes in microseconds, which is exactly the flaky test this
// suite avoids; the property is structural — the bytes never appear at the target path under a
// non-final name — so the structure is what gets pinned. Replacing the tmp+rename pair with a
// direct writeFile(target, ...) fails here.
test('writeLocation writes through a unique temp file and renames, never straight to the target', async () => {
  const source = await readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'state.mjs'),
    'utf8',
  )
  const start = source.indexOf('export async function writeLocation')
  assert.notEqual(start, -1, 'writeLocation is no longer declared under that name')
  const body = source.slice(start, source.indexOf('\n}', start))
  assert.match(body, /const tmp = `\$\{target\}\.\$\{process\.pid\}\./,
    'the temp name must be unique per writer, or two writers share one scratch file')
  assert.match(body, /await writeFile\(tmp,/, 'the payload must be written to the temp file')
  assert.match(body, /await rename\(tmp, target\)/, 'the temp file must be renamed onto the target')
  assert.doesNotMatch(body, /writeFile\(\s*target/,
    'writing straight to the target lets a concurrent reader see a half-written record')
})

// The location record is deliberately separate from the claim: adding it must not have relaxed
// the claim's atomicity or changed the bytes it writes.
test('claimTask still refuses a second claim and still writes exactly { taskId, teammate }', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-a'), true)
    assert.equal(await claimTask(root, 'r1', 'T1', 'impl-b'), false)
    const raw = await readFile(path.join(root, '.teammates', 'r1', 'claims', 'T1.json'), 'utf8')
    assert.equal(raw, JSON.stringify({ taskId: 'T1', teammate: 'impl-a' }))
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['taskId', 'teammate'])
  })
})

test('readFixRounds returns {} for a status with no fixRounds, and for null', () => {
  assert.deepEqual(readFixRounds({}, 'Implement'), {})
  assert.deepEqual(readFixRounds(null, 'Implement'), {})
})

test('readFixRounds accepts a numeric phase and a string phase interchangeably', () => {
  const status = { fixRounds: { '2': { T1: 1 } } }
  assert.deepEqual(readFixRounds(status, 2), { T1: 1 })
  assert.deepEqual(readFixRounds(status, '2'), { T1: 1 })
})

test('recordFixRound increments from absent to 1, then 1 to 2', () => {
  let status = recordFixRound({}, 'Implement', 'T1')
  assert.equal(status.fixRounds.Implement.T1, 1)
  status = recordFixRound(status, 'Implement', 'T1')
  assert.equal(status.fixRounds.Implement.T1, 2)
})

test('recordFixRound does not mutate the status object it was given, and leaves another phase untouched', () => {
  const before = { fixRounds: { Verify: { T2: 3 } } }
  const after = recordFixRound(before, 'Implement', 'T1')
  assert.deepEqual(before, { fixRounds: { Verify: { T2: 3 } } })
  assert.deepEqual(after.fixRounds.Verify, { T2: 3 })
  assert.equal(after.fixRounds.Implement.T1, 1)
})
