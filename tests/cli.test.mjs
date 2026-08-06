import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runCli, mergeSuppliedResults } from '../scripts/cli.mjs'
import { loadGateConfig, previewLinks } from '../scripts/gate-config.mjs'

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

// --- Fix round: the merge preview `runChecks` builds is phase-wide, which reintroduced
// the coupling the scoping above removed, by another route: a sibling that stomped this
// task's file made the preview fail and took the compliant task down with it. `complete`
// now declares its scope once, as `ctx.taskScope`, and `gate-runner` honours it for both
// the preview's branch set and `runFilesetCheck`'s phase-task list.
//
// SIBLING: the narrowing itself lives in `scripts/gate-runner.mjs` (task T5). Until that
// commit lands, `runChecks` builds no preview at all, so this scenario passes for the
// weaker reason that there is nothing phase-wide left to fail. It is written against the
// merged behaviour and must keep passing once the preview exists.
test('complete passes for a compliant task even when a sibling stomps its file', async () => {
  await withRepo(async ({ root, io, lines, git: gitCmd }) => {
    const planPath = path.join(root, 'plan.md')
    gitCmd(['checkout', '--quiet', 'main'])
    await writeFile(planPath, TWO_TASK_SAME_PHASE_PLAN, 'utf8')
    await writeEnforcementManifest(root)
    gitCmd(['add', 'plan.md', 'teammates.gate.json'])
    gitCmd(['commit', '--quiet', '-m', 'two-task same-phase plan and gate manifest'])
    gitCmd(['checkout', '--quiet', 'run-branch'])
    gitCmd(['merge', '--quiet', '--ff-only', 'main'])

    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)

    // T1 is fully compliant: it declared a.mjs and committed exactly a.mjs.
    gitCmd(['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    gitCmd(['add', 'a.mjs'])
    gitCmd(['commit', '--quiet', '-m', 'T1 work'])
    gitCmd(['checkout', '--quiet', 'run-branch'])

    // T2 declared only b.mjs but also stomps a.mjs — T2's problem, not T1's.
    gitCmd(['checkout', '--quiet', '-b', 'teammates/r1/T2'])
    await writeFile(path.join(root, 'b.mjs'), 'export const b = 2\n', 'utf8')
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 999\n', 'utf8')
    gitCmd(['add', 'b.mjs', 'a.mjs'])
    gitCmd(['commit', '--quiet', '-m', 'T2 work, stomping a.mjs'])
    gitCmd(['checkout', '--quiet', 'run-branch'])

    lines.length = 0
    const codeT1 = await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(codeT1, 0, lines.join('\n'))
    assert.match(lines.join('\n'), /T1 done/)

    // T2 is the one at fault and still fails on its own undeclared write.
    lines.length = 0
    const codeT2 = await runCli(['complete', '--run', 'r1', '--task', 'T2', '--plan', 'plan.md', '--root', root], io)
    assert.equal(codeT2, 4, lines.join('\n'))
  })
})

// `gate` stays phase-wide: it must still see the sibling's undeclared write that
// `complete --task T1` is allowed to ignore. This is the other half of the same contract —
// scoping is `complete`'s alone.
//
// SIBLING: gains its full force once `gate-runner` honours `taskScope`, since only then
// could a stray marker on gate's context narrow anything.
test('gate stays phase-wide and still fails on a sibling that complete --task ignores', async () => {
  await withRepo(async ({ root, io, lines, git: gitCmd }) => {
    const planPath = path.join(root, 'plan.md')
    gitCmd(['checkout', '--quiet', 'main'])
    await writeFile(planPath, TWO_TASK_SAME_PHASE_PLAN, 'utf8')
    await writeEnforcementManifest(root)
    gitCmd(['add', 'plan.md', 'teammates.gate.json'])
    gitCmd(['commit', '--quiet', '-m', 'two-task same-phase plan and gate manifest'])
    gitCmd(['checkout', '--quiet', 'run-branch'])
    gitCmd(['merge', '--quiet', '--ff-only', 'main'])

    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)

    gitCmd(['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    gitCmd(['add', 'a.mjs'])
    gitCmd(['commit', '--quiet', '-m', 'T1 work'])
    gitCmd(['checkout', '--quiet', 'run-branch'])

    gitCmd(['checkout', '--quiet', '-b', 'teammates/r1/T2'])
    await writeFile(path.join(root, 'b.mjs'), 'export const b = 2\n', 'utf8')
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 999\n', 'utf8')
    gitCmd(['add', 'b.mjs', 'a.mjs'])
    gitCmd(['commit', '--quiet', '-m', 'T2 work, stomping a.mjs'])
    gitCmd(['checkout', '--quiet', 'run-branch'])

    lines.length = 0
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(code, 1)
    const parsed = JSON.parse(lines.join('\n'))
    assert.equal(parsed.verdict, 'FAIL')
    assert.ok(parsed.results.some((r) => r.name === 'fileset' && r.status === 'fail'))
    // No result name is ever emitted twice: two entries under one name can disagree, and
    // the verdict would then depend on which one a reader happened to look at.
    const names = parsed.results.map((r) => r.name)
    assert.deepEqual(names, [...new Set(names)])
  })
})

// The contract with `scripts/gate-runner.mjs` is structural on this side: `complete` makes
// exactly one `runChecks` call, over the whole check list, with `taskScope` set; `gate`
// makes its own and sets no scope. Splitting `complete`'s call back into one per kind
// rebuilds the preview per call and re-emits a duplicate `merge` result — a defect the
// exit code alone does not show, since both calls can still agree on PASS.
test('complete makes exactly one runChecks call carrying taskScope, and gate sets none', async () => {
  const src = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  const completeBody = src.slice(src.indexOf("if (command === 'complete')"))
  const gateBody = src.slice(src.indexOf("if (command === 'gate')"), src.indexOf("if (command === 'complete')"))

  assert.equal((completeBody.match(/runChecks\(/g) ?? []).length, 1)
  assert.match(completeBody, /taskScope:\s*flags\.task/)
  // The scoped context must not also narrow `tasks` — runOwnershipCheck has to stay
  // run-wide to explain every commit on the run branch, not just this task's.
  assert.doesNotMatch(completeBody, /tasks:\s*\(ctx\.tasks/)

  assert.equal((gateBody.match(/runChecks\(/g) ?? []).length, 1)
  assert.doesNotMatch(gateBody, /taskScope/)
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

// --- Task 8, fix round: the fix-round counter's writer, --phase validation for `fix`,
// --- --models value validation, and the coverage gaps three reviewers found.

// The whole point of `record-fix-round` is that `fix` stays a pure read. These tests drive
// the counter the way the skill does — record a round at the moment a retry is dispatched,
// then re-derive the decision — so the loop's own termination is what is under test, not
// a hand-placed `status.fixRounds`.
test('record-fix-round is listed in usage', async () => {
  await withRepo(async ({ io, lines }) => {
    assert.equal(await runCli(['nope'], io), 2)
    assert.match(lines.join('\n'), /record-fix-round\s+--run <id> --phase <n> --task <id>/)
  })
})

test('record-fix-round with no flags exits 2 naming every missing flag', async () => {
  await withRepo(async ({ io, lines }) => {
    const code = await runCli(['record-fix-round'], io)
    assert.equal(code, 2)
    const out = lines.join('\n')
    assert.match(out, /missing required argument/)
    assert.match(out, /--run/)
    assert.match(out, /--phase/)
    assert.match(out, /--task/)
  })
})

test('record-fix-round increments the per-phase count for the task and prints it', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    assert.equal(
      await runCli(['record-fix-round', '--run', 'r1', '--phase', '1', '--task', 'T1', '--root', root], io),
      0,
    )
    assert.match(lines.join('\n'), /T1.*1/)
    assert.deepEqual((await readStatus(root, 'r1')).fixRounds, { 1: { T1: 1 } })

    lines.length = 0
    assert.equal(
      await runCli(['record-fix-round', '--run', 'r1', '--phase', '1', '--task', 'T1', '--root', root], io),
      0,
    )
    assert.match(lines.join('\n'), /T1.*2/)
    assert.deepEqual((await readStatus(root, 'r1')).fixRounds, { 1: { T1: 2 } })
  })
})

test('record-fix-round refuses a task that is not in the named phase', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    // T2 is a phase-2 task; recording a phase-1 round against it would spend a budget that
    // belongs to a different phase.
    const code = await runCli(['record-fix-round', '--run', 'r1', '--phase', '1', '--task', 'T2', '--root', root], io)
    assert.equal(code, 1)
    assert.match(lines.join('\n'), /T2/)
    assert.equal((await readStatus(root, 'r1')).fixRounds, undefined)
  })
})

test('recording a round each dispatch drives fix from retry to budget-exhausted', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ phases: { default: { fixRounds: 2, checks: [] } } }),
      'utf8',
    )
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const verdictPath = await writeVerdict(root, {
      verdict: 'FAIL',
      results: [{ name: 'review', kind: 'agent', status: 'fail', findings: [{ file: 'a.mjs' }] }],
    })
    const decide = async () => {
      lines.length = 0
      assert.equal(
        await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io),
        0,
      )
      return JSON.parse(lines.join('\n'))
    }
    const record = async () => runCli(
      ['record-fix-round', '--run', 'r1', '--phase', '1', '--task', 'T1', '--root', root],
      io,
    )

    const first = await decide()
    assert.equal(first.decision, 'retry')
    assert.equal(first.tasks[0].round, 1)
    await record()

    const second = await decide()
    assert.equal(second.decision, 'retry')
    // The counter has a writer, so the round advances instead of pinning at 1 forever.
    assert.equal(second.tasks[0].round, 2)
    await record()

    const third = await decide()
    assert.equal(third.decision, 'escalate')
    assert.equal(third.reason, 'budget-exhausted')
    assert.equal(third.taskId, 'T1')
  })
})

