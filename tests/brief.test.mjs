import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeBrief } from '../scripts/brief.mjs'

const TASK = {
  id: 'T4',
  title: 'the SubagentStop handler',
  files: ['hooks/subagent-stop.mjs', 'tests/hook.test.mjs'],
  branch: 'teammates/substop/T4',
}

const FULL = {
  task: TASK,
  runId: 'substop',
  planPath: 'docs/plans/2026-08-13-subagent-stop-enforcement.md',
  baseBranch: 'master',
  constraints: ['Node >= 24.2.0', 'Zero new runtime dependencies'],
}

// Ordering assertions read positions off the rendered text rather than a line index, so a
// section that moves between blocks is caught even when its own line is unchanged.
const at = (brief, needle) => {
  const i = brief.indexOf(needle)
  assert.notEqual(i, -1, `expected the brief to contain ${JSON.stringify(needle)}`)
  return i
}

test('a fully supplied brief carries the checkout, baseline, plan, files and constraints', () => {
  const brief = composeBrief(FULL)
  assert.ok(brief.includes('git checkout -B teammates/substop/T4 master'))
  assert.ok(brief.includes('IN THE FOREGROUND'))
  assert.ok(brief.includes('docs/plans/2026-08-13-subagent-stop-enforcement.md'))
  assert.ok(brief.includes('You may create or modify ONLY these files:'))
  for (const f of TASK.files) assert.ok(brief.includes(f), `missing declared file ${f}`)
  for (const c of FULL.constraints) assert.ok(brief.includes('- ' + c), `missing constraint ${c}`)
})

test('the plan section names the task section by its bare number', () => {
  const brief = composeBrief(FULL)
  assert.ok(brief.includes('the section titled "Task 4:"'))
})

test('the locate command carries the real ids and is rendered before BASELINE', () => {
  const brief = composeBrief(FULL)
  const locate = 'cli.mjs" locate --run substop --task T4'
  assert.ok(brief.includes(locate), 'locate command missing or ids not substituted')
  assert.ok(at(brief, locate) < at(brief, 'BASELINE.'),
    'the location record must be written before the baseline work, not after it')
})

test('the locate line is rendered after the checkout it follows', () => {
  const brief = composeBrief(FULL)
  assert.ok(at(brief, 'git checkout -B ') < at(brief, 'locate --run substop'))
})

test('the complete command carries run, task and plan and sits after the constraints', () => {
  const brief = composeBrief(FULL)
  assert.ok(brief.includes('cli.mjs" complete'), 'complete command missing')
  assert.ok(brief.includes('--run substop --task T4 --plan ' + FULL.planPath),
    'complete command does not substitute run id, task id and plan path')
  assert.ok(at(brief, 'GLOBAL CONSTRAINTS:') < at(brief, 'cli.mjs" complete'),
    'self-verification must follow the constraints section')
  assert.ok(at(brief, 'cli.mjs" complete') < at(brief, 'Commit your work on'),
    'self-verification must precede the final commit instruction')
})

test('with no run id neither the locate nor the verify section is rendered', () => {
  const brief = composeBrief({ ...FULL, runId: '' })
  assert.ok(!brief.includes('locate --run'), 'locate section rendered without a run id')
  assert.ok(!brief.includes('cli.mjs" complete'), 'verify section rendered without a run id')
  assert.ok(!brief.includes('--run  '), 'a command was emitted with an empty --run value')
  assert.ok(!/--run\s*$/m.test(brief), 'a command was emitted with a trailing empty --run value')
})

test('with no plan path the verify section is dropped rather than emitting an empty --plan', () => {
  const brief = composeBrief({ ...FULL, planPath: '' })
  assert.ok(!brief.includes('cli.mjs" complete'), 'verify section rendered without a plan path')
  assert.ok(!brief.includes('--plan '), 'a complete command was emitted with an empty plan path')
  assert.ok(brief.includes('locate --run substop --task T4'),
    'the locate section does not depend on the plan path')
})

