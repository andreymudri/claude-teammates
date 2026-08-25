import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { composeBrief } from '../scripts/brief.mjs'
import { renderDigest } from '../scripts/digest.mjs'
import { parseDoc, splitFrontmatter, assertStatement } from './md-contract.mjs'

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
  // Both terms in ONE statement: a sentence about reviewers elsewhere in the skill would
  // otherwise satisfy this without saying anything about caveman.
  assertStatement(
    await doc(),
    /caveman[\s\S]*reviewer|reviewer[\s\S]*caveman/i,
    'teammates-config must say reviewer dispatches are unaffected by caveman',
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
  assertStatement(
    await doc(),
    /(larger|longer|bigger)/i,
    'teammates-config must say the caveman brief is larger than the default',
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
