// Drives scripts/subagent-stop.mjs the way the harness does: as a child process with a JSON
// payload on stdin, reading its exit status and stderr. Nothing here imports the handler as a
// module, because the contract under test is the process contract — 0 allows the stop, 2 blocks
// it — and an import would test a function the harness never calls.
//
// Every case that gets as far as a location record runs the handler from inside a REAL linked
// worktree, because that is the only configuration a dispatched teammate is ever in. Running
// them from the main worktree was the earlier shape of this file and it left the whole path
// resolution untested: `--git-dir` in place of `--git-common-dir` kept the suite green while
// resolving every teammate's root to `<main>/.git/worktrees/<name>`, where no record is ever
// found and every teammate in the run stops unchallenged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeLocation, writeState } from '../scripts/state.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const handler = path.join(repoRoot, 'scripts', 'subagent-stop.mjs')

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// A real repository, because every branch of the handler after the payload check is decided by
// git. The root is read back out of git rather than assumed from mkdtemp: on both platforms the
// temp directory can be reached by a path that differs from the one git prints (a symlinked
// /var, an 8.3 short name), and the handler derives its root from git — so a test that composed
// the root itself would write its records where the handler never looks.
//
// Async, and the body is awaited before the cleanup runs: a synchronous try/finally around an
// async callback removes the repository while the case is still using it, and every assertion
// then reports the fail-open answer rather than the one under test.
async function withRepo(fn) {
  const parent = mkdtempSync(path.join(tmpdir(), 'tm-substop-'))
  const dir = path.join(parent, 'main')
  try {
    mkdirSync(dir)
    git(['init', '--initial-branch=master'], dir)
    git(['config', 'user.email', 'test@example.com'], dir)
    git(['config', 'user.name', 'test'], dir)
    writeFileSync(path.join(dir, 'seed.txt'), 'seed\n')
    git(['add', '.'], dir)
    git(['commit', '-m', 'seed'], dir)
    const root = path.dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir))
    // Created as a SIBLING of the main worktree, so no prefix relationship between the two
    // paths can make a wrong root accidentally resolve.
    const addWorktree = (name) => {
      const at = path.join(parent, name)
      git(['worktree', 'add', '--detach', at], dir)
      return at
    }
    return await fn({ dir, root, parent, addWorktree })
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5 })
  }
}

function run(payload, { cwd = repoRoot, script = handler, env = {} } = {}) {
  return spawnSync(process.execPath, [script], {
    cwd,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  })
}

