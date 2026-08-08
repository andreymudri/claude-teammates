import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runCli, mergeSuppliedResults, parseConstraints } from '../scripts/cli.mjs'

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

// Inference sets `preview.link` only when a package.json exists, so a Python, Rust or Go adopter
// gets a manifest with no preview field, links nothing into the merge preview, and every command
// check fails on a tree that is fine. JSON carries no comment, and an empty link list teaches
// nothing, so the guidance goes beside the manifest — printed only where it is needed.
test('gate inference without a package.json says how to provision the merge preview', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await rm(path.join(root, 'package.json'))
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root], io)
    assert.equal(code, 3)
    const out = lines.join('\n')
    assert.match(out, /inferred gate manifest/)
    assert.match(out, /tracked files only/i)
    assert.match(out, /"preview": \{ "link"/)
    // The inferred manifest itself must stay a manifest: no preview field is invented for a
    // project whose build inputs the CLI cannot name — and above all not `node_modules`, which
    // a non-Node repo does not have and whose link would fail the merge check.
    assert.doesNotMatch(out, /"link": \[\s*\]/)
    assert.doesNotMatch(out, /node_modules/)
  })
})

test('gate inference with a package.json links node_modules and prints no provisioning note', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8')
    const code = await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root], io)
    assert.equal(code, 3)
    const out = lines.join('\n')
    assert.match(out, /"node_modules"/)
    assert.doesNotMatch(out, /tracked files only/i)
  })
})

// End-to-end on a real repository: the report is only worth anything if it reads the actual
// refs. T1 gets a real commit, T2 a branch pointed at the run tip with nothing on it — the
// stale-base shape — and the report must tell them apart without being told which is which.
test('doctor reports a real contribution and an empty branch from git alone', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    g(['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    g(['add', 'a.mjs'])
    g(['commit', '--quiet', '-m', 'T1 work'])
    g(['checkout', '--quiet', 'run-branch'])
    g(['branch', 'teammates/r1/T2'])
    lines.length = 0
    const code = await runCli(['doctor', '--run', 'r1', '--plan', planPath, '--base', 'main', '--root', root], io)
    const out = lines.join('\n')
    assert.match(out, /T1/)
    assert.match(out, /T1 work/)
    assert.match(out, /T2.*NO CHANGES|NO CHANGES/s)
    assert.match(out, /problem/)
    // Exit 1 on problems, so a caller can branch on it the way it branches on the gate.
    assert.equal(code, 1)
  })
})

test('doctor exits 0 and says so when it finds nothing wrong', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    for (const id of ['T1', 'T2', 'T3']) {
      g(['checkout', '--quiet', '-b', `teammates/r1/${id}`])
      await writeFile(path.join(root, `${id}.mjs`), 'export const x = 1\n', 'utf8')
      g(['add', `${id}.mjs`])
      g(['commit', '--quiet', '-m', `${id} work`])
      g(['checkout', '--quiet', 'run-branch'])
    }
    lines.length = 0
    const code = await runCli(['doctor', '--run', 'r1', '--plan', planPath, '--base', 'main', '--root', root], io)
    assert.match(lines.join('\n'), /no problems/i)
    assert.equal(code, 0)
  })
})

// The diagnostic has to work in exactly the state the gate refuses to run in — the main
// worktree parked on the base branch — because that is when an operator most needs it.
test('doctor still reports when the main worktree sits on the base branch', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    g(['checkout', '--quiet', 'main'])
    lines.length = 0
    const code = await runCli(
      ['doctor', '--run', 'r1', '--plan', planPath, '--base', 'main', '--run-branch', 'run-branch', '--root', root],
      io,
    )
    assert.match(lines.join('\n'), /main worktree is on main/)
    assert.equal(code, 1)
  })
})

async function writeReviewFile(root, runId, name, body) {
  await mkdir(path.join(root, '.teammates', runId, 'reviews'), { recursive: true })
  await writeFile(path.join(root, '.teammates', runId, 'reviews', name), JSON.stringify(body), 'utf8')
}

test('collect-reviews turns the reviewers’ findings files into a gate results file', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const config = {
      lens: ['correctness', 'security'],
      phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer', blockOn: ['high'] }] } },
    }
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(config), 'utf8')
    await writeReviewFile(root, 'r1', '1-correctness.json', { findings: [] })
    await writeReviewFile(root, 'r1', '1-security.json', {
      findings: [{ severity: 'high', file: 'a.mjs', line: 2, summary: 's', failureScenario: 'f' }],
    })
    lines.length = 0
    const code = await runCli(['collect-reviews', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.equal(code, 0)
    const parsed = JSON.parse(lines.join('\n'))
    assert.equal(parsed.results[0].status, 'fail')
    assert.equal(parsed.results[0].source, 'file')
    assert.equal(parsed.results[0].findings[0].lens, 'security')
  })
})

// The whole point of the fallback: a lens whose reviewer died leaves no file, and that must not
// collapse into a passing review. Exit 4 — "cannot verify", the code `complete` already uses for
// this shape of answer — rather than printing a results file the caller would feed to the gate.
test('collect-reviews refuses to emit a results file while a lens is missing', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const config = {
      lens: ['correctness', 'security'],
      phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer' }] } },
    }
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(config), 'utf8')
    await writeReviewFile(root, 'r1', '1-correctness.json', { findings: [] })
    lines.length = 0
    const code = await runCli(['collect-reviews', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.equal(code, 4)
    const out = lines.join('\n')
    assert.match(out, /security/)
    assert.doesNotMatch(out, /"status": "pass"/)
  })
})

test('collect-reviews reports a findings file that is not readable JSON instead of skipping it', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const config = {
      lens: ['correctness'],
      phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer' }] } },
    }
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(config), 'utf8')
    await mkdir(path.join(root, '.teammates', 'r1', 'reviews'), { recursive: true })
    await writeFile(path.join(root, '.teammates', 'r1', 'reviews', '1-correctness.json'), '{ not json', 'utf8')
    lines.length = 0
    const code = await runCli(['collect-reviews', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.equal(code, 4)
    assert.match(lines.join('\n'), /1-correctness\.json/)
  })
})

test('collect-reviews needs a manifest to know which lenses were dispatched', async () => {
  await withRepo(async ({ root, io, lines }) => {
    lines.length = 0
    const code = await runCli(['collect-reviews', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.equal(code, 4)
    assert.match(lines.join('\n'), /manifest/)
  })
})

async function writeReviewManifest(root, extra = {}) {
  await writeFile(
    path.join(root, 'teammates.gate.json'),
    JSON.stringify({
      lens: ['correctness', 'security'],
      phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer', blockOn: ['high'] }] } },
      ...extra,
    }),
    'utf8',
  )
}

test('review-dispatch emits one unnamed reviewer per lens over the phase branches', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeReviewManifest(root)
    for (const id of ['T1', 'T2']) {
      g(['checkout', '--quiet', '-b', `teammates/r1/${id}`])
      await writeFile(path.join(root, `${id}.mjs`), 'export const x = 1\n', 'utf8')
      g(['add', `${id}.mjs`])
      g(['commit', '--quiet', '-m', `${id} work`])
      g(['checkout', '--quiet', 'run-branch'])
    }
    lines.length = 0
    const code = await runCli(['review-dispatch', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.equal(code, 0)
    const spec = JSON.parse(lines.join('\n'))
    assert.equal(spec.reviewers.length, 2)
    assert.equal(spec.tier, 'capable')
    assert.equal(spec.reviewers[0].name, null)
    assert.match(spec.reviewers[0].findingsPath, /reviews\/1-correctness\.json$/)
    assert.match(spec.reviewers[0].prompt, /teammates\/r1\/T1/)
  })
})

// The reviewer grades the diff, so its tier comes from the tracked manifest only — the
// gitignored local layer must not be able to pick the judge. The generated dispatch has to
// follow the same rule the skill states.
test('review-dispatch takes the reviewer tier from the tracked manifest', async () => {
  await withRepo(async ({ root, planPath, io, lines, git: g }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeReviewManifest(root, { agents: { reviewer: { tier: 'mid', effort: 'high' } } })
    g(['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'T1.mjs'), 'export const x = 1\n', 'utf8')
    g(['add', 'T1.mjs'])
    g(['commit', '--quiet', '-m', 'T1 work'])
    g(['checkout', '--quiet', 'run-branch'])
    lines.length = 0
    const code = await runCli(
      ['review-dispatch', '--run', 'r1', '--phase', '1', '--root', root, '--models', '{"mid":"sonnet"}'],
      io,
    )
    assert.equal(code, 0)
    const spec = JSON.parse(lines.join('\n'))
    assert.equal(spec.tier, 'mid')
    assert.equal(spec.reviewers[0].model, 'sonnet')
    assert.equal(spec.reviewers[0].effort, 'high')
  })
})

// A phase whose branches do not exist yet has nothing to review. Emitting a dispatch anyway
// would produce reviewers grading an empty diff and reporting no findings — a clean-looking
// review of nothing at all.
test('review-dispatch refuses a phase whose task branches do not exist', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeReviewManifest(root)
    lines.length = 0
    const code = await runCli(['review-dispatch', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.equal(code, 4)
    assert.match(lines.join('\n'), /branch/i)
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

// `gate`, `complete` and `fix` read the manifest through a path neither validator covered. It
// failed CLOSED — a body of `[]` yields zero checks and the verdict is FAIL — so nothing passed
// that should not have. What the operator got was a failing gate and no word about their
// manifest, and one variant was worse: a non-array `checks` died with a TypeError, so stdout
// was not the JSON the phase-gate skill parses.
const BROKEN_MANIFESTS = [
  { body: '[]', message: /^teammates\.gate\.json must contain a JSON object$/m },
  { body: '"nope"', message: /^teammates\.gate\.json must contain a JSON object$/m },
  { body: 'null', message: /^teammates\.gate\.json must contain a JSON object$/m },
  { body: '{ not json', message: /^teammates\.gate\.json is not valid JSON/m },
  {
    // The TypeError variant, by name.
    body: JSON.stringify({ phases: { default: { checks: 'nope' } } }),
    message: /^phases\.default\.checks must be an array$/m,
  },
  {
    body: JSON.stringify({ lens: 'correctness', phases: { default: { checks: [] } } }),
    message: /^lens must be a non-empty array of strings$/m,
  },
]

test('gate exits 2 naming the manifest instead of returning a verdict about it', async () => {
  for (const { body, message } of BROKEN_MANIFESTS) {
    await withRepo(async ({ root, planPath, io, lines }) => {
      await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
      await writeFile(path.join(root, 'teammates.gate.json'), body, 'utf8')
      lines.length = 0
      assert.equal(await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], io), 2, body)
      assert.match(lines.join('\n'), message, body)
      // Not a verdict. Exit 1 with a FAIL body would have the operator reading the checks for
      // a cause that is not there, and 3 would have them saving an inferred manifest over the
      // broken one they meant to fix.
      assert.doesNotMatch(lines.join('\n'), /"verdict"/, body)
      assert.doesNotMatch(lines.join('\n'), /inferred gate manifest/, body)
    })
  }
})

test('complete and fix exit 2 on the same broken manifest', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeFile(path.join(root, 'teammates.gate.json'), '[]', 'utf8')
    lines.length = 0
    assert.equal(await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--root', root], io), 2)
    // 2, not the 4 an absent manifest gets: `cannot verify completion` reads as a verdict about
    // the teammate's own branch, and it is the repo's config that is broken.
    assert.match(lines.join('\n'), /^teammates\.gate\.json must contain a JSON object$/m)
    assert.doesNotMatch(lines.join('\n'), /cannot verify completion/)

    const verdictPath = path.join(root, 'verdict.json')
    await writeFile(verdictPath, JSON.stringify({ verdict: 'FAIL', phase: 1, results: [] }), 'utf8')
    lines.length = 0
    assert.equal(await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io), 2)
    assert.match(lines.join('\n'), /^teammates\.gate\.json must contain a JSON object$/m)
    // `fix` used to read the same file as `?? {}`, so a broken manifest silently became the
    // DEFAULT fix budget — indistinguishable, from the outside, from a budget that was set.
    assert.doesNotMatch(lines.join('\n'), /"decision"/)
  })
})

// The absent manifest is not the broken one, and each command still answers it its own way.
test('an absent manifest keeps its own exit code in all three commands', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    assert.equal(await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], io), 3)
    assert.match(lines.join('\n'), /inferred gate manifest/)
    lines.length = 0
    assert.equal(await runCli(['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md', '--root', root], io), 4)
    assert.match(lines.join('\n'), /no gate manifest — cannot verify completion/)
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
    assert.match(lines.join('\n'), /init-run\|gate\|doctor\|digest\|claim\|unclaim\|workflow\|complete\|fix/)
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
// A review recovered from the reviewer's findings file — because the reviewer idled without
// returning — is a different fact from one the reviewer handed back, and until now it survived
// nowhere: `--results` carried no way to say it, so the recorded verdict could not tell the two
// apart. `source` is provenance only; it never affects the verdict.
test('mergeSuppliedResults carries the provenance of a supplied result', () => {
  const raw = [{ name: 'review', kind: 'agent', status: 'pending', output: '', optional: false }]
  const merged = mergeSuppliedResults(raw, [
    { name: 'review', kind: 'agent', status: 'pass', findings: [], source: 'file' },
  ])
  assert.equal(merged[0].source, 'file')
})

