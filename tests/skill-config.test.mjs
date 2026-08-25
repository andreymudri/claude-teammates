import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { composeBrief } from '../scripts/brief.mjs'
import { renderDigest } from '../scripts/digest.mjs'
import { CAVEMAN_LEVELS } from '../scripts/config.mjs'
import { parseDoc, splitFrontmatter, assertStatement, assertNoStatement, assertClaim } from './md-contract.mjs'

// WHY THIS FILE EXISTS
// --------------------
// `caveman` was carried for a session as "the largest remaining token lever". Measuring it on
// 2026-08-25 against real subagent transcripts found the opposite, and found that no document
// stated what the knob actually reaches — the README and this skill both listed it beside
// `maxParallel` with a four-level domain and no scope at all.
//
// Every assertion below is paired: one pins the sentence in the skill, one pins the behaviour
// that sentence describes. A claim about code that no test binds to the code is exactly the
// defect the `claims` review lens exists to catch, and documenting a measurement is the easiest
// place in this repository to commit one.

const doc = async () => {
  const text = await readFile(new URL('../skills/teammates-config/SKILL.md', import.meta.url), 'utf8')
  const { body } = splitFrontmatter(text, 'teammates-config')
  return parseDoc(body, 'teammates-config/SKILL.md')
}

// The SECTION that holds the claim, not the whole document. `assertClaim` screens back-references
// across whatever scope it is handed, so passing the document made an innocuous sentence in an
// unrelated section fail the caveman test — with a message about caveman. Both screens belong
// where the claim lives.
const cavemanSection = async () => {
  const parsed = await doc()
  const section = parsed.sections.find((s) => /What .*caveman.* actually reaches/.test(s.title ?? ''))
  assert.ok(section, 'the skill must keep a section stating what caveman reaches')
  return section
}

const task = {
  id: 'T1',
  title: 'a task',
  files: ['a.mjs'],
  branch: 'teammates/r1/T1',
}
const brief = (caveman) => composeBrief({ task, runId: 'r1', planPath: 'p.md', baseBranch: 'main', caveman })

// WHY THIS IS A SNAPSHOT AND NOT A PATTERN.
//
// This claim has now been defeated FIVE times, and every fix opened the next hole: co-occurrence
// matching; one sentence satisfying the claim while stating its inverse; the inverse appended to
// the claim sentence, which `assertClaim` exempts by construction; a heading, which `parseDoc`
// never turns into a statement; the inverse appended to an allow-listed sentence; an inversion in
// another section once the claim was scoped to its own; a sentence naming neither "reviewer" nor
// "caveman" ("the grading lenses ... do receive the level in full"); and — the round-four
// instrument defeating itself — an aside spliced INSIDE the claim sentence, through the `[^.]*`
// in the exact-shape regex, which both inventory screens then skip because it IS the claim.
//
// The lesson is structural, not a matter of a better regex. A word-matcher over prose can only
// forbid the phrasings its author imagined, and prose has unbounded ways to say the opposite. So
// the section that carries the claim is pinned EXACTLY. Any edit to it fails this test, which is
// the point: the measurement it records is load-bearing, and changing it should be a deliberate
// act that updates this fixture in the same commit.
const CAVEMAN_SECTION = "## What `caveman` actually reaches\n\nMeasured 2026-08-25 against real subagent transcripts. `caveman` is a much narrower knob than its\nposition beside `maxParallel` suggests, and the measurement contradicts the name, so state its\nscope rather than letting an operator infer it.\n\n`caveman` has exactly two consumers: it rewrites the **implementer** brief, and it renders the\nlocal `digest` output terse. Reviewer and integrator dispatches carry no caveman path at all, so the\nreviewers \u2014 the largest emitters in a run \u2014 are unaffected by any value you set.\n\nWithin the implementer brief its instruction is scoped to the returned summary and blockers, not\nto intermediate turns. That summary is the last message an agent emits, so it is re-read zero\ntimes by the agent that wrote it.\n\nThe caveman brief is **larger** than the default, by about 3%. Compressing the connective prose\nsaves less than the added STYLE block costs, and a brief sits in the agent's prefix, so that cost\nis re-read on every turn.\n\nThe three levels are validated but not honoured by this plugin's own code: `digest` reads only\nwhether the value is truthy, and the brief passes the level through to an external\n`caveman:caveman` skill, telling the agent to apply the style directly when that skill is absent.\n\nReach for `agents.<role>.effort` instead when a run's output cost is the problem. Thinking is\n72-76% of an agent's output tokens, `effort` is the control for thinking, and no style\ninstruction can touch it. Lowering it is a real quality trade-off, so raise it with the operator\nrather than setting it quietly.\n"

