import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bulletSection,
  proseSection,
  parsePlanSections,
  PlanSectionError,
} from '../scripts/plan-sections.mjs'

// The 1-based line of the first line that contains `needle`. Tests assert error line numbers
// against this rather than against a hand-counted constant: a hand-counted line drifts the
// moment anyone edits a fixture above it, and drifts silently.
function lineOf(markdown, needle) {
  const index = markdown.split('\n').findIndex((line) => line.includes(needle))
  assert.notEqual(index, -1, `fixture is missing its anchor: ${needle}`)
  return index + 1
}

const FULL = `# A plan

## Destination

The gate answers PASS or FAIL from git alone,
with no operator in the loop.

## Global Constraints

- Node >= 24.2.0

## Not Yet Specified

- Where does a resolved fog entry go once someone decides it?
- Should \`status\` show open fog too, or is that only a landing concern?

## Out of Scope

- Caching — the destination is the verdict, not latency
- Token usage — worth its own spec

### Task 1: something

**Files:**
- Create: \`scripts/thing.mjs\`
`

test('all three sections are parsed from one document', () => {
  const sections = parsePlanSections(FULL)
  assert.equal(
    sections.destination,
    'The gate answers PASS or FAIL from git alone, with no operator in the loop.',
  )
  assert.deepEqual(
    sections.notYetSpecified.map((entry) => entry.text),
    [
      'Where does a resolved fog entry go once someone decides it?',
      'Should `status` show open fog too, or is that only a landing concern?',
    ],
  )
  assert.deepEqual(
    sections.outOfScope.map((entry) => entry.text),
    [
      'Caching — the destination is the verdict, not latency',
      'Token usage — worth its own spec',
    ],
  )
  assert.equal(
    sections.notYetSpecified[0].line,
    lineOf(FULL, 'Where does a resolved fog entry go'),
  )
  assert.equal(sections.outOfScope[1].line, lineOf(FULL, 'Token usage'))
})

test('no section leaks a task heading or a task file bullet into itself', () => {
  const sections = parsePlanSections(FULL)
  const all = [...sections.notYetSpecified, ...sections.outOfScope].map((e) => e.text)
  for (const text of all) assert.ok(!text.includes('scripts/thing.mjs'), text)
  assert.ok(!sections.destination.includes('Global Constraints'))
})

test('a document with none of the three sections parses to the empty shape', () => {
  const sections = parsePlanSections('# A plan\n\n### Task 1: something\n')
  assert.deepEqual(sections, { destination: null, notYetSpecified: [], outOfScope: [] })
})

test('parsePlanSections tolerates a nullish document', () => {
  assert.deepEqual(parsePlanSections(undefined), {
    destination: null,
    notYetSpecified: [],
    outOfScope: [],
  })
})

test('Destination alone parses, with the other two empty', () => {
  const md = '# A plan\n\n## Destination\n\nSomewhere specific.\n'
  const sections = parsePlanSections(md)
  assert.equal(sections.destination, 'Somewhere specific.')
  assert.deepEqual(sections.notYetSpecified, [])
  assert.deepEqual(sections.outOfScope, [])
})

test('Not Yet Specified alone parses, with no destination and no out of scope', () => {
  const md = '# A plan\n\n## Not Yet Specified\n\n- Which store owns this?\n'
  const sections = parsePlanSections(md)
  assert.equal(sections.destination, null)
  assert.deepEqual(
    sections.notYetSpecified.map((e) => e.text),
    ['Which store owns this?'],
  )
  assert.deepEqual(sections.outOfScope, [])
})

test('Out of Scope alone is refused, because it has no Destination to be beyond', () => {
  const md = '# A plan\n\n## Out of Scope\n\n- Caching — worth its own spec\n'
  assert.ok(md.includes('## Out of Scope'), 'fixture must carry the section it is refused for')
  assert.ok(!md.includes('## Destination'), 'fixture must not carry a destination')
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      assert.ok(error instanceof PlanSectionError)
      assert.equal(error.reason, 'missing-destination')
      assert.equal(error.line, null)
      assert.equal(error.entry, null)
      return true
    },
  )
})

test('Out of Scope with a Destination is accepted', () => {
  const md = '# A plan\n\n## Destination\n\nSomewhere.\n\n## Out of Scope\n\n- Caching — its own spec\n'
  assert.deepEqual(
    parsePlanSections(md).outOfScope.map((e) => e.text),
    ['Caching — its own spec'],
  )
})

const SEPARATORS = [
  ['an em dash', 'Caching — the destination is the verdict'],
  ['an en dash', 'Caching – the destination is the verdict'],
  ['a spaced hyphen', 'Caching - the destination is the verdict'],
  ['a spaced double hyphen', 'Caching -- the destination is the verdict'],
]