test('fix rejects a non-integer --phase instead of deciding unattributable', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const verdictPath = await writeVerdict(root, {
      verdict: 'FAIL',
      results: [{ name: 'review', kind: 'agent', status: 'fail', findings: [{ file: 'a.mjs' }] }],
    })
    lines.length = 0
    // `default` is the exact token `gate` uses when --phase is omitted, so it is the most
    // likely thing an operator carries across to `fix`.
    const code = await runCli(['fix', '--run', 'r1', '--phase', 'default', '--verdict', verdictPath, '--root', root], io)
    assert.equal(code, 2)
    const out = lines.join('\n')
    assert.match(out, /--phase <integer>/)
    assert.doesNotMatch(out, /unattributable/)
  })
})

test('fix accepts a zero-padded --phase and still selects the phase', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const verdictPath = await writeVerdict(root, {
      verdict: 'FAIL',
      results: [{ name: 'review', kind: 'agent', status: 'fail', findings: [{ file: 'a.mjs' }] }],
    })
    lines.length = 0
    const code = await runCli(['fix', '--run', 'r1', '--phase', '01', '--verdict', verdictPath, '--root', root], io)
    assert.equal(code, 0)
    const decision = JSON.parse(lines.join('\n'))
    assert.equal(decision.decision, 'retry')
    assert.deepEqual(decision.tasks.map((t) => t.taskId), ['T1'])
  })
})