// A copy of scripts/ whose cli.mjs is a stub. The handler resolves the CLI relative to its own
// file, so replacing that one file in a copied tree is what makes the spawned invocation
// observable — the alternative, running the real CLI, would test the CLI rather than the argv
// this handler builds, and the flag most worth pinning is the one whose absence shows up only
// as a hook timeout.
//
// It is also the ran/never-ran discriminator for every case whose subject is an EARLY allow:
// "exit 0" alone is the same observation whether the guard fired or the handler ran the whole
// sequence and was let through, so those cases assert on the argv file's existence instead.
function withStubCli(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tm-substop-cli-'))
  try {
    cpSync(path.join(repoRoot, 'scripts'), path.join(dir, 'scripts'), { recursive: true })
    const argvOut = path.join(dir, 'argv.json')
    writeFileSync(path.join(dir, 'scripts', 'cli.mjs'), [
      'import { writeFileSync } from "node:fs"',
      'writeFileSync(process.env.TM_STUB_ARGV_OUT, JSON.stringify(process.argv.slice(2)))',
      'if (process.env.TM_STUB_STDOUT) process.stdout.write(process.env.TM_STUB_STDOUT)',
      'process.exit(Number(process.env.TM_STUB_EXIT ?? 0))',
      '',
    ].join('\n'))
    return fn({ script: path.join(dir, 'scripts', 'subagent-stop.mjs'), argvOut })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('unparseable stdin allows the stop', () => {
  const result = run('not json at all')
  assert.equal(result.status, 0)
})

test('an empty payload allows the stop', () => {
  assert.equal(run({}).status, 0)
})

test('a cwd outside any repository allows the stop', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tm-substop-bare-'))
  try {
    assert.equal(run({ cwd: dir }).status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a repository with no .teammates directory allows the stop', async () => {
  await withRepo(({ dir }) => {
    assert.equal(run({ cwd: dir }).status, 0)
  })
})

test('a linked worktree with no location record allows the stop', async () => {
  await withRepo(async ({ dir, addWorktree }) => {
    const wt = addWorktree('agent-1')
    await writeState(path.dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)),
      'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    assert.equal(run({ cwd: wt }).status, 0)
  })
})

test('stop_hook_active allows the stop even when the task would otherwise be blocked', async () => {
  await withRepo(async ({ root, addWorktree }) => {
    const wt = addWorktree('agent-1')
    await writeLocation(root, 'r1', 'T1', { worktree: wt, branch: 'worktree-agent-abc' })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    // Same payload as the blocking case below, plus the flag. One stop costs one forced retry.
    assert.equal(run({ cwd: wt, stop_hook_active: true }).status, 0)
  })
})

test('a teammate worktree with no task branch blocks the stop and names task and branch', async () => {
  await withRepo(async ({ root, addWorktree }) => {
    const wt = addWorktree('agent-1')
    await writeLocation(root, 'r1', 'T1', { worktree: wt, branch: 'worktree-agent-abc' })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    const result = run({ cwd: wt })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /T1/)
    assert.match(result.stderr, /teammates\/r1\/T1/)
  })
})

// The remediation may NAME the missing ref and must not send anyone to create or commit to it:
// the record's ids are attacker-chosen, so the honest construction can resolve to another task's
// branch, and a victim that obeyed would land its commits where fileset and ownership read them
// as that task's work. The trustworthy source of the branch name is the teammate's own brief.
test('the remediation names no command and sends the teammate to its brief', async () => {
  await withRepo(async ({ root, addWorktree }) => {
    const wt = addWorktree('agent-1')
    await writeLocation(root, 'r1', 'T1', { worktree: wt, branch: null })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    const { stderr } = run({ cwd: wt })
    assert.doesNotMatch(stderr, /git checkout/)
    assert.doesNotMatch(stderr, /checkout -B/)
    assert.doesNotMatch(stderr, /git commit/)
    assert.match(stderr, /brief/i)
  })
})

// A record naming the MAIN worktree is bogus under this project's own rule that no teammate
// works there, and honouring one turns the next unrelated subagent that stops into the victim:
// blocked, and told to commit to a ref the record chose. The record here is otherwise perfect —
// it names the directory it is filed under, and the task branch genuinely does not exist — so
// the guard is the only thing standing between this and a block.
test('a record naming the main worktree is ignored rather than obeyed', async () => {
  await withRepo(async ({ dir, root }) => {
    await writeLocation(root, 'r1', 'T1', { worktree: dir, branch: null })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    const result = run({ cwd: dir })
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
  })
})

// The planPath guard, with a ran/never-ran discriminator rather than exit 0 alone. This is the
// case that kills its deletion: an empty planPath is a string, so without the guard the spawn
// is well-formed and the stub runs.
test('a plan recording an empty planPath allows the stop without running complete', async () => {
  await withRepo(async ({ root, addWorktree }) => {
    const wt = addWorktree('agent-1')
    git(['branch', 'teammates/r1/T1'], path.join(path.dirname(wt), 'main'))
    await writeLocation(root, 'r1', 'T1', { worktree: wt, branch: 'teammates/r1/T1' })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: '' })
    withStubCli(({ script, argvOut }) => {
      const result = run({ cwd: wt }, { script, env: { TM_STUB_ARGV_OUT: argvOut, TM_STUB_EXIT: '0' } })
      assert.equal(result.status, 0)
      assert.equal(existsSync(argvOut), false, 'complete was spawned despite no plan path')
    })
  })
})