test('mergeSuppliedResults defaults provenance to the returned response', () => {
  const raw = [{ name: 'review', kind: 'agent', status: 'pending', output: '', optional: false }]
  const merged = mergeSuppliedResults(raw, [{ name: 'review', kind: 'agent', status: 'pass' }])
  assert.equal(merged[0].source, 'response')
})

test('gate rejects a supplied result whose provenance is not one of the two it knows', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const config = { phases: { default: { checks: [{ name: 'review', kind: 'agent', agent: 'tm-reviewer' }] } } }
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(config), 'utf8')
    const results = path.join(root, 'results.json')
    await writeFile(results, JSON.stringify({
      results: [{ name: 'review', kind: 'agent', status: 'pass', source: 'trust me' }],
    }), 'utf8')
    lines.length = 0
    const code = await runCli(
      ['gate', '--run', 'r1', '--plan', 'plan.md', '--no-fleet', '--root', root, '--results', results],
      io,
    )
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /source/)
  })
})

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
    // The check writes a sentinel file at an absolute path outside the merge preview's own
    // worktree — reachable regardless of the command's cwd — but only after confirming the
    // linked file is visible. `complete`'s exit code and "T1 done" stay identical whether this
    // check genuinely ran and passed, or was silently skipped (aggregateVerdict counts `skip`
    // as neither failed nor pending), so the exit code alone cannot tell those apart. The
    // sentinel can: it exists only if the command actually executed inside the preview and
    // found the linked file there.
    const sentinelPath = path.join(root, 'sentinel-executed.txt')
    // Built as a single-quoted JS string literal (backslashes doubled) rather than with
    // JSON.stringify, which would emit double quotes that collide with the outer `-e "..."`
    // quoting the same way the pre-existing check's `\'fs\'` escaping already avoids.
    const sentinelLiteral = `'${sentinelPath.replace(/\\/g, '\\\\')}'`
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({
        preview: { link: ['deps'] },
        phases: {
          default: {
            checks: [{
              name: 'reads-linked-file',
              kind: 'command',
              run: `node -e "const fs=require('fs'); const ok=fs.existsSync('deps/marker.txt'); if (ok) fs.writeFileSync(${sentinelLiteral}, 'ran'); process.exit(ok ? 0 : 1)"`,
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
    const ranInsidePreview = await readFile(sentinelPath, 'utf8').catch(() => null)
    assert.equal(ranInsidePreview, 'ran', 'the command check must have actually run inside the preview and found the linked file')
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
    // What ctx.previewLink actually resolves to for an absent preview.link, and that it is
    // this same previewLinks(config) the `gate` path calls, is already pinned by the unit
    // tests `previewLinks returns [] when there is nothing to link` and `previewLinks
    // returns [] when link is not an array` — this end-to-end test only needs the PASS
    // above, confirming the absent-link path never fails while resolving a link.
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
    assert.match(lines.join('\n'), /--root must not be empty/)
  })
})

test('a whitespace-only --root is rejected rather than silently falling back to cwd', async () => {
  await withRepo(async ({ planPath, io, lines }) => {
    const code = await runCli(['init-run', planPath, '--run', 'r1', '--root', '   '], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /--root must not be empty/)
  })
})

// Fix round: parseFlags maps a flag with no following value (last on argv, or immediately
// followed by another flag) to `true`, not a string — so a bare `--root` with its value
// missing entirely (the same unset-`$PROJECT_ROOT`-templated-unquoted mistake, one step
// further) skipped the string-emptiness guard above and reached path.join(true, ...) as a
// raw TypeError with no verdict. Solo `gate` has no `--run` to catch it incidentally.
test('a --root with no value at all is rejected rather than crashing', async () => {
  await withRepo(async ({ io, lines }) => {
    const code = await runCli(['gate', '--no-fleet', '--root'], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /--root must not be empty/)
  })
})

// --- init-run re-run must not erase what the gate recorded ---------------------------
//
// `init-run` used to write a fresh status object unconditionally, so re-running it on an
// existing run id dropped `gates` and `fixRounds` — the run's only history of what passed
// and what it cost. A plan amendment mid-run is a normal reason to re-init, and after one
// the rule "never report a phase done without a recorded PASS" became unsatisfiable.
test('init-run run twice preserves a gates object recorded between the two runs', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const status = await readStatus(root, 'r1')
    status.gates = { 1: { verdict: 'PASS', at: '2026-08-06T00:00:00.000Z' } }
    await writeFile(path.join(root, '.teammates', 'r1', 'status.json'), JSON.stringify(status), 'utf8')

    assert.equal(await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io), 0)
    const after = await readStatus(root, 'r1')
    assert.deepEqual(after.gates, { 1: { verdict: 'PASS', at: '2026-08-06T00:00:00.000Z' } })
  })
})

test('init-run run twice preserves fixRounds recorded between the two runs', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const status = await readStatus(root, 'r1')
    status.fixRounds = { 1: { T1: 2 } }
    await writeFile(path.join(root, '.teammates', 'r1', 'status.json'), JSON.stringify(status), 'utf8')

    assert.equal(await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io), 0)
    const after = await readStatus(root, 'r1')
    assert.deepEqual(after.fixRounds, { 1: { T1: 2 } })
  })
})

// Absent, not empty: an empty `gates` object is indistinguishable from a recorded one to
// anything that only checks the key's presence, so a fresh run must carry neither key.
test('init-run on a fresh run id emits neither gates nor fixRounds', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await runCli(['init-run', planPath, '--run', 'fresh', '--root', root], io)
    const status = await readStatus(root, 'fresh')
    assert.ok(!('gates' in status), 'a fresh run must not carry a gates key at all')
    assert.ok(!('fixRounds' in status), 'a fresh run must not carry a fixRounds key at all')
  })
})

// The amendment case this exists for: the plan grew a phase and a task, and the re-init has
// to pick both up while still preserving the earlier phase's recorded verdict.
test('init-run re-run after a plan change updates totalPhases and tasks while preserving gates', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const before = await readStatus(root, 'r1')
    assert.equal(before.totalPhases, 2)
    before.gates = { 1: { verdict: 'PASS' } }
    await writeFile(path.join(root, '.teammates', 'r1', 'status.json'), JSON.stringify(before), 'utf8')

    await writeFile(planPath, `${PLAN}
### Task 3: C

**Files:**
- Create: \`c.mjs\`

**Depends:** T2
`, 'utf8')
    assert.equal(await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io), 0)

    const after = await readStatus(root, 'r1')
    assert.equal(after.totalPhases, 3)
    assert.deepEqual(after.tasks.map((t) => t.id), ['T1', 'T2', 'T3'])
    assert.deepEqual(after.gates, { 1: { verdict: 'PASS' } })
  })
})

// `phase` is run history too: it is how far the run got. Re-writing it as 1 on a re-init
// is the same "re-init erases what the gate recorded" failure as dropping `gates`, and it
// is the one that silently rewinds a mid-run plan amendment back to the first phase.
test('init-run re-run preserves a recorded phase rather than rewinding the run to 1', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const status = await readStatus(root, 'r1')
    status.phase = 2
    await writeFile(path.join(root, '.teammates', 'r1', 'status.json'), JSON.stringify(status), 'utf8')

    assert.equal(await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io), 0)
    const after = await readStatus(root, 'r1')
    assert.equal(after.phase, 2, 're-init must not rewind a run that already reached phase 2')
  })
})

