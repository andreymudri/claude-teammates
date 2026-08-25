import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readSessionUsage, DEFAULT_MAX_ENTRIES } from '../scripts/usage-store.mjs'
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

// The traversal is refused where the join happens, not only at the CLI, because `--session` is
// not the only way a name reaches here: `newestSession` returns a directory name that is joined
// again, so a directory an attacker can create is the same primitive.
test('a session name with a path separator is refused before it is joined', async () => {
  await withStore(async ({ projectsDir }) => {
    await assert.rejects(
      () => readSessionUsage({ projectsDir, root: FAKE_ROOT, sessionId: '../../elsewhere' }),
      (err) => /no path separators/.test(err.message) && !/no transcripts found/.test(err.message),
    )
    await assert.rejects(
      () => readSessionUsage({ projectsDir, root: FAKE_ROOT, sessionId: '..' }),
      (err) => /no path separators/.test(err.message),
    )
  }, { files: { 'agent-a.jsonl': line({ cache_read_input_tokens: 10 }) } })
})


// The second route to the empty report the module header forbids, independent of the recursion
// bug: `subagents/` exists but holds no transcript at all, so newestSession accepted the session,
// readdir succeeded, and the command rendered a table of zeros at exit 0.
test('a session whose store holds no transcript throws rather than reporting zeros', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-bare-'))
  try {
    await mkdir(path.join(dir, projectSlug(FAKE_ROOT), 'sess-1', 'subagents'), { recursive: true })
    await assert.rejects(
      () => readSessionUsage({ projectsDir: dir, root: FAKE_ROOT }),
      (err) => /no transcripts found/.test(err.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ...but a store whose every transcript is unreadable is NOT an empty report. It names what it
// could not read, and dropping that would understate the totals silently — the opposite failure.
test('a store whose transcripts are all unreadable reports them rather than throwing', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.agents.length, 0)
    assert.equal(report.unreadable.length, 1, 'the unreadable transcript must still be named')
  }, { files: { 'agent-bad.jsonl': 'not json at all' } })
})


// SYMLINKS ARE NOT FOLLOWED. Making the walk recursive also made it follow directory symlinks, so
// one planted link inside the store made `usage` read and report agent-*.jsonl from anywhere on
// disk — and the walk re-entered itself until ELOOP, multiplying every total. The session-name
// validator does not help: it checks the one component this module joins, while this traversal
// happens inside the walk. Skipped on Windows, where creating a symlink needs a privilege CI does
// not grant; the behaviour under test is platform-independent.
test('a directory symlink inside the store is not followed', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-link-'))
  try {
    const subagents = path.join(dir, projectSlug(FAKE_ROOT), 'sess-1', 'subagents')
    await mkdir(subagents, { recursive: true })
    await writeFile(path.join(subagents, 'agent-a.jsonl'), line({ cache_read_input_tokens: 10 }), 'utf8')

    const outside = path.join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'agent-secret.jsonl'), line({ cache_read_input_tokens: 999 }), 'utf8')
    await symlink(outside, path.join(subagents, 'peek'), 'dir')

    const report = await readSessionUsage({ projectsDir: dir, root: FAKE_ROOT })
    assert.equal(report.agents.length, 1, 'only the transcript inside the store may be reported')
    assert.equal(report.agents[0].cacheRead, 10)
    assert.doesNotMatch(JSON.stringify(report), /agent-secret/, 'the walk left the store')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// One unreadable subdirectory must not abort the whole report. The recursive readdir propagated a
