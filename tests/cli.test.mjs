import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runCli } from '../scripts/cli.mjs'

const PLAN = `### Task 1: A

**Files:**
- Create: \`a.mjs\`

### Task 2: B

**Files:**
- Create: \`b.mjs\`

**Depends:** T1
`

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// Every derived command (gate without --no-fleet, complete) needs a real git repository:
// deriveContext reads the plan from the merge-base commit, not the working tree, so a
// fake or missing repo cannot exercise it. The repo starts with a committed plan.md and
// package.json so the anchor commit always has something to derive from.
//
// The repo is left checked out on `run-branch`, a distinct branch off `main` — not on
// `main` itself. `derive()` refuses to run when the current branch and the base branch
// are the same name (a gate run from the base branch is always vacuous: merge-base(X, X)
// is X's own tip, so every diff and commit range is empty). A test that wants to exercise
// that specific guard checks out `main` itself before calling gate/complete.
async function withRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-cli-'))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  const planPath = path.join(root, 'plan.md')
  await writeFile(planPath, PLAN, 'utf8')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
  // Ignored so that init-run's own state files (.teammates/<runId>/*.json) never make the
  // ownership check see an untracked, "dirty" worktree — the same as any real project
  // adopting this tooling would configure.
  await writeFile(path.join(root, '.gitignore'), '.teammates/\n', 'utf8')
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', 'initial'])
  git(root, ['checkout', '--quiet', '-b', 'run-branch'])
  const lines = []
  const io = { out: (t) => lines.push(t) }
  try {
    await fn({ root, planPath, io, lines, git: (args) => git(root, args) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function readStatus(root, runId) {
  return JSON.parse(await readFile(path.join(root, '.teammates', runId, 'status.json'), 'utf8'))
}

// Writes a fileset+ownership gate manifest so `gate`/`complete` exercise the derived
// checks. `--no-fleet` strips fileset/ownership regardless of what the manifest contains.
async function writeEnforcementManifest(root) {
  await writeFile(
    path.join(root, 'teammates.gate.json'),
    JSON.stringify({
      phases: {
        default: {
          checks: [
            { name: 'noop', kind: 'command', run: 'node -e ""' },
            { name: 'fileset', kind: 'fileset' },
            { name: 'ownership', kind: 'ownership' },
          ],
        },
      },
    }),
    'utf8',
  )
}

test('init-run writes plan and status and reports phases', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    const code = await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /phase 1: T1/)
    assert.match(lines.join('\n'), /phase 2: T2/)
  })
})

test('digest renders from the status written by init-run', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(['digest', '--run', 'r1', '--root', root], io)
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /run r1 · phase 1\/2 · 2 tasks/)
  })
})

test('claim reports claimed once then taken', async () => {
  await withRepo(async ({ root, io, lines }) => {
    assert.equal(await runCli(['claim', '--run', 'r1', '--task', 'T1', '--by', 'a', '--root', root], io), 0)
    assert.equal(await runCli(['claim', '--run', 'r1', '--task', 'T1', '--by', 'b', '--root', root], io), 1)
    assert.deepEqual(lines, ['claimed', 'taken'])
  })
})

test('unclaim releases a task so it can be claimed again', async () => {
  await withRepo(async ({ root, io }) => {
    assert.equal(await runCli(['claim', '--run', 'r1', '--task', 'T1', '--by', 'a', '--root', root], io), 0)
    assert.equal(await runCli(['unclaim', '--run', 'r1', '--task', 'T1', '--root', root], io), 0)
    assert.equal(await runCli(['claim', '--run', 'r1', '--task', 'T1', '--by', 'b', '--root', root], io), 0)
  })
})

test('workflow prints generated source for a phase', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /export const meta = \{/)
  })
})

test('init-run uses maxParallel from the gate manifest when present', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ maxParallel: 2, phases: { default: { checks: [] } } }),
      'utf8',
    )
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const status = await readStatus(root, 'r1')
    assert.equal(status.maxParallel, 2)
  })
})