// The other direction: with no previous status there is nothing to carry forward, so a
// fresh run must start at 1 rather than at undefined.
test('init-run on a fresh run id starts at phase 1', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await runCli(['init-run', planPath, '--run', 'fresh', '--root', root], io)
    assert.equal((await readStatus(root, 'fresh')).phase, 1)
  })
})

// --- workflow wires --plan and --base through to the generated brief -----------------
//
// Evaluates the generated body with stubbed primitives and returns every prompt the
// generated code passed to agent(). The brief is assembled at run time by string
// concatenation, so the checkout command exists only once the generated code runs —
// asserting on the source text alone would never see it.
async function captureAgentPrompts(src) {
  const body = src.replace(/^export const meta = /m, 'const meta = ')
  const captured = []
  const phaseFn = () => {}
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const agent = (prompt) => {
    captured.push(prompt)
    return Promise.resolve({ status: 'done', branch: 'b', filesChanged: [], summary: 's', blockers: [] })
  }
  const run = new Function('phase', 'parallel', 'agent', `return (async () => { ${body} })`)(phaseFn, parallel, agent)
  await run()
  return captured
}

// The values cli.mjs decides and hands the generator, read by running the generated module
// rather than by matching its text. Asserting on the rendered declaration would couple these
// tests to the template's spacing and to jsString's choice of quote character — both owned by
// tests/workflow-gen.test.mjs — so a pure reformat of templates/phase-workflow.js would fail
// a test about cli.mjs. Evaluating the module reads the argument that actually arrived.
async function captureWorkflowConstants(src) {
  const body = src.replace(/^export const meta = /m, 'const meta = ')
  // The module ends in a top-level `return`, so anything appended after it is unreachable.
  // Discarding that one value is what lets the constants be read; it couples this helper to
  // the workflow contract that a phase module returns its results, not to how any
  // declaration inside it is spelled.
  const at = body.lastIndexOf('\nreturn ')
  assert.ok(at !== -1, 'a generated phase module must end in a top-level return')
  const readable = `${body.slice(0, at)}\nvoid ${body.slice(at + '\nreturn '.length)}`
  const phaseFn = () => {}
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const agent = () =>
    Promise.resolve({ status: 'done', branch: 'b', filesChanged: [], summary: 's', blockers: [] })
  const run = new Function(
    'phase',
    'parallel',
    'agent',
    `return (async () => { ${readable}\n;return { PLAN_PATH, BASE_BRANCH } })`,
  )(phaseFn, parallel, agent)
  return run()
}

test('workflow --plan and --base put the base branch in a checkout line and name the plan', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(
      ['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--plan', planPath, '--base', 'run-branch'],
      io,
    )
    assert.equal(code, 0, lines.join('\n'))
    const src = lines.join('\n')
    const [prompt] = await captureAgentPrompts(src)
    assert.ok(
      prompt.includes('git checkout -B teammates/r1/T1 run-branch'),
      'the base branch must reach the brief as a runnable checkout start point',
    )
    assert.ok(prompt.includes(planPath), 'the brief must point at the plan the run was initialised from')
  })
})

test('workflow with a plan carrying Global Constraints puts every constraint in the brief', async () => {
  await withRepo(async ({ root, planPath, io, lines, git }) => {
    await writeFile(planPath, `${PLAN}
## Global Constraints

- Node >= 24.2.0
- Zero new runtime dependencies
`, 'utf8')
    // Committed on the base branch, because that is where the anchor reads it from. A plan
    // that exists only in the working tree is not the plan the gate will enforce.
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'plan with constraints'])
    git(['branch', '--force', 'main', 'HEAD'])
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--plan', planPath], io)
    const [prompt] = await captureAgentPrompts(lines.join('\n'))
    assert.ok(prompt.includes('- Node >= 24.2.0'), 'first constraint must reach the brief')
    assert.ok(prompt.includes('- Zero new runtime dependencies'), 'second constraint must reach the brief')
  })
})

// The brief is generated from the plan at the anchor, never from the checked-out copy. Both
// `gate` and `complete` already read it that way, so that a teammate cannot widen its own
// declared file set by editing the working tree. Reading it from disk here left the two
// disagreeing: constraints injected into every dispatch would have come from mutable,
// uncommitted markdown while the gate enforced the committed plan.
test('workflow reads the plan from the anchor, not the working tree', async () => {
  await withRepo(async ({ root, planPath, io, lines, git }) => {
    await writeFile(planPath, `${PLAN}
## Global Constraints

- committed rule
`, 'utf8')
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'plan with constraints'])
    git(['branch', '--force', 'main', 'HEAD'])
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    // Edited after the commit and left uncommitted: this is the text an enforced agent could
    // put on disk between phases. It must not reach any brief.
    await writeFile(planPath, `${PLAN}
## Global Constraints

- committed rule
- injected from the working tree
`, 'utf8')
    lines.length = 0
    const code = await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--plan', planPath], io)
    assert.equal(code, 0, lines.join('\n'))
    const [prompt] = await captureAgentPrompts(lines.join('\n'))
    assert.ok(prompt.includes('- committed rule'), 'the committed constraint must reach the brief')
    assert.ok(
      !prompt.includes('injected from the working tree'),
      'an uncommitted edit must not reach the brief',
    )
  })
})

// A --plan pointing at nothing must fail loudly. Silently generating a constraint-free
// brief would hand every teammate in the phase a dispatch missing the very rules the
// caller asked to include, with exit 0 and nothing on stdout to say so.
test('workflow --plan naming a file that does not exist exits 2 rather than dropping the constraints', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(
      ['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--plan', path.join(root, 'nope.md')],
      io,
    )
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /--plan/)
  })
})

// Both flags are optional: omitted, the brief renders its no-base variant rather than
// failing or, worse, rendering the string "undefined" where a branch name belongs.
test('workflow with neither --plan nor --base still succeeds and emits no undefined', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.equal(code, 0, lines.join('\n'))
    const src = lines.join('\n')
    assert.ok(!src.includes('undefined'), 'generated source must never contain the string undefined')
    const [prompt] = await captureAgentPrompts(src)
    assert.ok(!prompt.includes('undefined'), 'the brief must never contain the string undefined')
  })
})

// A bare `--plan`/`--base` parses as `true` (parseFlags's boolean-switch reading). Coerced
// into the generator it would render the literal `true` as a plan path or a branch name, so
// each is treated as the omitted value it is.
test('workflow with a valueless --base renders the no-base brief rather than the word true', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--base'], io)
    assert.equal(code, 0, lines.join('\n'))
    const src = lines.join('\n')
    // The value, not its rendering: what cli.mjs decides here is the empty string, and that
    // is what the generated module must hold however the template spells the declaration.
    const { BASE_BRANCH } = await captureWorkflowConstants(src)
    assert.equal(BASE_BRANCH, '', 'a valueless --base must reach the generator as the empty string')
    const [prompt] = await captureAgentPrompts(src)
    assert.ok(!prompt.includes('git checkout -B teammates/r1/T1 true'), 'a valueless --base must not become a branch')
  })
})

// The symmetric case. Without the `=== true` guard, `--plan` written bare reaches readFile
// as the boolean `true`, which throws — so the command exits 2 with "--plan true could not
// be read" instead of rendering the no-plan brief and exiting 0.
test('workflow with a valueless --plan renders the no-plan brief rather than failing to read "true"', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const code = await runCli(
      ['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--base', 'main', '--plan'],
      io,
    )
    assert.equal(code, 0, lines.join('\n'))
    const src = lines.join('\n')
    const { PLAN_PATH } = await captureWorkflowConstants(src)
    assert.equal(PLAN_PATH, '', 'a valueless --plan must reach the generator as the empty string')
    const [prompt] = await captureAgentPrompts(src)
    assert.ok(!prompt.includes('PLAN. Read true'), 'a valueless --plan must not become a plan path')
  })
})

test('workflow names --plan and --base in its usage line', async () => {
  await withRepo(async ({ io, lines }) => {
    await runCli(['nope'], io)
    assert.match(lines.join('\n'), /workflow .*--plan <path>.*--base <branch>/)
  })
})

// --- parseConstraints ----------------------------------------------------------------
test('parseConstraints returns every bullet of a Global Constraints section', async () => {
  const constraints = parseConstraints(`# Plan

## Global Constraints

- Node >= 24.2.0
- Zero new runtime dependencies and zero new dev dependencies
- Tests use the built-in \`node:test\` runner

## Tasks

- not a constraint
`)
  assert.deepEqual(constraints, [
    'Node >= 24.2.0',
    'Zero new runtime dependencies and zero new dev dependencies',
    'Tests use the built-in `node:test` runner',
  ])
})

// A task heading is `###`, one level deeper than the section itself, and its file bullets
// are not constraints. Terminating only on `##` would sweep every task's file list into
// the list every teammate is told it must obey.
test('parseConstraints stops at the next heading of any level', async () => {
  assert.deepEqual(
    parseConstraints('## Global Constraints\n\n- only this one\n\n### Task 1: A\n\n- Create: `a.mjs`\n'),
    ['only this one'],
  )
})

test('parseConstraints returns [] for a plan without a Global Constraints section', async () => {
  assert.deepEqual(parseConstraints('# Plan\n\n## Tasks\n\n- a bullet\n'), [])
  assert.deepEqual(parseConstraints(''), [])
  assert.deepEqual(parseConstraints(undefined), [])
})

// The section running to the end of the file is the common case for a plan that lists its
// constraints last, and it has no following heading to terminate on.
test('parseConstraints reads a section that runs to the end of the file', async () => {
  assert.deepEqual(parseConstraints('# Plan\n\n## Global Constraints\n\n- a\n- b\n'), ['a', 'b'])
})

// A wrapped bullet is one constraint, not a truncated one. A plan author who wraps a long
// rule at the margin must not ship every teammate its first line and silently drop the rest.
test('parseConstraints joins a bullet wrapped over more than one line', async () => {
  assert.deepEqual(
    parseConstraints('## Global Constraints\n\n- a constraint that\n  wraps a line\n- a second one\n'),
    ['a constraint that wraps a line', 'a second one'],
  )
})

// A blank line closes the item, so a following indented paragraph is not swallowed into
// the constraint above it.
test('parseConstraints does not join an indented line separated from its bullet by a blank line', async () => {
  assert.deepEqual(
    parseConstraints('## Global Constraints\n\n- a constraint\n\n  an indented aside\n'),
    ['a constraint'],
  )
})

