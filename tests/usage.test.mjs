import { test } from 'node:test'
import assert from 'node:assert/strict'

import { projectSlug, summarizeTranscript, renderUsage } from '../scripts/usage.mjs'

const usageRecord = (over = {}) => ({
  message: {
    usage: {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...over,
    },
  },
})

// The colon matters as much as the separators: every absolute Windows path carries a drive
// letter, and a colon cannot appear in a Windows filename, so a slug that kept it would name a
// directory that can never exist.
test('projectSlug replaces both separator kinds and the drive colon', () => {
  assert.equal(projectSlug('/home/u/p'), '-home-u-p')
  assert.equal(projectSlug('C:\\Users\\u\\p'), 'C--Users-u-p')
  assert.doesNotMatch(projectSlug('D:\\a\\b'), /:/, 'a slug with a colon is not a legal Windows directory name')
})

test('summarizeTranscript sums every usage category', () => {
  const t = summarizeTranscript([
    usageRecord({ input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }),
    usageRecord({ input_tokens: 2, output_tokens: 20, cache_read_input_tokens: 200 }),
    usageRecord({ input_tokens: 3, output_tokens: 30, cache_read_input_tokens: 300 }),
  ])
  assert.equal(t.turns, 3)
  assert.equal(t.input, 6)
  assert.equal(t.output, 60)
  assert.equal(t.cacheRead, 600)
  assert.equal(t.cacheWrite, 5)
})

// The minimum cannot be inflated by ordering or by a retried first turn. Both arrays below hold
// the same contexts; only the order differs, so a first-message implementation passes one and
// fails the other.
test('prefix is the minimum context, not the first message\'s', () => {
  const ctx = (n) => usageRecord({ cache_read_input_tokens: n })
  assert.equal(summarizeTranscript([ctx(900), ctx(400), ctx(700)]).prefix, 400)
  assert.equal(summarizeTranscript([ctx(400), ctx(700), ctx(900)]).prefix, 400)
})

test('records without usage are ignored, not counted as turns', () => {
  const t = summarizeTranscript([usageRecord({ input_tokens: 1 }), { type: 'system' }, { message: {} }])
  assert.equal(t.turns, 1)
})

test('renderUsage reports the prefix share of cache reads', () => {
  const out = renderUsage({
    sessionId: 'sess-1',
    agents: [
      { agentType: 'tm-reviewer', model: 'opus', turns: 10, prefix: 100, cacheRead: 2000, output: 50 },
      { agentType: 'tm-integrator', model: 'sonnet', turns: 2, prefix: 500, cacheRead: 2000, output: 5 },
    ],
    unreadable: [],
  })
  assert.match(out, /fixed prefix = 50% of all cache reads/)
  assert.match(out, /tm-reviewer/)
  assert.match(out, /tm-integrator/)
  assert.match(out, /2,000/, 'numbers must carry thousands separators')
})

test('renderUsage does not divide by zero when nothing was cached', () => {
  const out = renderUsage({
    sessionId: 'sess-1',
    agents: [{ agentType: 'tm-reviewer', model: 'opus', turns: 1, prefix: 10, cacheRead: 0, output: 1 }],
    unreadable: [],
  })
  assert.match(out, /n\/a/)
  assert.doesNotMatch(out, /NaN|Infinity/)
})

// Silently skipping a transcript understates a total, and an understated total is how this tool
// would appear to prove a saving nobody made.
test('renderUsage names every unreadable transcript and counts them', () => {
  const out = renderUsage({
    sessionId: 'sess-1',
    agents: [{ agentType: 'tm-reviewer', model: 'opus', turns: 1, prefix: 10, cacheRead: 20, output: 1 }],
    unreadable: [{ name: 'agent-x.jsonl', reason: 'Unexpected end of JSON input' }],
  })
  assert.match(out, /agent-x\.jsonl/)
  assert.match(out, /Unexpected end of JSON input/)
  assert.match(out, /1 transcript\(s\) unreadable/)
})

// A fixture WIDER than its column, so the truncation branch actually runs. The old fixture was
// `claude-teammates:tm-integrator` — 30 characters against a 32-wide column — so `padEnd` alone
// satisfied every assertion and deleting the truncation entirely left the suite green. Found by
// mutation; the comment claimed the opposite of what the fixture did.
test('renderUsage truncates an agentType wider than its column', () => {
  const long = 'claude-teammates:tm-implementer-with-a-very-long-suffix'
  const out = renderUsage({
    sessionId: 's',
    agents: [{ agentType: long, model: 'sonnet', turns: 1, prefix: 1, cacheRead: 1, output: 1 }],
    unreadable: [],
  })
  const row = out.split('\n').find((l) => l.includes('claude-teammates:tm-impl'))
  assert.ok(row, 'the row must be present')
  assert.ok(row.length < long.length + 40, 'the oversized cell must be truncated, not printed whole')
  assert.match(row, /…/, 'a truncated cell is marked, so the reader can see it was cut')
  assert.match(row, /sonnet/, 'the model must still be present')
  assert.doesNotMatch(row, /suffix/, 'the tail of an oversized cell must not survive into the row')
})