// nested EACCES to the top-level catch, which threw "no transcripts found" — dropping a readable
// transcript sitting in the very directory the message named, and blaming a harness layout change
// that had not happened. A workflow directory removed mid-walk (ENOENT) does the same, during
// exactly the live run an operator reports on.
test('an unreadable subdirectory is reported, not fatal to the whole report', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-eacces-'))
  const locked = path.join(dir, projectSlug(FAKE_ROOT), 'sess-1', 'subagents', 'locked')
  try {
    const subagents = path.join(dir, projectSlug(FAKE_ROOT), 'sess-1', 'subagents')
    await mkdir(locked, { recursive: true })
    await writeFile(path.join(subagents, 'agent-a.jsonl'), line({ cache_read_input_tokens: 10 }), 'utf8')
    await chmod(locked, 0o000)
    // chmod is not a permission check for uid 0, which reads the directory regardless — so the
    // fixture would silently test nothing in a root container. Probed, not assumed.
    try {
      await readdir(locked)
      t.skip('this user can read a 0o000 directory (running as root?), so the fixture cannot be built')
      return
    } catch { /* refused, as intended: the fixture is real */ }

    const report = await readSessionUsage({ projectsDir: dir, root: FAKE_ROOT })
    assert.equal(report.agents.length, 1, 'the readable transcript must still be reported')
    assert.equal(report.unreadable.length, 1, 'the directory that could not be read must be named')
    assert.match(report.unreadable[0].name, /locked/)
    // The PRODUCER's kind. tests/usage.test.mjs pins the renderer against hand-built literals that
    // carry `kind` themselves, so without this neither side of the contract is bound: deleting
    // `kind: 'directory'` here left the whole suite green and reinstated a locked directory being
    // tallied as an unreadable transcript.
    assert.equal(report.unreadable[0].kind, 'directory')
  } finally {
    await chmod(locked, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

// A transcript that parsed to zero records with zero parse errors — an empty or whitespace-only
// agent-*.jsonl, the ordinary state between a dispatch creating the file and the first turn being
// appended — was dropped with no row AND no unreadable entry. Alone in a store it tripped the
// empty-report throw and blamed the layout; beside a good one it vanished from the count.
test('an empty transcript is reported rather than silently dropped', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.agents.length, 1, 'the transcript with records still produces a row')
    assert.equal(report.unreadable.length, 1, 'the empty one must be named, not dropped')
    assert.match(report.unreadable[0].name, /agent-empty/)
    assert.equal(report.unreadable[0].kept, 0)
    assert.equal(report.unreadable[0].kind, 'empty', 'the producer must say which kind of gap this is')
  }, {
    files: {
      'agent-a.jsonl': line({ cache_read_input_tokens: 10 }),
      'agent-empty.jsonl': '   \n  \n',
    },
  })
})

// And alone, an empty transcript is a store that yielded nothing readable — but it is NOT the
// "layout has changed" case, because the file is present and correctly named.
test('a store holding only an empty transcript reports it rather than blaming the layout', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.agents.length, 0)
    assert.equal(report.unreadable.length, 1)
  }, { files: { 'agent-empty.jsonl': '' } })
})

// The cap must not stop the walk silently. Past it, a store under-reported its totals at exit 0 —
// and with nothing else readable it threw the very "layout may have changed" message the walk was
// written to eliminate, reintroduced by the bound added to keep the walk finite.
test('a truncated walk says so rather than under-reporting silently', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-cap-'))
  try {
    const subagents = path.join(dir, projectSlug(FAKE_ROOT), 'sess-1', 'subagents')
    await mkdir(path.join(subagents, 'wf-1'), { recursive: true })
    await writeFile(path.join(subagents, 'agent-flat.jsonl'), line({ cache_read_input_tokens: 1000 }), 'utf8')
    await writeFile(path.join(subagents, 'wf-1', 'agent-nested.jsonl'), line({ cache_read_input_tokens: 1000 }), 'utf8')

    // The cap is INJECTED rather than reached. Building a store past the real 20,000 took 20,050
    // files, which is slow everywhere and failed on macOS CI with EMFILE — the fixture, not the
    // code. A bound a test cannot reach cheaply is a bound no test verifies.
    const report = await readSessionUsage({ projectsDir: dir, root: FAKE_ROOT, maxEntries: 2 })
    const truncated = report.unreadable.filter((e) => e.kind === 'truncated')
    assert.equal(truncated.length, 1, 'a truncated walk must be reported, never silent')
    assert.match(truncated[0].reason, /incomplete/i)
    assert.match(truncated[0].reason, /stopped after 2 entries/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// And an uncapped walk says nothing, so the notice cannot become background noise.
test('a walk that finishes within the cap reports no truncation', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.unreadable.filter((e) => e.kind === 'truncated').length, 0)
  }, { files: { 'agent-a.jsonl': line({ cache_read_input_tokens: 10 }) } })
})


