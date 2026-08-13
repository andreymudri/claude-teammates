import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
  assert.ok(brief.includes('--root "$ROOT"'), 'complete command does not pass --root')
  // Without the assignment, --root "$ROOT" expands to the empty string and the CLI resolves the
  // run branch to the task branch — the wrong question, asked silently.
  assert.ok(brief.includes('ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")'),
    'the ROOT assignment that gives --root its value is missing')
  assert.ok(at(brief, 'ROOT=$(dirname') < at(brief, '--root "$ROOT"'),
    'ROOT must be assigned before it is passed to --root')
  assert.ok(at(brief, 'GLOBAL CONSTRAINTS:') < at(brief, 'cli.mjs" complete'),
    'self-verification must follow the constraints section')
  assert.ok(at(brief, 'cli.mjs" complete') < at(brief, 'Commit your work on'),
    'self-verification must precede the final commit instruction')
})

// `complete` exits 0, 2 or 4 and the three are not interchangeable: 4 is "cannot verify", a
// fact about the run configuration. A brief that collapses them tells a teammate on a repo
// with no tracked gate manifest to loop on a message that names nothing to fix.
test('the verify step distinguishes all three complete exit codes', () => {
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, caveman: 'full' })]) {
    assert.ok(/exit 0[^\n]*passes/.test(brief), 'exit 0 is not described as passing')
    assert.ok(brief.includes('exit 2'), 'exit 2 is not named')
    assert.ok(/exit 2[^]{0,200}fix/.test(brief), 'exit 2 is not the teammate\'s work to fix')
    assert.ok(brief.includes('exit 4'), 'exit 4 is not named')
    assert.ok(/exit 4[^]{0,400}could not verify/.test(brief),
      'exit 4 is not described as a failure to verify')
    assert.ok(/exit 4[^]{0,600}Do not loop on it/.test(brief),
      'exit 4 does not tell the teammate to proceed rather than loop')
    assert.ok(!/Anything else: fix what it names/.test(brief),
      'the brief still treats every non-zero exit as the teammate\'s defect')
    assert.ok(at(brief, 'exit 0') < at(brief, 'exit 2') && at(brief, 'exit 2') < at(brief, 'exit 4'),
      'the exit codes are not listed in order')
  }
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
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, caveman: 'full' })]) {
    for (const flag of ['run', 'task', 'plan', 'root']) {
      assert.ok(!new RegExp('--' + flag + '\\s*$', 'm').test(brief),
        `a --${flag} flag ends a line with no value`)
      assert.ok(!brief.includes('--' + flag + '  '),
        `a --${flag} flag is followed by an empty value`)
      assert.ok(!brief.includes('--' + flag + ' ""'),
        `a --${flag} flag is given an empty literal`)
    }
  }
})

// Strips comments and string contents, leaving executable source. Almost every line of
// brief.mjs is brief prose held in a string literal, so scanning raw text confuses a word in
// the prose ("respawn", "process.") with a call. Template substitutions are KEPT — `${...}`
// holds real code — while the literal text around them is dropped. Regex literals are not
// tracked; brief.mjs contains one (`/^T/`) and it holds no quote, so it does not perturb the
// scan.
function executableSource(src) {
  let out = ''
  let i = 0
  const stack = []
  while (i < src.length) {
    const c = src[i]
    const two = src.slice(i, i + 2)
    if (two === '//') { i = src.indexOf('\n', i); if (i === -1) break; continue }
    if (two === '/*') { i = src.indexOf('*/', i) + 2; continue }
    if (c === "'" || c === '"') {
      const q = c
      i += 1
      while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1
      i += 1
      out += ' '
      continue
    }
    if (c === '`') {
      i += 1
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '`') { i += 1; break }
        if (src.slice(i, i + 2) === '${') {
          i += 2
          let depth = 1
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth += 1
            else if (src[i] === '}') depth -= 1
            if (depth > 0) out += src[i]
            i += 1
          }
          out += ' '
          continue
        }
        i += 1
      }
      out += ' '
      continue
    }
    out += c
    i += 1
  }
  return out
}

// Cross-file, source-level check. The module's purity is a claim about what it does NOT do:
// an unused `node:fs` import or a `process.env` read changes no rendered output, so no
// behavioural assertion over composeBrief's return value can fail on it. This repository
// already uses cross-file source checks for exactly this shape of claim.
test('scripts/brief.mjs executable source imports nothing and touches no host state', async () => {
  const src = await readFile(new URL('../scripts/brief.mjs', import.meta.url), 'utf8')
  const code = executableSource(src)
  assert.ok(!/(^|[\s;}])import\s+[\w{*'"]/.test(code), 'scripts/brief.mjs must import nothing')
  assert.ok(!/\bimport\s*\(/.test(code), 'scripts/brief.mjs must not use a dynamic import')
  assert.ok(!/\brequire\s*\(/.test(code), 'scripts/brief.mjs must not require anything')
  assert.ok(!/\bprocess\b/.test(code), 'scripts/brief.mjs must not touch process')
  assert.ok(!/\bglobalThis\b/.test(code), 'scripts/brief.mjs must not reach through globalThis')
  assert.ok(!/\b(eval|Function)\s*\(/.test(code),
    'scripts/brief.mjs must not construct code at runtime')
  // The stripper is the load-bearing half of this check, so pin it against both directions of
  // the mistake it exists to prevent.
  assert.equal(/\bprocess\b/.test(executableSource("const a = 'process.env is prose here'")), false)
  assert.equal(/\bimport\s*\(/.test(executableSource("await import('node:' + 'fs')")), true)
  assert.equal(/\bprocess\b/.test(executableSource('const a = `x${process.env.Y}z`')), true)
})
