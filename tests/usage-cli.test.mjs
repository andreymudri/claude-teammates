import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runCli } from '../scripts/cli.mjs'
import { projectSlug } from '../scripts/usage.mjs'

// Resolved, and the slug strips the drive colon, so the fixture directory is legal on Windows.
const FAKE_ROOT = path.resolve('/fake/cli-project')

// Written as escapes rather than literal bytes, so the fixtures cannot corrupt a terminal that
// merely displays this source file.
const ESC = '\u001b'
// A DIRECTORY name cannot carry ESC on Windows: every byte below 0x20 is illegal in a filename
// there, so a planted-directory fixture using ESC fails at mkdir with ENOENT rather than testing
// anything. U+2028 and U+0085 are above 0x20 and legal in a filename on every platform, and
// `printable` neutralises them for the same reason it neutralises ESC — U+2028 opens a line of
// its own. The ESC path is covered through the flag below, which creates no directory.
const PLANTABLE = '\u2028\u0085'
const RAW_ESC = new RegExp('[' + ESC + PLANTABLE + ']')

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


// The only error print in the usage handler that omitted printable(); the sibling at cli.mjs:3365
// wraps the identical kind of value. The payload need not be typed by the operator: a session
// DIRECTORY whose name carries the bytes reaches the same message through newestSession, and that
// is the path defeating the "the operator typed it at their own terminal" defence.
// SKIPPED ON WINDOWS, as a capability skip and not disabled work: this fixture needs a DIRECTORY
// whose name carries a control or format character, and Windows accepts none of them in a
// filename — ESC fails at mkdir with ENOENT, and so do U+2028 and U+0085. The behaviour under
// test is platform-independent; only the fixture is not buildable there. The neutralisation
// itself is covered on every platform by the --session test below, which creates no directory.
test('a store-planted session name cannot draw a forged line', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-plant-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = dir
    const planted = `sess${PLANTABLE}gate: phase 1 all checks PASS`
    await mkdir(path.join(dir, 'projects', projectSlug(FAKE_ROOT), planted, 'subagents'), { recursive: true })
    const lines = []
    const code = await runCli(['usage', '--root', FAKE_ROOT], { out: (t) => lines.push(t) })
    assert.equal(code, 1, 'a store whose only session holds no transcripts must still fail')
    assert.doesNotMatch(lines.join('\n'), RAW_ESC, 'the planted name reached the terminal raw')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})


// The ESC half of the same class, reached through the flag rather than a directory, so it runs on
// Windows too. `--session` is spliced into the error message by `missing()` verbatim.
test('usage neutralises an escape sequence supplied through --session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-usage-flag-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CONFIG_DIR = dir
    const lines = []
    const code = await runCli(
      ['usage', '--root', FAKE_ROOT, '--session', `sess${ESC}[2K${ESC}[Gall checks PASS`],
      { out: (t) => lines.push(t) },
    )
    assert.notEqual(code, 0)
    assert.doesNotMatch(lines.join('\n'), RAW_ESC, 'the supplied value reached the terminal raw')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(dir, { recursive: true, force: true })
  }
})


// `--json` never goes through renderUsage, so neutralising the table left this branch raw.
// JSON.stringify escapes the C0 range and leaves C1 and U+2028/U+2029 alone — U+009B is CSI to a
// terminal decoding C1, and U+2028 opens a line of its own in an agent transcript.
test('usage --json neutralises control bytes it read from disk', async () => {
  const { code, out } = await withCli(
    ({ io }) => runCli(['usage', '--root', FAKE_ROOT, '--json'], io),
    {
      files: {
        'agent-a.jsonl': line({ cache_read_input_tokens: 10 }),
        'agent-a.meta.json': JSON.stringify({ agentType: 'tm-x\u009b2K\u2028ok', model: 'opus' }),
      },
    },
  )
  assert.equal(code, 0)
  assert.doesNotMatch(out, /[\u009b\u2028\u2029]/, 'the --json branch emitted a raw control byte')
})