// The other half of the symlink rule, and it was unpinned: `entry.isFile()` is false for a symlink
// to a file, so a link named `agent-x.jsonl` is not read — but deleting that guard left the whole
// suite green, and the symlink test above covers only DIRECTORY links. Off-store reads re-open
// through a file link exactly as through a directory one.
test('a file symlink named like a transcript is not read', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-flink-'))
  try {
    const subagents = path.join(dir, projectSlug(FAKE_ROOT), 'sess-1', 'subagents')
    await mkdir(subagents, { recursive: true })
    await writeFile(path.join(subagents, 'agent-a.jsonl'), line({ cache_read_input_tokens: 10 }), 'utf8')

    const outside = path.join(dir, 'outside.jsonl')
    await writeFile(outside, line({ cache_read_input_tokens: 999 }), 'utf8')
    await symlink(outside, path.join(subagents, 'agent-secret.jsonl'), 'file')

    const report = await readSessionUsage({ projectsDir: dir, root: FAKE_ROOT })
    assert.equal(report.agents.length, 1, 'only the real transcript may be read')
    assert.equal(report.agents[0].cacheRead, 10)
    assert.doesNotMatch(JSON.stringify(report), /agent-secret/, 'a file symlink was followed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


// THE BOUNDARY. `if (budget-- <= 0) break` post-decrements, so a walk that consumed exactly
// `maxEntries` entries and saw everything leaves `budget === 0` — indistinguishable, to a
// `budget <= 0` test, from one that stopped short. A complete report was therefore declared
// incomplete, which is the "notice becomes background noise" failure the companion test claims to
// prevent; that test never caught it because it used the 20,000 default and never reached the edge.
test('a walk that consumes exactly the cap and sees everything is not called truncated', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT, maxEntries: 2 })
    assert.equal(report.agents.length, 2, 'both transcripts must be reported')
    assert.equal(report.unreadable.filter((e) => e.kind === 'truncated').length, 0,
      'a complete walk must not be declared incomplete')
  }, {
    files: {
      'agent-a.jsonl': line({ cache_read_input_tokens: 10 }),
      'agent-b.jsonl': line({ cache_read_input_tokens: 20 }),
    },
  })
})

// A transcript where NOTHING parsed contributes no row, so calling it "with dropped lines" asserts
// it is in the table minus a few lines when it is absent entirely and its whole spend is missing
// from TOTAL. That is the same misstatement the `kind` split was introduced to remove, inverted —
// and it regressed against the base, which reported it as unreadable.
test('a transcript where every line fails is unreadable, not partial', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    const bad = report.unreadable.find((e) => e.name.endsWith('agent-bad.jsonl'))
    assert.ok(bad, 'the transcript must be reported')
    assert.equal(bad.kept, 0)
    assert.equal(bad.kind, 'unreadable', 'nothing survived, so it is not a partial read')
  }, {
    files: {
      'agent-bad.jsonl': 'nope\nalso nope\nstill nope',
      'agent-ok.jsonl': line({ cache_read_input_tokens: 10 }),
    },
  })
})

