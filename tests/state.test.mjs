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

const MAX_BRANCH_CODE_UNITS = 512
const MAX_WORKTREE_TEST_BYTES = 32_767

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

// Location records are addressed by the hash of their normalised worktree, so these tests are
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
      worktree: normaliseWorktree(worktree),
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

// A backslash ends a path on win32 and is an ordinary filename character on POSIX, so the
// trailing-separator strip has to be platform-specific: collapsing `/a/foo\` onto `/a/foo`
// would make one record answer for a different directory, and the reader's key-agreement check
// would recompute the same collapsed form and agree with it.
//
// THE POSIX BRANCH IS THE PIN; the win32 branch is a smoke assertion and nothing more. On win32
// `path.resolve` has already removed the trailing separator before `stripTrailingSeparator` ever
// sees the value, so that assertion holds even if the strip is disabled entirely — verified by
// replacing the pattern with one that never matches, which leaves the whole suite green here.
// The load-bearing win32 case for that function is the filesystem-root guard, pinned separately.
test('a trailing backslash is a separator on win32 and a filename character on POSIX', () => {
  const base = path.resolve(path.join('a', 'foo'))
  const withBackslash = `${base}\\`
  if (process.platform === 'win32') {
    assert.equal(worktreeKey(withBackslash), worktreeKey(base))
  } else {
    assert.notEqual(worktreeKey(withBackslash), worktreeKey(base))
    assert.equal(worktreeKey(`${base}/`), worktreeKey(base))
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
    for (const runId of ['../..', '../escaped', '..', '.']) {
      await assert.rejects(writeLocation(root, runId, 'T1', args), /escapes the run directory/)
    }
  })
})

// `init-run --run 2026/substop` is accepted by the CLI and creates .teammates/2026/substop, so
// refusing a nested run id here would abort `locate` for a run the CLI legitimately made and
// leave that whole run unenforced. Containment, not single-segment, is the rule for a run id.
test('writeLocation accepts a nested runId, as init-run does', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    await writeLocation(root, '2026/substop', 'T1', { worktree, branch: 'teammates/2026/substop/T1' })
    assert.deepEqual(await findTaskByWorktree(root, worktree), {
      runId: '2026/substop',
      taskId: 'T1',
      branch: 'teammates/2026/substop/T1',
    })
  })
})

// Both ids are spent as argv by the consumer and interpolated into refs and stderr, so path
// safety is not enough on its own: containment accepts every one of these.
// Both ids become git refs, argv and stderr, so they are validated as git-ref-legal component
// sequences rather than by charset. These are the shapes a charset got wrong in both directions.
test('writeLocation refuses ids that are contained but illegal as ref components', async () => {
  await withTempRoot(async (root) => {
    const args = { worktree: path.join(root, 'wt', 'agent-1'), branch: 'b' }
    const badRunIds = [
      'sub/../substop', // contained (path.join normalises it) yet carries `..` to any consumer
      '--no-fleet', '-r', // reaches argv as a flag
      'a b', 'a\nb', // space and control bytes
      'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', // git's forbidden set
      'a@{b', // reflog syntax
      'sub//substop', 'sub/', 'x'.repeat(256),
      // Ref-legality shapes that used to be listed here — `.hidden`, `x.lock`, `trailing.` —
      // are gone with the rules that refused them: git decides ref legality at the point of
      // use, and refusing them here only cost legitimate runs their enforcement.
    ]
    for (const runId of badRunIds) {
      await assert.rejects(
        writeLocation(root, runId, 'T1', args),
        /is not a usable run id|escapes the run directory/,
        `runId ${JSON.stringify(runId)} was accepted`,
      )
    }
    for (const taskId of ['--force', '-rf', 'a b', 'a\nb', 'a~b', 'a:b', 'a^b', 'x'.repeat(129)]) {
      await assert.rejects(
        writeLocation(root, 'r1', taskId, args),
        /is not a usable task id|escapes the run directory/,
        `taskId ${JSON.stringify(taskId)} was accepted`,
      )
    }
  })
})

// The shape a single-segment path check cannot see: `T1/` joins to the same directory as `T1`,
// so containment accepts it, and only the one-component rule rejects it. Under a widened
// pattern it reaches `complete --task T1/` and `refs/heads/teammates/r1/T1/`.
test('a trailing slash is refused in a task id, at both ends', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    await assert.rejects(
      writeLocation(root, 'r1', 'T1/', { worktree, branch: 'b' }),
      /is not a usable task id/,
    )
    await plant(root, worktree, { runId: 'r1', taskId: 'T1/', worktree, branch: 'b' })
    assert.equal(await findTaskByWorktree(root, worktree), null)
  })
})

// A run id that aliases its own directory satisfies both sides of the branch equality check,
// because the record's author writes both. Rejecting the spelling is what closes it.
test('findTaskByWorktree skips a runId that aliases its run directory', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    await plant(root, worktree, {
      runId: 'sub/../substop',
      taskId: 'T1',
      worktree,
      branch: 'teammates/sub/../substop/T1',
    })
    assert.equal(await findTaskByWorktree(root, worktree), null)
  })
})

// The other direction: ids git accepts and init-run creates must keep working, or `locate`
// aborts and the whole run loses enforcement.
test('ids that git and init-run accept are accepted here', async () => {
  await withTempRoot(async (root) => {
    const cases = [
      ['café', 'T1'],
      ['2026/substop', 'T10'],
      ['run.1', 'task_a'],
      ['a-b/c-d', 'a.b'],
      ['ünïcode/日本語', 'T7'],
      ['x'.repeat(255), 'y'.repeat(128)],
    ]
    for (const [runId, taskId] of cases) {
      const worktree = path.join(root, 'wt', `agent-${encodeURIComponent(runId).slice(0, 20)}-${taskId.slice(0, 8)}`)
      await writeLocation(root, runId, taskId, { worktree, branch: `teammates/${runId}/${taskId}` })
      assert.deepEqual(
        await findTaskByWorktree(root, worktree),
        { runId, taskId, branch: `teammates/${runId}/${taskId}` },
        `${JSON.stringify(runId)} / ${JSON.stringify(taskId)} was refused`,
      )
    }
  })
})