test('workflow uses maxParallel from the gate manifest when present', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ maxParallel: 2, phases: { default: { checks: [] } } }),
      'utf8',
    )
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.match(lines.join('\n'), /max 2 parallel/)
  })
})

test('gate with no manifest prints the inferred config for confirmation', async () => {
  await withRepo(async ({ root, io, lines }) => {
    // package.json already committed by withRepo carries no scripts; overwrite with one that does.
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8')
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root], io)
    assert.equal(code, 3)
    assert.match(lines.join('\n'), /inferred gate manifest/)
    assert.match(lines.join('\n'), /"name": "test"/)
  })
})

test('gate reports a JSON verdict when a manifest exists', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const config = { maxParallel: 2, phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(config), 'utf8')
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root], io)
    const parsed = JSON.parse(lines[lines.length - 1])
    assert.equal(parsed.verdict, 'PASS')
    assert.equal(code, 0)
  })
})

test('gate records a PASS verdict into status.json for the run', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const config = { maxParallel: 2, phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(config), 'utf8')
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root], io)
    assert.equal(code, 0)
    const status = await readStatus(root, 'r1')
    // A solo (--no-fleet) verdict never derived an anchor, so it is recorded under a
    // `solo:` key distinct from a real, derived phase record — see the `gateKey` comment
    // in cli.mjs.
    assert.equal(status.gates['solo:default'].verdict, 'PASS')
    assert.ok(typeof status.gates['solo:default'].recordedAt === 'number')
  })
})

test('gate records a FAIL verdict into status.json for the run', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const config = { maxParallel: 2, phases: { default: { checks: [{ name: 'boom', kind: 'command', run: 'node -e "process.exit(1)"' }] } } }
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(config), 'utf8')
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root], io)
    assert.equal(code, 1)
    const status = await readStatus(root, 'r1')
    assert.equal(status.gates['solo:default'].verdict, 'FAIL')
    assert.deepEqual(status.gates['solo:default'].failed, ['boom'])
  })
})

test('gate with no status file for the run does not create one and still returns the right exit code', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const config = { maxParallel: 2, phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(config), 'utf8')
    const code = await runCli(['gate', '--run', 'nope', '--plan', 'plan.md', '--no-fleet', '--root', root], io)
    assert.equal(code, 0)
    await assert.rejects(
      readFile(path.join(root, '.teammates', 'nope', 'status.json'), 'utf8'),
    )
  })
})

test('an unknown subcommand prints usage and exits 2', async () => {
  await withRepo(async ({ io, lines }) => {
    assert.equal(await runCli(['nope'], io), 2)
    assert.match(lines.join('\n'), /usage: cli\.mjs/)
  })
})

test('digest with no --run reports a missing argument instead of crashing', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['digest', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /missing required argument/)
    assert.match(lines.join('\n'), /--run/)
  })
})

test('claim with --run but no --task or --by names both missing flags', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['claim', '--run', 'r1', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /missing required argument/)
    assert.match(lines.join('\n'), /--task/)
    assert.match(lines.join('\n'), /--by/)
  })
})

test('init-run with --run but no plan path names <planPath>', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['init-run', '--run', 'r1', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /missing required argument/)
    assert.match(lines.join('\n'), /<planPath>/)
  })
})

test('workflow with a non-integer --phase returns 2 rather than generating anything', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(['workflow', '--run', 'r1', '--phase', 'abc', '--root', root], io)
    assert.equal(code, 2)
    assert.doesNotMatch(lines.join('\n'), /export const meta/)
  })
})

test('integrated is no longer a command and exits 2', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['integrated', '--run', 'r1', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /usage: cli\.mjs/)
  })
})

test('gate without --plan exits 2 naming --plan', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['gate', '--run', 'r1', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /missing required argument/)
    assert.match(lines.join('\n'), /--plan/)
  })
})