// The parameter is part of the module's exported surface now, and the comment advertises it for
// injection. Unvalidated, 0 and NaN reproduced the misleading "layout may have changed" throw for
// a perfectly readable store, and null crashed on toLocaleString.
test('an unusable maxEntries is refused by name, not turned into a layout lie', async () => {
  await withStore(async ({ projectsDir }) => {
    for (const bad of [0, -1, 1.5, Number.NaN, 'x', {}, true]) {
      await assert.rejects(
        () => readSessionUsage({ projectsDir, root: FAKE_ROOT, maxEntries: bad }),
        (err) => /maxEntries/.test(err.message) && !/may have changed/.test(err.message),
        `maxEntries: ${JSON.stringify(bad)} must be refused by name`,
      )
    }
    // `null` is not a bad value: it means "use the shipped default", which is how the CLI reaches
    // this function. This is a deliberate BEHAVIOUR CHANGE, not a crash fix: at `f1626e3` the
    // guard ran on the raw parameter, so `Number.isInteger(null)` was false and `null` was refused
    // BY NAME — this very list used to contain it. (An earlier version of this comment said `null`
    // "crashed", which belongs to the era before any validation existed and was wrong about the
    // revision immediately before it.)
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT, maxEntries: null })
    assert.equal(report.agents.length, 1)
    assert.equal(report.cap, DEFAULT_MAX_ENTRIES, 'null must resolve to the shipped default')
  }, { files: { 'agent-a.jsonl': line({ cache_read_input_tokens: 10 }) } })
})


// The injectable cap verifies the notice; the DEFAULT bound was still unpinned, so raising
// MAX_ENTRIES to Number.MAX_SAFE_INTEGER left the suite green and the walk effectively unbounded —
// reason 3 for hand-writing it in the first place, unverified.
test('the default cap is a real bound, not an unreachable number', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    // `report.cap`, NOT a truncation count. On a one-file store `if (budget-- <= 0)` cannot trip
    // for ANY admissible cap, so asserting "nothing truncated" here was unfalsifiable by
    // construction — the test named for the bound did not guard the bound, and setting the shipped
    // default to 1 left it green while every `usage` run reported at most one transcript.
    assert.equal(report.cap, DEFAULT_MAX_ENTRIES, 'the walk must APPLY the documented default')
    assert.equal(DEFAULT_MAX_ENTRIES, 20_000, 'the documented bound is the one that ships')
    assert.ok(Number.isInteger(DEFAULT_MAX_ENTRIES) && DEFAULT_MAX_ENTRIES < 1e6,
      'a bound nothing can reach is not a bound')
  }, { files: { 'agent-a.jsonl': line({ cache_read_input_tokens: 10 }) } })
})


// The `partial` SIBLING. A test pins that nothing-parsed is `unreadable`, but nothing pinned the
// other branch, so `records.length > 0 ? 'partial' : 'unreadable'` collapsed to plain
// `'unreadable'` with the suite green — reinstating the misstatement that a transcript which DID
// contribute a row was a read failure.
test('a transcript that lost some lines but kept others is partial, not unreadable', async () => {
  await withStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    const torn = report.unreadable.find((e) => e.name.endsWith('agent-torn.jsonl'))
    assert.ok(torn, 'the drop must be reported')
    assert.equal(torn.kind, 'partial', 'records survived, so this is not a read failure')
    assert.equal(torn.kept, 1)
    assert.equal(torn.dropped, 1)
    assert.ok(report.agents.some((a) => a.name.endsWith('agent-torn.jsonl')),
      'a partial transcript still contributes its row, which is what makes it partial')
  }, { files: { 'agent-torn.jsonl': `${line({ cache_read_input_tokens: 10 })}\n{"broken` } })
})


// The Windows half of the traversal rule, at the site the finding was reported against. Windows
// strips trailing spaces and dots from a path component, so `'.. '` reaches the filesystem as
// `..`. This was left open across a release BECAUSE `reviewFileName` shared the gap — the two
// checks were separate implementations of one rule. They are the same function now.
test('a session name Windows would strip back to .. is refused', async () => {
  await withStore(async ({ projectsDir }) => {
    for (const escape of ['.. ', '...', '. ', '..\t', '   ']) {
      await assert.rejects(
        () => readSessionUsage({ projectsDir, root: FAKE_ROOT, sessionId: escape }),
        (err) => /no path separators/.test(err.message) && !/no transcripts found/.test(err.message),
        `session ${JSON.stringify(escape)} must be refused by name`,
      )
    }
  }, { files: { 'agent-a.jsonl': line({ cache_read_input_tokens: 10 }) } })
})


