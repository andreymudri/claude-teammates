// Pins the boundary between what the gate defends and what it does not, both with real
// git repositories. No fake git anywhere in this file: every bug this suite regression-tests
// was invisible to a fake with canned changedFiles, and several of them shipped precisely
// because a fake agreed with the implementation. See:
//   docs/specs/2026-08-05-tamper-evident-enforcement-design.md ("Not defended against")
//   docs/plans/2026-08-05-tamper-evident-enforcement.md (Task 4)
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

// The default phase runs only the two enforcement checks — command checks are irrelevant
// to what this file pins and would only make failures harder to attribute.
const MANIFEST = {
  phases: {
    default: {
      checks: [
        { name: 'fileset', kind: 'fileset' },
        { name: 'ownership', kind: 'ownership' },
      ],
    },
  },
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

// Builds a real repository: `main` carries a committed plan.md, package.json, an
// enforcement-only teammates.gate.json, and a .gitignore excluding .teammates/ — without
// that last piece, `ownership`'s dirty-worktree check sees init-run's own state files as
// untracked and fails every test for a reason unrelated to what each test means to pin.
// The repo is left checked out on `run-branch`, off `main`.
async function withRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-adv-'))
  git(root, ['init', '--quiet', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  await writeFile(path.join(root, 'plan.md'), PLAN, 'utf8')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
  await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify(MANIFEST), 'utf8')
  await writeFile(path.join(root, '.gitignore'), '.teammates/\n', 'utf8')
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', 'initial'])
  git(root, ['checkout', '--quiet', '-b', 'run-branch'])
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runCliOn(root, args) {
  const lines = []
  const io = { out: (t) => lines.push(t) }
  const code = await runCli([...args, '--root', root], io)
  return { code, out: lines.join('\n') }
}

// Creates teammates/<runId>/<taskId>, writes and commits the given files, and returns to
// run-branch. `from` defaults to run-branch's current tip (the anchor, for a fresh repo).
async function taskBranch(root, runId, taskId, { from = 'run-branch', files = {} } = {}) {
  const branch = `teammates/${runId}/${taskId}`
  git(root, ['checkout', '--quiet', '-b', branch, from])
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(root, rel), content, 'utf8')
  }
  git(root, ['add', '.'])
  git(root, ['commit', '--quiet', '-m', `${taskId}: work`])
  git(root, ['checkout', '--quiet', 'run-branch'])
  return branch
}

async function readStatus(root, runId) {
  return JSON.parse(await readFile(path.join(root, '.teammates', runId, 'status.json'), 'utf8'))
}

// ============================================================================================
// Step 2 — attacks that ARE defended. Each asserts the gate FAILs.
// ============================================================================================

test('gate fails when a teammate commits a file outside its declared set', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'export default 1\n', 'stray.mjs': 'export default 2\n' } })
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /stray\.mjs/)
  })
})

test('gate fails and names the pre-image when a teammate renames away a file belonging to another task', async () => {
  await withRepo(async (root) => {
    // T1 lands a.mjs and is integrated first — the real workflow order.
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'teammates/r1/T1'])
    // T2 forks after that merge, so a.mjs is present in its history, then renames it away
    // instead of adding its own declared b.mjs.
    git(root, ['checkout', '--quiet', '-b', 'teammates/r1/T2', 'run-branch'])
    git(root, ['mv', 'a.mjs', 'b.mjs'])
    git(root, ['commit', '--quiet', '-m', 'T2: rename instead of adding my own file'])
    git(root, ['checkout', '--quiet', 'run-branch'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    // --no-renames means git reports both the deletion of a.mjs (the pre-image, which
    // belongs to T1) and the addition of b.mjs — the deletion must show up as a violation
    // of T2's declared set.
    assert.match(out, /a\.mjs/)
  })
})

test('gate fails even when a tag shadows the task branch name', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n', 'stray.mjs': 'y\n' } })
    // Plant a tag with the exact branch name, pointing at a clean commit. Every ref this
    // codebase resolves is fully qualified through refs/heads/, so the tag cannot stand in
    // for the branch — the stray file must still be seen.
    git(root, ['tag', 'teammates/r1/T1', 'main'])
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /stray\.mjs/)
  })
})

