import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readSessionUsage } from '../scripts/usage-store.mjs'
import { projectSlug } from '../scripts/usage.mjs'

// Resolved here, because the store resolves before deriving the slug. Passing the unresolved
// path built the fixture under a different name on Windows, where resolve adds a drive letter.
const FAKE_ROOT = path.resolve('/fake/project')

const line = (over) => JSON.stringify({
  message: { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over } },
})

// No test may read the developer's real ~/.claude, so every fixture store is built in a temp
// directory and the projects directory is injected.
async function withStore(fn, { files }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-'))
  try {
    const subagents = path.join(dir, projectSlug(FAKE_ROOT), 'sess-1', 'subagents')
    await mkdir(subagents, { recursive: true })
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(subagents, name), body, 'utf8')
    }
    await fn({ projectsDir: dir, subagents })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('reads per-agent totals and takes the role from the meta file', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.sessionId, 'sess-1')
    const reviewer = report.agents.find((a) => a.agentType === 'claude-teammates:tm-reviewer')
    assert.ok(reviewer, 'the meta file must supply the agent role')
    assert.equal(reviewer.model, 'opus')
    assert.equal(reviewer.turns, 2)
    assert.equal(reviewer.cacheRead, 300)
  }, {
    files: {
      'agent-a.jsonl': [line({ cache_read_input_tokens: 100 }), line({ cache_read_input_tokens: 200 })].join('\n'),
      'agent-a.meta.json': JSON.stringify({ agentType: 'claude-teammates:tm-reviewer', model: 'opus' }),
    },
  })
})

// The tokens were still spent, so the row must still appear.
test('a transcript with no meta file is reported as unknown, not dropped', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    const unknown = report.agents.find((a) => a.agentType === '(unknown)')
    assert.ok(unknown, 'a transcript without meta must still produce a row')
    assert.equal(unknown.turns, 1)
  }, { files: { 'agent-b.jsonl': line({ cache_read_input_tokens: 50 }) } })
})

test('an unparseable transcript is reported, not skipped', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.unreadable.length, 1)
    assert.match(report.unreadable[0].name, /agent-bad\.jsonl/)
    assert.ok(report.unreadable[0].reason, 'the reason must be carried, not just the name')
    assert.equal(report.agents.length, 1, 'the readable transcript must still produce a row')
  }, {
    files: {
      'agent-bad.jsonl': '{"message":',
      'agent-ok.jsonl': line({ cache_read_input_tokens: 10 }),
    },
  })
})

test('a missing project directory throws, naming the path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-empty-'))
  try {
    await assert.rejects(
      () => readSessionUsage({ projectsDir: dir, root: FAKE_ROOT }),
      (err) => err instanceof Error
        && err.message.includes(projectSlug(FAKE_ROOT))
        && /may have changed/.test(err.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// The shape that produced the real finding: fewer turns, larger prefix, and the bigger per-turn
// tax. A report ordered by totals would bury it.
test('rows are ordered by prefix times turns, descending', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.agents[0].agentType, 'tm-integrator')
    assert.ok(report.agents[0].turns < report.agents[1].turns, 'the fixture must give the winner fewer turns')
  }, {
    // The winner is named so it sorts LAST alphabetically. With the names the other way round the
    // fixture was already in the expected order and the assertion passed with the sort deleted —
    // found by mutation. A test whose fixture is pre-sorted pins nothing.
    files: {
      'agent-aaa-many.jsonl': Array.from({ length: 8 }, () => line({ cache_read_input_tokens: 100 })).join('\n'),
      'agent-aaa-many.meta.json': JSON.stringify({ agentType: 'tm-reviewer', model: 'opus' }),
      'agent-zzz-few.jsonl': [line({ cache_read_input_tokens: 5000 }), line({ cache_read_input_tokens: 5000 })].join('\n'),
      'agent-zzz-few.meta.json': JSON.stringify({ agentType: 'tm-integrator', model: 'sonnet' }),
    },
  })
})

// The CLI passes `flags.root ?? process.cwd()` verbatim, so a relative --root reaches here as
// "." — whose slug is "." — and path.join then collapses to the projects directory itself, where
// the newest PROJECT is mistaken for a session. Caught by running the real command; the fixtures
// above all pass an absolute root and so could not see it.
test('a relative root is resolved before the slug is derived', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-rel-'))
  try {
    await assert.rejects(
      () => readSessionUsage({ projectsDir: dir, root: '.' }),
      (err) => err.message.includes(projectSlug(path.resolve('.')))
        && !err.message.includes(`${path.sep}.${path.sep}`),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// The project directory holds more than sessions: the harness keeps `memory/` alongside them, and
// being the most recently written directory it won every mtime comparison — so the command
// reported on a directory that can never hold a transcript. A session is identified by the store
// it carries, not by being newest. Caught by running the real command against a real ~/.claude.
test('a non-session directory is not mistaken for the newest session', async () => {
  await withStore(async ({ projectsDir }) => {
    const notASession = path.join(projectsDir, projectSlug(FAKE_ROOT), 'memory')
    await mkdir(notASession, { recursive: true })
    const future = new Date(Date.now() + 60_000)
    await utimes(notASession, future, future)

    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.sessionId, 'sess-1')
  }, { files: { 'agent-a.jsonl': line({ cache_read_input_tokens: 10 }) } })
})

// Without this the failure names whichever directory happened to be newest, which reads as "that
// session is empty" rather than "no session here has a store at all".
test('a project directory with no session store throws, naming the layout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-nosess-'))
  try {
    await mkdir(path.join(dir, projectSlug(FAKE_ROOT), 'memory'), { recursive: true })
    await assert.rejects(
      () => readSessionUsage({ projectsDir: dir, root: FAKE_ROOT }),
      (err) => err.message.includes('subagents')
        && !err.message.includes('memory')
        && /may have changed/.test(err.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
