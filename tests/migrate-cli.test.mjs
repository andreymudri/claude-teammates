import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from '../scripts/cli.mjs'
import { findTaskByWorktree, normaliseWorktree, worktreeKey } from '../scripts/state.mjs'

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const exists = async (p) => { try { await lstat(p); return true } catch { return false } }

async function withLegacyRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'fm-migrate-cli-'))
  try {
    git(root, ['init', '--quiet', '--initial-branch=main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify({ phases: { default: { checks: [{ name: 'noop', kind: 'command', run: 'node -e ""' }] } } }), 'utf8')
    await writeFile(path.join(root, '.gitignore'), '.teammates/\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'adopt claude-teammates'])
    const lines = []
    const errLines = []
    await fn({ root, io: { out: (t) => lines.push(t), err: (t) => errLines.push(t) }, lines, errLines })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('any CLI command migrates a claude-teammates repository before it runs', async () => {
  await withLegacyRepo(async ({ root, io, errLines }) => {
    await runCli(['gate', '--no-fleet', '--root', root], io)
    assert.equal(await exists(path.join(root, 'teammates.gate.json')), false)
    assert.equal(await exists(path.join(root, 'fleetmates.gate.json')), true)
    assert.match(errLines.join('\n'), /migrating claude-teammates names to fleetmates/)
    assert.match(await readFile(path.join(root, '.gitignore'), 'utf8'), /^\.fleetmates\/$/m)
  })
})

test('a refused migration is the command exit, and the command body never runs', async () => {
  await withLegacyRepo(async ({ root, io, lines }) => {
    await writeFile(path.join(root, 'fleetmates.gate.json'), '{}', 'utf8')
    assert.equal(await runCli(['gate', '--no-fleet', '--root', root], io), 2)
    assert.match(lines.join('\n'), /teammates\.gate\.json and fleetmates\.gate\.json both exist/)
    assert.doesNotMatch(lines.join('\n'), /verdict/i)
  })
})

test('a location record written before the migration still names its branch afterwards', async () => {
  await withLegacyRepo(async ({ root, io }) => {
    const worktree = path.join(root, 'wt')
    await mkdir(worktree)
    git(root, ['branch', 'teammates/r1/T1'])
    await mkdir(path.join(root, '.teammates', 'index'), { recursive: true })
    // Written as 1.3.0's `writeLocation` wrote it — the same normalised path and key — but under
    // .teammates/ and naming the legacy branch.
    const normalised = normaliseWorktree(worktree)
    await writeFile(
      path.join(root, '.teammates', 'index', `${worktreeKey(normalised)}.json`),
      `${JSON.stringify({ runId: 'r1', taskId: 'T1', branch: 'teammates/r1/T1', worktree: normalised })}\n`,
      'utf8',
    )
    await runCli(['gate', '--no-fleet', '--root', root], io)
    const found = await findTaskByWorktree(root, worktree)
    assert.equal(found?.branch, 'fleetmates/r1/T1')
  })
})