// The walk's ROOT is reached by `readdir()`/`stat()`, and both FOLLOW symlinks. The hand-written
// walk closed the symlink hole for links found INSIDE it — `withFileTypes` + `isDirectory()` is
// false for a link — and left the one at its own entry point, under a comment asserting the hole
// was closed. Validating the session COMPONENT cannot help: the name is ordinary, only its target
// escapes. The store path is therefore compared, RESOLVED, against the one path it may be.
//
// Every test below builds a real symlink, so every one carries the win32 skip this file uses at
// :352, :378 and :476. Without it they do not skip on Windows — they THROW EPERM inside the
// fixture builder and FAIL, which reads as a product regression rather than a fixture that cannot
// be built, and would have taken CI red on one of the three platforms in the matrix.
const NO_SYMLINKS_ON_WIN32 = { skip: process.platform === 'win32' }

async function withRawStore(fn, build) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-sym-'))
  try {
    const over = (await build(dir)) ?? {}
    // `projectDir` is derived AFTER the spread, from whatever `projectsDir` ends up being: derived
    // before it, a builder that redirects `projectsDir` left `projectDir` pointing at a path that
    // was never created, silently wrong for the next test that reads it.
    const projectsDir = over.projectsDir ?? dir
    await fn({ ...over, projectsDir, projectDir: path.join(projectsDir, projectSlug(FAKE_ROOT)) })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const usageLine = (reads) => line({ cache_read_input_tokens: reads })

test('a session whose subagents/ is a symlink out of the store is not auto-selected', NO_SYMLINKS_ON_WIN32, async () => {
  await withRawStore(async ({ projectsDir }) => {
    await assert.rejects(
      () => readSessionUsage({ projectsDir, root: FAKE_ROOT }),
      (err) => /no transcripts found/.test(err.message),
      'a store reached through a link must not be walked, nor reported as this project',
    )
  }, async (dir) => {
    const outside = path.join(dir, 'outside', 'subagents')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'agent-outside.jsonl'), usageLine(999999), 'utf8')
    const session = path.join(dir, projectSlug(FAKE_ROOT), 'sess-plausible')
    await mkdir(session, { recursive: true })
    await symlink(outside, path.join(session, 'subagents'), 'dir')
  })
})

// Pins the `lstat` half of the fix SPECIFICALLY, by observing WHICH session is selected rather
// than that the call rejects. The test above passes with `lstat` reverted to `stat`, because the
// containment check rejects on its own — so it never observed the thing it is named for, and
// `stat` survived as a mutation. Here the decoy is newer, so under `stat` it becomes a candidate,
// WINS on mtime, and the containment check then throws: one planted link denies the operator a
// report on a real session sitting right beside it.
test('a session whose subagents/ is a symlink loses to a real one instead of hiding it', NO_SYMLINKS_ON_WIN32, async () => {
  await withRawStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.sessionId, 'sess-real', 'the real session must still be found and selected')
    assert.equal(report.agents.length, 1)
  }, async (dir) => {
    const project = path.join(dir, projectSlug(FAKE_ROOT))
    const real = path.join(project, 'sess-real', 'subagents')
    await mkdir(real, { recursive: true })
    await writeFile(path.join(real, 'agent-a.jsonl'), usageLine(10), 'utf8')
    const outside = path.join(dir, 'outside', 'subagents')
    await mkdir(outside, { recursive: true })
    await writeFile(path.join(outside, 'agent-outside.jsonl'), usageLine(999999), 'utf8')
    const decoy = path.join(project, 'sess-decoy')
    await mkdir(decoy, { recursive: true })
    await symlink(outside, path.join(decoy, 'subagents'), 'dir')
    // Newer than the real one, so under `stat` it wins every mtime comparison.
    const later = new Date(Date.now() + 60_000)
    await utimes(decoy, later, later)
  })
})