// Pinned as-is: a nested bullet is flattened to a standalone constraint. Every teammate
// reads it as a rule in its own right, which is the intended reading for a plan that
// indents a sub-rule, and a change to the bullet regex must not alter it unnoticed.
test('parseConstraints flattens a nested bullet into a standalone constraint', async () => {
  assert.deepEqual(
    parseConstraints('## Global Constraints\n\n- a\n  - nested\n- b\n'),
    ['a', 'nested', 'b'],
  )
})

// One continuation line is the case a wrap-at-the-margin author hits first, but it is not
// the case that pins the loop: closing the item after absorbing a single line still passes
// a one-line-wrap test while dropping everything from the second continuation line on. A
// three-line bullet is the shortest input that distinguishes "join the wrap" from "join one
// line of the wrap", which is the same silent truncation the join exists to prevent.
test('parseConstraints joins every continuation line of a bullet wrapped over three lines', async () => {
  assert.deepEqual(
    parseConstraints('## Global Constraints\n\n- a\n  b\n  c\n- d\n'),
    ['a b c', 'd'],
  )
})

// The join must not turn a line it cannot read into a corruption of the line above it. An
// indented line that opens like a bullet but that the bullet pattern rejects — a bullet with
// no text, or one whose text is broken up by a Unicode line separator, which `.` does not
// match — is a rule in its own right, however malformed. Appending it to the previous item
// would silently fuse two unrelated rules into one constraint that every teammate then reads
// as a single sentence. It is dropped instead: losing a malformed rule is recoverable, a
// constraint that says something neither author wrote is not.
test('parseConstraints drops an indented bullet the bullet pattern rejects rather than gluing it to the constraint above', async () => {
  // A bare `-` with no text is the shape the bullet pattern genuinely rejects. It is dropped,
  // not appended: joining it would fuse two unrelated rules into one sentence that says what
  // neither author wrote, which a teammate cannot detect. Losing a malformed rule is the only
  // failure here that cannot silently misinform.
  assert.deepEqual(
    parseConstraints('## Global Constraints\n\n- x\n  -  \n- y\n'),
    ['x', 'y'],
  )
})

// A continuation line may legitimately open with a hyphen: `--no-ff` begins the second line of
// a wrapped rule in this project's own constraints. Excluding every leading hyphen would
// truncate that rule into a sentence that reads complete, which is the corruption the join
// exists to prevent, arriving from the other side. Only a bullet-shaped opener — `- `, or a
// bare `-` — closes the item.
test('parseConstraints joins a continuation line that opens with a hyphen but is not a bullet', async () => {
  assert.deepEqual(
    parseConstraints('## Global Constraints\n\n- use the flag\n  --no-ff always\n'),
    ['use the flag --no-ff always'],
  )
})

// The bullet pattern captures with `[^\n]`, not `.`: `.` does not match U+2028/U+2029 while
// `\s` does, so a bullet whose text contained one failed the pattern entirely and vanished
// with no diagnostic — a rule the plan states, reaching no teammate's brief. Written as an
// escape rather than a raw character so the case is visible in the source and survives any
// editor or formatter that normalises line separators.
test('parseConstraints keeps a bullet whose text contains a Unicode line separator', async () => {
  assert.deepEqual(
    parseConstraints('## Global Constraints\n\n- keep it\u2028simple\n- and this one\n'),
    ['keep it\u2028simple', 'and this one'],
  )
  // Indented, such a line is a nested bullet like any other: flattened to a standalone
  // constraint, never glued onto the rule above it.
  assert.deepEqual(
    parseConstraints('## Global Constraints\n\n- x\n  - y\u2028z\n'),
    ['x', 'y\u2028z'],
  )
})

// The join removes the wrap and nothing else: it is not a reformatter. A run of spaces the
// author put inside a continuation line is part of the constraint text and survives, exactly
// as a run of spaces inside the bullet's own first line already does.
test('parseConstraints preserves internal whitespace when joining a wrapped bullet', async () => {
  assert.deepEqual(
    parseConstraints('## Global Constraints\n\n- a\n  b   c\n'),
    ['a b   c'],
  )
})

// Prose with no bullets is not a constraint list. It yields nothing rather than becoming
// one constraint per line of the paragraph.
test('parseConstraints returns [] for a section of prose with no bullets', async () => {
  assert.deepEqual(
    parseConstraints('## Global Constraints\n\nThere are no constraints on this run.\n\n## Tasks\n'),
    [],
  )
})

// --- Task 5: the `config` subcommand, and the config layers reaching the commands that consume them.

async function readLocal(root) {
  return JSON.parse(await readFile(path.join(root, 'teammates.local.json'), 'utf8'))
}

async function readGateFile(root) {
  return JSON.parse(await readFile(path.join(root, 'teammates.gate.json'), 'utf8'))
}

async function exists(file) {
  try {
    await readFile(file, 'utf8')
    return true
  } catch {
    return false
  }
}

test('usage lists the config subcommand and its four forms', async () => {
  await withRepo(async ({ io, lines }) => {
    assert.equal(await runCli(['nope'], io), 2)
    const text = lines.join('\n')
    assert.match(text, /\|config>/)
    assert.match(text, /config\s+list \[--root <path>\]/)
    assert.match(text, /config\s+get <key>/)
    assert.match(text, /config\s+set <key> <value>.*--local/)
    assert.match(text, /config\s+unset <key>.*--local/)
  })
})

test('config list prints every resolved field with the layer it came from', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'list', '--root', root], io)
    assert.equal(code, 0)
    const text = lines.join('\n')
    assert.match(text, /^maxParallel\s+\d+\s+\(default\)$/m)
    assert.match(text, /^caveman\s+false\s+\(default\)$/m)
    for (const role of ['implementer', 'reviewer', 'integrator']) {
      assert.match(text, new RegExp(`^agents\\.${role}\\.tier\\s+-\\s+\\(default\\)$`, 'm'))
      assert.match(text, new RegExp(`^agents\\.${role}\\.effort\\s+-\\s+\\(default\\)$`, 'm'))
    }
  })
})

// Provenance is per FIELD. A role whose tier is pinned in the tracked manifest and whose effort
// comes from the gitignored file must not report one layer for both — an operator reading the
// list has to be able to tell which of the two they can change without leaving evidence.
test('config list reports the source per field, not per role', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ agents: { implementer: { tier: 'capable' } }, phases: { default: { checks: [] } } }),
      'utf8',
    )
    await writeFile(
      path.join(root, 'teammates.local.json'),
      JSON.stringify({ agents: { implementer: { effort: 'high' } } }),
      'utf8',
    )
    assert.equal(await runCli(['config', 'list', '--root', root], io), 0)
    const text = lines.join('\n')
    assert.match(text, /^agents\.implementer\.tier\s+capable\s+\(teammates\.gate\.json\)$/m)
    assert.match(text, /^agents\.implementer\.effort\s+high\s+\(teammates\.local\.json\)$/m)
  })
})

test('config set --local writes the local layer and gitignores it, reporting both', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'set', 'maxParallel', '12', '--local', '--root', root], io)
    assert.equal(code, 0)
    assert.deepEqual(await readLocal(root), { maxParallel: 12 })
    const text = lines.join('\n')
    assert.match(text, /wrote teammates\.local\.json/)
    assert.match(text, /added teammates\.local\.json to \.gitignore/)
    const ignore = await readFile(path.join(root, '.gitignore'), 'utf8')
    assert.equal(ignore.split(/\r?\n/).filter((l) => l.trim() === 'teammates.local.json').length, 1)
  })
})

test('a second config set does not append a duplicate gitignore line', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await runCli(['config', 'set', 'maxParallel', '12', '--local', '--root', root], io)
    lines.length = 0
    assert.equal(await runCli(['config', 'set', 'caveman', 'full', '--local', '--root', root], io), 0)
    assert.doesNotMatch(lines.join('\n'), /added teammates\.local\.json/)
    const ignore = await readFile(path.join(root, '.gitignore'), 'utf8')
    assert.equal(ignore.split(/\r?\n/).filter((l) => l.trim() === 'teammates.local.json').length, 1)
    assert.deepEqual(await readLocal(root), { maxParallel: 12, caveman: 'full' })
  })
})

// A bare word that is not valid JSON is the string the caller typed, so `capable` needs no shell
// quoting; `12` and `false` still arrive as a number and a boolean rather than as their spelling.
test('config set parses a JSON value first and falls back to the literal string', async () => {
  await withRepo(async ({ root, io }) => {
    assert.equal(await runCli(['config', 'set', 'caveman', 'false', '--local', '--root', root], io), 0)
    assert.equal(
      await runCli(['config', 'set', 'agents.implementer.tier', 'capable', '--local', '--root', root], io),
      0,
    )
    assert.deepEqual(await readLocal(root), { caveman: false, agents: { implementer: { tier: 'capable' } } })
  })
})

test('config set then get round-trips a role tier', async () => {
  await withRepo(async ({ root, io, lines }) => {
    assert.equal(
      await runCli(['config', 'set', 'agents.implementer.tier', 'capable', '--local', '--root', root], io),
      0,
    )
    lines.length = 0
    assert.equal(await runCli(['config', 'get', 'agents.implementer.tier', '--root', root], io), 0)
    assert.equal(lines.join('\n'), 'capable')
  })
})

test('config unset removes a key from the layer it targets', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await runCli(['config', 'set', 'maxParallel', '12', '--local', '--root', root], io)
    await runCli(['config', 'set', 'agents.implementer.tier', 'capable', '--local', '--root', root], io)
    lines.length = 0
    assert.equal(await runCli(['config', 'unset', 'agents.implementer.tier', '--local', '--root', root], io), 0)
    assert.deepEqual(await readLocal(root), { maxParallel: 12, agents: { implementer: {} } })
  })
})

// The reviewer produces the verdict for `agent`-kind gate checks. Letting the gitignored layer
// choose its tier would let a teammate pick the reviewer that grades its own diff, and leave no
// dirty worktree for `fileset` or `ownership` to notice. The tracked manifest is the only place
// it may be set — this is the security property the whole config layer exists to preserve.
test('config set agents.reviewer.tier --local is refused as an enforcement key and writes nothing', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'set', 'agents.reviewer.tier', 'capable', '--local', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /agents\.reviewer\.tier is an enforcement key/)
    assert.match(lines.join('\n'), /teammates\.gate\.json/)
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)
  })
})

