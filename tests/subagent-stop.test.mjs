// Drives scripts/subagent-stop.mjs the way the harness does: as a child process with a JSON
// payload on stdin, reading its exit status and stderr. Nothing here imports the handler as a
// module, because the contract under test is the process contract — 0 allows the stop, 2 blocks
// it — and an import would test a function the harness never calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
// Async, and the body is awaited before the cleanup runs: a synchronous try/finally around an
// async callback removes the repository while the case is still using it, and every assertion
// then reports the fail-open answer rather than the one under test.
async function withRepo(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tm-substop-'))
  try {
    git(['init', '--initial-branch=master'], dir)
    git(['config', 'user.email', 'test@example.com'], dir)
    git(['config', 'user.name', 'test'], dir)
    writeFileSync(path.join(dir, 'seed.txt'), 'seed\n')
    git(['add', '.'], dir)
    git(['commit', '-m', 'seed'], dir)
    const root = path.dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir))
    return await fn({ dir, root })
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
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

test('stop_hook_active allows the stop even when the task would otherwise be blocked', async () => {
  await withRepo(async ({ dir, root }) => {
    await writeLocation(root, 'r1', 'T1', { worktree: dir, branch: 'worktree-agent-abc' })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    // Same payload as the blocking case below, plus the flag. One stop costs one forced retry.
    assert.equal(run({ cwd: dir, stop_hook_active: true }).status, 0)
  })
})

test('a recorded worktree with no task branch blocks the stop and names task and branch', async () => {
  await withRepo(async ({ dir, root }) => {
    await writeLocation(root, 'r1', 'T1', { worktree: dir, branch: 'worktree-agent-abc' })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    const result = run({ cwd: dir })
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
  await withRepo(async ({ dir, root }) => {
    await writeLocation(root, 'r1', 'T1', { worktree: dir, branch: null })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    const { stderr } = run({ cwd: dir })
    assert.doesNotMatch(stderr, /git checkout/)
    assert.doesNotMatch(stderr, /checkout -B/)
    assert.doesNotMatch(stderr, /git commit/)
    assert.match(stderr, /brief/i)
  })
})

test('a run whose plan records no planPath allows the stop', async () => {
  await withRepo(async ({ dir, root }) => {
    git(['branch', 'teammates/r1/T1'], dir)
    await writeLocation(root, 'r1', 'T1', { worktree: dir, branch: 'teammates/r1/T1' })
    await writeState(root, 'r1', 'plan', { runId: 'r1' })
    assert.equal(run({ cwd: dir }).status, 0)
  })
})

test('a recorded worktree with no run state at all allows the stop', async () => {
  await withRepo(async ({ dir, root }) => {
    git(['branch', 'teammates/r1/T1'], dir)
    await writeLocation(root, 'r1', 'T1', { worktree: dir, branch: 'teammates/r1/T1' })
    assert.equal(run({ cwd: dir }).status, 0)
  })
})

test('the spawned complete invocation carries --enforcement-only and the run context', async () => {
  await withRepo(async ({ dir, root }) => {
    git(['branch', 'teammates/r1/T1'], dir)
    await writeLocation(root, 'r1', 'T1', { worktree: dir, branch: 'teammates/r1/T1' })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    withStubCli(({ script, argvOut }) => {
      const result = run({ cwd: dir }, { script, env: { TM_STUB_ARGV_OUT: argvOut, TM_STUB_EXIT: '0' } })
      assert.equal(result.status, 0)
      const argv = JSON.parse(readFileSync(argvOut, 'utf8'))
      assert.equal(argv[0], 'complete')
      assert.ok(argv.includes('--enforcement-only'), `argv was ${JSON.stringify(argv)}`)
      assert.equal(argv[argv.indexOf('--run') + 1], 'r1')
      assert.equal(argv[argv.indexOf('--task') + 1], 'T1')
      assert.equal(argv[argv.indexOf('--plan') + 1], 'docs/plan.md')
      assert.equal(argv[argv.indexOf('--root') + 1], root)
    })
  })
})

// 3 is the rejection-specific code `complete --enforcement-only` returns when the recomputed
// enforcement checks reject. It is the only code that blocks.
test('complete exiting 3 blocks the stop and returns its output as the reason', async () => {
  await withRepo(async ({ dir, root }) => {
    git(['branch', 'teammates/r1/T1'], dir)
    await writeLocation(root, 'r1', 'T1', { worktree: dir, branch: 'teammates/r1/T1' })
    await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
    withStubCli(({ script, argvOut }) => {
      const result = run({ cwd: dir }, {
        script,
        env: { TM_STUB_ARGV_OUT: argvOut, TM_STUB_EXIT: '3', TM_STUB_STDOUT: 'fileset: T1 touched scripts/cli.mjs' },
      })
      assert.equal(result.status, 2)
      assert.match(result.stderr, /fileset: T1 touched scripts\/cli\.mjs/)
    })
  })
})

// Every other code allows, 2 and 4 included: 2 is a malformed manifest OR an argv error and 4 is
// a cannot-verify, and a fact about the run's configuration must never cost a teammate a turn.
for (const code of ['0', '1', '2', '4', '5']) {
  test(`complete exiting ${code} allows the stop`, async () => {
    await withRepo(async ({ dir, root }) => {
      git(['branch', 'teammates/r1/T1'], dir)
      await writeLocation(root, 'r1', 'T1', { worktree: dir, branch: 'teammates/r1/T1' })
      await writeState(root, 'r1', 'plan', { runId: 'r1', planPath: 'docs/plan.md' })
      withStubCli(({ script, argvOut }) => {
        const result = run({ cwd: dir }, {
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
// so the path that answers "not a teammate" is the one whose cost everyone pays.
test('the no-op path spawns no bash and finishes quickly', () => {
  const source = readFileSync(handler, 'utf8')
  assert.doesNotMatch(source, /\bbash\b/)
  assert.doesNotMatch(source, /\bsh -c\b/)
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