test('the caveman section is exactly what was measured', async () => {
  const text = await readFile(new URL('../skills/teammates-config/SKILL.md', import.meta.url), 'utf8')
  const i = text.indexOf('## What `caveman` actually reaches')
  assert.notEqual(i, -1, 'the skill must keep a section stating what caveman reaches')
  assert.equal(text.indexOf('## What `caveman` actually reaches', i + 1), -1,
    'exactly one such section: a duplicate-titled decoy would absorb every assertion below')
  const j = text.indexOf('\n## ', i + 10)
  assert.equal(text.slice(i, j === -1 ? undefined : j), CAVEMAN_SECTION,
    'the caveman section changed; if the measurement changed, update CAVEMAN_SECTION deliberately')
})

// The section is pinned, so the remaining surface is every OTHER mention of caveman in the skill —
// including headings, code blocks and the frontmatter, none of which `parseDoc` turns into a
// statement, and each of which carried a working escape. Every such site is inventoried by hand.
test('every mention of caveman outside the pinned section is accounted for', async () => {
  const text = await readFile(new URL('../skills/teammates-config/SKILL.md', import.meta.url), 'utf8')
  const i = text.indexOf('## What `caveman` actually reaches')
  const j = text.indexOf('\n## ', i + 10)
  const outside = text.slice(0, i) + (j === -1 ? '' : text.slice(j))
  const lines = outside.split('\n').filter((l) => /caveman/i.test(l))
  const ALLOWED = [
    /^`config` manages the \*\*ergonomics\*\* keys only: `maxParallel`, `caveman`, and$/,
    /^\s*caveman: false \| lite \| full \| ultra$/,
    /^- `caveman` — `false`, or one of `lite`, `full`, `ultra`\. See below for what it reaches\.$/,
  ]
  const strays = lines.filter((l) => !ALLOWED.some((a) => a.test(l.trim())))
  assert.deepEqual(strays, [],
    'a mention of caveman outside the pinned section is unreviewed; add it here deliberately')
})


test('caveman never reaches a reviewer dispatch', async () => {
  const source = await readFile(new URL('../scripts/review-gen.mjs', import.meta.url), 'utf8')
  assert.ok(
    !/caveman/i.test(source),
    'review-gen.mjs must carry no caveman path; the skill claims reviewers are unaffected',
  )
})

test('the skill states that the terse brief is larger, not smaller', async () => {
  // Named subject, not a bare comparative. `/(larger|longer|bigger)/i` matched any unrelated
  // sentence in the skill — "no longer" alone satisfied it — so the claim this test exists to
  // pin could be deleted outright and the suite stayed green. Found by mutation.
  assertStatement(
    await doc(),
    /caveman brief[\s\S]*\blarger\b[\s\S]*than the default/i,
    'teammates-config must say the caveman brief is larger than the default',
  )
  assertNoStatement(
    await doc(),
    /caveman[\s\S]*brief[\s\S]*\b(smaller|shorter|terser|briefer)\b/i,
    'teammates-config must not claim the caveman brief is smaller',
  )
})

test('the caveman brief is in fact larger than the default brief', () => {
  // The claim above is only worth making because the arithmetic runs the other way from the
  // name. The STYLE block costs more than the compressed connective prose saves, and a brief
  // sits in the agent's prefix, so that cost is re-read on every turn.
  assert.ok(
    brief('full').length > brief(false).length,
    'expected the caveman brief to be longer than the default brief',
  )
})