// An id crafted to FAIL containment is exactly the one carrying the escape sequence, and that
// message used to interpolate it raw. Printed by `locate`, it clears the terminal and prints
// attacker-chosen text that reads as a verdict.
test('a rejected id is never interpolated raw into the error that reports it', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const esc = String.fromCharCode(27)
    const del = String.fromCharCode(127)
    const csi = String.fromCharCode(0x9b)
    const lineSep = String.fromCharCode(0x2028)
    const hostile = [
      `../${esc}[2J${esc}[31mPWNED`, // fails containment
      `..${esc}[2Jx`,
      `${esc}[2Jcontained-but-unusable`, // fails the ref rule
      `run${del}${csi}31m${lineSep}x`,
    ]
    const unsafe = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]')
    for (const id of hostile) {
      const fromRun = await writeLocation(root, id, 'T1', { worktree, branch: 'b' }).then(
        () => null,
        (err) => err.message,
      )
      const fromTask = await writeLocation(root, 'r1', id, { worktree, branch: 'b' }).then(
        () => null,
        (err) => err.message,
      )
      for (const message of [fromRun, fromTask]) {
        assert.notEqual(message, null, `${JSON.stringify(id)} was accepted`)
        assert.doesNotMatch(message, unsafe, `raw control bytes survived into: ${JSON.stringify(message)}`)
        // And the bytes are still reported, escaped, rather than silently dropped.
        // Two escape forms are both correct: JSON.stringify already escapes C0 itself,
        // and everything it leaves raw is escaped afterwards as `\u{7f}`, `\u{9b}`, `\u{2028}`.
        assert.match(message, /\\u001b|\\u\{[0-9a-f]{2,6}\}|\\n/)
      }
    }
  })
})

/// The validator and the printer must agree about which bytes are dangerous. They did not: the
// printer escaped the C1 block and U+2028/U+2029 while the validator certified them, so an id
// carrying U+009B — CSI, a control introducer that needs no ESC — was returned verbatim to a
// consumer that spends it as argv and prints it.
test('an id carrying C1 or line-separator code points is refused, not just escaped when printed', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const csi = String.fromCharCode(0x9b)
    const nel = String.fromCharCode(0x85)
    const lineSep = String.fromCharCode(0x2028)
    const paraSep = String.fromCharCode(0x2029)
    const del = String.fromCharCode(127)
    for (const hostile of [`T2${csi}K`, `run${nel}x`, `a${lineSep}b`, `a${paraSep}b`, `a${del}b`]) {
      await assert.rejects(
        writeLocation(root, hostile, 'T1', { worktree, branch: 'b' }),
        /is not a usable run id/,
        `runId ${JSON.stringify(hostile)} was accepted`,
      )
      await assert.rejects(
        writeLocation(root, 'r1', hostile, { worktree, branch: 'b' }),
        /is not a usable task id/,
        `taskId ${JSON.stringify(hostile)} was accepted`,
      )
      // And the reader refuses a hand-written record carrying the same bytes.
      await plant(root, worktree, { runId: 'r1', taskId: hostile, worktree, branch: 'b' })
      assert.equal(await findTaskByWorktree(root, worktree), null, `taskId ${JSON.stringify(hostile)} was returned`)
      await plant(root, worktree, { runId: hostile, taskId: 'T1', worktree, branch: 'b' })
      assert.equal(await findTaskByWorktree(root, worktree), null, `runId ${JSON.stringify(hostile)} was returned`)
    }
  })
})

// Git's rule 3 forbids `..` ANYWHERE in a refname, not merely as a whole component. Beyond the
// refname being rejected by git, `..` is revision-range syntax, so `teammates/a..b/T1` parses as
// a range rather than failing outright in a consumer that accepts ranges.
test('an id containing .. anywhere is refused at both ends', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    for (const bad of ['a..b', 'x..y', 'a...b', 'sub..stop']) {
      await assert.rejects(
        writeLocation(root, bad, 'T1', { worktree, branch: 'b' }),
        /is not a usable run id/,
        `runId ${JSON.stringify(bad)} was accepted`,
      )
      await assert.rejects(
        writeLocation(root, 'r1', bad, { worktree, branch: 'b' }),
        /is not a usable task id/,
        `taskId ${JSON.stringify(bad)} was accepted`,
      )
      await plant(root, worktree, { runId: bad, taskId: 'T1', worktree, branch: `teammates/${bad}/T1` })
      assert.equal(await findTaskByWorktree(root, worktree), null, `runId ${JSON.stringify(bad)} was returned`)
    }
    // The multi-component spellings git also refuses.
    for (const bad of ['a..b/c', 'a/b..c']) {
      await assert.rejects(writeLocation(root, bad, 'T1', { worktree, branch: 'b' }), /is not a usable run id/)
    }
  })
})

// The writer's check on the NORMALISED worktree. A directory symlink to a UNC target splits the
// raw spelling (looks local) from the resolved one (does not), which is the only way to reach
// that guard — and it is reachable, contrary to what an earlier version of this suite recorded.
// No cmd.exe: the target is built from char codes because a shell mangles the backslashes, and
// that mangling is exactly what produced the false "unreachable" measurement.
test('writeLocation refuses a worktree whose resolved form the reader would reject', async (t) => {
  await withTempRoot(async (root) => {
    const B = String.fromCharCode(92)
    const targets = [
      B + B + 'wsl.localhost' + B + 'Ubuntu' + B + 'tmp',
      B + B + 'localhost' + B + 'C$' + B + 'Users',
      B + B + 'localhost' + B + 'C$',
    ]
    let link = null
    for (const target of targets) {
      const candidate = path.join(root, `wt-link-${targets.indexOf(target)}`)
      try {
        await symlink(target, candidate, 'dir')
      } catch { continue }
      // Only a target that actually resolves to a UNC path exercises the guard.
      if (isLocalAbsolute(candidate) && !isLocalAbsolute(normaliseWorktree(candidate))) {
        link = candidate
        break
      }
    }
    if (link === null) {
      t.skip('no UNC target on this host resolves to a non-local path')
      return
    }
    await assert.rejects(
      writeLocation(root, 'r1', 'T1', { worktree: link, branch: 'teammates/r1/T1' }),
      /which no record can name/,
    )
    // And nothing was left behind for that key, so a failed write cannot displace a good record.
    assert.equal(await findTaskByWorktree(root, link), null)
  })
})

