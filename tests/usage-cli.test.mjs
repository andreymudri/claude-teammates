import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runCli } from '../scripts/cli.mjs'
import { projectSlug } from '../scripts/usage.mjs'

// Resolved, and the slug strips the drive colon, so the fixture directory is legal on Windows.
const FAKE_ROOT = path.resolve('/fake/cli-project')
const line = (over) => JSON.stringify({ message: { usage: { cache_read_input_tokens: 0, output_tokens: 0, ...over } } })

// The fixture store is injected through CLAUDE_CONFIG_DIR so no test reads the developer's real
// transcripts, and the variable is restored afterwards whatever happens.
async function withCli(fn, { files, other }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-cli-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    const subagents = path.join(dir, 'projects', projectSlug(FAKE_ROOT), 'sess-9', 'subagents')
    await mkdir(subagents, { recursive: true })
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(subagents, name), body, 'utf8')
    // A second session, so `--session` has something to choose BETWEEN. With one session in the
    // store the flag could be ignored entirely and every assertion still passed.
    for (const [name, body] of Object.entries(other ?? {})) {
      const dir2 = path.join(dir, 'projects', projectSlug(FAKE_ROOT), 'sess-other', 'subagents')
      await mkdir(dir2, { recursive: true })
      await writeFile(path.join(dir2, name), body, 'utf8')
    }
    process.env.CLAUDE_CONFIG_DIR = dir
    const lines = []
    const code = await fn({ io: { out: (t) => lines.push(t) }, lines })
    return { code, out: lines.join('\n') }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
}

const FIXTURE = {
  'agent-a.jsonl': [line({ cache_read_input_tokens: 100 }), line({ cache_read_input_tokens: 300 })].join('\n'),
  'agent-a.meta.json': JSON.stringify({ agentType: 'claude-teammates:tm-reviewer', model: 'opus' }),
  'agent-b.jsonl': line({ cache_read_input_tokens: 50 }),
  'agent-b.meta.json': JSON.stringify({ agentType: 'claude-teammates:tm-integrator', model: 'sonnet' }),
}

test('usage renders a table naming every agent', async () => {
  const { code, out } = await withCli(
    ({ io }) => runCli(['usage', '--root', FAKE_ROOT], io),
    { files: FIXTURE },
  )
  assert.equal(code, 0)
  assert.match(out, /tm-reviewer/)
  assert.match(out, /tm-integrator/)
  assert.match(out, /fixed prefix = \d+% of all cache reads/)
})

// An empty table would read as "this run cost nothing", which is a lie the reader cannot catch.
test('usage exits 1 and names the path when no transcripts exist', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-none-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = dir
    const lines = []
    const code = await runCli(['usage', '--root', FAKE_ROOT], { out: (t) => lines.push(t) })
    assert.equal(code, 1)
    assert.match(lines.join('\n'), /may have changed/)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('usage --json emits the same numbers as the table', async () => {
  const { code, out } = await withCli(
    ({ io }) => runCli(['usage', '--root', FAKE_ROOT, '--json'], io),
    { files: FIXTURE },
  )
  assert.equal(code, 0)
  const report = JSON.parse(out)
  const reviewer = report.agents.find((a) => a.agentType === 'claude-teammates:tm-reviewer')
  assert.equal(reviewer.turns, 2)
  assert.equal(reviewer.cacheRead, 400)
  assert.equal(report.sessionId, 'sess-9')
})

// `--session` was documented in USAGE and registered in KNOWN_FLAGS but no test drove it, so the
// CLI could ignore the flag entirely and the suite stayed green. Two sessions, so selecting one
// means something.
test('usage --session reports on the named session, not the newest', async () => {
  const { code, out } = await withCli(
    ({ io }) => runCli(['usage', '--root', FAKE_ROOT, '--session', 'sess-other', '--json'], io),
    {
      files: FIXTURE,
      other: { 'agent-z.jsonl': line({ cache_read_input_tokens: 7777 }) },
    },
  )
  assert.equal(code, 0)
  const report = JSON.parse(out)
  assert.equal(report.sessionId, 'sess-other')
  assert.equal(report.agents.length, 1, 'only the named session may be read')
  assert.equal(report.agents[0].cacheRead, 7777)
})

// `--session` is joined straight into the store path, so `../` walked out of the projects
// directory and read .jsonl files elsewhere on disk — disclosing the first bytes of one in the
// parse-error line. Refused by name now, the way reviewFileName already refuses a lens.
test('usage --session refuses a value carrying a path separator', async () => {
  const { code, out } = await withCli(
    ({ io }) => runCli(['usage', '--root', FAKE_ROOT, '--session', '../../../outside'], io),
    { files: FIXTURE },
  )
  assert.notEqual(code, 0)
  assert.match(out, /no path separators/)
  assert.doesNotMatch(out, /no transcripts found/, 'refused by name, not by failing to find it')
})