test('fix rejects a --phase that disagrees with the verdict it was handed', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const verdictPath = await writeVerdict(root, {
      verdict: 'FAIL',
      phase: 1,
      results: [{ name: 'review', kind: 'agent', status: 'fail', findings: [{ file: 'a.mjs' }] }],
    })
    lines.length = 0
    const code = await runCli(['fix', '--run', 'r1', '--phase', '3', '--verdict', verdictPath, '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /phase/)
    assert.doesNotMatch(lines.join('\n'), /"decision"/)
  })
})

test('the fix-round budget is read under the same manifest key the gate used for checks', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    // The manifest is keyed by phase NAME. `gate --phase integration` picks that phase's
    // checks; adjudicating that same gate must pick that phase's fixRounds, not default's.
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({
        phases: {
          default: { fixRounds: 2, checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] },
          integration: { fixRounds: 5, checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] },
        },
      }),
      'utf8',
    )
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    assert.equal(
      await runCli(
        ['gate', '--run', 'r1', '--plan', 'plan.md', '--phase', 'integration', '--no-fleet', '--root', root],
        io,
      ),
      0,
    )
    const gateOut = JSON.parse(lines[lines.length - 1])
    const verdictPath = await writeVerdict(root, {
      ...gateOut,
      verdict: 'FAIL',
      results: [{ name: 'review', kind: 'agent', status: 'fail', findings: [{ file: 'a.mjs' }] }],
    })
    // Four rounds already spent: over the default budget of 2, under integration's 5.
    const status = await readStatus(root, 'r1')
    status.fixRounds = { 1: { T1: 4 } }
    await writeFile(path.join(root, '.teammates', 'r1', 'status.json'), JSON.stringify(status), 'utf8')

    lines.length = 0
    assert.equal(
      await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io),
      0,
    )
    const decision = JSON.parse(lines.join('\n'))
    assert.equal(decision.decision, 'retry')
    assert.equal(decision.tasks[0].round, 5)
  })
})

test('workflow rejects --models values that are not non-empty strings', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    for (const models of ['{"mid":{"evil":1}}', '{"mid":1}', '{"mid":null}', '{"mid":""}', '{"mid":["a"]}']) {
      lines.length = 0
      const code = await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--models', models], io)
      assert.equal(code, 2, `expected rejection for ${models}`)
      assert.match(lines.join('\n'), /--models/)
      assert.doesNotMatch(lines.join('\n'), /export const meta/)
    }
  })
})

test('workflow rejects --models given as a bare switch instead of dropping it', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--models'], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /--models/)
    assert.doesNotMatch(lines.join('\n'), /export const meta/)
  })
})