// Each rejection is bound to the key it rejected. `/enforcement key/` alone would pass just as
// happily if the CLI reported some OTHER key as the reason, which is the whole question here.
test('config set agents.reviewer.effort --local is refused too, and the bare role with it', async () => {
  await withRepo(async ({ root, io, lines }) => {
    assert.equal(
      await runCli(['config', 'set', 'agents.reviewer.effort', 'high', '--local', '--root', root], io),
      2,
    )
    assert.match(lines.join('\n'), /^agents\.reviewer\.effort is an enforcement key; it may only be set in teammates\.gate\.json$/m)
    lines.length = 0
    assert.equal(await runCli(['config', 'unset', 'agents.reviewer', '--local', '--root', root], io), 2)
    assert.match(lines.join('\n'), /^agents\.reviewer is an enforcement key; it may only be set in teammates\.gate\.json$/m)
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)
  })
})

test('the same reviewer tier succeeds against the tracked manifest', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'set', 'agents.reviewer.tier', 'capable', '--root', root], io)
    assert.equal(code, 0)
    assert.match(lines.join('\n'), /wrote teammates\.gate\.json/)
    assert.deepEqual((await readGateFile(root)).agents, { reviewer: { tier: 'capable' } })
    // Writing the tracked manifest must not gitignore anything: it is tracked on purpose.
    const ignore = await readFile(path.join(root, '.gitignore'), 'utf8')
    assert.doesNotMatch(ignore, /teammates\.local\.json/)
  })
})

// `phases` decides which checks run at all, so it is enforcement wherever it appears.
test('config set phases --local is refused and writes nothing', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'set', 'phases', '{}', '--local', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /phases is an enforcement key/)
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)
  })
})

// There is no top-level `fixRounds`: the budget lives at `phases.<name>.fixRounds`, and
// `phases` is enforcement. So a bare `fixRounds` is an UNKNOWN key, not an enforcement one —
// two rejections that both exit 2 and both contain the key name. The exact message is asserted
// because that is the only thing that tells them apart, and the difference is not cosmetic: one
// says "this layer may not decide that", the other says "nothing reads this".
test('config set fixRounds --local exits 2 as an unknown key and writes nothing', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'set', 'fixRounds', '99', '--local', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /^unknown config key: fixRounds$/m)
    assert.doesNotMatch(lines.join('\n'), /enforcement key/)
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)
  })
})

// The real verdict-affecting path. The fix-round budget a phase runs under decides how many
// retries a failing task gets before the run escalates to a human, so it is enforcement
// wherever it is spelled — and `phases.default.fixRounds` is where it actually lives.
test('config set phases.default.fixRounds --local is refused as enforcement and writes nothing', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'set', 'phases.default.fixRounds', '99', '--local', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /^phases\.default\.fixRounds is an enforcement key; it may only be set in teammates\.gate\.json$/m)
    assert.doesNotMatch(lines.join('\n'), /unknown config key/)
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)
  })
})

test('config set rejects a tier outside the vocabulary and lists the valid ones', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'set', 'agents.implementer.tier', 'nonsense', '--local', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /tier must be one of cheap, mid, capable/)
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)
  })
})

// A dotted key is caller input. `__proto__` reaches Object.prototype rather than the config
// object, so a write through it pollutes every object in the process instead of the file. It is
// rejected by name, on `set` and `unset` alike, before any layer is read or written.
test('config set through __proto__ exits 2 and pollutes nothing', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'set', '__proto__.maxParallel', '1', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /unsafe config key segment/)
    assert.equal(({}).maxParallel, undefined)
    assert.equal(await exists(path.join(root, 'teammates.gate.json')), false)
  })
})

test('config unset and get through a prototype segment exit 2 as well', async () => {
  await withRepo(async ({ root, io, lines }) => {
    assert.equal(await runCli(['config', 'unset', 'constructor.prototype.x', '--local', '--root', root], io), 2)
    assert.match(lines.join('\n'), /unsafe config key segment/)
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)
    lines.length = 0
    assert.equal(await runCli(['config', 'get', '__proto__', '--root', root], io), 2)
    assert.match(lines.join('\n'), /unsafe config key segment/)
  })
})

// The guard's position is the point of it, not its existence: `scripts/config.mjs` re-checks
// inside every getKey/setKey/unsetKey/validateKey, so a test that only asserts "an unsafe key
// exits 2" passes with the CLI-level check deleted. What only the CLI-level check buys is that
// the unsafe key is rejected BEFORE any layer is read, validated or written — so the answer
// does not depend on what else happens to be wrong with the layer files. Each of the two tests
// below is RED with the `assertSafeKey(key)` line in the config handler removed.
test('an unsafe key is rejected before the layer is read, even when the layer is corrupt', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeFile(path.join(root, 'teammates.local.json'), '{', 'utf8')
    const code = await runCli(['config', 'unset', '__proto__.x', '--local', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /^unsafe config key segment: __proto__$/m)
    // Reading the layer first would report the corrupt file instead, which tells the caller
    // nothing about the key they actually typed.
    assert.doesNotMatch(lines.join('\n'), /is not valid JSON/)
  })
})

test('an unsafe key is rejected before the enforcement check that would otherwise claim it', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'set', 'agents.reviewer.__proto__', '1', '--local', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /^unsafe config key segment: __proto__$/m)
    assert.doesNotMatch(lines.join('\n'), /enforcement key/)
    assert.equal(({}).x, undefined)
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)
  })
})

test('config get on an unset key exits 2', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'get', 'agents.implementer.tier', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /unset: agents\.implementer\.tier/)
  })
})

test('config get, set and unset without their arguments exit 2 with a message', async () => {
  await withRepo(async ({ root, io, lines }) => {
    assert.equal(await runCli(['config', 'get', '--root', root], io), 2)
    assert.match(lines.join('\n'), /config get needs a key/)
    lines.length = 0
    assert.equal(await runCli(['config', 'set', '--root', root], io), 2)
    assert.match(lines.join('\n'), /config set needs a key/)
    lines.length = 0
    assert.equal(await runCli(['config', 'unset', '--root', root], io), 2)
    assert.match(lines.join('\n'), /config unset needs a key/)
    lines.length = 0
    assert.equal(await runCli(['config', 'set', 'maxParallel', '--root', root], io), 2)
    assert.match(lines.join('\n'), /config set needs a value/)
  })
})

test('an unknown config subcommand exits 2 with the usage line', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'bogus', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /usage: config <list\|get\|set\|unset>/)
  })
})

// A skill branches on this exit code, so a malformed layer must arrive as a message and 2 —
// never as a SyntaxError stack out of JSON.parse.
test('a corrupt teammates.local.json exits 2 with a message rather than a stack', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeFile(path.join(root, 'teammates.local.json'), '{', 'utf8')
    const code = await runCli(['config', 'list', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /teammates\.local\.json is not valid JSON/)
    assert.doesNotMatch(lines.join('\n'), /at JSON\.parse/)
  })
})

// Every command that resolves config reads the same gitignored layer, so a malformed one must
// not reach an operator as a stack trace from whichever command happened to read it first.
test('a corrupt teammates.local.json exits 2 from init-run, workflow and digest too', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeFile(path.join(root, 'teammates.local.json'), '{', 'utf8')
    for (const argv of [
      ['init-run', planPath, '--run', 'r1', '--root', root],
      ['workflow', '--run', 'r1', '--phase', '1', '--root', root],
      ['digest', '--run', 'r1', '--root', root],
    ]) {
      lines.length = 0
      assert.equal(await runCli(argv, io), 2, argv[0])
      assert.match(lines.join('\n'), /teammates\.local\.json is not valid JSON/)
    }
  })
})

// The local layer is refused wholesale when it carries an enforcement key, not just when the
// CLI is the one writing it — a hand-edited file must not buy what `config set` refuses.
test('a local layer carrying an enforcement key exits 2 rather than resolving', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeFile(
      path.join(root, 'teammates.local.json'),
      JSON.stringify({ agents: { reviewer: { tier: 'capable' } } }),
      'utf8',
    )
    const code = await runCli(['config', 'list', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /agents\.reviewer is an enforcement key/)
  })
})

test('init-run and workflow take maxParallel from the local layer over the manifest', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ maxParallel: 2, phases: { default: { checks: [] } } }),
      'utf8',
    )
    await writeFile(path.join(root, 'teammates.local.json'), JSON.stringify({ maxParallel: 5 }), 'utf8')
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    assert.equal((await readStatus(root, 'r1')).maxParallel, 5)
    lines.length = 0
    await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], io)
    assert.match(lines.join('\n'), /max 5 parallel/)
  })
})

test('workflow renders a caveman brief when the local layer configures one', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await writeFile(path.join(root, 'teammates.local.json'), JSON.stringify({ caveman: 'full' }), 'utf8')
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    assert.equal(await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], io), 0)
    const src = lines.join('\n')
    assert.match(src, /CAVEMAN = 'full'/)
    // Compressed or not, the instructions that make a brief safe are still there verbatim.
    assert.match(src, /MANDATORY FIRST STEP/)
  })
})

test('a configured implementer effort reaches the generated dispatch', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await writeFile(
      path.join(root, 'teammates.local.json'),
      JSON.stringify({ agents: { implementer: { effort: 'high' } } }),
      'utf8',
    )
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    assert.equal(await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], io), 0)
    const src = lines.join('\n')
    assert.match(src, /const EFFORT = 'high'/)
    // And it is spread into the dispatch options rather than merely declared.
    assert.match(src, /EFFORT \? \{ effort: EFFORT \}/)
  })
})

// A configured role tier is an explicit operator decision and outranks inferTier's guess.
test('a configured implementer tier overrides an inferred one in the workflow dispatch', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await writeFile(
      path.join(root, 'teammates.local.json'),
      JSON.stringify({ agents: { implementer: { tier: 'capable' } } }),
      'utf8',
    )
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const models = JSON.stringify({ mid: 'm-mid', capable: 'm-cap' })
    assert.equal(
      await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--models', models], io),
      0,
    )
    assert.match(lines.join('\n'), /m-cap/)
    assert.doesNotMatch(lines.join('\n'), /m-mid/)
  })
})

// A per-task `**Model:**` names a task the operator already reasoned about, so it stays
// authoritative over a blanket role tier.
test('a declared task tier outranks the configured implementer tier', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const planPath = path.join(root, 'declared.md')
    await writeFile(planPath, planWithModel('cheap'), 'utf8')
    await writeFile(
      path.join(root, 'teammates.local.json'),
      JSON.stringify({ agents: { implementer: { tier: 'capable' } } }),
      'utf8',
    )
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    const models = JSON.stringify({ cheap: 'm-cheap', capable: 'm-cap' })
    assert.equal(
      await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root, '--models', models], io),
      0,
    )
    assert.match(lines.join('\n'), /m-cheap/)
    assert.doesNotMatch(lines.join('\n'), /m-cap/)
  })
})