test('gate fails on a merge commit that introduces its own content: a new file, a tampered file, and a deletion', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'A1\n' } })
    git(root, ['checkout', '--quiet', '-b', 'teammates/r1/T2', 'main'])
    await writeFile(path.join(root, 'b.mjs'), 'B1\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'T2: b.mjs'])
    git(root, ['checkout', '--quiet', 'run-branch'])

    // An octopus merge of both task branches, then hand-tampered before completing:
    // a.mjs gets different bytes than T1 committed, rogue.mjs has no source in any parent,
    // and b.mjs — which T2's own parent introduced — is deleted.
    git(root, ['merge', '--quiet', '--no-ff', '--no-commit', 'teammates/r1/T1', 'teammates/r1/T2'])
    await writeFile(path.join(root, 'a.mjs'), 'TAMPERED\n', 'utf8')
    await writeFile(path.join(root, 'rogue.mjs'), 'no legitimate source\n', 'utf8')
    git(root, ['rm', '--quiet', '-f', 'b.mjs'])
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'merge T1 and T2 with smuggled content'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /reachable from no task branch/)
  })
})

test('gate fails naming --no-ff when a teammate commits directly to the run branch', async () => {
  await withRepo(async (root) => {
    await writeFile(path.join(root, 'sneaky.mjs'), 'x\n', 'utf8')
    git(root, ['add', 'sneaky.mjs'])
    git(root, ['commit', '--quiet', '-m', 'direct write to the run branch'])
    const sha = git(root, ['rev-parse', 'HEAD']).trim()

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /--no-ff/)
    assert.match(out, new RegExp(sha))
  })
})

test('a forged status.json PASS changes neither the gate verdict nor complete', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    const statusPath = path.join(root, '.teammates', 'r1', 'status.json')
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    status.gates = { 1: { verdict: 'PASS', failed: [], skipped: [], pending: [], recordedAt: Date.now() } }
    await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')

    // No task branches exist, so the recomputed gate fails naming T1's missing branch —
    // the forged PASS buys nothing because neither command ever reads status.gates.
    const gateResult = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(gateResult.code, 1)
    assert.equal(JSON.parse(gateResult.out).verdict, 'FAIL')

    const completeResult = await runCliOn(root, ['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md'])
    assert.equal(completeResult.code, 4)
  })
})

test('gate still fails correctly when .teammates/plan.json is deleted', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await rm(path.join(root, '.teammates', 'r1', 'plan.json'))
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    // The gate never reads .teammates/plan.json — everything comes from git — so deleting
    // it changes nothing about the verdict: it still fails on the missing T1 branch.
    assert.equal(code, 1)
    assert.match(out, /T1/)
  })
})

test('gate still fails correctly when .teammates/ is deleted entirely', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await rm(path.join(root, '.teammates'), { recursive: true, force: true })
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /T1/)
  })
})

test('gate fails on a widened working-tree plan edit because the plan is read from the anchor commit', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n', 'stray.mjs': 'y\n' } })
    // Widen T1's declared file set in the working tree only — never committed.
    const widened = PLAN.replace('- Create: `a.mjs`', '- Create: `a.mjs`\n- Create: `stray.mjs`')
    await writeFile(path.join(root, 'plan.md'), widened, 'utf8')

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /stray\.mjs/)
  })
})

test('gate fails with the phase error, not a silent skip, when phases integrate out of order', async () => {
  await withRepo(async (root) => {
    await taskBranch(root, 'r1', 'T2', { files: { 'b.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T2 out of order', 'teammates/r1/T2'])
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /not integrated but a later phase is/)
  })
})