test('gate --no-fleet runs neither enforcement check and says so on stdout', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    await writeEnforcementManifest(root)
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root], io)
    assert.equal(code, 0)
    const out = lines.join('\n')
    assert.match(out, /--no-fleet: enforcement checks are not running/)
    const parsed = JSON.parse(lines[lines.length - 1])
    assert.equal(parsed.verdict, 'PASS')
    assert.deepEqual(parsed.results.map((r) => r.kind), ['command'])
  })
})

test('gate with a plan path absent at the anchor exits 1 with a derive error rather than passing', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    await writeEnforcementManifest(root)
    // missing-plan.md exists nowhere, not even in the working tree, so it is certainly
    // absent at the anchor commit — deriveContext must fail, not silently pass.
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'missing-plan.md', '--root', root], io)
    assert.equal(code, 1)
    const parsed = JSON.parse(lines.join('\n'))
    assert.equal(parsed.verdict, 'FAIL')
    assert.deepEqual(parsed.failed, ['derive'])
  })
})

test('complete exits 4 when the recomputed gate fails', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    // No task branch (teammates/r1/T1) exists yet, so the fileset check the recomputed
    // gate runs fails naming the missing branch.
    await writeEnforcementManifest(root)
    lines.length = 0
    const code = await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(code, 4)
    assert.match(lines.join('\n'), /gate does not pass for phase/)
    const status = await readStatus(root, 'r1')
    assert.equal(status.tasks.find((t) => t.id === 'T1').state, 'pending')
  })
})

test('complete exits 0 and marks the task done when it passes', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    // A manifest with only a command check: nothing here depends on task branches
    // existing, so the recomputed gate passes cleanly.
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }),
      'utf8',
    )
    lines.length = 0
    const code = await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /T1 done/)
    const status = await readStatus(root, 'r1')
    assert.equal(status.tasks.find((t) => t.id === 'T1').state, 'done')
  })
})

test('complete ignores a forged status.gates PASS', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    // Forge a PASS a teammate could have written by hand, papering over the missing
    // task branch that the real fileset check below would reject. `gate` writes
    // phase-number keys (see `gateKey` in cli.mjs), not the manifest's phase name, so the
    // forgery has to land under the key `complete` would actually be tempted to trust —
    // phase 1, since neither T1 nor T2 has started.
    const status = await readStatus(root, 'r1')
    status.gates = { 1: { verdict: 'PASS', failed: [], skipped: [], pending: [], recordedAt: Date.now() } }
    await writeFile(path.join(root, '.teammates', 'r1', 'status.json'), `${JSON.stringify(status, null, 2)}\n`, 'utf8')
    await writeEnforcementManifest(root)

    lines.length = 0
    const code = await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--root', root], io)
    // The exit code reflects recomputation, not the forged file: complete never reads
    // status.gates at all.
    assert.equal(code, 4)
    const after = await readStatus(root, 'r1')
    assert.equal(after.tasks.find((t) => t.id === 'T1').state, 'pending')
  })
})

// --- Review round: HIGH — resolveBaseBranch must not silently choose between two
// candidate base branches. Creating a branch named `main` is the same ref-creation
// primitive as the tag-shadowing bypass this design already closed elsewhere: it lets
// an attacker choose which ref the anchor is computed against.
test('gate refuses to guess the base branch when both main and master exist and --base is not given', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: gitCmd }) => {
    // withRepo leaves the repo checked out on `run-branch`, off `main`; add `master` too
    // so both base candidates exist.
    gitCmd(['branch', 'master'])
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    await writeEnforcementManifest(root)
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(code, 1)
    const parsed = JSON.parse(lines.join('\n'))
    assert.equal(parsed.verdict, 'FAIL')
    assert.match(parsed.error, /ambiguous/i)
    assert.match(parsed.error, /--base/)
  })
})