// The empty-component clause and the composed-refname check cover each other rather than being
// individually load-bearing: `/foo` contains no `//`, so the `//` rule does not catch it, and
// removing BOTH clauses accepts it as branch `teammates//foo/T1`. This pins the outcome; the
// source comment records which clauses jointly provide it.
test('a leading or trailing separator in an id is refused, at both ends', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    for (const runId of ['/foo', 'foo/', 'a//b', '/']) {
      await assert.rejects(
        writeLocation(root, runId, 'T1', { worktree, branch: 'b' }),
        /is not a usable run id|escapes the run directory|do not name a valid branch/,
        `runId ${JSON.stringify(runId)} was accepted`,
      )
      await plant(root, worktree, { runId, taskId: 'T1', worktree, branch: `teammates/${runId}/T1` })
      assert.equal(await findTaskByWorktree(root, worktree), null, `runId ${JSON.stringify(runId)} was returned`)
    }
  })
})

// Git accepts these in a refname; this project does not. A zero-width space makes a REAL branch
// distinct from its visible twin, and every diagnostic renders the two identically, so a forged
// record would enforce against a ref the victim never used and no inspection could tell. U+202E
// reverses the error line that reports it (Trojan Source, CVE-2021-42574).
test('invisible and bidi control characters are refused as ids and escaped when printed', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const zwsp = String.fromCharCode(0x200b)
    const rtlOverride = String.fromCharCode(0x202e)
    const lrm = String.fromCharCode(0x200e)
    const isolate = String.fromCharCode(0x2066)
    const bom = String.fromCharCode(0xfeff)
    for (const hostile of [`T1${zwsp}`, `a${rtlOverride}b`, `r${lrm}1`, `a${isolate}b`, `${bom}T1`]) {
      const message = await writeLocation(root, 'r1', hostile, { worktree, branch: 'b' })
        .then(() => null, (err) => err.message)
      assert.notEqual(message, null, `taskId ${JSON.stringify(hostile)} was accepted`)
      // Reported escaped, so the message cannot be reshaped by what it reports.
      assert.doesNotMatch(message, new RegExp('[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]'))
      await assert.rejects(writeLocation(root, hostile, 'T1', { worktree, branch: 'b' }), /is not a usable run id/)
      await plant(root, worktree, { runId: 'r1', taskId: hostile, worktree, branch: 'b' })
      assert.equal(await findTaskByWorktree(root, worktree), null, `taskId ${JSON.stringify(hostile)} was returned`)
    }
  })
})

// `branch` was the only record field with no bound, which is enough on its own to write a record
// the reader refuses on size for ever after.
test('writeLocation refuses a branch that would make the record unreadable', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    await assert.rejects(
      writeLocation(root, 'r1', 'T1', { worktree, branch: 'b'.repeat(70_000) }),
      /longer than|could never be read back/,
    )
    // Separates the branch bound from the whole-record bound: 700 characters is over the branch
    // limit and nowhere near the record limit, so this case can only be rejected by the branch
    // bound and the assertion names that message specifically.
    await assert.rejects(
      writeLocation(root, 'r1', 'T1', { worktree, branch: 'b'.repeat(700) }),
      /longer than 512 bytes/,
    )
    // And a branch at the limit is still accepted, so the bound is a limit and not a ban. Under
    // its own worktree, so the "nothing was written" assertion below still means what it says.
    const accepted = path.join(root, 'wt', 'agent-limit')
    await writeLocation(root, 'r1', 'T1', { worktree: accepted, branch: 'b'.repeat(512) })
    assert.deepEqual(await findTaskByWorktree(root, accepted), { runId: 'r1', taskId: 'T1', branch: null })
    for (const branch of [42, {}, []]) {
      await assert.rejects(
        writeLocation(root, 'r1', 'T1', { worktree, branch }),
        /is not a branch name/,
        `branch ${JSON.stringify(branch)} was accepted`,
      )
    }
    // Nothing was written, so a refused write cannot displace an existing good record.
    assert.equal(await findTaskByWorktree(root, worktree), null)
    // A null branch stays legal, and so does an ABSENT one: a teammate that never created its
    // task branch is the case the hook exists to catch, and it must still be able to record
    // where it is, whether its caller passes null or omits the field entirely.
    await writeLocation(root, 'r1', 'T1', { worktree, branch: null })
    assert.deepEqual(await findTaskByWorktree(root, worktree), { runId: 'r1', taskId: 'T1', branch: null })
    const absent = path.join(root, 'wt', 'agent-absent')
    await writeLocation(root, 'r1', 'T1', { worktree: absent })
    assert.deepEqual(await findTaskByWorktree(root, absent), { runId: 'r1', taskId: 'T1', branch: null })
  })
})

// Each of these renders as nothing, so each makes a git ref indistinguishable from the honest
// one beside it. They are spread across blocks and planes deliberately: the rule has to hold for
// code points nobody thought to list, which is why it is a property and not an enumeration.
test('code points that render as nothing are refused as ids', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const missedByTheOldList = [
      0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner and invisible operators
      0x00ad, // soft hyphen
      0x180e, // Mongolian vowel separator
      0x061c, // Arabic letter mark
      0x115f, 0x3164, 0xffa0, // Hangul fillers
      0xfff9, 0xfffa, 0xfffb, // interlinear annotation
      0xe0001, 0xe0020, 0xe007f, // the tag block
    ]
    for (const cp of missedByTheOldList) {
      const hostile = `T1${String.fromCodePoint(cp)}`
      const label = `U+${cp.toString(16).toUpperCase()}`
      await assert.rejects(
        writeLocation(root, 'r1', hostile, { worktree, branch: 'b' }),
        /is not a usable task id/,
        `${label} was accepted as a task id`,
      )
      await plant(root, worktree, { runId: 'r1', taskId: hostile, worktree, branch: 'b' })
      assert.equal(await findTaskByWorktree(root, worktree), null, `${label} was returned by the reader`)
    }
    // And the property does not reject ordinary ids, including non-ASCII ones.
    for (const taskId of ['T1', 'café', '日本語', 'run-1_x', 'a.b']) {
      await writeLocation(root, 'r1', taskId, { worktree, branch: `teammates/r1/${taskId}` })
      assert.equal((await findTaskByWorktree(root, worktree)).taskId, taskId)
    }
  })
})