for (const [name, entry] of SEPARATORS) {
  test(`a reason clause introduced by ${name} is accepted`, () => {
    const md = `## Destination\n\nSomewhere.\n\n## Out of Scope\n\n- ${entry}\n`
    assert.ok(md.includes(entry), 'fixture must carry the entry under test')
    assert.deepEqual(
      parsePlanSections(md).outOfScope.map((e) => e.text),
      [entry],
    )
  })
}

test('a separator with nothing after it is not a reason clause', () => {
  const md = '## Destination\n\nSomewhere.\n\n## Out of Scope\n\n- Caching —\n'
  assert.ok(md.includes('- Caching —'), 'fixture must carry the malformed entry')
  assert.throws(() => parsePlanSections(md), PlanSectionError)
})

test('a bare noun in Out of Scope is refused, naming its line and quoting it', () => {
  const md = `# A plan

## Destination

Somewhere specific.

## Out of Scope

- Caching — the destination is the verdict, not latency
- Caching
`
  assert.ok(md.split('\n').includes('- Caching'), 'fixture must carry the bare noun')
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      assert.ok(error instanceof PlanSectionError)
      assert.equal(error.reason, 'missing-reason')
      assert.equal(error.entry, 'Caching')
      assert.equal(error.line, md.split('\n').indexOf('- Caching') + 1)
      assert.equal(error.index, 2)
      return true
    },
  )
})

test('a fog entry whose question mark is mid sentence is accepted', () => {
  const entry = 'Where does a resolved entry go? It depends on who decides it.'
  const md = `## Not Yet Specified\n\n- ${entry}\n`
  assert.ok(md.includes(entry), 'fixture must carry the entry under test')
  assert.deepEqual(
    parsePlanSections(md).notYetSpecified.map((e) => e.text),
    [entry],
  )
})

test('a fog entry with no question mark anywhere is refused, naming its line', () => {
  const md = `# A plan

## Not Yet Specified

- Should status show open fog too?
- Rewrite scripts/reviews.mjs
`
  assert.ok(
    md.split('\n').includes('- Rewrite scripts/reviews.mjs'),
    'fixture must carry the work item wearing a note as clothes',
  )
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      assert.ok(error instanceof PlanSectionError)
      assert.equal(error.reason, 'missing-question')
      assert.equal(error.entry, 'Rewrite scripts/reviews.mjs')
      assert.equal(error.line, lineOf(md, 'Rewrite scripts/reviews.mjs'))
      assert.equal(error.index, 2)
      return true
    },
  )
})

test('PlanSectionError is an Error subclass with its own name and own properties', () => {
  const error = new PlanSectionError('a message', { line: 4, entry: 'x', reason: 'missing-reason' })
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'PlanSectionError')
  assert.equal(error.message, 'a message')
  for (const key of ['line', 'entry', 'reason']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(error, key),
      `${key} must be an own property, so a caller can format without re-parsing the message`,
    )
  }
})

test('bulletSection terminates at the next heading of any level', () => {
  const md = `## Out of Scope

- Caching — its own spec

### Task 1: something

**Files:**
- Create: \`scripts/thing.mjs\`
`
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    ['Caching — its own spec'],
  )
})

test('bulletSection joins a wrapped bullet into one entry', () => {
  const md = '## Out of Scope\n\n- Caching — worth its own spec,\n  and a different destination\n'
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    ['Caching — worth its own spec, and a different destination'],
  )
})

test('a wrapped bullet reports the line of its first line', () => {
  const md = '## Out of Scope\n\n- Caching — worth its own spec,\n  and a different destination\n'
  assert.equal(bulletSection(md, 'Out of Scope')[0].line, lineOf(md, '- Caching'))
})

test('a blank line closes a bullet, so a following indented paragraph is not swallowed', () => {
  const md = '## Out of Scope\n\n- Caching — its own spec\n\n  An unrelated indented paragraph.\n'
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    ['Caching — its own spec'],
  )
})

test('a bullet containing U+2028 survives, because the patterns use a negated newline class', () => {
  const entry = 'Caching still one entry — its own spec'
  const md = `## Out of Scope

- ${entry}
`
  assert.ok(md.includes(' '), 'fixture must actually carry the separator under test')
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    [entry],
  )
})

test('bulletSection returns an empty array when the heading is absent', () => {
  assert.deepEqual(bulletSection('# A plan\n', 'Out of Scope'), [])
})

test('a heading with regex metacharacters is matched literally, not as a pattern', () => {
  assert.deepEqual(bulletSection('## Out of Scope\n\n- x\n', 'Out.of.Scope'), [])
})