test('gate accepts an explicit --base when both main and master exist', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: gitCmd }) => {
    gitCmd(['branch', 'master'])
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }),
      'utf8',
    )
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--base', 'master', '--root', root], io)
    assert.equal(code, 0)
  })
})

// --- Review round: L2 — --base had no coverage proving it is actually read rather than
// ignored (deleting `if (flag) return flag` from resolveBaseBranch would leave the suite
// green). Naming a branch resolveBaseBranch's main/master heuristic would never guess on
// its own proves the flag's value reaches deriveContext.
test('--base is honoured even when it names a branch that is neither main nor master', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: gitCmd }) => {
    gitCmd(['branch', 'trunk'])
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }),
      'utf8',
    )
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--base', 'trunk', '--root', root], io)
    assert.equal(code, 0)
    const parsed = JSON.parse(lines.join('\n'))
    assert.equal(parsed.verdict, 'PASS')
  })
})

// --- Review round: H4 — a gate run from the base branch itself must fail closed, not
// return a vacuous PASS. merge-base(X, X) is X's own tip, so every diff and commit range
// is empty and both enforcement checks pass trivially with nothing actually verified.
test('gate fails when the current branch is the base branch itself', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: gitCmd }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    gitCmd(['checkout', '--quiet', 'main'])
    lines.length = 0
    await writeEnforcementManifest(root)
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(code, 1)
    const parsed = JSON.parse(lines.join('\n'))
    assert.equal(parsed.verdict, 'FAIL')
    assert.match(parsed.error, /run branch/i)
    assert.match(parsed.error, /base branch/i)
  })
})

test('complete fails when the current branch is the base branch itself', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: gitCmd }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    gitCmd(['checkout', '--quiet', 'main'])
    await writeEnforcementManifest(root)
    lines.length = 0
    const code = await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(code, 4)
    assert.match(lines.join('\n'), /run branch/i)
  })
})

// --- Review round: H2 — --no-fleet never derives anything, so it must not require
// --plan or --run at all. Requiring either only teaches a caller to invent a throwaway
// value to get past the argument check.
test('gate --no-fleet needs neither --plan nor --run', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }),
      'utf8',
    )
    const code = await runCli(['gate', '--no-fleet', '--root', root], io)
    assert.equal(code, 0)
    const parsed = JSON.parse(lines[lines.length - 1])
    assert.equal(parsed.verdict, 'PASS')
  })
})

// --- Review round: M2 — complete must surface the failing checks' own output, not just
// their bare names, or a teammate cannot tell what actually went wrong.
test('complete prints the failing checks\' output, not just their names', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeEnforcementManifest(root)
    lines.length = 0
    const code = await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(code, 4)
    const out = lines.join('\n')
    assert.match(out, /gate does not pass for phase/)
    // The summary line only lists check names ("fileset"); the actual diagnostic — which
    // branch is missing — lives in the check's own output and must also be printed.
    assert.match(out, /does not exist/)
  })
})

// --- Review round: M3 — complete must verify only the calling task, not the whole
// phase. runFilesetCheck walks every task in the current phase, so with the unscoped
// context a sibling that has not started always blocks the teammate who has finished.
const TWO_TASK_SAME_PHASE_PLAN = `### Task 1: A

**Files:**
- Create: \`a.mjs\`

### Task 2: B

**Files:**
- Create: \`b.mjs\`
`