// A partially-parsed transcript still produced its row, so counting it under "unreadable" states
// the opposite of what happened — and this is the one line a reader takes the totals'
// trustworthiness from. The two cases are counted separately.
test('renderUsage distinguishes a dropped line from an unreadable transcript', () => {
  const out = renderUsage({
    sessionId: 'sess-1',
    agents: [{ agentType: 'tm-reviewer', model: 'opus', turns: 2, prefix: 10, cacheRead: 20, output: 1 }],
    unreadable: [
      { name: 'agent-torn.jsonl', reason: '1 of 3 line(s) did not parse', dropped: 1, kept: 2 },
      { name: 'agent-dead.jsonl', reason: 'could not be read', dropped: 0, kept: 0 },
    ],
  })
  assert.match(out, /1 transcript\(s\) unreadable/, 'only the transcript with no records is unreadable')
  assert.match(out, /1 transcript\(s\) with dropped lines/, 'the partial one is counted apart')
})

// The headline number of a token report is not a value to truncate. `fit` applied its rule to
// numeric cells too, so a cache_rd of 1,000,000,000 rendered as `1,000,000,…` in a 12-wide
// column — and a long fleet run reaches 10^9 comfortably. Numeric columns widen instead.
// COLUMN ALIGNMENT, not just the digits. `padStart` alone keeps every digit, so an assertion that
// only checks the number survives `return width` — the entire widening block was dead weight to
// the suite. What widening actually buys is that the rows still line up, which needs two agents of
// different magnitudes and a header and TOTAL row measured against them.
test('renderUsage widens a numeric column so every row still lines up', () => {
  const out = renderUsage({
    sessionId: 's',
    agents: [
      { agentType: 'tm-a', model: 'opus', turns: 1, prefix: 1, cacheRead: 121_000_000_000, output: 1 },
      { agentType: 'tm-b', model: 'opus', turns: 1, prefix: 1, cacheRead: 12_000_000_000, output: 1 },
    ],
    unreadable: [],
  })
  const rows = out.split('\n').filter((l) => /tm-a|tm-b|agentType|TOTAL|^─+$/.test(l))
  assert.equal(rows.length, 5, 'header, two agent rows, separator and TOTAL')
  const widths = new Set(rows.map((r) => [...r].length))
  assert.equal(widths.size, 1, `rows must share one width, got ${[...widths].join(', ')}`)
  // Ungrouped digits mean two cells collided: `121,000,000,00012,000,000,000` is what a fixed
  // width produced.
  assert.doesNotMatch(out, /\d{4,}/, 'a numeric cell ran into its neighbour')
})

test('renderUsage never truncates a numeric cell', () => {
  const out = renderUsage({
    sessionId: 's',
    agents: [{ agentType: 'tm-reviewer', model: 'opus', turns: 1, prefix: 1, cacheRead: 1_000_000_000, output: 1 }],
    unreadable: [],
  })
  assert.match(out, /1,000,000,000/, 'the full number must survive')
  assert.doesNotMatch(out, /1,000,000,…|1,000,00…/, 'a token count must never be shown truncated')
})

// Every other render module in scripts/ neutralises what it prints; this one had no printable()
// call at all. `fit` pads by String.length, so a literal newline counts as one character — a
// crafted meta.json needed no escape sequence to draw an extra line that reads like real output.
test('renderUsage neutralises control bytes in values read from disk', () => {
  const out = renderUsage({
    sessionId: 'sess\u001b[2K\u001b[G forged',
    agents: [{ agentType: 'x\nTOTAL 0 0 0', model: 'opus\u2028', turns: 1, prefix: 1, cacheRead: 1, output: 1 }],
    unreadable: [{ name: 'agent-a\u001b[2K.jsonl', reason: 'r\u0085x', dropped: 1, kept: 1 }],
  })
  assert.doesNotMatch(out, /\u001b|\u2028|\u0085/, 'no raw control byte may reach the terminal')
  // One line per row. A newline inside a cell must not open a line of its own — `fit` pads by
  // String.length, so it counted as a single character and the forged line looked like output
  // this CLI printed. Compared against a benign render rather than by counting a substring: the
  // genuine TOTAL row contains the same word the payload does.
  const benign = renderUsage({
    sessionId: 's',
    agents: [{ agentType: 'x', model: 'opus', turns: 1, prefix: 1, cacheRead: 1, output: 1 }],
    unreadable: [{ name: 'agent-a.jsonl', reason: 'r', dropped: 1, kept: 1 }],
  })
  assert.equal(out.split('\n').length, benign.split('\n').length, 'a newline in a cell forged a row')
})