test('proseSection returns null for an absent heading and collapses whitespace otherwise', () => {
  assert.equal(proseSection('# A plan\n', 'Destination'), null)
  assert.equal(
    proseSection('## Destination\n\nOne line\nand   a second.\n\n## Next\n\ntext\n', 'Destination'),
    'One line and a second.',
  )
})

// The continuation lookahead is `-\s|-$`, not a bare `-` and not nothing at all. Both mutations
// used to leave the whole suite green, so the two tests below are written to go red under each:
// widening the lookahead away lets a bullet-shaped line be swallowed as continuation, and
// narrowing it to `(?!-)` truncates a continuation that merely starts with a hyphen.
test('a continuation starting with `--` joins, and a hyphen-only line does not', () => {
  const md = `## Out of Scope

- Merge flags — the runner passes
  --no-ff so the merge commit survives
  -
- Caching — its own spec
`
  assert.ok(md.includes('\n  --no-ff'), 'fixture must carry the `--` continuation under test')
  assert.ok(md.includes('\n  -\n'), 'fixture must carry the hyphen-only line under test')
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    [
      'Merge flags — the runner passes --no-ff so the merge commit survives',
      'Caching — its own spec',
    ],
  )
})

test('a hyphen followed by whitespace and nothing else is not a continuation either', () => {
  // Written as a single-quoted string with explicit `\n` escapes rather than as a multi-line
  // template literal: the line under test ends in a trailing space, and a trailing space at the
  // end of a real source line is what an editor or a formatter strips without a word. Escaped, it
  // is an ordinary character mid-line, and the assert below fails loudly if it goes anyway.
  const md = '## Out of Scope\n\n- Caching — its own spec\n  - \n'
  assert.ok(md.includes('\n  - \n'), 'fixture must carry the trailing-space hyphen line')
  assert.deepEqual(
    bulletSection(md, 'Out of Scope').map((e) => e.text),
    ['Caching — its own spec'],
  )
})

test('a missing Destination is reported before any malformed entry in the same document', () => {
  const md = `# A plan

## Out of Scope

- Caching

## Not Yet Specified

- A note with no question mark
`
  assert.ok(!md.includes('## Destination'), 'fixture must not carry a destination')
  assert.ok(md.split('\n').includes('- Caching'), 'fixture must also carry a malformed entry')
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      // The document-level defect wins: an entry refusal here would quote `- Caching`, a bullet
      // that is not what is wrong with this plan.
      assert.equal(error.reason, 'missing-destination')
      assert.equal(error.line, null)
      assert.equal(error.entry, null)
      assert.equal(error.index, null)
      return true
    },
  )
})

// The Destination requirement is two decisions — what triggers it, and what satisfies it — and
// each one used to survive its own mutation with the suite green. No fixture elsewhere in this
// file distinguishes the two readings of either half; the two below are written to do nothing
// else.
test('an Out of Scope heading with no bullets under it still requires a Destination', () => {
  const md = `# A plan

## Out of Scope

`
  assert.ok(md.includes('## Out of Scope'), 'fixture must carry the heading under test')
  assert.ok(!md.includes('## Destination'), 'fixture must not carry a destination')
  assert.deepEqual(bulletSection(md, 'Out of Scope'), [], 'fixture section must be empty of bullets')
  // Triggered by the presence of the heading, not by the bullet count: an author who opened the
  // section has declared a boundary exists, and a plan with a boundary needs the destination it
  // is a boundary of. Reading this off `outOfScope.length` would let the empty section through.
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      assert.ok(error instanceof PlanSectionError)
      assert.equal(error.reason, 'missing-destination')
      return true
    },
  )
})

test('a Destination heading with no prose under it does not satisfy the requirement', () => {
  const md = `## Destination

## Out of Scope

- Caching — its own spec
`
  assert.ok(md.includes('## Destination'), 'fixture must carry the empty destination heading')
  assert.equal(
    proseSection(md, 'Destination'),
    '',
    'fixture must produce an empty-string destination, not null',
  )
  // The check is `!destination`, not `destination === null`, so the empty string is refused
  // exactly like an absent heading. What the rule buys is a destination Out of Scope can be
  // judged against; an opened heading with nothing under it buys none of it, and accepting it
  // would let an author satisfy the rule by typing four characters. Weakening this back to
  // `=== null` is what the assert above and the refusal below jointly forbid.
  assert.throws(
    () => parsePlanSections(md),
    (error) => {
      assert.ok(error instanceof PlanSectionError)
      assert.equal(error.reason, 'missing-destination')
      assert.equal(error.line, null)
      assert.equal(error.entry, null)
      return true
    },
  )
})