// The same guard reached through a missing key and through no run state at all. These
// discriminate deletion too, for a reason worth writing down because the opposite was assumed
// here first and measured false: `spawnSync` does not reject a non-string argument, it
// stringifies it, so without the guard the handler runs `complete --plan undefined` against a
// plan path that names nothing. Verified by execution, node v24.
test('a run whose plan records no planPath allows the stop without running complete', async () => {
  await withRepo(async ({ dir, root, addWorktree }) => {
    const wt = addWorktree('agent-1')
    git(['branch', 'teammates/r1/T1'], dir)
    await writeLocation(root, 'r1', 'T1', { worktree: wt, branch: 'teammates/r1/T1' })
    await writeState(root, 'r1', 'plan', { runId: 'r1' })
    withStubCli(({ script, argvOut }) => {
      const result = run({ cwd: wt }, { script, env: { TM_STUB_ARGV_OUT: argvOut, TM_STUB_EXIT: '0' } })
      assert.equal(result.status, 0)
      assert.equal(existsSync(argvOut), false, 'complete was spawned despite no plan path')
    })
  })
})

test('a recorded worktree with no run state at all allows the stop without running complete', async () => {
  await withRepo(async ({ dir, root, addWorktree }) => {
    const wt = addWorktree('agent-1')
    git(['branch', 'teammates/r1/T1'], dir)
    await writeLocation(root, 'r1', 'T1', { worktree: wt, branch: 'teammates/r1/T1' })
    withStubCli(({ script, argvOut }) => {
      const result = run({ cwd: wt }, { script, env: { TM_STUB_ARGV_OUT: argvOut, TM_STUB_EXIT: '0' } })
      assert.equal(result.status, 0)
      assert.equal(existsSync(argvOut), false, 'complete was spawned despite no run state')
    })
  })
})

// The fail-open of last resort, reached through a real crash rather than a simulated one:
// `readState` throws a SyntaxError on malformed JSON (verified by execution), which nothing
// between it and the terminal handler catches. A teammate must not be blocked because someone
// else's state file is corrupt.
test('a malformed plan.json allows the stop rather than crashing into a block', async () => {
  await withRepo(async ({ dir, root, addWorktree }) => {
    const wt = addWorktree('agent-1')
    git(['branch', 'teammates/r1/T1'], dir)
    await writeLocation(root, 'r1', 'T1', { worktree: wt, branch: 'teammates/r1/T1' })
    mkdirSync(path.join(root, '.teammates', 'r1'), { recursive: true })
    writeFileSync(path.join(root, '.teammates', 'r1', 'plan.json'), '{ not json at all')
    assert.equal(run({ cwd: wt }).status, 0)
  })
})

test('the spawned complete invocation carries --enforcement-only and the main root', async () => {
  await withRepo(async ({ dir, root, addWorktree }) => {
    const wt = addWorktree('agent-1')
    git(['branch', 'teammates/r1/T1'], dir)
    await writeLocation(root, 'r1', 'T1', { worktree: wt, branch: 'teammates/r1/T1' })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    withStubCli(({ script, argvOut }) => {
      const result = run({ cwd: wt }, { script, env: { TM_STUB_ARGV_OUT: argvOut, TM_STUB_EXIT: '0' } })
      assert.equal(result.status, 0)
      const argv = JSON.parse(readFileSync(argvOut, 'utf8'))
      assert.equal(argv[0], 'complete')
      assert.ok(argv.includes('--enforcement-only'), `argv was ${JSON.stringify(argv)}`)
      assert.equal(argv[argv.indexOf('--run') + 1], 'r1')
      assert.equal(argv[argv.indexOf('--task') + 1], 'T1')
      assert.equal(argv[argv.indexOf('--plan') + 1], 'docs/plan.md')
      // The MAIN worktree, computed by the handler from inside a linked one. `complete` run
      // against the linked worktree would resolve the run branch to the task's own branch and
      // answer a different question.
      assert.equal(argv[argv.indexOf('--root') + 1], root)
    })
  })
})

