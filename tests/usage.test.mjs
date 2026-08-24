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

test('projectSlug replaces both separator kinds', () => {
  assert.equal(projectSlug('/home/u/p'), '-home-u-p')
  assert.equal(projectSlug('C:\\Users\\u\\p'), 'C:-Users-u-p')
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

// A fully-qualified agent type is 30 characters. Padding alone let it run into the model column,
// so the table became unreadable in exactly the case it is used for.
test('renderUsage keeps columns apart when an agentType is long', () => {
  const out = renderUsage({
    sessionId: 's',
    agents: [{ agentType: 'claude-teammates:tm-integrator', model: 'sonnet', turns: 1, prefix: 1, cacheRead: 1, output: 1 }],
    unreadable: [],
  })
  const row = out.split('\n').find((l) => l.includes('tm-integrator'))
  assert.ok(row.includes(' sonnet') || row.includes('sonnet'), 'the model must still be present')
  assert.doesNotMatch(row, /integratorsonnet/, 'the agentType column ran into the model column')
})
