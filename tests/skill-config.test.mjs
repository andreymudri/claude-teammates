import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { composeBrief } from '../scripts/brief.mjs'
import { renderDigest } from '../scripts/digest.mjs'
import { CAVEMAN_LEVELS } from '../scripts/config.mjs'
import { parseDoc, splitFrontmatter, assertStatement, assertNoStatement } from './md-contract.mjs'

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
  // Polarity, not co-occurrence. Requiring only that both terms appear in one statement let the
  // sentence be rewritten to its exact opposite — "Reviewer dispatches also apply caveman, so the
  // reviewers obey any value you set" — with the suite green. Found by mutation.
  assertStatement(
    await doc(),
    /reviewer[\s\S]*(no caveman path|unaffected)/i,
    'teammates-config must say reviewer dispatches are unaffected by caveman',
  )
  // And the inversion is refused outright, so a future edit cannot satisfy the assertion above in
  // one sentence while asserting the opposite in another.
  assertNoStatement(
    await doc(),
    /reviewer[\s\S]*\b(obeys?|apply|applies|receives?|honou?rs?)\b[\s\S]*caveman|caveman[\s\S]*reviewer[\s\S]*\b(obeys?|applies|honou?rs)\b/i,
    'teammates-config must not claim reviewers apply caveman',
  )
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