test('workflow rejects a --models payload that is not a JSON object', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    // An array, a null, a bare scalar and a quoted string all parse as valid JSON; none of
    // them is a tier map, and each would otherwise reach generatePhaseWorkflow.
    for (const models of ['["sonnet"]', 'null', '5', 'true', '"sonnet"']) {
      lines.length = 0
      const code = await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--models', models], io)
      assert.equal(code, 2, `expected rejection for ${models}`)
      assert.match(lines.join('\n'), /--models must be a JSON object mapping tiers to model names/)
      assert.doesNotMatch(lines.join('\n'), /export const meta/)
    }
  })
})

test('fix reads a verdict file the real gate produced, not a hand-written one', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    // A full, derived gate — no --no-fleet — so the fileset check really runs and really
    // fails (no teammates/r1/T1 branch exists). Every field `fix` reads (`results`, each
    // result's `kind` and `status`, the bound `phase`) is produced by the gate itself, so
    // a rename or a dropped field on either side fails here instead of in production.
    await writeEnforcementManifest(root)
    lines.length = 0
    const gateCode = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(gateCode, 1)
    const verdictPath = path.join(root, 'gate-verdict.json')
    await writeFile(verdictPath, lines[lines.length - 1], 'utf8')
    const gateOut = JSON.parse(lines[lines.length - 1])
    assert.equal(gateOut.phase, 1)
    assert.ok(gateOut.results.some((r) => r.name === 'fileset' && r.status === 'fail'))

    lines.length = 0
    const code = await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io)
    assert.equal(code, 0)
    const decision = JSON.parse(lines.join('\n'))
    // A fileset failure is a process violation. If the gate ever stopped labelling its
    // results with `kind`, this would come back `unattributable` instead.
    assert.equal(decision.decision, 'escalate')
    assert.equal(decision.reason, 'process-violation')
    assert.equal(decision.check, 'fileset')
  })
})

test('fix does not retry a later phase task whose file a finding cites', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    // b.mjs belongs to T2, a phase-2 task. Adjudicating phase 1 must not reach it: the
    // finding is unattributable within phase 1, and phase 2 has not run yet.
    const verdictPath = await writeVerdict(root, {
      verdict: 'FAIL',
      results: [{ name: 'review', kind: 'agent', status: 'fail', findings: [{ file: 'b.mjs' }] }],
    })
    lines.length = 0
    const code = await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io)
    assert.equal(code, 0)
    const decision = JSON.parse(lines.join('\n'))
    assert.equal(decision.decision, 'escalate')
    assert.equal(decision.reason, 'unattributable')
    assert.deepEqual(decision.tasks, [])
  })
})

// --- `gate --results`: caller-supplied results for the checks the CLI cannot run itself.
//
// These pin the trust boundary. `--results` is caller input for one run: it may only fill in
// `agent`/`mcp` checks the manifest already declares, and only where the gate left them
// `pending`. Everything else is an error, because a supplied `fileset`/`ownership`/`command`
// entry would be a way to hand the gate a passing enforcement check.

// Manifest with one runnable command check and one `agent` check the gate cannot run, so the
// gate always leaves `review` pending until a caller supplies it.
async function writeAgentManifest(root) {
  await writeFile(
    path.join(root, 'teammates.gate.json'),
    JSON.stringify({
      phases: {
        default: {
          checks: [
            { name: 'noop', kind: 'command', run: 'node -e ""' },
            { name: 'review', kind: 'agent' },
          ],
        },
      },
    }),
    'utf8',
  )
}

// Written under .teammates/, which withRepo gitignores: a results file dropped in the work
// tree would make the ownership check see an untracked path and report a dirty worktree.
async function writeResults(root, body) {
  const target = path.join(root, '.teammates', 'results.json')
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return target
}

test('gate with a pending agent check exits 1, and --results supplying it as pass exits 0 with PASS', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeAgentManifest(root)

    lines.length = 0
    const pendingCode = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root], io)
    assert.equal(pendingCode, 1)
    const pendingOut = JSON.parse(lines[lines.length - 1])
    assert.equal(pendingOut.verdict, 'FAIL')
    assert.deepEqual(pendingOut.pending, ['review'])

    const resultsPath = await writeResults(root, {
      results: [{ name: 'review', kind: 'agent', status: 'pass', findings: [] }],
    })
    lines.length = 0
    const code = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root, '--results', resultsPath],
      io,
    )
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /"verdict": "PASS"/)
    const parsed = JSON.parse(lines[lines.length - 1])
    assert.deepEqual(parsed.pending, [])
    assert.ok(parsed.results.some((r) => r.name === 'review' && r.status === 'pass'))
  })
})

