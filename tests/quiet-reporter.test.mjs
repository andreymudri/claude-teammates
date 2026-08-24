import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import quietReporter from '../scripts/quiet-reporter.mjs'

// A file:// URL, not a filesystem path. `--test-reporter` is resolved by the ESM loader, and on
// Windows an absolute path begins `D:\...`, whose drive letter the loader reads as a URL scheme:
// it fails with ERR_UNSUPPORTED_ESM_URL_SCHEME, "Received protocol 'd:'". A file:// URL is
// accepted on every platform, so it is what this passes. (`.pathname` is wrong for the opposite
// reason — it keeps the URL's leading slash, `/C:/...`, which is not a valid path.) Note this
// applies to the ABSOLUTE specifier only: package.json passes a relative one,
// `./scripts/quiet-reporter.mjs`, which has no scheme to misread and works as-is.
const reporterUrl = new URL('../scripts/quiet-reporter.mjs', import.meta.url).href

async function collect(events) {
  async function* source() { for (const e of events) yield e }
  let out = ''
  for await (const chunk of quietReporter(source())) out += chunk
  return out
}

const counts = (over = {}) => ({
  tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, ...over,
})
const rootSummary = (over = {}, success = true) => ({
  type: 'test:summary', data: { success, counts: counts(over) },
})

test('a green run prints only the summary line', async () => {
  const out = await collect([
    { type: 'test:pass', data: { name: 'one' } },
    { type: 'test:pass', data: { name: 'two' } },
    { type: 'test:pass', data: { name: 'three' } },
    rootSummary({ tests: 3, passed: 3 }),
  ])
  assert.equal(out, '\n3 tests | 3 pass | 0 fail | 0 skipped\n')
  assert.doesNotMatch(out, /✔|one|two|three/)
})

// THE CASE THE NAIVE IMPLEMENTATION GETS WRONG. A parent suite emits its own `test:pass`
// alongside its children, so tallying them inflates the count — measured at 5 where the truth
// was 4. The per-file summary is the other wrong source: the runner emits one per file AND one
// for the whole run, and only the latter aggregates. A wrong count is worse than a verbose one,
// because this project's evidence rule depends on the number being true.
test('counts come from the root summary, not from tallying pass events', async () => {
  const out = await collect([
    { type: 'test:pass', data: { name: 'leaf one' } },
    { type: 'test:pass', data: { name: 'leaf two' } },
    { type: 'test:pass', data: { name: 'a suite' } },
    { type: 'test:pass', data: { name: 'subtest' } },
    { type: 'test:pass', data: { name: 'top level' } },
    { type: 'test:summary', data: { success: true, file: '/x.test.mjs', counts: counts({ tests: 99, passed: 99 }) } },
    rootSummary({ tests: 4, passed: 4 }),
  ])
  assert.match(out, /4 tests \| 4 pass/)
  assert.doesNotMatch(out, /5 tests/, 'tallied test:pass events instead of reading the root summary')
  assert.doesNotMatch(out, /99 tests/, 'read the per-file summary instead of the root one')
})

test('a failing run prints the failure and still prints the summary', async () => {
  const error = Object.assign(new Error('boom'), { stack: 'Error: boom\n    at x.mjs:1:1' })
  const out = await collect([
    { type: 'test:fail', data: { name: 'breaks', details: { error } } },
    rootSummary({ tests: 1, failed: 1 }, false),
  ])
  assert.match(out, /✖ breaks/)
  assert.match(out, /at x\.mjs:1:1/, 'the stack must not be abbreviated')
  assert.match(out, /1 fail/)
  assert.match(out, /FAILED/)
})

test('stderr and stdout pass through verbatim', async () => {
  const out = await collect([
    { type: 'test:stderr', data: { message: 'a real warning\n' } },
    { type: 'test:stdout', data: { message: 'printed by a test\n' } },
    rootSummary({ tests: 1, passed: 1 }),
  ])
  assert.match(out, /a real warning\n/)
  assert.match(out, /printed by a test\n/)
})

// A crashed run that never emits a root summary must not read as clean output.
test('a run that emits no root summary is reported as failed', async () => {
  const out = await collect([
    { type: 'test:summary', data: { success: true, file: '/x.test.mjs', counts: counts({ tests: 1, passed: 1 }) } },
  ])
  assert.match(out, /treat this run as failed/)
})

test('skipped tests are counted and not named', async () => {
  const out = await collect([
    { type: 'test:pass', data: { name: 'skipped one', skip: true } },
    { type: 'test:pass', data: { name: 'skipped two', skip: true } },
    rootSummary({ tests: 5, passed: 3, skipped: 2 }),
  ])
  assert.match(out, /2 skipped/)
  assert.doesNotMatch(out, /skipped one|skipped two/)
})

// The tests above drive the generator directly and so never observe an exit code, which the
// contract names for both outcomes. This drives a real runner over real fixtures.
test('the reporter drives a real run and preserves exit codes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tm-quiet-'))
  try {
    const green = path.join(dir, 'green.test.mjs')
    const red = path.join(dir, 'red.test.mjs')
    await writeFile(green, "import { test } from 'node:test'\ntest('ok', () => {})\n", 'utf8')
    await writeFile(red, "import { test } from 'node:test'\ntest('bad', () => { throw new Error('nope') })\n", 'utf8')

    // NODE_TEST_CONTEXT must be scrubbed from the child's environment. The runner sets it to
    // `child-v8` in every test process, and a nested `node --test` that sees it switches to the
    // internal serialised protocol and ignores `--test-reporter` entirely — the child then exits
    // 0 with EMPTY stdout, which reads as "the reporter printed nothing" rather than as "the
    // reporter was never asked". Found the hard way: this test failed with actual '' while the
    // identical command worked from a shell.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT

    const run = (file) => {
      try {
        const stdout = execFileSync('node', ['--test', '--test-reporter', reporterUrl, file], { encoding: 'utf8', env })
        return { status: 0, stdout }
      } catch (err) {
        return { status: err.status, stdout: err.stdout ?? '' }
      }
    }

    const ok = run(green)
    assert.equal(ok.status, 0)
    assert.match(ok.stdout, /1 tests \| 1 pass \| 0 fail/)

    const bad = run(red)
    assert.equal(bad.status, 1)
    assert.match(bad.stdout, /✖/)
    assert.match(bad.stdout, /1 fail/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