// `set` gets its key check from validateKey, which needs a value; `unset` has none to give it.
// Without an equivalent check, `config unset totallyBogus --local` created the file, gitignored
// it, reported `wrote …` and exited 0 having removed nothing — the opposite answer to the same
// key's `set`, for the same reason.
test('config unset refuses an unknown key exactly as config set does', async () => {
  await withRepo(async ({ root, io, lines }) => {
    assert.equal(await runCli(['config', 'set', 'totallyBogus', '1', '--local', '--root', root], io), 2)
    assert.match(lines.join('\n'), /^unknown config key: totallyBogus$/m)
    lines.length = 0
    assert.equal(await runCli(['config', 'unset', 'totallyBogus', '--local', '--root', root], io), 2)
    assert.match(lines.join('\n'), /^unknown config key: totallyBogus$/m)
    assert.doesNotMatch(lines.join('\n'), /wrote/)
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)
  })
})

// One role's entry is a real subtree of the layer, so unsetting it is meaningful.
test('config unset accepts a single role entry', async () => {
  await withRepo(async ({ root, io }) => {
    await runCli(['config', 'set', 'agents.implementer.tier', 'capable', '--local', '--root', root], io)
    assert.equal(await runCli(['config', 'unset', 'agents.implementer', '--local', '--root', root], io), 0)
    assert.deepEqual(await readLocal(root), { agents: {} })
  })
})

// The bare segment `agents` is a prefix of EVERY role including the reviewer's, and
// `isEnforcementKey('agents')` is false — so a prefix rule that accepted it walked straight
// past the enforcement guard and wiped the reviewer's tier and effort with everyone else's. A
// key that can reach an enforcement field is not an ergonomics key, whatever it is spelled.
test('config unset agents is refused rather than wiping the reviewer entry with the rest', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const body = JSON.stringify({ agents: { implementer: { tier: 'capable' } } })
    await writeFile(path.join(root, 'teammates.local.json'), body, 'utf8')
    const code = await runCli(['config', 'unset', 'agents', '--local', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /^unknown config key: agents$/m)
    assert.equal(await readFile(path.join(root, 'teammates.local.json'), 'utf8'), body)
  })
})

// `get` narrows the same way `set` and `unset` do. It printed `[object Object]` at exit 0 for a
// group key, which a caller reading a scalar cannot act on and cannot detect.
test('config get refuses a key that names a group rather than a field', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await runCli(['config', 'set', 'agents.implementer.tier', 'capable', '--local', '--root', root], io)
    lines.length = 0
    assert.equal(await runCli(['config', 'get', 'agents.implementer', '--root', root], io), 2)
    assert.match(lines.join('\n'), /^unknown config key: agents\.implementer$/m)
    assert.doesNotMatch(lines.join('\n'), /object Object/)
    lines.length = 0
    assert.equal(await runCli(['config', 'get', 'agents', '--root', root], io), 2)
    assert.match(lines.join('\n'), /^unknown config key: agents$/m)
  })
})

// Both layers, both bodies, one answer per file. `readLayer` parses without validating and the
// `?? {}` after it only catches a nullish body, so a layer holding `[]` reached setKey, which
// set a property JSON.stringify then dropped: `wrote …` at exit 0 with the file unchanged. A
// body of `"text"` died with a raw TypeError stack at exit 1. Meanwhile `config list` exited 2
// on both — one CLI giving two answers about one file.
test('a malformed layer body is refused by the write path, symmetrically for both layers', async () => {
  for (const [file, flagArgs] of [['teammates.gate.json', []], ['teammates.local.json', ['--local']]]) {
    for (const body of ['[]', '"text"', '3', 'null']) {
      // eslint-disable-next-line no-await-in-loop
      await withRepo(async ({ root, io, lines }) => {
        await writeFile(path.join(root, file), body, 'utf8')
        const where = `${file} body ${body}`
        const code = await runCli(['config', 'set', 'maxParallel', '4', ...flagArgs, '--root', root], io)
        assert.equal(code, 2, where)
        assert.match(lines.join('\n'), new RegExp(`^${file.replace('.', '\\.')} must contain a JSON object$`, 'm'), where)
        // Not a stack, and not a silent rewrite of the file it refused.
        assert.doesNotMatch(lines.join('\n'), /TypeError/, where)
        assert.doesNotMatch(lines.join('\n'), /wrote/, where)
        assert.equal(await readFile(path.join(root, file), 'utf8'), body, where)
      })
    }
  }
})

// The read path gets the same treatment as the write path, for the same layer. A gate file
// holding `[]` resolved every key to its default at exit 0 — the tracked, authoritative file
// silently ignored — while the identical body in the local layer exited 2.
test('a malformed gate layer is refused by every command that resolves config', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await writeFile(path.join(root, 'teammates.gate.json'), '[]', 'utf8')
    for (const argv of [
      ['config', 'list', '--root', root],
      ['config', 'get', 'maxParallel', '--root', root],
      ['init-run', planPath, '--run', 'r1', '--root', root],
      ['workflow', '--run', 'r1', '--phase', '1', '--root', root],
      ['digest', '--run', 'r1', '--root', root],
    ]) {
      lines.length = 0
      assert.equal(await runCli(argv, io), 2, argv.join(' '))
      assert.match(lines.join('\n'), /^teammates\.gate\.json must contain a JSON object$/m, argv.join(' '))
    }
  })
})

// `--results ""` is what an unset variable templated *quoted* produces, where templated
// unquoted it produces the bare `--results` that was already caught. One mistake, two
// spellings: the empty one used to skip the supplied-results block silently and exit 1 on the
// still-pending checks with nothing on stdout about the flag it dropped.
test('gate treats an empty --results as the missing argument the bare flag already was', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeEnforcementManifest(root)
    for (const value of ['', '   ']) {
      lines.length = 0
      const code = await runCli(['gate', '--no-fleet', '--results', value, '--root', root], io)
      assert.equal(code, 2, JSON.stringify(value))
      assert.match(lines.join('\n'), /missing required argument: --results <path>/, JSON.stringify(value))
    }
  })
})

// Whole-body shapes (`[]`, `"text"`, `3`, `null`) are rejected by any validator worth the name,
// so the tests above cannot tell the real gate validator from a bare shape check. These are the
// cases that can: a body that IS an object and whose FIELDS are wrong. Each one is a value the
// operator believes is set and that silently resolves to a default — a misspelled tier makes
// the tierModels lookup yield undefined, so the dispatch carries no model at all, at exit 0.
//
// The file must come back byte-identical: refusing a write and then rewriting the file anyway
// would launder the bad value into a file this CLI itself wrote.
const BAD_GATE_FIELDS = [
  [{ agents: { implementer: { tier: 'capabel' } } }, /^tier must be one of cheap, mid, capable$/m],
  [{ agents: { nope: { tier: 'capable' } } }, /^unknown agent role: nope$/m],
  [{ agents: { implementer: { fast: true } } }, /^unknown key in teammates\.gate\.json: agents\.implementer\.fast$/m],
  [{ maxParallel: 0 }, /^maxParallel must be an integer >= 1$/m],
]

test('config set refuses a gate manifest whose fields are invalid, not just its shape', async () => {
  for (const [gate, message] of BAD_GATE_FIELDS) {
    // eslint-disable-next-line no-await-in-loop
    await withRepo(async ({ root, io, lines }) => {
      const where = JSON.stringify(gate)
      const body = JSON.stringify({ ...gate, phases: { default: { checks: [] } } })
      await writeFile(path.join(root, 'teammates.gate.json'), body, 'utf8')
      const code = await runCli(['config', 'set', 'caveman', 'false', '--root', root], io)
      assert.equal(code, 2, where)
      assert.match(lines.join('\n'), message, where)
      assert.doesNotMatch(lines.join('\n'), /wrote/, where)
      assert.equal(await readFile(path.join(root, 'teammates.gate.json'), 'utf8'), body, where)
    })
  }
})

// `unset` reads and rewrites the same layer through the same call, so it answers the same way.
test('config unset refuses a gate manifest whose fields are invalid', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const body = JSON.stringify({ agents: { implementer: { tier: 'capabel' } } })
    await writeFile(path.join(root, 'teammates.gate.json'), body, 'utf8')
    assert.equal(await runCli(['config', 'unset', 'caveman', '--root', root], io), 2)
    assert.match(lines.join('\n'), /^tier must be one of cheap, mid, capable$/m)
    assert.equal(await readFile(path.join(root, 'teammates.gate.json'), 'utf8'), body)
  })
})

// `config list` and `config set` must agree about the same file. This is the assertion that
// pins the two halves together rather than testing each in isolation.
test('config list and config set give the same answer about a malformed gate layer', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeFile(path.join(root, 'teammates.gate.json'), '[]', 'utf8')
    assert.equal(await runCli(['config', 'list', '--root', root], io), 2)
    const fromList = lines.join('\n')
    lines.length = 0
    assert.equal(await runCli(['config', 'set', 'maxParallel', '4', '--root', root], io), 2)
    assert.equal(lines.join('\n'), fromList)
  })
})

// `unset` reads and rewrites the same layer, so it gets the same check as `set`.
test('config unset refuses a malformed layer as well', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeFile(path.join(root, 'teammates.local.json'), '[]', 'utf8')
    assert.equal(await runCli(['config', 'unset', 'maxParallel', '--local', '--root', root], io), 2)
    assert.match(lines.join('\n'), /^teammates\.local\.json must contain a JSON object$/m)
    assert.equal(await readFile(path.join(root, 'teammates.local.json'), 'utf8'), '[]')
  })
})

// `--local=true` parsed as a flag literally named `local=true`, leaving `flags.local` undefined
// — so the write silently landed in the TRACKED enforcement manifest instead of the gitignored
// layer the caller named. The spelling is refused rather than interpreted: see the --no-fleet
// tests below for why guessing at it is worse than not accepting it.
test('--local=true is refused rather than silently writing the tracked manifest', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const code = await runCli(['config', 'set', 'maxParallel', '12', '--local=true', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /unsupported flag spelling: `--local=true`/)
    assert.match(lines.join('\n'), /`--local` takes no value: write `--local` alone/)
    // Neither layer is written: the point of the refusal is that no file is chosen for the
    // caller when the CLI cannot tell which one they meant.
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)
    assert.equal(await exists(path.join(root, 'teammates.gate.json')), false)
  })
})