test('the verdict recorded into status.json after a --results run is PASS', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeAgentManifest(root)
    const resultsPath = await writeResults(root, {
      results: [{ name: 'review', kind: 'agent', status: 'pass', findings: [] }],
    })
    lines.length = 0
    // A derived (non-solo) run, so the record lands under the numeric phase key rather
    // than the `solo:` one — that is the key a digest and the fix loop read.
    const code = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root, '--results', resultsPath],
      io,
    )
    assert.equal(code, 0)
    const status = await readStatus(root, 'r1')
    assert.equal(status.gates['1'].verdict, 'PASS')
  })
})

test('--results naming a check absent from the manifest exits 2 and records nothing', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeAgentManifest(root)
    const resultsPath = await writeResults(root, {
      results: [{ name: 'invented', kind: 'agent', status: 'pass' }],
    })
    lines.length = 0
    const code = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root, '--results', resultsPath],
      io,
    )
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /names a check not in this phase's manifest/)
    const status = await readStatus(root, 'r1')
    assert.equal(status.gates, undefined)
  })
})

test('--results supplying a command check exits 2', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeAgentManifest(root)
    const resultsPath = await writeResults(root, {
      results: [{ name: 'noop', kind: 'command', status: 'pass' }],
    })
    lines.length = 0
    const code = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root, '--results', resultsPath],
      io,
    )
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /may not supply a command check: noop/)
    const status = await readStatus(root, 'r1')
    assert.equal(status.gates, undefined)
  })
})

test('--results supplying a fileset check exits 2', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeEnforcementManifest(root)
    const resultsPath = await writeResults(root, {
      results: [{ name: 'fileset', kind: 'fileset', status: 'pass' }],
    })
    lines.length = 0
    // A derived run, so the manifest's fileset check is really in the check list — the
    // rejection is the kind rule, not "no such check".
    const code = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root, '--results', resultsPath],
      io,
    )
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /may not supply a fileset check: fileset/)
    const status = await readStatus(root, 'r1')
    assert.equal(status.gates, undefined)
  })
})

test('--results carrying an unrecognized status casing exits 2 rather than passing', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeAgentManifest(root)
    const resultsPath = await writeResults(root, {
      results: [{ name: 'review', kind: 'agent', status: 'PASS' }],
    })
    lines.length = 0
    const code = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root, '--results', resultsPath],
      io,
    )
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /unrecognized status for review/)
    const status = await readStatus(root, 'r1')
    assert.equal(status.gates, undefined)
  })
})

test('--results pointing at a missing file exits 2 with a message and no stack trace', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeAgentManifest(root)
    lines.length = 0
    const code = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root,
        '--results', path.join(root, '.teammates', 'nope.json')],
      io,
    )
    assert.equal(code, 2)
    const out = lines.join('\n')
    assert.match(out, /--results must be a readable JSON file/)
    assert.doesNotMatch(out, /at .*cli\.mjs/)
  })
})

test('--results pointing at malformed JSON, or at JSON without a results array, exits 2', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeAgentManifest(root)

    const malformed = await writeResults(root, '{ not json')
    lines.length = 0
    const malformedCode = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root, '--results', malformed],
      io,
    )
    assert.equal(malformedCode, 2)
    assert.match(lines.join('\n'), /--results must be a readable JSON file/)
    assert.doesNotMatch(lines.join('\n'), /at .*cli\.mjs/)

    const notAnArray = await writeResults(root, { results: 'review' })
    lines.length = 0
    const shapeCode = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root, '--results', notAnArray],
      io,
    )
    assert.equal(shapeCode, 2)
    assert.match(lines.join('\n'), /--results must be a readable JSON file/)
  })
})

// Only `pending` results are replaced. Pinned on the merge function directly because no
// suppliable kind can currently produce a non-pending result through `runChecks` — `agent`
// and `mcp` have no runner, so the gate always leaves them pending. The guard exists for the
// moment one of them does run: a supplied result must never overwrite a computed one.
test('mergeSuppliedResults leaves a check that already ran untouched', async () => {
  const raw = [
    { name: 'review', kind: 'agent', status: 'pass', output: 'computed', optional: false },
    { name: 'audit', kind: 'agent', status: 'fail', output: 'computed', optional: false },
    { name: 'scan', kind: 'mcp', status: 'pending', optional: false, check: { name: 'scan', kind: 'mcp' } },
  ]
  const merged = mergeSuppliedResults(raw, [
    { name: 'review', kind: 'agent', status: 'fail' },
    { name: 'audit', kind: 'agent', status: 'pass' },
    { name: 'scan', kind: 'mcp', status: 'pass', output: 'supplied', findings: [] },
  ])
  assert.deepEqual(merged[0], raw[0])
  assert.deepEqual(merged[1], raw[1])
  assert.equal(merged[2].status, 'pass')
  assert.equal(merged[2].output, 'supplied')
})