test('complete verifies only the calling task — a sibling with no branch does not block it', async () => {
  await withRepo(async ({ root, io, lines, git: gitCmd }) => {
    const planPath = path.join(root, 'plan.md')
    // Commit the two-task plan and the gate manifest on `main`, then fast-forward
    // `run-branch` onto it — both must be part of the anchor commit itself. Committing
    // them directly on `run-branch` instead would make the anchor (main's older tip)
    // predate them, so a task branch cut from `run-branch` would carry their diffs too
    // and the fileset check would reject plan.md as an undeclared file. Leaving the gate
    // manifest untracked would make the ownership check see a dirty worktree and fail for
    // an unrelated reason.
    gitCmd(['checkout', '--quiet', 'main'])
    await writeFile(planPath, TWO_TASK_SAME_PHASE_PLAN, 'utf8')
    await writeEnforcementManifest(root)
    gitCmd(['add', 'plan.md', 'teammates.gate.json'])
    gitCmd(['commit', '--quiet', '-m', 'two-task same-phase plan and gate manifest'])
    gitCmd(['checkout', '--quiet', 'run-branch'])
    gitCmd(['merge', '--quiet', '--ff-only', 'main'])

    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)

    // T1 finishes its own work on its own task branch; T2 has not started at all — no
    // branch named teammates/r1/T2 exists anywhere.
    gitCmd(['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    gitCmd(['add', 'a.mjs'])
    gitCmd(['commit', '--quiet', '-m', 'T1 work'])
    gitCmd(['checkout', '--quiet', 'run-branch'])

    lines.length = 0
    const codeT1 = await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(codeT1, 0, lines.join('\n'))
    assert.match(lines.join('\n'), /T1 done/)
    const status = await readStatus(root, 'r1')
    assert.equal(status.tasks.find((t) => t.id === 'T1').state, 'done')
    assert.equal(status.tasks.find((t) => t.id === 'T2').state, 'pending')

    // T2, which really has not started, still fails on its own missing branch.
    lines.length = 0
    const codeT2 = await runCli(['complete', '--run', 'r1', '--task', 'T2', '--plan', 'plan.md', '--root', root], io)
    assert.equal(codeT2, 4)
    assert.match(lines.join('\n'), /T2/)
  })
})

// --- Review round: LOW — --run/--task must not be allowed to escape the run directory.
test('init-run rejects a --run value that escapes the run directory', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    const code = await runCli(['init-run', planPath, '--run', '../../ESCAPED', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /--run/)
    // Nothing was written under .teammates for the traversal target, and nothing leaked
    // outside root/.teammates either.
    const { readdir } = await import('node:fs/promises')
    await assert.rejects(readdir(path.join(root, '.teammates')))
  })
})

test('claim rejects a --task value that escapes the run directory', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['claim', '--run', 'r1', '--task', '../../../CLAIMED', '--by', 'a', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /--task/)
    const { readdir } = await import('node:fs/promises')
    await assert.rejects(readdir(path.join(root, '.teammates', 'r1', 'claims')))
  })
})

// --- Review round: LOW — status.gates key collisions and prototype pollution via a
// user-controlled --phase value.
test('a solo (--no-fleet) gate record does not collide with or overwrite a real phase record', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    // Seed a "real" derived record at the same key a solo run for phase 1 would use if
    // the two shared a namespace.
    const seeded = await readStatus(root, 'r1')
    seeded.gates = { 1: { verdict: 'PASS', anchorSha: 'deadbeef', failed: [], skipped: [], pending: [], recordedAt: 1 } }
    await writeFile(path.join(root, '.teammates', 'r1', 'status.json'), `${JSON.stringify(seeded, null, 2)}\n`, 'utf8')

    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }),
      'utf8',
    )
    const silent = { out: () => {} }
    await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--phase', '1', '--no-fleet', '--root', root], silent)

    const after = await readStatus(root, 'r1')
    // The seeded, anchorSha-bearing record must survive untouched.
    assert.equal(after.gates['1'].anchorSha, 'deadbeef')
  })
})

test('a --phase named __proto__ does not pollute Object.prototype and its record is retrievable', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }),
      'utf8',
    )
    const beforeProto = Object.getPrototypeOf({})
    const silent = { out: () => {} }
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--phase', '__proto__', '--no-fleet', '--root', root], silent)
    assert.equal(code, 0)
    assert.equal(Object.getPrototypeOf({}), beforeProto)
    const status = await readStatus(root, 'r1')
    const own = Object.keys(status.gates).some((k) => k.includes('__proto__'))
    assert.ok(own, `expected a retrievable record naming __proto__, got keys: ${Object.keys(status.gates)}`)
  })
})