test('an explicitly named session that is itself a symlink is refused', NO_SYMLINKS_ON_WIN32, async () => {
  await withRawStore(async ({ projectsDir }) => {
    await assert.rejects(
      () => readSessionUsage({ projectsDir, root: FAKE_ROOT, sessionId: 'sess-linked' }),
      (err) => /no transcripts found/.test(err.message),
      'the component name is ordinary; only its target escapes, so the name check cannot catch it',
    )
  }, async (dir) => {
    const outside = path.join(dir, 'elsewhere')
    await mkdir(path.join(outside, 'subagents'), { recursive: true })
    await writeFile(path.join(outside, 'subagents', 'agent-leak.jsonl'), usageLine(999999), 'utf8')
    const project = path.join(dir, projectSlug(FAKE_ROOT))
    await mkdir(project, { recursive: true })
    await symlink(outside, path.join(project, 'sess-linked'), 'dir')
  })
})

// The escape that defeated the FIRST containment check: it anchored on `realpath(projectDir)`, and
// `projectDir` is `<projectsDir>/<slug>` — a DERIVED name whoever writes the store can replace
// with a link. `realpath` followed it, so the attacker's store resolved "inside" the attacker's
// own directory and the check passed. `projectsDir` is the caller's, and is the only path here
// that nobody plants.
test('a project directory that is itself a symlink does not become the containment anchor', NO_SYMLINKS_ON_WIN32, async () => {
  await withRawStore(async ({ projectsDir }) => {
    await assert.rejects(
      () => readSessionUsage({ projectsDir, root: FAKE_ROOT }),
      (err) => /no transcripts found/.test(err.message),
      'the anchor must not be a path the store owner can redirect',
    )
  }, async (dir) => {
    const secret = path.join(dir, 'SECRET-STORE', 'sess-x', 'subagents')
    await mkdir(secret, { recursive: true })
    await writeFile(path.join(secret, 'agent-someone-else.jsonl'), usageLine(999999), 'utf8')
    await symlink(path.join(dir, 'SECRET-STORE'), path.join(dir, projectSlug(FAKE_ROOT)), 'dir')
  })
})

// Prefix-based containment accepted this: `path.relative` gives `sess-other/subagents`, which has
// no `..` and is not absolute, so another session's transcripts were reported under this session's
// id. Exact match has no prefix arithmetic to get wrong.
test('a store symlinked to a sibling session is refused rather than misattributed', NO_SYMLINKS_ON_WIN32, async () => {
  await withRawStore(async ({ projectsDir }) => {
    await assert.rejects(
      () => readSessionUsage({ projectsDir, root: FAKE_ROOT, sessionId: 'sess-1' }),
      (err) => /no transcripts found/.test(err.message),
      "one session's report must not be built from another session's store",
    )
  }, async (dir) => {
    const project = path.join(dir, projectSlug(FAKE_ROOT))
    const other = path.join(project, 'store-real')
    await mkdir(other, { recursive: true })
    await writeFile(path.join(other, 'agent-a.jsonl'), usageLine(10), 'utf8')
    await mkdir(path.join(project, 'sess-1'), { recursive: true })
    await symlink(other, path.join(project, 'sess-1', 'subagents'), 'dir')
  })
})

// Prefix-based containment needed a separate `rel === ''` arm for this, and deleting that arm
// passed the whole suite: a store resolving to the project directory itself walked EVERY session
// into one session's report.
test('a store symlinked to the project directory itself is refused', NO_SYMLINKS_ON_WIN32, async () => {
  await withRawStore(async ({ projectsDir }) => {
    await assert.rejects(
      () => readSessionUsage({ projectsDir, root: FAKE_ROOT, sessionId: 'sess-loop' }),
      (err) => /no transcripts found/.test(err.message),
      'a store that resolves to the project directory would walk every session in it',
    )
  }, async (dir) => {
    const project = path.join(dir, projectSlug(FAKE_ROOT))
    const other = path.join(project, 'sess-other', 'subagents')
    await mkdir(other, { recursive: true })
    await writeFile(path.join(other, 'agent-other.jsonl'), usageLine(10), 'utf8')
    await mkdir(path.join(project, 'sess-loop'), { recursive: true })
    await symlink('..', path.join(project, 'sess-loop', 'subagents'), 'dir')
  })
})