test('a manifest marking fileset/ownership optional: true still fails the gate', async () => {
  await withRepo(async (root) => {
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({
        phases: {
          default: {
            checks: [
              { name: 'fileset', kind: 'fileset', optional: true },
              { name: 'ownership', kind: 'ownership', optional: true },
            ],
          },
        },
      }),
      'utf8',
    )
    // No branches exist; fileset fails on T1's missing branch. ALWAYS_ENFORCED_KINDS in
    // gate-runner.mjs forces optional back to false for fileset/ownership regardless of
    // what the manifest declares, so the gate still fails rather than shipping anyway.
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.equal(JSON.parse(out).verdict, 'FAIL')
  })
})

test('gate fails and marks the check pending for a manifest with kind "toString"', async () => {
  await withRepo(async (root) => {
    await writeFile(
      path.join(root, 'teammates.gate.json'),
      JSON.stringify({ phases: { default: { checks: [{ name: 'evil', kind: 'toString' }] } } }),
      'utf8',
    )
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    const parsed = JSON.parse(out)
    assert.equal(parsed.verdict, 'FAIL')
    const check = parsed.results.find((r) => r.name === 'evil')
    assert.equal(check.status, 'pending')
  })
})

test('fast-forwarding the run branch to an empty commit does not read its phase as integrated', async () => {
  await withRepo(async (root) => {
    git(root, ['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    git(root, ['commit', '--quiet', '--allow-empty', '-m', 'T1: no-op'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--quiet', '--ff-only', 'teammates/r1/T1'])

    const { out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    const parsed = JSON.parse(out)
    // T1's branch is now an ancestor of the run branch via the fast-forward, but it
    // changed zero files. deriveContext requires at least one changed file before a phase
    // counts as integrated, so phase 1 must still read as open (never null or 2).
    assert.equal(parsed.phase, 1)
  })
})

test('gate reports the ambiguity, not a silent guess, when both main and master exist', async () => {
  await withRepo(async (root) => {
    git(root, ['branch', 'master', 'main'])
    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 1)
    assert.match(out, /ambiguous base branch/)
  })
})

// ============================================================================================
// Step 3 — limits that are NOT defended. Each asserts the CURRENT behavior (usually a PASS),
// with a comment naming the limitation and pointing at the spec's "Not defended against" list.
// This is deliberate: an untested limitation drifts into an implied guarantee, which is the
// exact defect that started this work.
// ============================================================================================

test('LIMIT (self-integration): fast-forwarding to your own tip and pointing another task branch at it reads as integrated', async () => {
  await withRepo(async (root) => {
    // Spec: "Self-integration. A teammate can fast-forward the run branch to its own tip
    // and create branches named for tasks it does not own, making phases read as
    // integrated so no check runs. Confirmed." This is out of scope by design: enforcement
    // does not stop a teammate targeting it.
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--ff-only', 'teammates/r1/T1'])
    // T2's branch is created pointing at the run tip, which already carries T1's real
    // work — so the ownChanges guard (which defends the *empty-commit* variant above) is
    // satisfied trivially, and T2 gets credit for work it never did.
    git(root, ['branch', 'teammates/r1/T2', 'run-branch'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 0)
    assert.equal(JSON.parse(out).verdict, 'PASS')
  })
})

test('LIMIT (mode-only change): a merge that only flips a file\'s executable bit is invisible to ownership', async () => {
  await withRepo(async (root) => {
    // Spec: fileAtCommit returns bytes and never mode. The ownership check's merge-content
    // verification compares byte content only, so a merge that silently changes a file's
    // permission bits beyond what the honest task branch committed is accepted as clean.
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '--no-commit', 'teammates/r1/T1'])
    git(root, ['update-index', '--chmod=+x', 'a.mjs'])
    git(root, ['commit', '--quiet', '-m', 'integrate T1 (tampered mode bit)'])

    await taskBranch(root, 'r1', 'T2', { from: 'main', files: { 'b.mjs': 'y\n' } })
    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T2', 'teammates/r1/T2'])

    const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(code, 0)
    assert.equal(JSON.parse(out).verdict, 'PASS')
  })
})