test('with no base branch the brief refuses to name a starting commit', () => {
  const brief = composeBrief({ ...FULL, baseBranch: '' })
  assert.ok(brief.includes('No base branch was supplied'))
  assert.ok(!brief.includes('git checkout -B teammates/substop/T4 '),
    'the no-base variant must not emit a checkout with a start point')
  assert.ok(brief.includes('report status "blocked"'))
})

test('with no constraints the GLOBAL CONSTRAINTS header is not rendered', () => {
  const brief = composeBrief({ ...FULL, constraints: [] })
  assert.ok(!brief.includes('GLOBAL CONSTRAINTS:'))
  assert.ok(brief.includes('cli.mjs" complete'), 'the verify section survives an empty constraint list')
})

test('a blast radius renders every neighbour with its percentage', () => {
  const brief = composeBrief({
    ...FULL,
    task: { ...TASK, neighbours: [{ path: 'scripts/cli.mjs', confidence: 0.82 }, { path: 'scripts/state.mjs', confidence: 0.4 }] },
  })
  assert.ok(brief.includes('BLAST RADIUS.'))
  assert.ok(brief.includes('82%  scripts/cli.mjs'))
  assert.ok(brief.includes('40%  scripts/state.mjs'))
})

test('a task with no neighbours renders no blast radius and no undefined', () => {
  const brief = composeBrief(FULL)
  assert.ok(!brief.includes('BLAST RADIUS.'))
  assert.ok(!brief.includes('undefined'))
})

test('the caveman variant keeps every load-bearing instruction', () => {
  const brief = composeBrief({ ...FULL, caveman: 'full' })
  assert.ok(brief.includes('git checkout -B teammates/substop/T4 master'))
  assert.ok(brief.includes('locate --run substop --task T4'))
  assert.ok(brief.includes('cli.mjs" complete'))
  assert.ok(brief.includes('--run substop --task T4 --plan ' + FULL.planPath))
  assert.ok(brief.includes('IN THE FOREGROUND'))
  assert.ok(brief.includes(FULL.planPath))
  for (const f of TASK.files) assert.ok(brief.includes(f), `missing declared file ${f}`)
  assert.ok(brief.includes('level full'), 'the caveman level is not substituted')
})

test('the caveman variant keeps the locate before BASELINE and complete before the commit line', () => {
  const brief = composeBrief({ ...FULL, caveman: 'full' })
  assert.ok(at(brief, 'locate --run substop') < at(brief, 'BASELINE.'))
  assert.ok(at(brief, 'cli.mjs" complete') < at(brief, 'Commit your work on'))
})

test('the caveman variant drops the same sections when inputs are omitted', () => {
  const brief = composeBrief({ task: TASK, caveman: 'full' })
  assert.ok(!brief.includes('locate --run'))
  assert.ok(!brief.includes('cli.mjs" complete'))
  assert.ok(!brief.includes('--run  '))
  assert.ok(brief.includes('No base branch was supplied'))
})

test('composeBrief throws when task.id is missing', () => {
  assert.throws(() => composeBrief({ task: { files: [], branch: 'b' } }), /task\.id is required/)
  assert.throws(() => composeBrief({}), /task\.id is required/)
})

test('composeBrief throws when task.files is not an array', () => {
  assert.throws(
    () => composeBrief({ task: { id: 'T1', files: 'a,b', branch: 'b' } }),
    /T1 has no files array/,
  )
})

test('composeBrief throws when task.branch is empty', () => {
  assert.throws(
    () => composeBrief({ task: { id: 'T1', files: [], branch: '' } }),
    /T1 has no branch/,
  )
})

test('no rendered line is empty of content yet claims a value it does not have', () => {
  const brief = composeBrief(FULL)
  assert.ok(!/--run(\s*)$/m.test(brief), 'a --run flag ends a line with no value')
  assert.ok(!/--task(\s*)$/m.test(brief), 'a --task flag ends a line with no value')
  assert.ok(!/--plan(\s*)$/m.test(brief), 'a --plan flag ends a line with no value')
})
