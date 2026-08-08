import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapNotesHeader, readMapNotesHeader, mapNotesStale, mapNotesPrompt } from '../scripts/mapnotes.mjs'

test('the header names the run and the commit the notes describe', () => {
  assert.equal(mapNotesHeader({ runId: 'r1', sha: 'abc123' }), '<!-- teammates-map run=r1 sha=abc123 -->')
})

test('a header with no run or no sha is refused rather than written incomplete', () => {
  assert.throws(() => mapNotesHeader({ runId: 'r1' }), /sha/)
  assert.throws(() => mapNotesHeader({ sha: 'abc123' }), /run/)
})

test('the header round-trips through the reader', () => {
  const text = `${mapNotesHeader({ runId: 'r1', sha: 'abc123' })}\n\n# Map\n`
  assert.deepEqual(readMapNotesHeader(text), { runId: 'r1', sha: 'abc123' })
})

test('notes written at the current commit are not stale', () => {
  const text = `${mapNotesHeader({ runId: 'r1', sha: 'abc123' })}\nbody\n`
  assert.equal(mapNotesStale(text, { runId: 'r1', sha: 'abc123' }), null)
})

test('notes written at another commit are stale and say which', () => {
  const text = `${mapNotesHeader({ runId: 'r1', sha: 'old111' })}\nbody\n`
  assert.match(mapNotesStale(text, { runId: 'r1', sha: 'new222' }), /old111.*new222/)
})

// Notes with no provenance are the artefact this design refuses to trust everywhere else.
test('notes with no header are stale whatever they contain', () => {
  assert.match(mapNotesStale('# Map\nlots of prose\n', { runId: 'r1', sha: 'abc123' }), /no teammates-map header/)
})

test('missing or empty notes are stale', () => {
  assert.match(mapNotesStale('', { runId: 'r1', sha: 'abc' }), /no map notes/)
  assert.match(mapNotesStale(null, { runId: 'r1', sha: 'abc' }), /no map notes/)
})

test('notes from another run are stale', () => {
  const text = `${mapNotesHeader({ runId: 'other', sha: 'abc123' })}\nbody\n`
  assert.match(mapNotesStale(text, { runId: 'r1', sha: 'abc123' }), /run other/)
})

test('the prompt carries the exact header line, the target path and the refusal to guess', () => {
  const prompt = mapNotesPrompt({ runId: 'r1', sha: 'abc123', notesPath: '.teammates/r1/map.md', topDirectories: ['src', 'test'] })
  assert.match(prompt, /<!-- teammates-map run=r1 sha=abc123 -->/)
  assert.match(prompt, /\.teammates\/r1\/map\.md/)
  assert.match(prompt, /src, test/)
  assert.match(prompt, /Say "unclear"/)
})

test('the prompt omits the directory sentence when there are none', () => {
  assert.doesNotMatch(mapNotesPrompt({ runId: 'r1', sha: 'a', notesPath: 'p' }), /largest directories/)
})

test('non-hex shas like UNKNOWN are accepted and reported in mismatch messages', () => {
  const text = mapNotesHeader({ runId: 'r1', sha: 'UNKNOWN' })
  assert.equal(text, '<!-- teammates-map run=r1 sha=UNKNOWN -->')
  const header = readMapNotesHeader(text)
  assert.equal(header.sha, 'UNKNOWN')
  const staleMessage = mapNotesStale(text, { runId: 'r1', sha: 'HEAD' })
  assert.match(staleMessage, /UNKNOWN.*HEAD/)
})