// Ref legality is git's question, answered where a branch is actually used. These shapes were
// refused here in earlier rounds and are accepted now: a hand-maintained approximation of "what
// git can create" over-rejected legitimate ids — `com0` and `lpt0` are not reserved by Windows
// and git creates them — and each refusal cost a whole run its enforcement for nothing.
test('ids that are legal for this store but were refused by the deleted ref rules now pass', async () => {
  await withTempRoot(async (root) => {
    const cases = [
      ['trailing.', 'T1'],
      ['run', 'T1.'],
      ['.leading', 'T1'],
      ['x.lock', 'T1'],
      ['com0', 'lpt0'],
      ['nul', 'con'],
      ['2026/substop', 'T10'],
      ['café', 'ünïcode'],
    ]
    for (const [runId, taskId] of cases) {
      const worktree = path.join(root, 'wt', `agent-${cases.findIndex((c) => c[0] === runId)}`)
      await writeLocation(root, runId, taskId, { worktree, branch: `teammates/${runId}/${taskId}` })
      assert.deepEqual(
        await findTaskByWorktree(root, worktree),
        { runId, taskId, branch: `teammates/${runId}/${taskId}` },
        `${JSON.stringify(runId)} / ${JSON.stringify(taskId)} was refused`,
      )
    }
  })
})

// What the composed branch is SPENT as is still guarded, because those characters change what a
// git revision argument MEANS rather than whether it is a legal name.
test('revision syntax is still refused in either id', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    for (const bad of ['a..b', 'a~1', 'a^', 'a:b', 'a@{u}', 'a?b', 'a*b', 'a[b']) {
      await assert.rejects(
        writeLocation(root, bad, 'T1', { worktree, branch: 'b' }),
        /is not a usable run id/,
        `runId ${JSON.stringify(bad)} was accepted`,
      )
      await plant(root, worktree, { runId: 'r1', taskId: bad, worktree, branch: 'b' })
      assert.equal(await findTaskByWorktree(root, worktree), null, `taskId ${JSON.stringify(bad)} was returned`)
    }
  })
})

// `worktree` had no length bound: isLocalAbsolute inspects a prefix, and normaliseWorktree falls
// back to the lexical form when realpath throws, so a 70,000-character path reached the
// serialiser. It was caught only by the whole-record size guard, which nothing pinned.
test('writeLocation refuses a worktree longer than any real path', async () => {
  await withTempRoot(async (root) => {
    // Built for whichever platform runs it, and never skipped: a win32 path literal is merely
    // RELATIVE on Linux, so it would be rejected by the wrong check there and this assertion
    // would pass without exercising the bound. A skip would leave the same hole more quietly.
    const enormous = process.platform === 'win32'
      ? `C:${path.sep}${'a'.repeat(70_000)}`
      : `${path.sep}${'a'.repeat(70_000)}`
    assert.equal(isLocalAbsolute(enormous), true, 'the fixture must be absolute on this platform')
    await assert.rejects(
      writeLocation(root, 'r1', 'T1', { worktree: enormous, branch: 'teammates/r1/T1' }),
      /over the 32767 allowed/,
    )
    assert.equal(await findTaskByWorktree(root, enormous), null)
    // An ordinary deep path is still fine, so this is a limit rather than a ban.
    const deep = path.join(root, ...Array.from({ length: 20 }, (_, i) => `level-${i}`))
    await writeLocation(root, 'r1', 'T1', { worktree: deep, branch: 'teammates/r1/T1' })
    assert.equal((await findTaskByWorktree(root, deep)).taskId, 'T1')
  })
})

// The allowlist's whole point: these are refused without any of them being named. The 29 `Cf`
// code points below are the ones `Default_Ignorable_Code_Point` does NOT cover — its derivation
// subtracts prepended-concatenation marks and Egyptian format controls — so the previous rule
// accepted every one of them, and each makes a git ref that renders identically to the honest
// branch beside it. U+2800 and the `Zs` separators were accepted while ASCII space was refused.
test('format, separator and blank code points are refused without being enumerated in the rule', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const cfMissedByTheProperty = [
      0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, // Arabic number signs
      0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, // Arabic end of ayah, Syriac abbreviation mark
      0x110bd, 0x110cd, // Kaithi number signs
      0x13430, 0x1343f, // Egyptian format controls
    ]
    const separatorsAndBlanks = [
      0x2800, // braille blank — not a space by any property, renders as nothing
      0x0020, 0x00a0, 0x2000, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000, // Zs
    ]
    for (const cp of [...cfMissedByTheProperty, ...separatorsAndBlanks]) {
      const hostile = `T1${String.fromCodePoint(cp)}`
      const label = `U+${cp.toString(16).toUpperCase()}`
      await assert.rejects(
        writeLocation(root, 'r1', hostile, { worktree, branch: 'b' }),
        /is not a usable task id/,
        `${label} was accepted as a task id`,
      )
      await plant(root, worktree, { runId: 'r1', taskId: hostile, worktree, branch: 'b' })
      assert.equal(await findTaskByWorktree(root, worktree), null, `${label} was returned by the reader`)
    }
  })
})

// The allowlist is also a RELAXATION where the blocklist was over-strict: a variation selector
// is a Mark, so an emoji id that `init-run` and `git check-ref-format` both accept now works
// here too, where the previous rule refused it and cost that run its enforcement.
test('a marked or non-ASCII id that git accepts is accepted here', async () => {
  await withTempRoot(async (root) => {
    // Marks on a base character are allowed, because they are visible: a Devanagari id whose
    // matras are marks, and a digit carrying an enclosing keycap. What the rule is about is
    // invisibility, not emoji — a character that renders is fine whatever its category.


    const cases = ['T1', 'café', '日本語', 'run-1_x', 'run.1', '.hidden', 'T1.', 'हिन्दी', `1${String.fromCodePoint(0x20e3)}`]
    for (const taskId of cases) {
      const worktree = path.join(root, 'wt', `agent-${cases.indexOf(taskId)}`)
      await writeLocation(root, 'r1', taskId, { worktree, branch: `teammates/r1/${taskId}` })
      assert.deepEqual(
        await findTaskByWorktree(root, worktree),
        { runId: 'r1', taskId, branch: `teammates/r1/${taskId}` },
        `${JSON.stringify(taskId)} was refused`,
      )
    }
    // Nesting still works for a run id, and `2026/substop` is what init-run creates.
    const nested = path.join(root, 'wt', 'agent-nested')
    await writeLocation(root, '2026/substop', 'T10', { worktree: nested, branch: 'teammates/2026/substop/T10' })
    assert.equal((await findTaskByWorktree(root, nested)).runId, '2026/substop')
  })
})