// `optional` is a manifest declaration ("this check does not block"), not a result field. It
// must come from the computed check and never from the supplied file — otherwise a results
// file reporting its own failure can also declare that failure advisory. Pinned on the merge
// function directly because that is the single line where the two sources meet: flipping it
// to `s.optional ?? r.optional` must fail here.
test('mergeSuppliedResults takes optional from the computed check, never from the supplied entry', () => {
  const raw = [{ name: 'review', kind: 'agent', status: 'pending', optional: false }]
  const merged = mergeSuppliedResults(raw, [
    { name: 'review', kind: 'agent', status: 'fail', optional: true, findings: [{ file: 'a.mjs' }] },
  ])
  assert.equal(merged[0].status, 'fail')
  assert.equal(merged[0].optional, false)
})

// The end-to-end consequence of the line above: a required `agent` check reported as failing
// stays a blocking failure. If `optional` were laundered through the file, this would print
// PASS with the failure demoted into `optionalFailed` and exit 0.
test('--results cannot launder a failing required check into an optional one', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeAgentManifest(root)
    const resultsPath = await writeResults(root, {
      results: [{ name: 'review', kind: 'agent', status: 'fail', optional: true, findings: [{ file: 'a.mjs' }] }],
    })
    lines.length = 0
    const code = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root, '--results', resultsPath],
      io,
    )
    assert.equal(code, 1)
    const parsed = JSON.parse(lines[lines.length - 1])
    assert.equal(parsed.verdict, 'FAIL')
    assert.deepEqual(parsed.failed, ['review'])
    assert.deepEqual(parsed.optionalFailed, [])
    assert.equal(parsed.results.find((r) => r.name === 'review').optional, false)
  })
})

// `checksForPhase` does not enforce unique check names. Validation resolves a supplied name
// to exactly one check (last wins) while the merge writes to every result with that name, so
// a collision would let an `agent` result land on a same-named `command` check — and whether
// the file was accepted at all would depend on manifest declaration order. Both orders must
// be rejected identically.
test('--results naming a check declared twice in the manifest exits 2, whichever order they are declared in', async () => {
  const collidingChecks = [
    { name: 'test', kind: 'command', run: 'node -e "process.exit(1)"' },
    { name: 'test', kind: 'agent' },
  ]
  for (const checks of [collidingChecks, [...collidingChecks].reverse()]) {
    await withRepo(async ({ root, planPath, io, lines }) => {
      await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
      await writeFile(
        path.join(root, 'teammates.gate.json'),
        JSON.stringify({ phases: { default: { checks } } }),
        'utf8',
      )
      const resultsPath = await writeResults(root, {
        results: [{ name: 'test', kind: 'agent', status: 'pass' }],
      })
      lines.length = 0
      const code = await runCli(
        ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root, '--results', resultsPath],
        io,
      )
      assert.equal(code, 2)
      assert.match(lines.join('\n'), /declared more than once in this phase's manifest/)
      const status = await readStatus(root, 'r1')
      assert.equal(status.gates, undefined)
    })
  }
})

// The writing half of the same invariant: even if a duplicate name ever reached the merge, one
// supplied entry fills at most one pending result. The second collides and stays pending, so
// the gate blocks rather than passing a check nobody reported.
test('mergeSuppliedResults fills at most one pending result per supplied entry', () => {
  const raw = [
    { name: 'test', kind: 'command', status: 'pending', optional: false },
    { name: 'test', kind: 'agent', status: 'pending', optional: false },
  ]
  const merged = mergeSuppliedResults(raw, [{ name: 'test', kind: 'agent', status: 'pass' }])
  assert.equal(merged[0].status, 'pass')
  assert.equal(merged[1].status, 'pending')
  assert.deepEqual(merged[1], raw[1])
})

test('a valueless --results is reported as a missing argument rather than silently dropped', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeAgentManifest(root)
    lines.length = 0
    const code = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root, '--results'],
      io,
    )
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /missing required argument: --results <path>/)
  })
})

// Also in the middle of argv, where parseFlags reads the following flag name as the value
// unless the boolean-switch rule fires.
test('a valueless --results before another flag is still reported as missing', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeAgentManifest(root)
    lines.length = 0
    const code = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--results', '--root', root, '--no-fleet'],
      io,
    )
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /missing required argument: --results <path>/)
  })
})

