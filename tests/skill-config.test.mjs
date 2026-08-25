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

const task = {
  id: 'T1',
  title: 'a task',
  files: ['a.mjs'],
  branch: 'teammates/r1/T1',
}
const brief = (caveman) => composeBrief({ task, runId: 'r1', planPath: 'p.md', baseBranch: 'main', caveman })

test('the skill states that caveman reaches only implementer briefs and the local digest', async () => {
  assertStatement(
    await doc(),
    /caveman[\s\S]*implementer/i,
    'teammates-config must say caveman reaches implementer briefs',
  )
  // An INVENTORY LOCK, not a pattern match. Two rounds of tightening regexes both failed the same
  // way: a reviewer wrote one sentence that satisfied the required claim AND stated its inverse
  // ("carry no caveman path in the `digest`, but the reviewer brief does carry whatever level you
  // set"), because a forbid-list can only ever name the phrasings someone already thought of.
  // `assertClaim`'s `subject` inverts that: EVERY statement in the document mentioning reviewers
  // must be the claim itself or explicitly allowed here, so a new sentence about reviewers fails
  // whatever words it uses. Adding one is then a deliberate act with a test to update.
  assertClaim(await doc(), {
    label: 'reviewers are unaffected by caveman',
    claim: /Reviewer and integrator dispatches carry no caveman path at all/,
    subject: /reviewer/i,
    allow: [
      // Not about caveman: the enforcement-key rule happens to name `agents.reviewer.*`.
      /enforcement key never goes in the local file/,
      /a well-shaped value passes silently/,
    ],
  })
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