// A `.` component is as much an alias as `..`: `sub/./substop` names the same directory, and the
// branch it composes — `teammates/sub/./substop/T1` — is one git cannot resolve. Only `..` was
// refused before, so the same class was half closed.
test('a dot component is refused wherever a dot-dot component would be', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    for (const runId of ['sub/./substop', './sub', 'a/.', '.', 'sub/../substop', '..']) {
      await assert.rejects(
        writeLocation(root, runId, 'T1', { worktree, branch: `teammates/${runId}/T1` }),
        /is not a usable run id|escapes the run directory/,
        `runId ${JSON.stringify(runId)} was accepted`,
      )
      await plant(root, worktree, { runId, taskId: 'T1', worktree, branch: `teammates/${runId}/T1` })
      assert.equal(await findTaskByWorktree(root, worktree), null, `runId ${JSON.stringify(runId)} was returned`)
    }
    // `./b` is the shape `isSegment` does NOT catch — path.relative resolves the dot away — so
    // it is what the single-component rule and the dot-component rule jointly cover.
    for (const taskId of ['./b', './-b', 'a/b']) {
      await assert.rejects(
        writeLocation(root, 'r1', taskId, { worktree, branch: 'b' }),
        /is not a usable task id|escapes the run directory/,
        `taskId ${JSON.stringify(taskId)} was accepted`,
      )
    }
  })
})

// Bounds are bytes, and this is the case that proves it: 32,003 characters of Japanese is inside
// any code-unit bound and about 96 KB on disk. While the field bounds counted code units and the
// record bound counted bytes, they did not compose, and three notes claimed they did.
test('a multibyte worktree is bounded by its byte length, not its character count', async () => {
  await withTempRoot(async (root) => {
    const multibyte = `${path.sep}${'日'.repeat(32_000)}`
    const worktree = process.platform === 'win32' ? `C:${multibyte}` : multibyte
    assert.equal(worktree.length < 33_000, true, 'the fixture must be inside any code-unit bound')
    assert.equal(Buffer.byteLength(worktree, 'utf8') > 90_000, true, 'and past the byte bound')
    await assert.rejects(
      writeLocation(root, 'r1', 'T1', { worktree, branch: 'teammates/r1/T1' }),
      /bytes, over the 32767 allowed/,
    )
    assert.equal(await findTaskByWorktree(root, worktree), null)
  })
})

// Anything that renders as nothing is refused, with no exception for variation selectors. A
// zero-width character on a Letter makes an id indistinguishable from its honest twin, and a
// forged record supplies both the id and the branch, so nothing downstream can catch it.
test('a zero-width or variation selector on a letter is refused', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const hostile = [
      `T1${String.fromCodePoint(0xfe0e)}`, // text presentation selector
      `T1${String.fromCodePoint(0xfe0f)}`, // emoji presentation selector
      `T1${String.fromCodePoint(0xe0100)}`, // astral variation selector
      `T1${String.fromCodePoint(0x200b)}`,
      `T1${String.fromCodePoint(0x1160)}`, // Hangul junseong filler: classified as a letter
    ]
    for (const taskId of hostile) {
      await assert.rejects(
        writeLocation(root, 'r1', taskId, { worktree, branch: 'b' }),
        /is not a usable task id/,
        `${JSON.stringify(taskId)} was accepted`,
      )
      await plant(root, worktree, { runId: 'r1', taskId, worktree, branch: 'b' })
      assert.equal(await findTaskByWorktree(root, worktree), null, `${JSON.stringify(taskId)} was returned`)
    }
    // The honest twin is unaffected, which is the point: one of these two is an id and the
    // other cannot be told apart from it by looking.
    await writeLocation(root, 'r1', 'T1', { worktree, branch: 'teammates/r1/T1' })
    assert.equal((await findTaskByWorktree(root, worktree)).taskId, 'T1')
  })
})

// One rendering, one representation — enforced by REFUSING a non-NFC id rather than folding it.
// Folding would be the only normalisation in the repository: `init-run` creates the run
// directory byte-exactly and `taskBranchName` builds the ref byte-exactly, so a folded id names
// a directory nobody created and a branch git does not hold, and the canonicality check then
// compares a recomputed name against the stored one and disagrees with itself.
test('a non-NFC id is refused rather than folded', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const decomposed = `cafe${String.fromCodePoint(0x301)}`
    const precomposed = 'café'
    assert.notEqual(decomposed, precomposed)
    assert.equal(decomposed.normalize('NFC'), precomposed)
    await assert.rejects(
      writeLocation(root, 'r1', decomposed, { worktree, branch: `teammates/r1/${decomposed}` }),
      /is not a usable task id/,
    )
    await assert.rejects(
      writeLocation(root, decomposed, 'T1', { worktree, branch: 'b' }),
      /is not a usable run id/,
    )
    // A hand-written record carrying the decomposed form is skipped, not silently rewritten.
    await plant(root, worktree, { runId: 'r1', taskId: decomposed, worktree, branch: 'b' })
    assert.equal(await findTaskByWorktree(root, worktree), null)
    // The composed form is an ordinary id and is stored byte-for-byte as the caller wrote it,
    // which is what keeps it equal to the directory init-run made and the ref git holds.
    const written = await writeLocation(root, 'r1', precomposed, {
      worktree,
      branch: `teammates/r1/${precomposed}`,
    })
    assert.equal(JSON.parse(await readFile(written, 'utf8')).taskId, precomposed)
    assert.deepEqual(await findTaskByWorktree(root, worktree), {
      runId: 'r1',
      taskId: precomposed,
      branch: `teammates/r1/${precomposed}`,
    })
  })
})