// --- Review round: LOW — a flag given with no value must count as missing, not as `true`.
test('complete with --plan given no value is treated as a missing argument', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /missing required argument/)
    assert.match(lines.join('\n'), /--plan/)
  })
})

// --- Review round: usability — a plan absent at the anchor must not surface raw git
// stderr as the operator's first interaction with enforcement.
test('gate reports an actionable message, not raw git stderr, when the plan is absent at the anchor', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    await writeEnforcementManifest(root)
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'missing-plan.md', '--root', root], io)
    assert.equal(code, 1)
    const parsed = JSON.parse(lines.join('\n'))
    assert.match(parsed.error, /anchor/i)
    assert.match(parsed.error, /--plan/)
    assert.match(parsed.error, /committed/i)
    assert.doesNotMatch(parsed.error, /fatal:/i)
  })
})

// --- Task 8: model routing in init-run/workflow, and the fix decision subcommand.

async function readPlan(root, runId) {
  return JSON.parse(await readFile(path.join(root, '.teammates', runId, 'plan.json'), 'utf8'))
}

// A plan whose first task declares a tier. Written to its own file so the shared PLAN,
// which declares none, keeps pinning the inference path.
function planWithModel(tier) {
  return `### Task 1: A

**Files:**
- Create: \`a.mjs\`

**Model:** ${tier}

### Task 2: B

**Files:**
- Create: \`b.mjs\`

**Depends:** T1
`
}

async function writeVerdict(root, verdict) {
  const file = path.join(root, 'verdict.json')
  await writeFile(file, JSON.stringify(verdict), 'utf8')
  return file
}

test('usage lists the fix subcommand', async () => {
  await withRepo(async ({ io, lines }) => {
    assert.equal(await runCli(['nope'], io), 2)
    assert.match(lines.join('\n'), /init-run\|gate\|digest\|claim\|unclaim\|workflow\|complete\|fix/)
    assert.match(lines.join('\n'), /fix\s+--run <id> --phase <n> --verdict <path>/)
  })
})

test('fix with no flags exits 2 and prints usage', async () => {
  await withRepo(async ({ io, lines }) => {
    const code = await runCli(['fix'], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /missing required argument/)
    assert.match(lines.join('\n'), /--run/)
    assert.match(lines.join('\n'), /--phase/)
    assert.match(lines.join('\n'), /--verdict/)
    assert.match(lines.join('\n'), /usage: cli\.mjs/)
  })
})

test('init-run infers a tier for every task when the plan declares none', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    assert.equal(await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io), 0)
    const plan = await readPlan(root, 'r1')
    assert.equal(plan.tasks.length, 2)
    for (const task of plan.tasks) {
      assert.ok(['cheap', 'mid', 'capable'].includes(task.tier), `bad tier for ${task.id}: ${task.tier}`)
      assert.equal(task.tierSource, 'inferred')
    }
  })
})

test('init-run prints each task tier and its source in the phase breakdown', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const out = lines.join('\n')
    assert.match(out, /phase 1: T1 \((cheap|mid|capable), inferred\)/)
    assert.match(out, /phase 2: T2 \((cheap|mid|capable), inferred\)/)
  })
})

test('init-run records a declared tier verbatim as declared', async () => {
  await withRepo(async ({ root, io }) => {
    const declaredPath = path.join(root, 'declared.md')
    await writeFile(declaredPath, planWithModel('capable'), 'utf8')
    assert.equal(await runCli(['init-run', declaredPath, '--run', 'r1', '--root', root], io), 0)
    const plan = await readPlan(root, 'r1')
    const t1 = plan.tasks.find((t) => t.id === 'T1')
    assert.equal(t1.tier, 'capable')
    assert.equal(t1.tierSource, 'declared')
    const t2 = plan.tasks.find((t) => t.id === 'T2')
    assert.equal(t2.tierSource, 'inferred')
  })
})