test('LIMIT (uncommitted work): an out-of-set file left uncommitted in a teammate worktree is invisible', async () => {
  await withRepo(async (root) => {
    // Spec: "Uncommitted work. The gate reads commits. The claim is precisely 'committed
    // changes stayed in the declared set'." A teammate's worktree is separate from the
    // main checkout the gate runs from, so an uncommitted stray file there never reaches
    // either the fileset diff or the main worktree's dirty check.
    const wtPath = path.join(path.dirname(root), `${path.basename(root)}-t1`)
    git(root, ['worktree', 'add', '--quiet', '-b', 'teammates/r1/T1', wtPath, 'main'])
    try {
      await writeFile(path.join(wtPath, 'a.mjs'), 'x\n', 'utf8')
      git(wtPath, ['add', 'a.mjs'])
      git(wtPath, ['commit', '--quiet', '-m', 'T1: a.mjs'])
      await writeFile(path.join(wtPath, 'stray.mjs'), 'sneaky, never committed\n', 'utf8')

      const { code, out } = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
      assert.equal(code, 0)
      assert.equal(JSON.parse(out).verdict, 'PASS')
    } finally {
      await rm(wtPath, { recursive: true, force: true })
    }
  })
})

test('LIMIT (forged digest): a forged status.tasks[].state is reported as-is because status.json is a report, not evidence', async () => {
  await withRepo(async (root) => {
    // Spec: "A teammate that forges run state. .teammates/ is writable. Nothing reads it
    // for a verdict, so this buys little — but the digest and supervision output can be
    // made to lie."
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    const statusPath = path.join(root, '.teammates', 'r1', 'status.json')
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    status.tasks.find((t) => t.id === 'T1').state = 'done'
    await writeFile(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8')

    const { code, out } = await runCliOn(root, ['digest', '--run', 'r1'])
    assert.equal(code, 0)
    // No branch for T1 exists and no gate ever ran; the digest still shows T1 as done
    // because it renders whatever status.json says, unverified.
    assert.match(out, /A ✓/)
  })
})

// ============================================================================================
// Step 4 — non-attack tests: a compliant run behaves as intended.
// ============================================================================================

test('a compliant run passes the gate and complete marks the task done', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])
    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })

    const gateResult = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(gateResult.code, 0)
    assert.equal(JSON.parse(gateResult.out).verdict, 'PASS')

    const completeResult = await runCliOn(root, ['complete', '--run', 'r1', '--task', 'T1', '--plan', 'plan.md'])
    assert.equal(completeResult.code, 0)
    assert.match(completeResult.out, /T1 done/)
    const status = await readStatus(root, 'r1')
    assert.equal(status.tasks.find((t) => t.id === 'T1').state, 'done')
  })
})

test('a compliant two-phase run passes phase 1, is merged --no-ff, then derives and passes phase 2 with no manual state edits', async () => {
  await withRepo(async (root) => {
    await runCliOn(root, ['init-run', path.join(root, 'plan.md'), '--run', 'r1'])

    await taskBranch(root, 'r1', 'T1', { files: { 'a.mjs': 'x\n' } })
    const phase1 = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(phase1.code, 0)
    assert.equal(JSON.parse(phase1.out).phase, 1)

    git(root, ['merge', '--quiet', '--no-ff', '-m', 'integrate T1', 'teammates/r1/T1'])

    // T2 branches off the run branch AFTER the phase-1 merge — the real workflow, and a
    // regression test for a confirmed bug where every phase-2 task false-failed on files
    // phase 1 had already merged (the forkPoint fix in runFilesetCheck).
    await taskBranch(root, 'r1', 'T2', { from: 'run-branch', files: { 'b.mjs': 'y\n' } })
    const phase2 = await runCliOn(root, ['gate', '--run', 'r1', '--plan', 'plan.md'])
    assert.equal(phase2.code, 0)
    assert.equal(JSON.parse(phase2.out).phase, 2)

    const completeResult = await runCliOn(root, ['complete', '--run', 'r1', '--task', 'T2', '--plan', 'plan.md'])
    assert.equal(completeResult.code, 0)
    assert.match(completeResult.out, /T2 done/)
  })
})