// The bound is checked against the bytes that get stored, which is only meaningful because
// nothing rewrites the value between the check and the write. U+FB2C is 3 bytes and its NFC
// form is 6, so a fold after the check would store twice what was measured.
test('the byte bound is measured against the stored bytes', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const expanding = String.fromCodePoint(0xfb2c)
    assert.equal(Buffer.byteLength(expanding, 'utf8'), 3)
    assert.equal(Buffer.byteLength(expanding.normalize('NFC'), 'utf8'), 6)
    // Refused for being non-NFC, so the question of which form was measured never arises.
    await assert.rejects(
      writeLocation(root, 'r1', `T${expanding}`, { worktree, branch: 'b' }),
      /is not a usable task id/,
    )
    const composed = expanding.normalize('NFC')
    const written = await writeLocation(root, 'r1', `T${composed}`, { worktree, branch: 'b' })
    const stored = JSON.parse(await readFile(written, 'utf8')).taskId
    assert.equal(stored, `T${composed}`)
    assert.equal(Buffer.byteLength(stored, 'utf8') <= 128, true)
  })
})

// A worktree path is not an id: only C0 is refused, because those cannot come from a real path
// and make a stored path undiagnosable in an error. DEL and the C1 range are legal in filenames
// on both platforms, so refusing them would deny a record to a directory that really exists and
// leave the hook with nothing to find.
test('a worktree containing C0 controls is refused, and one with DEL or C1 is not', async () => {
  await withTempRoot(async (root) => {
    const prefix = process.platform === 'win32' ? 'C:/' : '/'
    for (const cp of [0x007f, 0x009b]) {
      const worktree = `${prefix}wt${String.fromCodePoint(cp)}agent`
      await writeLocation(root, 'r1', 'T1', { worktree, branch: 'teammates/r1/T1' })
      assert.equal(
        (await findTaskByWorktree(root, worktree)).taskId,
        'T1',
        `U+${cp.toString(16)} should be legal in a worktree path`,
      )
    }
    for (const cp of [0x0001, 0x001f]) {
      const worktree = `${prefix}wt${String.fromCodePoint(cp)}agent`
      await assert.rejects(
        writeLocation(root, 'r1', 'T1', { worktree, branch: 'teammates/r1/T1' }),
        /contains control characters/,
        `U+${cp.toString(16)} was accepted in a worktree`,
      )
    }
    // The shape that motivated it: inside the byte bound, far past the record bound once JSON
    // has escaped every byte of it.
    const enormous = `${prefix}${String.fromCodePoint(0x0001).repeat(30_000)}`
    assert.equal(Buffer.byteLength(enormous, 'utf8') < 32_767, true, 'must be inside the field bound')
    assert.equal(JSON.stringify(enormous).length > 150_000, true, 'and past the record bound once escaped')
    await assert.rejects(
      writeLocation(root, 'r1', 'T1', { worktree: enormous, branch: 'teammates/r1/T1' }),
      /contains control characters|could never be read back/,
    )
    assert.equal(await findTaskByWorktree(root, enormous), null)
  })
})

// The record bound is measured on the bytes that reach the disk, so it holds even when a field
// passes its own bound and then expands. `"` doubles under JSON escaping.
test('a record that would exceed the size bound once serialised is refused', async () => {
  await withTempRoot(async (root) => {
    const prefix = process.platform === 'win32' ? 'C:/' : '/'
    const quotes = '"'.repeat(32_760)
    const worktree = `${prefix}${quotes}`
    assert.equal(Buffer.byteLength(worktree, 'utf8') <= 32_767, true, 'must pass the field bound')
    // The record the writer builds carries three more fields, so the escaped worktree alone
    // sits just under the bound and the whole record just over it — which is the point: only a
    // measurement of the real serialised bytes can see that.
    assert.equal(JSON.stringify({ runId: 'r1', taskId: 'T1', branch: 'teammates/r1/T1', worktree }).length > 65_536, true, 'and fail once escaped')
    await assert.rejects(
      writeLocation(root, 'r1', 'T1', { worktree, branch: 'teammates/r1/T1' }),
      /could never be read back/,
    )
  })
})

// Bounds are bytes for ids and branch too, not just for the worktree: a multibyte id inside a
// character count can be far outside the byte budget the record is written against.
test('id and branch bounds are measured in bytes', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const multibyteRunId = '日'.repeat(200) // inside 255 counted as characters, 600 bytes
    assert.equal(multibyteRunId.length < 255, true, 'must pass a code-unit bound')
    assert.equal(Buffer.byteLength(multibyteRunId, 'utf8') > 255, true, 'and fail a byte bound')
    await assert.rejects(
      writeLocation(root, multibyteRunId, 'T1', { worktree, branch: 'b' }),
      /is not a usable run id/,
    )
    const multibyteTaskId = '日'.repeat(100) // inside 128 as characters, 300 bytes
    await assert.rejects(
      writeLocation(root, 'r1', multibyteTaskId, { worktree, branch: 'b' }),
      /is not a usable task id/,
    )
    // 413 characters — comfortably inside 512 counted as code units — and 1,213 bytes, which is
    // what the record is written in. A bound counting characters would accept this.
    const multibyteBranch = `teammates/r1/${'日'.repeat(400)}`
    assert.equal(multibyteBranch.length < MAX_BRANCH_CODE_UNITS, true, 'must pass a code-unit bound')
    assert.equal(Buffer.byteLength(multibyteBranch, 'utf8') > MAX_BRANCH_CODE_UNITS, true, 'and fail a byte bound')
    await assert.rejects(
      writeLocation(root, 'r1', 'T1', { worktree, branch: multibyteBranch }),
      /is longer than 512 bytes/,
    )
    // Inside the byte budget, these still work.
    await writeLocation(root, '日'.repeat(85), '日'.repeat(42), { worktree, branch: 'b' })
    assert.equal((await findTaskByWorktree(root, worktree)).runId, '日'.repeat(85))
  })
})

