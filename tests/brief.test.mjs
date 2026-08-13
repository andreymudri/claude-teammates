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

// Read out of `complete` in scripts/cli.mjs: the recomputed gate REJECTING the task exits 4,
// the same code as no-manifest / underivable-context / unknown-task. Only the printed first
// line `gate does not pass for phase` separates them. A brief that maps 4 to "proceed", or
// puts the rejection on 2, tells a teammate with a failing fileset check to return done.
test('the verify step maps rejection to exit 4 with its printed discriminator', () => {
  for (const brief of [composeBrief(FULL), composeBrief({ ...FULL, caveman: 'full' })]) {
    assert.ok(/exit 0[^\n]*passes/.test(brief), 'exit 0 is not described as passing')
    assert.ok(brief.includes('gate does not pass for phase'),
      'the brief does not name the line that identifies a rejection')
    // Assert the GUIDANCE inside the rejection clause, not the presence of a word the clause
    // itself supplies: `/REJECTED/ || /fix/i` short-circuited on its own text and stayed green
    // when the guidance was swapped for "quote it and proceed", which is the inversion again.
    const rejection = brief.slice(at(brief, 'gate does not pass for phase'), at(brief, 'no gate manifest'))
    assert.ok(/Fix exactly the checks it names/.test(rejection),
      'the rejection clause does not tell the teammate to fix the checks it names')
    assert.ok(/run the command again/.test(rejection),
      'the rejection clause does not tell the teammate to re-run')
    for (const wrong of ['proceed', 'do not loop', 'Quote']) {
      assert.ok(!rejection.includes(wrong),
        `the rejection clause tells the teammate to "${wrong}" — that is the cannot-verify guidance`)
    }
    assert.ok(/exit 4, output beginning "gate does not pass for phase"/.test(brief),
      'the rejection is not keyed to exit 4 and its printed first line')
    // ...and the cannot-verify clause must be a DIFFERENT exit-4 clause, the one that proceeds.
    assert.ok(/exit 4, output "no gate manifest"/.test(brief),
      'the cannot-verify situations are not keyed to exit 4')
    assert.ok(/no gate manifest[^]{0,400}do not loop on it/i.test(brief),
      'the cannot-verify clause does not tell the teammate to proceed rather than loop')
    assert.ok(at(brief, 'gate does not pass for phase') < at(brief, 'no gate manifest'),
      'the rejection clause must be read before the cannot-verify clause')
    // Exit 2 is a malformed manifest AND every argument error on the invocation. Without a
    // discriminator a teammate that drops a flag reads "not your work, do not loop" and
    // proceeds having never run the gate at all.
    assert.ok(/exit 2[^]{0,200}missing required argument:/.test(brief),
      'exit 2 does not name the argument-error output that shares its code')
    assert.ok(brief.includes('unsupported flag spelling:'),
      'exit 2 does not name the refused-spelling output')
    assert.ok(brief.includes('--root must not be empty'),
      'exit 2 does not name the empty-root output')
    assert.ok(/missing required argument:[^]{0,400}run it again/.test(brief),
      'a malformed invocation is not the teammate\'s own to fix and re-run')
    assert.ok(/missing required argument:[^]{0,400}verified NOTHING/.test(brief),
      'the brief does not say an argument error means the gate never ran')
    assert.ok(/exit 2[^]{0,600}malformed/.test(brief),
      'exit 2 no longer describes a malformed manifest')
    assert.ok(!/exit 2 — teammates\.gate\.json is malformed\. Configuration, not your work\./.test(brief),
      'exit 2 still maps every case to configuration')
    // The flag that does not exist on `complete` yet must not be handed to a teammate.
    assert.ok(!brief.includes('--enforcement-only'),
      'the brief emits --enforcement-only, which complete rejects with exit 2')
    assert.ok(/exit 1[^]{0,200}status file is missing/.test(brief),
      'exit 1 is not described as missing status bookkeeping')
    // The inverted mapping round 2 shipped must not come back.
    assert.ok(!/exit 2 — the gate ran and rejected/.test(brief),
      'exit 2 is still described as the gate rejecting the task')
    assert.ok(!/exit 4 — it could not verify/.test(brief),
      'exit 4 is still described as only a failure to verify')
    assert.ok(!/Anything else: fix what it names/.test(brief),
      'the brief still treats every non-zero exit as the teammate\'s defect')
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

// A runnable command in this brief is an indented line beginning with the executable. The
// prose that quotes a checkout starts with a double quote, so it is not one. Pinning the
// absence of any runnable checkout catches the operand-less `git checkout -B <branch>` the
// module's own comment warns about, in `switch -c` spelling too — the old assertion keyed on
// one exact string with a trailing space and caught neither.
const runnableCheckout = /^[ \t]*git[ \t]+(checkout|switch)\b/m

test('with no base branch the brief refuses to name a starting commit', () => {
  const brief = composeBrief({ ...FULL, baseBranch: '' })
  assert.ok(brief.includes('No base branch was supplied'))
  assert.ok(!runnableCheckout.test(brief),
    'the no-base variant emits a runnable checkout command; it must refuse to name a start point')
  assert.ok(brief.includes('report status "blocked"'))
  // The same regex must match the variant that DOES emit one, or it proves nothing above.
  assert.ok(runnableCheckout.test(composeBrief(FULL)),
    'the runnable-checkout pattern fails to match a real checkout command')
})

test('the no-base caveman variant also emits no runnable checkout', () => {
  const brief = composeBrief({ ...FULL, baseBranch: '', caveman: 'full' })
  assert.ok(!runnableCheckout.test(brief))
  assert.ok(brief.includes('No base branch was supplied'))
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

// An absent key and an empty array are different inputs and the guard must reject both: with
// only the absent-key case pinned, weakening the guard to a truthiness test on the array
// leaves the suite green while an empty list renders a header with nothing under it.
test('an empty neighbours array renders no blast radius header', () => {
  const brief = composeBrief({ ...FULL, task: { ...TASK, neighbours: [] } })
  assert.ok(!brief.includes('BLAST RADIUS.'),
    'an empty neighbours array rendered a header with no files under it')
  assert.ok(!brief.includes('They have changed together'))
  assert.ok(brief.includes('Touching any other file fails the phase gate.'),
    'the section around the blast radius is still rendered')
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
  // The constraints were the one clause the module's own "survives compression unchanged"
  // comment named and nothing checked: emptying them in `terse` alone left the suite green.
  assert.ok(brief.includes('GLOBAL CONSTRAINTS:'),
    'the compressed variant dropped the GLOBAL CONSTRAINTS header')
  for (const c of FULL.constraints) {
    assert.ok(brief.includes('- ' + c), `the compressed variant dropped the constraint: ${c}`)
  }
})

// The comment above `terse` claims parity with `full` on the load-bearing clauses. Assert it
// clause by clause rather than trusting the prose, so compression cannot silently lose one.
test('the compressed variant carries the same specification clauses as the full one', () => {
  const full = composeBrief(FULL)
  const terse = composeBrief({ ...FULL, caveman: 'full' })
  const clauses = [
    'MANDATORY FIRST STEP.',
    'git checkout -B teammates/substop/T4 master',
    'RECORD YOUR WORKTREE.',
    'locate --run substop --task T4',
    'BEFORE YOU RETURN "done".',
    '--run substop --task T4 --plan ' + FULL.planPath,
    'ROOT=$(dirname',
    'gate does not pass for phase',
    'IN THE FOREGROUND',
    'You may create or modify ONLY these files:',
    'GLOBAL CONSTRAINTS:',
    ...FULL.constraints.map((c) => '- ' + c),
  ]
  for (const clause of clauses) {
    assert.ok(full.includes(clause), `the full variant is missing: ${clause}`)
    assert.ok(terse.includes(clause), `compression dropped a specification clause: ${clause}`)
  }
})

// Which variant a caller gets by default is a behavioural choice nothing pinned: flipping the
// signature default to a caveman level sent every ordinary dispatch the compressed spec plus a
// STYLE directive no caller asked for, undetected.
test('an omitted caveman key renders the full variant, not the compressed one', () => {
  const brief = composeBrief(FULL)
  assert.ok(brief.includes('BASELINE. Then bootstrap the worktree, before writing anything'),
    'the default render is not the full variant')
  assert.ok(!brief.includes('STYLE.'), 'the default render carries the caveman STYLE directive')
  assert.ok(!brief.includes('caveman-terse'), 'the default render asks for caveman-terse output')
  assert.ok(!brief.includes('use it at level'), 'the default render names a caveman level')
  // ...and the compressed variant really is different, so the assertions above can fail.
  const terse = composeBrief({ ...FULL, caveman: 'full' })
  assert.ok(terse.includes('STYLE.') && !terse.includes('BASELINE. Then bootstrap'),
    'the two variants are indistinguishable, so the default cannot be pinned')
})

// Rendered at two distinct levels, because asserting `level full` against `caveman: 'full'`
// passes just as well when the level is hardcoded — the assertion has to see the value change.
test('the caveman level is substituted rather than hardcoded', () => {
  const asFull = composeBrief({ ...FULL, caveman: 'full' })
  const asUltra = composeBrief({ ...FULL, caveman: 'ultra' })
  assert.ok(asFull.includes('use it at level full'), 'level full is not substituted')
  assert.ok(asUltra.includes('use it at level ultra'), 'level ultra is not substituted')
  assert.ok(!asUltra.includes('level full'),
    'a brief asked for level ultra still names level full — the level is hardcoded')
  assert.ok(!asFull.includes('level ultra'))
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

// The realistic shape for a task read out of a plan is an ABSENT branch key, not an empty
// string. With only the empty-string case pinned, narrowing the guard to `=== ''` renders
// `git checkout -B undefined <base>` and the teammate commits to a branch named `undefined`,
// which no gate check can find.
test('composeBrief throws when task.branch is absent or not a string', () => {
  for (const branch of [undefined, null, 42, {}]) {
    const task = { id: 'T1', files: [] }
    if (branch !== undefined) task.branch = branch
    assert.throws(() => composeBrief({ task }), /T1 has no branch/,
      `a branch of ${JSON.stringify(branch) ?? 'undefined'} was accepted`)
  }
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
  // This module imports nothing at all, so the total check is the honest one: any occurrence
  // of the token `import` in executable source is a failure. A narrower pattern missed
  // `import "node:fs"` (the stripper removes the quotes, leaving a bare `import `),
  // `import{x}from'y'` with no space, and `export * from '...'`.
  assert.ok(!/\bimport\b/.test(code), 'scripts/brief.mjs must not import anything, in any form')
  assert.ok(!/\bexport\b[^;\n]*\bfrom\b/.test(code), 'scripts/brief.mjs must not re-export from a module')
  assert.ok(!/\brequire\s*\(/.test(code), 'scripts/brief.mjs must not require anything')
  assert.ok(!/\bprocess\b/.test(code), 'scripts/brief.mjs must not touch process')
  assert.ok(!/\bglobalThis\b/.test(code), 'scripts/brief.mjs must not reach through globalThis')
  assert.ok(!/\b(eval|Function)\s*\(/.test(code),
    'scripts/brief.mjs must not construct code at runtime')
  // The stripper is the load-bearing half of this check, so pin it against both directions of
  // the mistake it exists to prevent.
  assert.equal(/\bprocess\b/.test(executableSource("const a = 'process.env is prose here'")), false)
  assert.equal(/\bimport\b/.test(executableSource("const a = 'do not import a neighbour file'")), false)
  assert.equal(/\bimport\b/.test(executableSource('await import(\'node:\' + \'fs\')')), true)
  assert.equal(/\bimport\b/.test(executableSource('import "node:fs"')), true)
  assert.equal(/\bimport\b/.test(executableSource("import{readFileSync}from'node:fs'")), true)
  assert.equal(/\bexport\b[^;\n]*\bfrom\b/.test(executableSource("export * from 'node:fs'")), true)
  assert.equal(/\bprocess\b/.test(executableSource('const a = `x${process.env.Y}z`')), true)
})