test('gate exits 1 with a message when status.json is unreadable rather than throwing', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const config = { phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(config), 'utf8')
    // status.json is agent-writable. A corrupt one must not turn a computed verdict into a
    // stack trace for a caller that branches on exit codes.
    await writeFile(path.join(root, '.teammates', 'r1', 'status.json'), '{ not json', 'utf8')
    lines.length = 0
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root], io)
    assert.equal(code, 1)
    assert.match(lines.join('\n'), /could not read run state/)
  })
})

// An unreadable status.json is a gate failure, and the verdict that gets printed has to say
// so. Every check here passes, so a verdict computed and printed before the state read would
// put `"verdict": "PASS"` on stdout ahead of a bare error line — contradicting the exit code
// and leaving stdout unparseable for a caller that reads it as JSON.
test('a corrupt status.json produces parseable JSON whose verdict is FAIL, not PASS', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const config = { phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(config), 'utf8')
    await writeFile(path.join(root, '.teammates', 'r1', 'status.json'), '{ not json', 'utf8')
    lines.length = 0
    // A derived run, so nothing else is on stdout: `--no-fleet` prints its own notice line,
    // which would mask whether the verdict document itself is the whole output.
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(code, 1)

    const out = lines.join('\n')
    assert.doesNotMatch(out, /"verdict": "PASS"/)
    // The whole of stdout parses as JSON: no error line trailing the verdict document.
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    assert.ok(parsed.failed.includes('run-state'))
    assert.match(parsed.error, /could not read run state/)
    // The computed check results are still carried, so the failure is attributable.
    assert.ok(parsed.results.some((r) => r.name === 'noop' && r.status === 'pass'))
  })
})

// --- Task 4: a manifest's preview.link must actually reach runChecks -----------------------
//
// gate-config.mjs's previewLinks(config) existed since T2 but nothing called it: `gate`
// built ctx as `{ cwd: root, ...(await derive(...)) }`, so ctx.previewLink was always
// undefined and no link was ever created end to end. These pin that the `gate` path wires
// the saved manifest's preview.link through to the merge preview, and that a manifest
// without one still yields the pre-existing, link-free behaviour.

const ONE_TASK_PLAN = `### Task 1: A

**Files:**
- Create: \`a.mjs\`
`

test('gate wires a manifest\'s preview.link through to the merge preview', async () => {
  await withRepo(async ({ root, io, lines, git: gitCmd }) => {
    const planPath = path.join(root, 'plan.md')
    gitCmd(['checkout', '--quiet', 'main'])
    await writeFile(planPath, ONE_TASK_PLAN, 'utf8')
    // Ignored so the real, untracked `deps` directory created below never reads as a dirty
    // worktree to the ownership check — the same reason `.teammates/` is ignored.
    const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8')
    await writeFile(path.join(root, '.gitignore'), `${gitignore}deps/\n`, 'utf8')
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({
        preview: { link: ['deps'] },
        phases: {
          default: {
            checks: [{
              name: 'reads-linked-file',
              kind: 'command',
              run: 'node -e "process.exit(require(\'fs\').existsSync(\'deps/marker.txt\') ? 0 : 1)"',
            }],
          },
        },
      }),
      'utf8',
    )
    gitCmd(['add', 'plan.md', 'teammates.gate.json', '.gitignore'])
    gitCmd(['commit', '--quiet', '-m', 'plan, gate manifest with preview.link, and gitignore'])
    gitCmd(['checkout', '--quiet', 'run-branch'])
    gitCmd(['merge', '--quiet', '--ff-only', 'main'])

    // The linked directory is real content sitting in the actual repository working tree —
    // preview.link resolves against ctx.cwd (the repo root), not against anything committed.
    await mkdir(path.join(root, 'deps'), { recursive: true })
    await writeFile(path.join(root, 'deps', 'marker.txt'), 'linked build input\n', 'utf8')

    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)

    gitCmd(['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    gitCmd(['add', 'a.mjs'])
    gitCmd(['commit', '--quiet', '-m', 'T1 work'])
    gitCmd(['checkout', '--quiet', 'run-branch'])

    lines.length = 0
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(code, 0, lines.join('\n'))
    const parsed = JSON.parse(lines.join('\n'))
    assert.equal(parsed.verdict, 'PASS')
    assert.ok(
      parsed.results.some((r) => r.name === 'reads-linked-file' && r.status === 'pass'),
      'the command check must have found the linked file inside the preview',
    )
  })
})