// A refusal a reader cannot act on is not a refusal: the character being complained about has to
// survive into the message in a visible form.
test('characters that render as blank are escaped in error messages', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const blanks = [0x2800, 0x00a0, 0x2000, 0x3000, 0x2028, 0x200b, 0x0009]
    for (const cp of blanks) {
      const taskId = `T1${String.fromCodePoint(cp)}`
      const message = await writeLocation(root, 'r1', taskId, { worktree, branch: 'b' })
        .then(() => null, (err) => err.message)
      assert.notEqual(message, null, `U+${cp.toString(16)} was accepted`)
      const escaped = cp.toString(16)
      assert.match(
        message,
        new RegExp(`\\\\u\\{${escaped}\\}|\\\\[tn]`),
        `U+${cp.toString(16)} was not escaped in: ${JSON.stringify(message)}`,
      )
    }
  })
})

// The record bound counts BYTES on disk. An all-ASCII fixture cannot tell that from counting
// code units, so this one is sized to pass a code-unit bound and fail a byte bound: quotes
// double under JSON escaping, and the multibyte tail costs three bytes per character but one
// code unit each.
test('the record bound is measured in bytes, not code units', async () => {
  await withTempRoot(async (root) => {
    const prefix = process.platform === 'win32' ? 'C:/' : '/'
    const tail = '日'.repeat(17)
    const quotes = '"'.repeat(MAX_WORKTREE_TEST_BYTES - prefix.length - Buffer.byteLength(tail, 'utf8'))
    const worktree = `${prefix}${quotes}${tail}`
    const record = { runId: 'r1', taskId: 'T1', branch: 'teammates/r1/T1', worktree }
    const serialised = `${JSON.stringify(record)}\n`
    assert.equal(Buffer.byteLength(worktree, 'utf8') <= MAX_WORKTREE_TEST_BYTES, true, 'passes the field bound')
    assert.equal(serialised.length < 65_536, true, 'passes a code-unit bound')
    assert.equal(Buffer.byteLength(serialised, 'utf8') > 65_536, true, 'fails the byte bound')
    await assert.rejects(
      writeLocation(root, 'r1', 'T1', { worktree, branch: 'teammates/r1/T1' }),
      /could never be read back/,
    )
    assert.equal(await findTaskByWorktree(root, worktree), null)
  })
})

// Each alternative in the printer's class is the only cover for something, so each gets an input
// only it catches. A refusal that silently swallows the character it names cannot be acted on.
test('every class of unprintable character is escaped in a message', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const covered = [
      [0x0600, 'a format character that is not default-ignorable'],
      [0xfe0f, 'a default-ignorable that is not a format character'],
      [0x2028, 'a line separator'],
      [0x2029, 'a paragraph separator'],
      [0x00a0, 'a space separator'],
      [0x2800, 'a braille blank, which no property covers'],
      [0x0001, 'a C0 control'],
      [0x009b, 'a C1 control'],
      [0x007f, 'DEL'],
    ]
    for (const [cp, why] of covered) {
      const taskId = `T1${String.fromCodePoint(cp)}`
      const message = await writeLocation(root, 'r1', taskId, { worktree, branch: 'b' })
        .then(() => null, (err) => err.message)
      assert.notEqual(message, null, `U+${cp.toString(16)} (${why}) was accepted as an id`)
      // Two escape spellings are both correct: JSON.stringify escapes C0 itself, and anything
      // it leaves raw is escaped afterwards in the braced form.
      const hex = cp.toString(16)
      assert.match(
        message,
        new RegExp(`\\\\u\\{${hex}\\}|\\\\u${hex.padStart(4, '0')}|\\\\[tn]`),
        `U+${hex} (${why}) reached the message unescaped: ${JSON.stringify(message)}`,
      )
    }
  })
})

// `;` is refused, and this file is where that is decided: `init-run` accepts it today, so the
// divergence is deliberate and has to fail visibly rather than by producing an unreadable record.
test('a semicolon and other punctuation outside the allowlist are refused', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    for (const taskId of [';', 'T1;rm', 'T1;', 'a,b', 'a+b', 'a=b', 'a!b', "a'b", 'a`b', 'a$b']) {
      await assert.rejects(
        writeLocation(root, 'r1', taskId, { worktree, branch: 'b' }),
        /is not a usable task id/,
        `${JSON.stringify(taskId)} was accepted`,
      )
      await plant(root, worktree, { runId: 'r1', taskId, worktree, branch: 'b' })
      assert.equal(await findTaskByWorktree(root, worktree), null, `${JSON.stringify(taskId)} was returned`)
    }
  })
})

// The control-character rule applies to the RESOLVED path, which is the one that gets stored.
// A link whose own name is ordinary can resolve to a target whose name is not.
test('a worktree resolving to a path with control characters is refused', {
  skip: process.platform === 'win32' ? 'POSIX only: NTFS forbids control characters in names' : false,
}, async (t) => {
  await withTempRoot(async (root) => {
    const target = path.join(root, `wt${String.fromCodePoint(0x0001)}dir`)
    try {
      await mkdir(target, { recursive: true })
    } catch (err) {
      t.skip(`this filesystem refuses control characters in names: ${err.code}`)
      return
    }
    const link = path.join(root, 'ordinary-link')
    await symlink(target, link, 'dir')
    // The link's own spelling is clean, so only a check on the resolved form can catch this.
    assert.doesNotMatch(link, /[\u0000-\u001f]/)
    assert.match(normaliseWorktree(link), /[\u0000-\u001f]/)
    await assert.rejects(
      writeLocation(root, 'r1', 'T1', { worktree: link, branch: 'teammates/r1/T1' }),
      /contains control characters/,
    )
  })
})

// The writer must refuse exactly what the reader refuses. A reader-dependent spelling recorded
// here would name whatever directory the writer happened to stand in; a UNC one would be stored
// and then rejected on every read, leaving a worktree silently unenforced.
test('writeLocation refuses a worktree the reader could never accept', async () => {
  await withTempRoot(async (root) => {
    for (const worktree of ['', null, undefined, 42, '.', 'relative/path', './wt/x', '\\\\host\\share\\wt', '//host/share/wt']) {
      await assert.rejects(
        writeLocation(root, 'r1', 'T1', { worktree, branch: 'b' }),
        /is not a path a record can name|which no record can name/,
        `worktree ${JSON.stringify(worktree)} was accepted by the writer`,
      )
    }
  })
})

