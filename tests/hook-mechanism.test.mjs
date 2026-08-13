// The outside observer for tests/hook.test.mjs.
//
// WHY THIS FILE EXISTS
// --------------------
// Everything hook.test.mjs asserts about itself — that the body node:test ran for each case is
// the function the file's own text spells, that every marker line was reached, that the skip
// decision matched the probe — is written in the file it defends. Its own comments say so
// plainly: "the attacker and the file are the same thing, so no mechanism written here can bound
// what an edit to this file may do." Two shapes are recorded there as measured and NOT caught:
// an eval-compiled substitute carrying `//# sourceURL=`, which satisfies both the marker leg and
// the source-text leg while binding a no-op `assert` into every body, and any edit that replaces
// `Function.prototype.toString` before the source-text leg reads it.
//
// Neither can be closed from inside. Both are closed from OUTSIDE by asking a different
// question: never "does hook.test.mjs look honest", but "does hook.test.mjs still go red when
// the product it tests is broken". A neutered suite answers no. That is the one question a
// forged file cannot answer for itself, because the answer is produced by running it against a
// tree this file mutates, not by anything it says about its own text.
//
// WHAT IT DOES
// ------------
// Copies the working tree, breaks ONE documented string in `hooks/session-start` (the broken-
// install warning that several hook cases assert on), runs `node --test tests/hook.test.mjs`
// inside the copy, and requires that run to fail with at least one failing case named in
// hook.test.mjs's own source.
//
// WHAT IT DOES NOT DO
// -------------------
// It proves the suite is live against ONE mutation, not that it is live against every one. A
// forgery that leaves exactly the readiness cases working and neuters the other twenty-five
// passes here. Mutation coverage is a CI-scale question — every case mutated in turn — and this
// is one mutant chosen because the file's own comments record it as the mutation that separated
// an honest run from a forged one (49 pass / 5 fail honest, 49 pass / 0 fail forged).
//
// It also cannot run everywhere. hook.test.mjs skips its cases when bash cannot reach the
// repository path, and a suite that skipped everything cannot be red for the right reason, so
// this test skips itself rather than reporting a pass it did not earn.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// Directories that must not travel into the copy: git state, run state, agent worktrees, and
// anything a package manager put there. Everything else is source this suite reads.
const EXCLUDED = new Set(['.git', '.teammates', '.claude', 'node_modules'])

// The mutation. This exact string is asserted by the broken-install cases in hook.test.mjs, and
// is the one its own comments use when they report what an honest run and a forged run each
// produced — so a suite that does not fail on it is not the suite those comments describe.
const HEALTHY = 'NOT fully working'
const BROKEN = 'NOT fully operational'

// node:test's spec reporter prints these summary lines. Read the counts rather than the exit
// status alone: "it failed" and "it failed because thirty cases were skipped and one crashed"
// are different answers, and only the first is the evidence this file wants.
function summarize(output) {
  const count = (label) => {
    const m = new RegExp(`^\\s*(?:ℹ|#)\\s*${label}\\s+(\\d+)\\s*$`, 'm').exec(output)
    return m ? Number(m[1]) : null
  }
  return { pass: count('pass'), fail: count('fail'), skipped: count('skipped') }
}

// The case names hook.test.mjs's own text registers, read the same way that file reads them —
// from the source, never from anything the registration path maintains. A failing name that is
// not one of these means the child run died for some other reason (a copy that did not build, a
// missing file) and must not be credited as the mutation being caught.
function hookCaseNames(source) {
  return new Set(
    [...source.matchAll(/^hookTest\((['"])(.*?)\1,/gm)].map((m) => m[2]),
  )
}

function failingTestNames(output) {
  return [...output.matchAll(/^\s*✖\s+(.*?)\s+\(\d+(?:\.\d+)?ms\)\s*$/gm)].map((m) => m[1])
}

test('(cross-file) hook.test.mjs goes red when the product it tests is broken', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tm-hook-mutant-'))
  try {
    cpSync(root, dir, {
      recursive: true,
      filter: (src) => !EXCLUDED.has(path.basename(src)),
    })

    const hookPath = path.join(dir, 'hooks', 'session-start')
    const hookSource = readFileSync(hookPath, 'utf8')
    // Fail loudly if the mutation target moved. A silent no-op edit would make this test assert
    // that an UNMUTATED suite fails, which it must not, and the whole check would invert.
    assert.ok(
      hookSource.includes(HEALTHY),
      `hooks/session-start no longer contains ${JSON.stringify(HEALTHY)}, so this file mutated ` +
      'nothing and the run below would prove the opposite of what it claims',
    )
    writeFileSync(hookPath, hookSource.replace(HEALTHY, BROKEN), 'utf8')

    // NODE_TEST_CONTEXT and NODE_OPTIONS must not travel into the child. This test is itself
    // running under `node --test`, which exports NODE_TEST_CONTEXT; a child that inherits it
    // reports to the parent runner's protocol instead of printing a summary, and the counts
    // below come back empty — measured, and it is why they are deleted rather than passed on.
    // NODE_OPTIONS goes for a second reason: a `--test-name-pattern` set for the parent would
    // silently select a subset of the child's cases.
    const childEnv = { ...process.env }
    delete childEnv.NODE_TEST_CONTEXT
    delete childEnv.NODE_OPTIONS

    let output = ''
    try {
      output = execFileSync(process.execPath, ['--test', 'tests/hook.test.mjs'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 240000,
        env: childEnv,
      })
    } catch (err) {
      // A failing child exits non-zero, which is the outcome this test WANTS. The output is on
      // the error, and it is the evidence, so it is read rather than rethrown.
      output = `${typeof err.stdout === 'string' ? err.stdout : ''}${typeof err.stderr === 'string' ? err.stderr : ''}`
      assert.ok(output, `the child run produced no output to judge: ${err.message}`)
    }

    const { pass, fail, skipped } = summarize(output)
    assert.ok(
      pass !== null && fail !== null && skipped !== null,
      'could not read pass/fail/skipped counts from the child run, so its verdict is unknown:\n' +
      output.slice(-2000),
    )

    // The environment could not answer. hook.test.mjs skips its cases when bash cannot reach the
    // repository, and skipped cases cannot fail on a broken product — so there is nothing here
    // to conclude, and this reports that instead of passing.
    if (skipped > 0) {
      t.skip(
        `hook.test.mjs skipped ${skipped} cases in the copy (bash cannot reach ${dir}), so a ` +
        'broken product could not have reddened them',
      )
      return
    }

    assert.ok(
      fail > 0,
      'hook.test.mjs passed against a BROKEN product. Its cases assert on the string this test ' +
      `replaced (${JSON.stringify(HEALTHY)} -> ${JSON.stringify(BROKEN)}), so a green run means ` +
      'those bodies did not really execute or their assertions did not really run — the exact ' +
      'state its own mechanism pins cannot rule out, because a forged file forges them too. ' +
      `Child summary: ${pass} pass / ${fail} fail / ${skipped} skipped.`,
    )

    // Red for the RIGHT reason. A child that died on a missing file also exits non-zero, so the
    // failing names have to be cases hook.test.mjs's own text registers.
    const names = hookCaseNames(readFileSync(path.join(dir, 'tests', 'hook.test.mjs'), 'utf8'))
    const failed = failingTestNames(output)
    const failedCases = failed.filter((name) => names.has(name))
    assert.ok(
      failedCases.length > 0,
      'the child run failed, but no failing test name is a hook case this file can find in ' +
      `hook.test.mjs's source — so the failure is not the mutation being caught. Failing ` +
      `names: ${JSON.stringify(failed.slice(0, 10))}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
