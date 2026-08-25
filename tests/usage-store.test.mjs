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
      // A key may carry a subdirectory, because the harness nests a workflow's transcripts under
      // `subagents/workflows/<wf-id>/` rather than writing them flat.
      const full = path.join(subagents, ...name.split('/'))
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, body, 'utf8')
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

// The layout that produced the finding, taken from a real store: a workflow-dispatched run keeps
// its transcripts under `subagents/workflows/<wf-id>/`, and `subagents/` itself holds no .jsonl at
// all. A non-recursive readdir matched nothing, so five real transcripts were reported as
// `(0 subagents)` with a zeros table and exit 0 — the empty report the header above forbids.
test('transcripts nested under subagents/workflows are found, not reported as zero', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.agents.length, 2, 'both nested transcripts must be reported')
    const reviewer = report.agents.find((a) => a.agentType === 'tm-reviewer')
    assert.ok(reviewer, 'the meta file beside a nested transcript must still supply the role')
    assert.equal(reviewer.cacheRead, 900)
  }, {
    files: {
      'workflows/wf_204b1468/agent-a.jsonl': [line({ cache_read_input_tokens: 400 }), line({ cache_read_input_tokens: 500 })].join('\n'),
      'workflows/wf_204b1468/agent-a.meta.json': JSON.stringify({ agentType: 'tm-reviewer', model: 'opus' }),
      'workflows/wf_204b1468/agent-b.jsonl': line({ cache_read_input_tokens: 70 }),
    },
  })
})

// Recursing into `subagents/` reaches files the flat read never saw. A workflow keeps its
// `journal.jsonl` beside the agent transcripts; it is valid JSONL carrying no usage, so it parsed
// cleanly and produced a phantom `(unknown)` row of zeros — a row for an agent that never ran.
// The layout in the header names transcripts `agent-<id>.jsonl`, so the basename is the filter.
test('a non-agent .jsonl beside the transcripts is not reported as an agent', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.agents.length, 1, 'only the agent transcript may produce a row')
    assert.equal(report.agents[0].cacheRead, 40)
    assert.equal(report.unreadable.length, 0, 'the journal is skipped, not reported as unreadable')
  }, {
    files: {
      'workflows/wf_1/agent-a.jsonl': line({ cache_read_input_tokens: 40 }),
      'workflows/wf_1/journal.jsonl': JSON.stringify({ event: 'agent-start', label: 'review' }),
    },
  })
})

// A transcript is appended to while the session runs, so reading one during a live fleet run —
// exactly when an operator reports on it — catches a half-written last line. Parsing the whole
// file in one try sent every record in it to `unreadable`, so an agent's entire spend vanished
// and the `fixed prefix = N%` headline was computed from what survived. The line is dropped and
// counted; the records before it are not.
test('a torn last line drops that line, not the whole transcript', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    const agent = report.agents.find((a) => a.name.endsWith('agent-big.jsonl'))
    assert.ok(agent, 'the transcript must still produce a row')
    assert.equal(agent.turns, 2, 'both complete records must be counted')
    assert.equal(agent.cacheRead, 1_700_000)
    assert.equal(report.unreadable.length, 1, 'the drop must still be reported, not absorbed')
    assert.equal(report.unreadable[0].dropped, 1)
    assert.equal(report.unreadable[0].kept, 2)
  }, {
    files: {
      'agent-big.jsonl': [
        line({ cache_read_input_tokens: 1_000_000 }),
        line({ cache_read_input_tokens: 700_000 }),
        '{"message":{"usa',
      ].join('\n'),
    },
  })
})

// The reason is built from a line count, never from the JSON.parse message, which quotes the
// offending source text back — and the source here is the operator's real transcript, so the
// snippet put private conversation content into a printed report.
test('a drop reason carries no content from the transcript', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.unreadable.length, 1)
    // JSON.parse quotes only the first ten characters back, so asserting on the full secret
    // would pass against the leaky message too. The prefix is what actually leaks.
    assert.doesNotMatch(report.unreadable[0].reason, /ANTHROPIC/)
  }, { files: { 'agent-secret.jsonl': 'ANTHROPIC_API_KEY=sk-ant-secret-abc123' } })
})

// Builds several sessions with mtimes set explicitly on BOTH the session directory and its store,
// which is the only way to tell the two halves of the selection rule apart. Every fixture above
// carries exactly one session, so none of them could: the sort direction and the Math.max rule
// were both unpinned, and inverting either left the suite green.
async function withSessions(fn, sessions) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-sessions-'))
  try {
    for (const [name, { own, store }] of Object.entries(sessions)) {
      const subagents = path.join(dir, projectSlug(FAKE_ROOT), name, 'subagents')
      await mkdir(subagents, { recursive: true })
      await writeFile(path.join(subagents, 'agent-a.jsonl'), line({ cache_read_input_tokens: 1 }), 'utf8')
      // The store first: writing into a directory stamps it, so the session directory has to be
      // stamped after everything inside it exists.
      await utimes(subagents, new Date(store), new Date(store))
      await utimes(path.join(dir, projectSlug(FAKE_ROOT), name), new Date(own), new Date(own))
    }
    await fn({ projectsDir: dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const T = (ms) => 1_700_000_000_000 + ms

test('the newest session is chosen, not the oldest', async () => {
  await withSessions(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.sessionId, 'sess-new')
  }, {
    // Named so the winner sorts FIRST alphabetically, so a fixture that happened to be in
    // readdir order cannot pass an inverted sort by accident.
    'sess-new': { own: T(9000), store: T(9000) },
    'sess-old': { own: T(1000), store: T(1000) },
  })
})

// The store is stamped when a transcript is added; the session directory when the store is
// created. Taking only the directory's mtime picks the session that has been idle longest since
// its store appeared — here, the one that is not being written to.
test('a session whose store is newer wins over one whose directory is newer', async () => {
  await withSessions(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.sessionId, 'sess-live', 'the later of the two mtimes decides')
  }, {
    'sess-live': { own: T(1000), store: T(9000) },
    'sess-idle': { own: T(5000), store: T(2000) },
  })
})

// The other half of the same rule: taking only the store's mtime loses to a session whose
// directory was touched more recently than its store.
test('a session whose directory is newer wins over one whose store is newer', async () => {
  await withSessions(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.sessionId, 'sess-touched', 'the later of the two mtimes decides')
  }, {
    'sess-touched': { own: T(9000), store: T(1000) },
    'sess-stored': { own: T(2000), store: T(5000) },
  })
})