// The false positive prefix math produced: `path.relative` returns `..foo/subagents`, which
// `.startsWith('..')` refused — a readable transcript sitting exactly where the message said
// nothing was, blamed on a layout change that had not happened. `isUnsafePathComponent` accepts
// the name, so the two checks in this module disagreed about one value. No symlink here, so no
// win32 skip: this must hold on every platform.
test('a session directory whose name begins with two dots is read, not refused', async () => {
  await withRawStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT, sessionId: '..foo' })
    assert.equal(report.agents.length, 1, 'a legitimate in-store session must not be refused by name shape')
    const auto = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(auto.sessionId, '..foo', 'and it must still be selectable on the auto path')
  }, async (dir) => {
    const store = path.join(dir, projectSlug(FAKE_ROOT), '..foo', 'subagents')
    await mkdir(store, { recursive: true })
    await writeFile(path.join(store, 'agent-a.jsonl'), usageLine(10), 'utf8')
  })
})

// The containment check must not refuse a LEGITIMATE store reached through a link the operator put
// ABOVE the projects directory — a macOS temp dir is `/var/...`, itself a link to `/private/var`,
// so comparing unresolved paths would refuse every store there. Both sides are resolved, so an
// ancestor link cancels out.
test('a real store is still read when the projects directory itself is reached through a link', NO_SYMLINKS_ON_WIN32, async () => {
  await withRawStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT })
    assert.equal(report.sessionId, 'sess-1')
    assert.equal(report.agents.length, 1)
  }, async (dir) => {
    const real = path.join(dir, 'real', projectSlug(FAKE_ROOT), 'sess-1', 'subagents')
    await mkdir(real, { recursive: true })
    await writeFile(path.join(real, 'agent-a.jsonl'), usageLine(10), 'utf8')
    await symlink(path.join(dir, 'real'), path.join(dir, 'link'), 'dir')
    return { projectsDir: path.join(dir, 'link') }
  })
})

// The `.meta.json` path is DERIVED from the transcript name and never enumerated, so it passes
// neither the walk's `isFile()` filter nor the containment check — both only ever see paths the
// walk listed. It was a constrained arbitrary file read: any JSON file on disk, with two of its
// string fields printed into the operator's table.
test('a symlinked meta file is not read, and the row keeps an unknown role', NO_SYMLINKS_ON_WIN32, async () => {
  await withRawStore(async ({ projectsDir }) => {
    const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT, sessionId: 'sess-1' })
    assert.equal(report.agents.length, 1, 'the transcript itself is genuine and still gets a row')
    assert.equal(report.agents[0].agentType, '(unknown)', 'no value from outside the store may be printed')
    assert.equal(report.agents[0].model, '(unknown)')
  }, async (dir) => {
    const store = path.join(dir, projectSlug(FAKE_ROOT), 'sess-1', 'subagents')
    await mkdir(store, { recursive: true })
    await writeFile(path.join(store, 'agent-a.jsonl'), usageLine(10), 'utf8')
    const far = path.join(dir, 'FAR-AWAY')
    await mkdir(far, { recursive: true })
    await writeFile(path.join(far, 'private.json'),
      JSON.stringify({ agentType: 'CONTENT-FROM-OUTSIDE-THE-STORE', model: 'LEAKED' }), 'utf8')
    await symlink(path.join(far, 'private.json'), path.join(store, 'agent-a.meta.json'), 'file')
  })
})