test('init-run rejects an unknown declared tier and names the offending task', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const declaredPath = path.join(root, 'declared.md')
    await writeFile(declaredPath, planWithModel('enormous'), 'utf8')
    const code = await runCli(['init-run', declaredPath, '--run', 'r1', '--root', root], io)
    assert.equal(code, 2)
    const out = lines.join('\n')
    assert.match(out, /T1/)
    assert.match(out, /enormous/)
    assert.match(out, /cheap, mid, capable/)
    await assert.rejects(readPlan(root, 'r1'))
  })
})

test('workflow --models resolves each task tier to a concrete model', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const models = JSON.stringify({ cheap: 'haiku', mid: 'sonnet', capable: 'opus' })
    const code = await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--models', models], io)
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /"model": "(haiku|sonnet|opus)"/)
  })
})

test('workflow with malformed --models exits 2 with a message and no stack trace', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--models', '{'], io)
    assert.equal(code, 2)
    const out = lines.join('\n')
    assert.match(out, /--models must be a JSON object mapping tiers to model names/)
    assert.doesNotMatch(out, /SyntaxError/)
    assert.doesNotMatch(out, /at .*cli\.mjs/)
    assert.doesNotMatch(out, /export const meta/)
  })
})

test('fix prints a retry decision and exits 0 for an attributable agent failure', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const verdictPath = await writeVerdict(root, {
      verdict: 'FAIL',
      results: [{ name: 'review', kind: 'agent', status: 'fail', findings: [{ file: 'a.mjs' }] }],
    })
    lines.length = 0
    const code = await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io)
    assert.equal(code, 0)
    const out = lines.join('\n')
    assert.match(out, /"decision": "retry"/)
    const decision = JSON.parse(out)
    assert.deepEqual(decision.tasks.map((t) => t.taskId), ['T1'])
    assert.equal(decision.tasks[0].round, 1)
    assert.ok(['cheap', 'mid', 'capable'].includes(decision.tasks[0].tier))
  })
})

test('fix escalates a fileset failure as a process violation and still exits 0', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const verdictPath = await writeVerdict(root, {
      verdict: 'FAIL',
      results: [{ name: 'fileset', kind: 'fileset', status: 'fail' }],
    })
    lines.length = 0
    const code = await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io)
    assert.equal(code, 0)
    const out = lines.join('\n')
    assert.match(out, /"decision": "escalate"/)
    assert.match(out, /"reason": "process-violation"/)
  })
})

test('fix honours the manifest fix-round budget for the phase', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ phases: { default: { fixRounds: 1, checks: [] } } }),
      'utf8',
    )
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const status = await readStatus(root, 'r1')
    status.fixRounds = { 1: { T1: 1 } }
    await writeFile(path.join(root, '.teammates', 'r1', 'status.json'), JSON.stringify(status), 'utf8')
    const verdictPath = await writeVerdict(root, {
      verdict: 'FAIL',
      results: [{ name: 'review', kind: 'agent', status: 'fail', findings: [{ file: 'a.mjs' }] }],
    })
    lines.length = 0
    const code = await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io)
    assert.equal(code, 0)
    const decision = JSON.parse(lines.join('\n'))
    assert.equal(decision.decision, 'escalate')
    assert.equal(decision.reason, 'budget-exhausted')
    assert.equal(decision.taskId, 'T1')
  })
})

test('fix prints decision none and exits 0 when nothing is failing', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const verdictPath = await writeVerdict(root, {
      verdict: 'PASS',
      results: [{ name: 'noop', kind: 'command', status: 'pass' }],
    })
    lines.length = 0
    const code = await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io)
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /"decision": "none"/)
  })
})