test('--local=false does not enable the local layer either', async () => {
  await withRepo(async ({ root, io, lines }) => {
    assert.equal(await runCli(['config', 'set', 'maxParallel', '12', '--local=false', '--root', root], io), 2)
    assert.match(lines.join('\n'), /unsupported flag spelling/)
    assert.equal(await exists(path.join(root, 'teammates.local.json')), false)
    assert.equal(await exists(path.join(root, 'teammates.gate.json')), false)
  })
})

test('the = spelling is refused for a value-taking flag such as --root too', async () => {
  await withRepo(async ({ root, io, lines }) => {
    // One rule for every flag. An allowlist of "switches" would be a second table to keep in
    // step with the first, and the next value-less flag added would fall out of it silently.
    assert.equal(await runCli(['config', 'list', `--root=${root}`], io), 2)
    assert.match(lines.join('\n'), /unsupported flag spelling/)
  })
})

// The reason the `=` form is refused outright rather than interpreted. Every switch in this CLI
// is tested with `!== undefined`, so an interpreted `--no-fleet=false` READS as negation and
// TURNS OFF the fileset and ownership checks — while also dropping --run and --plan from the
// required set, opening the whole solo path from an argv that says enforcement is not disabled.
// There is no interpretation of that string that is safe to guess.
test('--no-fleet=false cannot disable the enforcement checks', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeEnforcementManifest(root)
    for (const spelling of ['--no-fleet=false', '--no-fleet=0', '--no-fleet=', '--no-fleet=off']) {
      lines.length = 0
      const code = await runCli(['gate', spelling, '--root', root], io)
      assert.equal(code, 2, spelling)
      const text = lines.join('\n')
      assert.match(text, /unsupported flag spelling/, spelling)
      // The two things the solo path would have produced, neither of which may appear.
      assert.doesNotMatch(text, /enforcement checks are not running/, spelling)
      assert.doesNotMatch(text, /"verdict": "PASS"/, spelling)
    }
  })
})

// Refused before the required-argument check, not after it: `--no-fleet` drops --run and --plan
// from REQUIRED, so a rejection that ran later would already have accepted an argv that names
// neither. At the base commit this argv exited 2 for the missing arguments, and it still must.
test('--no-fleet=false is refused before it can drop the required arguments', async () => {
  await withRepo(async ({ root, io, lines }) => {
    assert.equal(await runCli(['gate', '--no-fleet=false', '--root', root], io), 2)
    assert.match(lines.join('\n'), /unsupported flag spelling/)
    assert.doesNotMatch(lines.join('\n'), /missing required argument/)
  })
})

// `--no-fleet <anything>` reads to a human as "solo mode off" and did the exact opposite: any
// value at all left the flag defined, which is what both consumers tested, so an argv written
// to KEEP the fileset and ownership checks ran without them.
test('--no-fleet with a value does not enable solo mode', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeEnforcementManifest(root)
    for (const value of ['false', '0', 'off', 'true']) {
      lines.length = 0
      const code = await runCli(['gate', '--no-fleet', value, '--root', root], io)
      assert.equal(code, 2, value)
      const text = lines.join('\n')
      assert.match(text, /unsupported flag spelling: `--no-fleet /, value)
      assert.doesNotMatch(text, /enforcement checks are not running/, value)
      assert.doesNotMatch(text, /"verdict": "PASS"/, value)
    }
  })
})

// The advice printed for a refused spelling must name a form that actually works — and for
// `--no-fleet` it must not name the one that does the OPPOSITE of what the caller reached for.
// Someone typing `--no-fleet=false` wants the enforcement checks RUNNING; telling them to
// "write `--no-fleet <value>`" or "write `--no-fleet` alone" hands them the spelling that
// switches those checks off.
test('the refusal advice names a spelling that works, and never one that inverts the intent', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeEnforcementManifest(root)
    assert.equal(await runCli(['gate', '--no-fleet=false', '--root', root], io), 2)
    const text = lines.join('\n')
    assert.match(text, /`--no-fleet` takes no value: omit it entirely to keep the fileset and ownership checks running, or pass it alone to run without them/)
    assert.doesNotMatch(text, /write `--no-fleet <value>`/)

    // The form the advice names as the safe one — omitting the flag — does run the enforcement
    // checks, rather than being a spelling that merely exits differently.
    lines.length = 0
    await runCli(['gate', '--run', 'r1', '--plan', 'plan.md', '--root', root], io)
    assert.doesNotMatch(lines.join('\n'), /enforcement checks are not running/)
    assert.match(lines.join('\n'), /fileset/)
  })
})

// A value-taking flag gets the advice for a value-taking flag, and that advice works verbatim.
test('the refusal advice for a value-taking flag names the form that succeeds', async () => {
  await withRepo(async ({ root, io, lines }) => {
    assert.equal(await runCli(['config', 'list', `--root=${root}`], io), 2)
    assert.match(lines.join('\n'), /`--root=.*` — write `--root <value>`/)
    assert.doesNotMatch(lines.join('\n'), /takes no value/)
    lines.length = 0
    assert.equal(await runCli(['config', 'list', '--root', root], io), 0)
  })
})

// The spelling this CLI does take is untouched by the refusal.
test('the space-separated spelling of every flag still works', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeEnforcementManifest(root)
    assert.equal(await runCli(['config', 'set', 'maxParallel', '12', '--local', '--root', root], io), 0)
    assert.deepEqual(await readLocal(root), { maxParallel: 12 })
    lines.length = 0
    const code = await runCli(['gate', '--no-fleet', '--root', root], io)
    assert.match(lines.join('\n'), /enforcement checks are not running/)
    assert.equal(code, 0)
  })
})

// The `=` spelling was already refused, but the space-separated one was not: `--local` sat
// outside VALUELESS_FLAGS, so `--local false` consumed `false` as its value and the consumer's
// `!== undefined` still selected the gitignored layer. Same shape as the `--no-fleet false`
// regression — the caller writes the negation and gets the affirmative.
test('--local false is refused rather than selecting the local layer', async () => {
  await withRepo(async ({ root, io, lines }) => {
    for (const value of ['false', '0', '']) {
      lines.length = 0
      const argv = ['config', 'set', 'maxParallel', '12', '--local', value, '--root', root]
      assert.equal(await runCli(argv, io), 2, JSON.stringify(value))
      assert.match(lines.join('\n'), /`--local` takes no value: write `--local` alone/, JSON.stringify(value))
      // Neither layer is written: the refusal lands before the command runs, so the value never
      // reaches the tracked manifest as a consolation target either.
      assert.equal(await exists(path.join(root, 'teammates.local.json')), false, JSON.stringify(value))
      assert.equal(await exists(path.join(root, 'teammates.gate.json')), false, JSON.stringify(value))
    }

    // The spelling the advice names does select the local layer.
    assert.equal(await runCli(['config', 'set', 'maxParallel', '12', '--local', '--root', root], io), 0)
    assert.deepEqual(await readLocal(root), { maxParallel: 12 })
  })
})

// A layer file that exists but cannot be read is a Node system error, not a ConfigError. Left
// alone it escaped as an unhandled rejection with a raw stack and exit 1, which a skill
// branching on this exit code reads as neither a pass nor a stated failure.
test('an unreadable layer file exits 2 with a message from every command that resolves config', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    // A directory where the layer file belongs: readable as a path, never as JSON.
    await mkdir(path.join(root, 'teammates.local.json'))
    for (const argv of [
      ['config', 'list', '--root', root],
      ['config', 'get', 'maxParallel', '--root', root],
      ['init-run', planPath, '--run', 'r1', '--root', root],
      ['workflow', '--run', 'r1', '--phase', '1', '--root', root],
      ['digest', '--run', 'r1', '--root', root],
    ]) {
      lines.length = 0
      assert.equal(await runCli(argv, io), 2, argv.join(' '))
      assert.match(lines.join('\n'), /could not access the config layers/, argv.join(' '))
    }
  })
})

// `readLayer` parses but does not validate, so the layer being merged into was never checked.
// A local file already carrying `agents.reviewer` was therefore merged and rewritten at exit 0
// by the very command that refuses to write that key — while every reader of it exits 2.
test('config set validates the local layer it is merging into rather than rewriting it', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const body = JSON.stringify({ agents: { reviewer: { tier: 'capable' } } })
    await writeFile(path.join(root, 'teammates.local.json'), body, 'utf8')
    const code = await runCli(['config', 'set', 'caveman', 'full', '--local', '--root', root], io)
    assert.equal(code, 2)
    assert.match(lines.join('\n'), /^agents\.reviewer is an enforcement key; it may only be set in teammates\.gate\.json$/m)
    // Rewriting it would have laundered the enforcement key into a file the CLI itself wrote.
    assert.equal(await readFile(path.join(root, 'teammates.local.json'), 'utf8'), body)
  })
})

// The counterpart layer, which the write path did not look at: readers validate both through
// `loadValidatedConfig`, so a write that validated only its own target left `config set … --local`
// at exit 0 on a repo whose `config list` exited 2. One CLI must give one answer about one
// repository, whichever direction the asymmetry runs.
test('config set validates the layer it is NOT writing as well', async () => {
  const cases = [
    {
      what: 'a malformed gate manifest blocks a local write',
      broken: ['teammates.gate.json', '[]'],
      argv: (root) => ['config', 'set', 'maxParallel', '3', '--local', '--root', root],
      written: 'teammates.local.json',
      message: /^teammates\.gate\.json must contain a JSON object$/m,
    },
    {
      what: 'a malformed local layer blocks a tracked write',
      broken: ['teammates.local.json', '"text"'],
      argv: (root) => ['config', 'set', 'maxParallel', '3', '--root', root],
      written: 'teammates.gate.json',
      message: /^teammates\.local\.json must contain a JSON object$/m,
    },
    {
      // Not only a malformed body: an over-reaching one. The local layer's own rules are part
      // of what a reader enforces, so a write must see them too.
      what: 'an enforcement key in the local layer blocks a tracked write',
      broken: ['teammates.local.json', JSON.stringify({ lens: ['correctness'] })],
      argv: (root) => ['config', 'set', 'caveman', 'full', '--root', root],
      written: 'teammates.gate.json',
      message: /^lens is an enforcement key; it may only be set in teammates\.gate\.json$/m,
    },
  ]
  for (const { what, broken, argv, written, message } of cases) {
    await withRepo(async ({ root, io, lines }) => {
      const [brokenFile, body] = broken
      await writeFile(path.join(root, brokenFile), body, 'utf8')
      assert.equal(await runCli(argv(root), io), 2, what)
      assert.match(lines.join('\n'), message, what)
      // Neither file touched: the broken one is not rewritten into shape, and the target is not
      // written behind a refusal the operator was just shown.
      assert.equal(await readFile(path.join(root, brokenFile), 'utf8'), body, what)
      assert.equal(await exists(path.join(root, written)), false, what)
    })
  }
})

test('config unset validates the layer it is NOT writing as well', async () => {
  await withRepo(async ({ root, io, lines }) => {
    await writeFile(path.join(root, 'teammates.gate.json'), '[]', 'utf8')
    await writeFile(path.join(root, 'teammates.local.json'), JSON.stringify({ maxParallel: 3 }), 'utf8')
    assert.equal(await runCli(['config', 'unset', 'maxParallel', '--local', '--root', root], io), 2)
    assert.match(lines.join('\n'), /^teammates\.gate\.json must contain a JSON object$/m)
    assert.deepEqual(await readLocal(root), { maxParallel: 3 })
  })
})

// The counterpart being absent is the ordinary case — a project with no manifest at all — and
// must never be what fails a write. This is the assertion that keeps the fix from turning into
// "config set requires both files to exist".
test('an absent counterpart layer does not block a write in either direction', async () => {
  await withRepo(async ({ root, io }) => {
    assert.equal(await runCli(['config', 'set', 'maxParallel', '3', '--local', '--root', root], io), 0)
    assert.deepEqual(await readLocal(root), { maxParallel: 3 })
  })
  await withRepo(async ({ root, io }) => {
    assert.equal(await runCli(['config', 'set', 'caveman', 'full', '--root', root], io), 0)
    assert.deepEqual(await readGateFile(root), { caveman: 'full' })
  })
})

// `.gitignore` has no effect on a path git already tracks. Claiming the entry was added says
// the layer is untracked — the trust split the whole local/gate divide rests on — when it is
// not, so the tracked case is reported rather than papered over.
test('a tracked local layer is reported as tracked instead of claiming a gitignore entry', async () => {
  await withRepo(async ({ root, io, lines, git: g }) => {
    await writeFile(path.join(root, 'teammates.local.json'), JSON.stringify({ maxParallel: 3 }), 'utf8')
    g(['add', 'teammates.local.json'])
    g(['commit', '--quiet', '-m', 'track the local layer'])
    assert.equal(await runCli(['config', 'set', 'maxParallel', '12', '--local', '--root', root], io), 0)
    const text = lines.join('\n')
    assert.match(text, /wrote teammates\.local\.json/)
    assert.match(text, /teammates\.local\.json is tracked by git/)
    assert.match(text, /git rm --cached teammates\.local\.json/)
    assert.doesNotMatch(text, /added teammates\.local\.json to \.gitignore/)
  })
})

// A plan whose first task infers `cheap`: a fenced brief with a single declared file. It is the
// case that makes the escalation bug visible, because a configured `capable` is two tiers above
// what inference would have recorded.
function planWithFencedBrief() {
  return `### Task 1: A

**Files:**
- Create: \`a.mjs\`

do this:

\`\`\`js
const x = 1
\`\`\`

### Task 2: B

**Files:**
- Create: \`b.mjs\`

**Depends:** T1
`
}

test('init-run records and prints the configured tier, not the inferred one', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const planPath = path.join(root, 'fenced.md')
    await writeFile(planPath, planWithFencedBrief(), 'utf8')
    await writeFile(
      path.join(root, 'teammates.local.json'),
      JSON.stringify({ agents: { implementer: { tier: 'capable' } } }),
      'utf8',
    )
    assert.equal(await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io), 0)
    // The printed routing report is the operator's only view of what the run will dispatch,
    // so it must not name a tier the dispatch will override.
    assert.match(lines.join('\n'), /phase 1: T1 \(capable, configured\)/)
    const plan = await readPlan(root, 'r1')
    assert.equal(plan.tasks.find((t) => t.id === 'T1').tier, 'capable')
  })
})

