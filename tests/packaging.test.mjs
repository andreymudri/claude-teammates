import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runCli } from '../scripts/cli.mjs'

const readJson = async (rel) => JSON.parse(await readFile(new URL(rel, import.meta.url), 'utf8'))

test('marketplace manifest names the same plugin as plugin.json', async () => {
  const marketplace = await readJson('../.claude-plugin/marketplace.json')
  const plugin = await readJson('../.claude-plugin/plugin.json')
  const entry = marketplace.plugins.find((p) => p.name === plugin.name)
  assert.ok(entry, `marketplace.json does not list ${plugin.name}`)
  assert.equal(entry.source, './')
})

test('third-party license text is present and names the upstream author', async () => {
  const text = await readFile(new URL('../LICENSE-THIRD-PARTY', import.meta.url), 'utf8')
  assert.match(text, /MIT/)
  assert.match(text, /Jesse Vincent/)
  assert.match(text, /superpowers/i)
})

test('NOTICE lists every adapted skill and no skill that does not exist', async () => {
  const notice = await readFile(new URL('../NOTICE.md', import.meta.url), 'utf8')
  const present = (await readdir(new URL('../skills/', import.meta.url), { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  const ADAPTED = ['brainstorming', 'executing-plans', 'receiving-code-review', 'systematic-debugging', 'test-driven-development', 'writing-skills']
  for (const name of ADAPTED) assert.ok(notice.includes(name), `NOTICE.md omits adapted skill ${name}`)
  for (const m of notice.matchAll(/`([a-z-]+)`/g)) {
    if (present.includes(m[1]) || m[1].includes('.')) continue
    assert.ok(!m[1].startsWith('skills/'), `NOTICE.md references missing skill ${m[1]}`)
  }
})

test('NOTICE marks the original skills as original', async () => {
  const notice = await readFile(new URL('../NOTICE.md', import.meta.url), 'utf8')
  for (const name of ['writing-plans', 'finishing-a-development-branch', 'using-teammates']) {
    assert.ok(notice.includes(name), `NOTICE.md omits original skill ${name}`)
  }
})

test('the README states that run state is never swept automatically', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /`\.teammates\/<run-id>\/` is never removed by any command/)
})

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

// The behavioural counterpart to the prose assertion above. That assertion is a regex over the
// README's own text and stays green no matter what `prune-run` actually does to
// `.teammates/<run-id>/` — a reviewer proved this by adding an `rm` of that directory to
// `prune-run`'s handler and watching the full suite, this file included, stay green. This test
// builds a real run, prunes it with `--yes`, and checks the directory and its files are still on
// disk afterwards — the one thing the README's claim is actually about.
test('prune-run --yes leaves .teammates/<run-id>/ and its files on disk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-packaging-prune-'))
  try {
    git(root, ['init', '--quiet', '--initial-branch=main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    const planPath = path.join(root, 'plan.md')
    await writeFile(planPath, PLAN, 'utf8')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
    await writeFile(path.join(root, '.gitignore'), '.teammates/\n', 'utf8')
    git(root, ['add', '.'])
    git(root, ['commit', '--quiet', '-m', 'initial'])
    git(root, ['checkout', '--quiet', '-b', 'run-branch'])

    const io = { out: () => {}, err: () => {} }
    await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io)

    await writeFile(path.join(root, 'teammates.gate.json'), JSON.stringify({
      phases: { default: { checks: [{ name: 'fileset', kind: 'fileset' }] } },
    }), 'utf8')
    git(root, ['add', 'teammates.gate.json'])
    git(root, ['commit', '--quiet', '-m', 'manifest'])
    git(root, ['checkout', '--quiet', '-b', 'teammates/r1/T1'])
    await writeFile(path.join(root, 'a.mjs'), 'export const a = 1\n', 'utf8')
    git(root, ['add', 'a.mjs'])
    git(root, ['commit', '--quiet', '-m', 'T1 work'])
    git(root, ['checkout', '--quiet', 'run-branch'])
    git(root, ['merge', '--no-ff', '--quiet', '-m', 'integrate T1', 'teammates/r1/T1'])
    const wtPath = path.join(root, '.claude', 'worktrees', 'a1')
    git(root, ['worktree', 'add', '--quiet', wtPath, 'teammates/r1/T1'])

    const runDir = path.join(root, '.teammates', 'r1')
    const before = (await readdir(runDir)).sort()
    assert.ok(before.length > 0, 'init-run must have written run state for this test to pin its survival')

    const code = await runCli(
      ['prune-run', '--run', 'r1', '--plan', 'plan.md', '--base', 'main', '--root', root, '--yes'],
      io,
    )
    assert.equal(code, 0)

    const after = (await readdir(runDir)).sort()
    assert.deepEqual(after, before, '.teammates/r1 must hold the same entries after prune-run --yes')
    for (const name of before) {
      await readFile(path.join(runDir, name))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
