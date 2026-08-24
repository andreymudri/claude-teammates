import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runCli } from '../scripts/cli.mjs'
import { projectSlug } from '../scripts/usage.mjs'

const FAKE_ROOT = path.resolve('/fake/cli-project')
const line = (over) => JSON.stringify({ message: { usage: { cache_read_input_tokens: 0, output_tokens: 0, ...over } } })

// The fixture store is injected through CLAUDE_CONFIG_DIR so no test reads the developer's real
// transcripts, and the variable is restored afterwards whatever happens.
async function withCli(fn, { files }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-cli-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    const subagents = path.join(dir, 'projects', projectSlug(FAKE_ROOT), 'sess-9', 'subagents')
    await mkdir(subagents, { recursive: true })
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(subagents, name), body, 'utf8')
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