// `fix` escalates from the RECORDED tier. With the configured tier applied only in memory,
// plan.json kept `cheap`, so a retry after a failure that ran at `capable` was dispatched at
// `mid` — below the tier that had just failed on the same problem.
test('a retry escalates from the configured tier, not from the inferred one', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const planPath = path.join(root, 'fenced.md')
    await writeFile(planPath, planWithFencedBrief(), 'utf8')
    await writeFile(
      path.join(root, 'teammates.local.json'),
      JSON.stringify({ agents: { implementer: { tier: 'capable' } } }),
      'utf8',
    )
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const verdictPath = await writeVerdict(root, {
      verdict: 'FAIL',
      results: [{ name: 'review', kind: 'agent', status: 'fail', findings: [{ file: 'a.mjs' }] }],
    })
    lines.length = 0
    assert.equal(await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io), 0)
    const decision = JSON.parse(lines.join('\n'))
    assert.equal(decision.decision, 'retry')
    assert.equal(decision.tasks[0].taskId, 'T1')
    assert.equal(decision.tasks[0].tier, 'capable')
  })
})

// The same plan without the configured tier still escalates from what inference recorded, so
// the test above is pinning the configured tier rather than the top of the tier list.
test('the same plan with no configured tier escalates from the inferred cheap tier', async () => {
  await withRepo(async ({ root, io, lines }) => {
    const planPath = path.join(root, 'fenced.md')
    await writeFile(planPath, planWithFencedBrief(), 'utf8')
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    assert.equal((await readPlan(root, 'r1')).tasks.find((t) => t.id === 'T1').tier, 'cheap')
    const verdictPath = await writeVerdict(root, {
      verdict: 'FAIL',
      results: [{ name: 'review', kind: 'agent', status: 'fail', findings: [{ file: 'a.mjs' }] }],
    })
    lines.length = 0
    await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io)
    assert.equal(JSON.parse(lines.join('\n')).tasks[0].tier, 'mid')
  })
})

// Configuring a tier after init-run must reach plan.json too, or `fix` goes on escalating from
// the tier the run is no longer dispatching at.
test('workflow persists a tier configured after init-run', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    assert.equal((await readPlan(root, 'r1')).tasks.find((t) => t.id === 'T1').tier, 'mid')
    await writeFile(
      path.join(root, 'teammates.local.json'),
      JSON.stringify({ agents: { implementer: { tier: 'capable' } } }),
      'utf8',
    )
    assert.equal(await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], io), 0)
    const task = (await readPlan(root, 'r1')).tasks.find((t) => t.id === 'T1')
    assert.equal(task.tier, 'capable')
    assert.equal(task.tierSource, 'configured')
    // A task from another phase is untouched by a phase-1 workflow run.
    assert.equal((await readPlan(root, 'r1')).tasks.find((t) => t.id === 'T2').tierSource, 'inferred')
  })
})

// Applying a configured tier and reverting one are the same guarantee from two sides: plan.json
// must name the tier the run is actually dispatching at, because that is the tier `fix`
// escalates from. Gated on `if (roleTier)` alone, a task stamped `configured` kept the stale
// tier forever once the operator removed the setting, and only re-running init-run cleared it.
test('removing the configured tier reverts plan.json to the inferred tier', async () => {
  await withRepo(async ({ root, planPath, io }) => {
    const localFile = path.join(root, 'teammates.local.json')
    await writeFile(localFile, JSON.stringify({ agents: { implementer: { tier: 'cheap' } } }), 'utf8')
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    const configured = (await readPlan(root, 'r1')).tasks.find((t) => t.id === 'T1')
    assert.equal(configured.tier, 'cheap')
    assert.equal(configured.tierSource, 'configured')
    assert.equal(configured.inferredTier, 'mid')

    await rm(localFile)
    assert.equal(await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], io), 0)
    const reverted = (await readPlan(root, 'r1')).tasks.find((t) => t.id === 'T1')
    assert.equal(reverted.tier, 'mid')
    assert.equal(reverted.tierSource, 'inferred')
  })
})

// And the revert reaches the decision that consumes it, not just the file.
test('a retry after the configured tier is removed escalates from the inferred tier', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    const localFile = path.join(root, 'teammates.local.json')
    await writeFile(localFile, JSON.stringify({ agents: { implementer: { tier: 'cheap' } } }), 'utf8')
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await rm(localFile)
    await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], io)
    const verdictPath = await writeVerdict(root, {
      verdict: 'FAIL',
      results: [{ name: 'review', kind: 'agent', status: 'fail', findings: [{ file: 'a.mjs' }] }],
    })
    lines.length = 0
    await runCli(['fix', '--run', 'r1', '--phase', '1', '--verdict', verdictPath, '--root', root], io)
    // Escalated from the restored `mid`, not from the withdrawn `cheap`.
    assert.equal(JSON.parse(lines.join('\n')).tasks[0].tier, 'capable')
  })
})

// A declared tier is never re-tiered in either direction, so it has no inferredTier to revert
// to and must not acquire one.
test('a declared tier is untouched by configuring and then removing a role tier', async () => {
  await withRepo(async ({ root, io }) => {
    const planPath = path.join(root, 'declared.md')
    await writeFile(planPath, planWithModel('cheap'), 'utf8')
    const localFile = path.join(root, 'teammates.local.json')
    await writeFile(localFile, JSON.stringify({ agents: { implementer: { tier: 'capable' } } }), 'utf8')
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    await rm(localFile)
    await runCli(['workflow', '--run', 'r1', '--phase', '1', '--root', root], io)
    const task = (await readPlan(root, 'r1')).tasks.find((t) => t.id === 'T1')
    assert.equal(task.tier, 'cheap')
    assert.equal(task.tierSource, 'declared')
    assert.equal(task.inferredTier, undefined)
  })
})

test('digest renders terse when the local layer configures caveman', async () => {
  await withRepo(async ({ root, planPath, io, lines }) => {
    await writeFile(path.join(root, 'teammates.local.json'), JSON.stringify({ caveman: 'full' }), 'utf8')
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)
    lines.length = 0
    assert.equal(await runCli(['digest', '--run', 'r1', '--root', root], io), 0)
    assert.match(lines.join('\n'), /^r1 p1\/2 n2/)
  })
})
