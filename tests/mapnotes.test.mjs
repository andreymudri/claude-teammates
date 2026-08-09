import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapNotesHeader, readMapNotesHeader, mapNotesStale, mapNotesPrompt, mapNotesWritable } from '../scripts/mapnotes.mjs'

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

test('the prompt tells the agent to return the map and not to write it', () => {
  const prompt = mapNotesPrompt({ runId: 'r1', sha: 'abc123', notesPath: '.teammates/r1/map.md', topDirectories: ['src', 'test'] })
  assert.match(prompt, /<!-- teammates-map run=r1 sha=abc123 -->/)
  assert.match(prompt, /do NOT write it to a file/)
  assert.match(prompt, /the orchestrator writes/)
  assert.match(prompt, /src, test/)
  assert.match(prompt, /Say "unclear"/)
})

// The instruction that made this necessary: an agent told to write is an agent that will shell
// out to do it when it has no Write tool.
test('the prompt never instructs the agent to write the notes file', () => {
  const prompt = mapNotesPrompt({ runId: 'r1', sha: 'abc', notesPath: 'p' })
  assert.doesNotMatch(prompt, /Write a map/i)
})

test('the prompt omits the directory sentence when there are none', () => {
  assert.doesNotMatch(mapNotesPrompt({ runId: 'r1', sha: 'a', notesPath: 'p' }), /largest directories/)
})

test('a header that is not at the start of the text is not accepted as provenance', () => {
  const header = mapNotesHeader({ runId: 'r1', sha: 'old111' })
  const text = `# Map\n\nSome prose\n\n${header}\n`
  assert.equal(readMapNotesHeader(text), null)
  assert.match(mapNotesStale(text, { runId: 'r1', sha: 'new222' }), /no teammates-map header/)
})

test('a header quoted inside the body, not as the real first line, is not accepted', () => {
  const header = mapNotesHeader({ runId: 'r1', sha: 'old111' })
  const text = `# Map\n\nExample header format: ${header}\n`
  assert.equal(readMapNotesHeader(text), null)
})

test('leading whitespace before a real header at the start is still accepted', () => {
  const header = mapNotesHeader({ runId: 'r1', sha: 'abc123' })
  const text = `\n\n  ${header}\nbody\n`
  assert.deepEqual(readMapNotesHeader(text), { runId: 'r1', sha: 'abc123' })
  assert.equal(mapNotesStale(text, { runId: 'r1', sha: 'abc123' }), null)
})

test('a returned map carrying the right header is writable', () => {
  const text = `${mapNotesHeader({ runId: 'r1', sha: 'abc123' })}\n\n# Map\n`
  assert.equal(mapNotesWritable(text, { runId: 'r1', sha: 'abc123' }), null)
})

test('a returned map with no header is refused rather than written', () => {
  assert.match(mapNotesWritable('# Map\nprose\n', { runId: 'r1', sha: 'abc123' }), /does not begin with/)
})

test('a returned map claiming another commit or run is refused', () => {
  const wrongSha = `${mapNotesHeader({ runId: 'r1', sha: 'old111' })}\nbody\n`
  assert.match(mapNotesWritable(wrongSha, { runId: 'r1', sha: 'new222' }), /old111.*new222/)
  const wrongRun = `${mapNotesHeader({ runId: 'other', sha: 'abc' })}\nbody\n`
  assert.match(mapNotesWritable(wrongRun, { runId: 'r1', sha: 'abc' }), /run other/)
})

test('an empty return is refused', () => {
  assert.match(mapNotesWritable('', { runId: 'r1', sha: 'abc' }), /returned nothing/)
})

// The finding this guard exists for: an agent that echoes back only the header line it was
// handed has produced no map at all, yet the header alone used to pass every other check.
test('a return consisting only of the header is refused', () => {
  const text = mapNotesHeader({ runId: 'r1', sha: 'abc' })
  assert.match(mapNotesWritable(text, { runId: 'r1', sha: 'abc' }), /no body/)
})

test('a return of the header plus only whitespace or a blank line is refused', () => {
  const header = mapNotesHeader({ runId: 'r1', sha: 'abc' })
  assert.match(mapNotesWritable(`${header}\n`, { runId: 'r1', sha: 'abc' }), /no body/)
  assert.match(mapNotesWritable(`${header}\n\n   \n`, { runId: 'r1', sha: 'abc' }), /no body/)
})

test('a return of the header plus a real body is accepted, even a short one', () => {
  const header = mapNotesHeader({ runId: 'r1', sha: 'abc' })
  assert.equal(mapNotesWritable(`${header}\nSmall repo, one module: cli.js runs everything.\n`, { runId: 'r1', sha: 'abc' }), null)
})

test('non-hex shas like UNKNOWN are accepted and reported in mismatch messages', () => {
  const text = mapNotesHeader({ runId: 'r1', sha: 'UNKNOWN' })
  assert.equal(text, '<!-- teammates-map run=r1 sha=UNKNOWN -->')
  const header = readMapNotesHeader(text)
  assert.equal(header.sha, 'UNKNOWN')
  const staleMessage = mapNotesStale(text, { runId: 'r1', sha: 'HEAD' })
  assert.match(staleMessage, /UNKNOWN.*HEAD/)
})