// `readFile` on a FIFO blocks with no writer — no timeout, no AbortSignal — and the pending read
// keeps the event loop alive, so `usage` never returned AND the process would not exit: the
// operator sees nothing and has to Ctrl-C. Guarded by the same `lstat` + `isFile()` as the symlink
// case above.
//
// Run in a CHILD PROCESS with a hard kill, not raced in-process. Racing it in-process detects the
// hang but cannot end it — the dangling `readFile` holds the event loop open, so a regression took
// the whole test RUN to a timeout instead of failing this one test. Measured: with the `isFile()`
// guard removed, `node --test tests/usage-store.test.mjs` never terminated. A child can be killed.
test('a FIFO named like a meta file does not hang the report', NO_SYMLINKS_ON_WIN32, async () => {
  await withRawStore(async ({ projectsDir }) => {
    const script = `
      import { readSessionUsage } from ${JSON.stringify(new URL('../scripts/usage-store.mjs', import.meta.url).href)}
      const r = await readSessionUsage({ projectsDir: process.argv[1], root: process.argv[2], sessionId: 'sess-1' })
      process.stdout.write(JSON.stringify({ n: r.agents.length, role: r.agents[0]?.agentType }))
    `
    let out
    try {
      out = execFileSync(process.execPath, ['--input-type=module', '-e', script, projectsDir, FAKE_ROOT],
        { timeout: 15_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (err) {
      assert.fail(err.signal
        ? `readFile hung on the FIFO: the child had to be killed with ${err.signal}`
        : `the report failed on a store containing a FIFO: ${err.message}`)
    }
    assert.deepEqual(JSON.parse(out), { n: 1, role: '(unknown)' }, 'a FIFO is not a meta file')
  }, async (dir) => {
    const store = path.join(dir, projectSlug(FAKE_ROOT), 'sess-1', 'subagents')
    await mkdir(store, { recursive: true })
    await writeFile(path.join(store, 'agent-a.jsonl'), usageLine(10), 'utf8')
    execFileSync('mkfifo', [path.join(store, 'agent-a.meta.json')])
  })
})


// The applied bound, read back off the report rather than off the constant. The default was two
// values joined at a site nothing pinned — the signature default and the `??` — and the test that
// claimed to pin it read DEFAULT_MAX_ENTRIES and asserted "no truncation on a 1-file store", which
// observes NEITHER being applied. Both one-token escapes left the whole suite green: raising the
// signature default, and raising the `??` fallback. This asserts the number the walk actually used.
test('the default cap the walk applies is the exported constant', async () => {
  await withStore(async ({ projectsDir }) => {
    for (const injected of [undefined, null]) {
      const report = await readSessionUsage({ projectsDir, root: FAKE_ROOT, maxEntries: injected })
      assert.equal(report.cap, DEFAULT_MAX_ENTRIES,
        `maxEntries: ${injected} must resolve to the shipped default, and the walk must APPLY it`)
    }
    const injected = await readSessionUsage({ projectsDir, root: FAKE_ROOT, maxEntries: 7 })
    assert.equal(injected.cap, 7, 'an injected cap is reported as the one applied')
  }, { files: { 'agent-a.jsonl': line({ cache_read_input_tokens: 10 }) } })
})

// The refusal's contract is that a bad cap is named. `JSON.stringify` THROWS on a BigInt, so the
// error-formatting path itself failed with a TypeError naming neither the argument nor the value;
// it also renders NaN and Infinity as `null`, quoting a value the caller never passed.
test('an unusable cap is refused by name whatever its type', async () => {
  await withStore(async ({ projectsDir }) => {
    const cases = [[0, '0'], [-1, '-1'], [1.5, '1.5'], [NaN, 'NaN'], [Infinity, 'Infinity'], [2n, '2n'], ['x', '"x"'], [true, 'true']]
    for (const [value, shown] of cases) {
      await assert.rejects(
        () => readSessionUsage({ projectsDir, root: FAKE_ROOT, maxEntries: value }),
        (err) => /maxEntries must be a positive integer/.test(err.message) && err.message.endsWith(shown),
        `maxEntries ${String(value)} must be refused with its own value named, got a different message`,
      )
    }
  }, { files: { 'agent-a.jsonl': line({ cache_read_input_tokens: 10 }) } })
})