// Fix round: `complete` builds its own ctx (~line 522) separately from `gate`'s (~line 440),
// and only `gate`'s was wired to previewLinks(config). A manifest declaring preview.link
// worked from `gate` and failed from `complete` with the identical repo, manifest, and
// branch — every teammate's own `complete` call would blame its own work for a missing
// build input the manifest declares. This pins that `complete` reaches the same linked file.
test('complete wires a manifest\'s preview.link through to the merge preview', async () => {
  await withRepo(async ({ root, io, lines, git: gitCmd }) => {
    const planPath = path.join(root, 'plan.md')
    gitCmd(['checkout', '--quiet', 'main'])
    await writeFile(planPath, ONE_TASK_PLAN, 'utf8')
    const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8')
    await writeFile(path.join(root, '.gitignore'), `${gitignore}deps/\n`, 'utf8')
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({
        preview: { link: ['deps'] },
        phases: {
          default: {
            checks: [{
              name: 'reads-linked-file',
              kind: 'command',
              run: 'node -e "process.exit(require(\'fs\').existsSync(\'deps/marker.txt\') ? 0 : 1)"',
            }],
          },
        },
      }),
      'utf8',
    )
    gitCmd(['add', 'plan.md', 'teammates.gate.json', '.gitignore'])
    gitCmd(['commit', '--quiet', '-m', 'plan, gate manifest with preview.link, and gitignore'])
    gitCmd(['checkout', '--quiet', 'run-branch'])
    gitCmd(['merge', '--quiet', '--ff-only', 'main'])

    await mkdir(path.join(root, 'deps'), { recursive: true })
    await writeFile(path.join(root, 'deps', 'marker.txt'), 'linked build input\n', 'utf8')

    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)

    gitCmd(['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    gitCmd(['add', 'a.mjs'])
    gitCmd(['commit', '--quiet', '-m', 'T1 work'])
    gitCmd(['checkout', '--quiet', 'run-branch'])

    lines.length = 0
    const code = await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(code, 0, lines.join('\n'))
    assert.match(lines.join('\n'), /T1 done/)
  })
})

test('gate passes no links when the manifest declares no preview.link', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: gitCmd }) => {
    gitCmd(['checkout', '--quiet', 'main'])
    await writeEnforcementManifest(root)
    gitCmd(['add', 'teammates.gate.json'])
    gitCmd(['commit', '--quiet', '-m', 'gate manifest'])
    gitCmd(['checkout', '--quiet', 'run-branch'])
    gitCmd(['merge', '--quiet', '--ff-only', 'main'])
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)

    gitCmd(['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    gitCmd(['add', 'a.mjs'])
    gitCmd(['commit', '--quiet', '-m', 'T1 work'])
    gitCmd(['checkout', '--quiet', 'run-branch'])

    lines.length = 0
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], io)
    assert.equal(code, 0, lines.join('\n'))
    const parsed = JSON.parse(lines.join('\n'))
    // PASS with no link-related error is exactly today's pre-existing, link-free behaviour
    // for a manifest without a preview field: ctx.previewLink resolves to [], and the merge
    // preview needs no repoRoot to satisfy zero link entries.
    assert.equal(parsed.verdict, 'PASS')
    assert.ok(!parsed.error, 'a manifest without preview.link must never fail while resolving a link')

    // PASS alone does not distinguish "ctx.previewLink was [] and did nothing" from "the
    // wiring never ran at all" — both look identical from the exit code and JSON output,
    // which is exactly what a dozen pre-existing end-to-end tests already pin. Read the same
    // manifest the runner boundary reads, through the same previewLinks(config) the `gate`
    // path calls, to pin the actual value ctx.previewLink receives: [].
    const config = await loadGateConfig(root)
    assert.deepEqual(previewLinks(config), [])
  })
})

// Fix round: `const root = flags.root ?? process.cwd()` used `??`, which only rejects
// `undefined` — `--root ""` (e.g. an orchestrator templating an unset shell variable into
// `--root "$PROJECT_ROOT"`) survived as `root = ''`. That empty string reaches
// withMergePreview as `repoRoot`, passes its `typeof repoRoot !== 'string'` guard, and then
// `realpath('')` rejects, silently disabling both realpath-guarded containment checks in
// linkInto — including the one that stops a symlinked node_modules from writing outside the
// repo. Reject empty/whitespace --root outright instead of silently substituting cwd.
test('an empty --root is rejected rather than silently falling back to cwd', async () => {
  await withRepo(async ({ planPath, io, lines }) => {
    const code = await runCli(['init-run', planPath, '--run', 'r1', '--root', ''], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /--root/)
  })
})

test('a whitespace-only --root is rejected rather than silently falling back to cwd', async () => {
  await withRepo(async ({ planPath, io, lines }) => {
    const code = await runCli(['init-run', planPath, '--run', 'r1', '--root', '   '], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /--root/)
  })
})