test('the digest renderer ignores the caveman level and reads only its truthiness', () => {
  const status = {
    runId: 'r1',
    phase: 1,
    totalPhases: 2,
    maxParallel: 4,
    tasks: [{ id: 'T1', title: 'a task', state: 'running', startedAt: 1000 }],
  }
  const now = 61000
  const lite = renderDigest(status, now, 'lite')
  const ultra = renderDigest(status, now, 'ultra')
  assert.equal(lite, ultra, 'lite and ultra must render identically; the level is not honoured')
  assert.notEqual(lite, renderDigest(status, now, false), 'a truthy level must still change the digest')
})

test('the skill states that effort, not caveman, is the control for thinking', async () => {
  assertStatement(
    await doc(),
    /effort[\s\S]*thinking/i,
    'teammates-config must name effort as the control for thinking tokens',
  )
})

// The skill said "The four levels are validated" while CAVEMAN_LEVELS has three. Nothing bound the
// prose to the constant, so the count could drift in either direction unnoticed — and a document
// whose whole purpose is to state a measured scope had the wrong number in it.
test('the skill states the level count the code actually validates', async () => {
  assert.equal(CAVEMAN_LEVELS.length, 3, 'the fixture below names three; update both together')
  assertStatement(
    await doc(),
    /three levels[\s\S]*validated/i,
    'teammates-config must state the same level count CAVEMAN_LEVELS defines',
  )
  assertNoStatement(
    await doc(),
    /\b(two|four|five)\s+levels\b/i,
    'teammates-config must not name a level count the code does not validate',
  )
})

// The skill was bound to CAVEMAN_LEVELS; the README and CHANGELOG carry the same sentence and were
// NOT — mutating either back to "four levels" left the suite green while a followups doc claimed
// the two "cannot drift apart again in either direction". Bound here, so the claim is true.
test('the README and CHANGELOG state the level count the code validates', async () => {
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six']
  const correct = WORDS[CAVEMAN_LEVELS.length]
  // The wrong spellings are derived by EXCLUDING the right one, not hard-coded. A fixed list of
  // `(two|four|five)` contradicted the assertion above it for any count in that list — the two
  // could never both hold — so the test was unsatisfiable the moment CAVEMAN_LEVELS changed to one
  // of them, which is precisely when it needed to work.
  const wrong = WORDS.filter((w) => w !== correct).join('|')
  // README ONLY. CHANGELOG.md is a record of what a release said, so binding it to the LIVE
  // constant would make a future level change fail a test about a shipped version — history
  // rewritten to keep a test green. Its entry is checked against a fixed spelling below instead:
  // it was wrong when written, which is a different fault from drifting later.
  for (const file of ['../README.md']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8')
    // NO `continue` guard. Skipping when the sentence is absent let the binding evaporate on the
    // exact reword it exists to catch: delete the claim and the file stops being checked at all.
    assert.match(text, new RegExp(`${correct} levels are validated`, 'i'),
      `${file} must name the same level count CAVEMAN_LEVELS defines`)
    assert.doesNotMatch(text, new RegExp(`\\b(${wrong}) levels are validated`, 'i'),
      `${file} names a level count the code does not validate`)
  }

  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.match(changelog, /three levels are validated/i,
    'the CHANGELOG entry stated four when the code validated three; it is corrected, not bound')
})

// The scoping is the point, so it is pinned: prose elsewhere in the skill must not fail the test
// that speaks for the caveman section. Without this, an editor adding an unrelated paragraph gets
// a caveman-scope failure and learns to distrust the assertion.
test('prose in an unrelated section does not fail the caveman claim', async () => {
  const text = await readFile(new URL('../skills/teammates-config/SKILL.md', import.meta.url), 'utf8')
  const { body } = splitFrontmatter(text, 'teammates-config')
  const edited = `${body}\n\n## Troubleshooting\n\nThe above requirement applies to every layer.\n`
  const parsed = parseDoc(edited, 'teammates-config/SKILL.md (edited)')
  const section = parsed.sections.find((s) => /What .*caveman.* actually reaches/.test(s.title ?? ''))
  assertClaim(section, {
    label: 'reviewers are unaffected by caveman',
    claim: /Reviewer and integrator dispatches carry no caveman path at all/,
    subject: /reviewer/i,
    allow: [/enforcement key never goes in the local file/, /a well-shaped value passes silently/],
  })
})