test('writeLocation stores the normalised worktree, not the caller spelling', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    const written = await writeLocation(root, 'r1', 'T1', {
      worktree: `${worktree}${path.sep}`,
      branch: 'teammates/r1/T1',
    })
    const record = JSON.parse(await readFile(written, 'utf8'))
    assert.equal(record.worktree, normaliseWorktree(worktree))
    // Whatever is stored must satisfy the reader's own admission check and hash to this file.
    assert.equal(isLocalAbsolute(record.worktree), true)
    assert.equal(worktreeKey(record.worktree), path.basename(written, '.json'))
    assert.equal((await findTaskByWorktree(root, worktree)).taskId, 'T1')
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
    // `;` is absent: git accepts it in a ref and the consumer spawns an argv array, never a
    // shell, so the ref rule is the authority here rather than a shell-metacharacter list.
    for (const taskId of ['--force', '-rf', '--', '-', 'T1 --force', 'a b', 'T1\n', 'x'.repeat(129)]) {
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
// A runId reaches `complete --run <id>` in the consumer's argv, `refs/heads/<branch>` through
// taskBranchName, and the stderr a teammate is shown. `--no-fleet` alone makes that CLI print a
// usage dump and exit 2, which the specified handler maps to BLOCK — so the victim is blocked at
// every stop with a usage dump as its verdict, and the record's author controls both sides of
// the branch equality check, so nothing downstream catches it.
test('findTaskByWorktree skips a runId that is unusable as a token or escapes the store', async () => {
  await withTempRoot(async (root) => {
    const worktree = path.join(root, 'wt', 'agent-1')
    for (const runId of [
      '../..', '../escaped', '..', '.', '', 42, null, { id: 'r1' },
      '--no-fleet', '-r', 'a b', 'a\nb', '\u001b[2J\u001b[31mred', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'sub/../substop', 'sub//substop', 'sub/',
    ]) {
      await plant(root, worktree, { runId, taskId: 'T1', worktree, branch: 'b' })
      assert.equal(
        await findTaskByWorktree(root, worktree),
        null,
        `a record carrying runId ${JSON.stringify(runId)} was returned rather than skipped`,
      )
    }
    // A nested run id is legitimate — init-run creates them — so the guard must not refuse it.
    await plant(root, worktree, { runId: '2026/substop', taskId: 'T1', worktree, branch: 'b' })
    assert.equal((await findTaskByWorktree(root, worktree)).runId, '2026/substop')
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
  for (const p of [
    '//unreachable-host/share/w', '\\\\host\\share\\w', 'relative/path', '.', '..', '', null, undefined, 42, {},
    // A drive-letter-plus-separator INSIDE a UNC path. Without the `^` anchor these classify as
    // local and reach realpathSync.native on a network path — the multi-second stall this
    // predicate exists to prevent.
    '\\\\host\\share\\C:\\x', '//host/share/C:/x',
  ]) {
    assert.equal(isLocalAbsolute(p), false, `${JSON.stringify(p)} was classified as local`)
  }
  assert.equal(isLocalAbsolute(process.platform === 'win32' ? 'C:/x' : '/x'), true)
  assert.equal(isLocalAbsolute(process.platform === 'win32' ? 'C:\\x' : '/x/y'), true)
  if (process.platform === 'win32') {
    assert.equal(isLocalAbsolute('z:\\mapped'), true) // the stated residual: a mapped drive passes
    assert.equal(isLocalAbsolute('C:relative'), false) // drive-relative is not absolute
  }
})

// A RECORD's worktree is never realpath'd when it is UNC, which is what this pins: a hostile
// record cannot make the lookup wait on a network stack. The QUERY is a different matter and the
// claim here used to be wrong about it — `findTaskByWorktree` realpaths its query
// unconditionally, so this very test spends about a second on a name that fails DNS instantly,
// and the documented 26.8 s against an unreachable-but-resolvable host. That cost is ACCEPTED,
// not guarded: the query is the harness-supplied cwd of the agent that is stopping, so it is the
// directory the agent is genuinely in rather than anything an attacker chose, and refusing to
// resolve it would make a legitimate worktree on a network share permanently unfindable. What
// remains true is the narrower statement: a worktree on a share is not identifiable through a
// RECORD, so the hook fails open for it.
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
    // The shape that proves the cap is load-bearing rather than redundant with the bounded
    // read: a short, entirely valid record followed by whitespace past the cap. Truncating it
    // yields JSON that parses cleanly, so only the fstat'd size can reject this file.
    const padded = `${JSON.stringify({ runId: 'r1', taskId: 'T1', branch: 'teammates/r1/T1', worktree })}${' '.repeat(200_000)}`
    await plant(root, worktree, padded)
    assert.equal(JSON.parse(padded.slice(0, 64 * 1024)).taskId, 'T1', 'the truncated prefix must parse, or this pins nothing')
    assert.equal(await findTaskByWorktree(root, worktree), null)
    await plant(root, worktree, {
      runId: 'r1', taskId: 'T1', branch: 'teammates/r1/T1', worktree, pad: 'x'.repeat(200_000),
    })
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
    // A directory in place of a record: the outcome must be null and no throw, whichever of the
    // open, the fstat or the read is what refuses it.
    await mkdir(recordPath(root, worktree), { recursive: true })
    await assert.doesNotReject(findTaskByWorktree(root, worktree))
    assert.equal(await findTaskByWorktree(root, worktree), null)
  })
})

// A FIFO in place of a record must not hang the lookup. Opening one for reading blocks until a
// writer arrives unless O_NONBLOCK is set, and a hook that never returns is enforcement switched
// off with no error anywhere — so this races the lookup against a timer and fails loudly rather
// than hanging the runner. POSIX only, because win32 has no FIFO.
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
  const idsAt = body.indexOf('isTaskId(root, record.taskId)')
  const resolveAt = body.indexOf('worktreeKey(record.worktree)')
  assert.notEqual(idsAt, -1, 'the taskId check is gone')
  assert.notEqual(body.indexOf('isRunId(root, record.runId)'), -1, 'the runId check is gone')
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
