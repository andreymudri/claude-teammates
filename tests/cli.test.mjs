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
async function withRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-cli-'))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  const planPath = path.join(root, 'plan.md')
  await writeFile(planPath, PLAN, 'utf8')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', 'initial'])
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
    assert.equal(status.gates.default.verdict, 'PASS')
    assert.ok(typeof status.gates.default.recordedAt === 'number')
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
    assert.equal(status.gates.default.verdict, 'FAIL')
    assert.deepEqual(status.gates.default.failed, ['boom'])
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
    // task branch that the real fileset check below would reject.
    const status = await readStatus(root, 'r1')
    status.gates = { default: { verdict: 'PASS', failed: [], skipped: [], pending: [], recordedAt: Date.now() } }
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