// 3 is the rejection-specific code `complete --enforcement-only` returns when a TASK-SCOPED
// check rejects. It is the only code that blocks.
test('complete exiting 3 blocks the stop and returns its output as the reason', async () => {
  await withRepo(async ({ dir, root, addWorktree }) => {
    const wt = addWorktree('agent-1')
    git(['branch', 'teammates/r1/T1'], dir)
    await writeLocation(root, 'r1', 'T1', { worktree: wt, branch: 'teammates/r1/T1' })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    withStubCli(({ script, argvOut }) => {
      const result = run({ cwd: wt }, {
        script,
        env: { TM_STUB_ARGV_OUT: argvOut, TM_STUB_EXIT: '3', TM_STUB_STDOUT: 'fileset: T1 touched scripts/cli.mjs' },
      })
      assert.equal(result.status, 2)
      assert.match(result.stderr, /fileset: T1 touched scripts\/cli\.mjs/)
    })
  })
})

// Every other code allows, 2 and 4 included: 2 is a malformed manifest OR an argv error, and 4
// is a cannot-verify OR a run-wide failure this teammate cannot reach from its own worktree.
// Neither may cost it a turn.
for (const code of ['0', '1', '2', '4', '5']) {
  test(`complete exiting ${code} allows the stop`, async () => {
    await withRepo(async ({ dir, root, addWorktree }) => {
      const wt = addWorktree('agent-1')
      git(['branch', 'teammates/r1/T1'], dir)
      await writeLocation(root, 'r1', 'T1', { worktree: wt, branch: 'teammates/r1/T1' })
      await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
      withStubCli(({ script, argvOut }) => {
        const result = run({ cwd: wt }, {
          script,
          env: { TM_STUB_ARGV_OUT: argvOut, TM_STUB_EXIT: code, TM_STUB_STDOUT: 'some output' },
        })
        assert.equal(result.status, 0)
        // Not vacuous: an allow reached by never spawning `complete` at all is the same exit
        // status as an allow reached by reading its code, and this case is about the code.
        assert.equal(JSON.parse(readFileSync(argvOut, 'utf8'))[0], 'complete')
      })
    })
  })
}

// The handler fires for every subagent on the machine, including agents in unrelated projects,
// so the path that answers "not a teammate" is the one whose cost everyone pays. The count is
// measured, not asserted in prose: GIT_TRACE2_EVENT makes every git process this handler starts
// append a "start" event, so an added call is visible even though it costs milliseconds.
test('the no-op path starts exactly one git process and spawns no bash', async () => {
  const source = readFileSync(handler, 'utf8')
  assert.doesNotMatch(source, /\bbash\b/)
  assert.doesNotMatch(source, /\bsh -c\b/)
  await withRepo(async ({ dir, parent, addWorktree }) => {
    const wt = addWorktree('agent-1')
    for (const [name, cwd] of [['main worktree', dir], ['linked worktree', wt]]) {
      const trace = path.join(parent, `trace-${name.split(' ')[0]}.json`)
      const result = run({ cwd }, { env: { GIT_TRACE2_EVENT: trace } })
      assert.equal(result.status, 0)
      const starts = readFileSync(trace, 'utf8').split('\n').filter((l) => l.includes('"event":"start"'))
      assert.equal(starts.length, 1, `${name}: ${starts.length} git processes, expected 1`)
    }
  })
})

test('the no-op path finishes quickly', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tm-substop-cheap-'))
  try {
    const started = Date.now()
    assert.equal(run({ cwd: dir }).status, 0)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `no-op path took ${elapsed}ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
