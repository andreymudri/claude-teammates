import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { HAZARDS, hostileTmpdirName, sweepSupported, sweepVerdict } from '../scripts/hostile-tmpdir-sweep.mjs'

const root = new URL('..', import.meta.url)

// Four hazards, and the sweep is worth having only because each of them found something the
// others did not. A single quote and a command substitution found the shell injections in
// `tests/gate-runner.test.mjs` and `tests/cli.test.mjs`. LENGTH found the `sun_path` limit, which
// no hostile character reaches — a 77-byte benign TMPDIR reproduces it. A SPACE found a `file://`
// URL built by hand, which failed as a JSON parse error three tests away from its cause. Dropping
// any one of them would have left one of those four classes unmeasured, which is why this asserts
// the set rather than the count.
test('the sweep folds every hazard it claims into one directory name', () => {
  // Built with `path.join` rather than written as a literal: `hostileTmpdirName` joins, so on
  // win32 the separators in the embedded log path come back as backslashes and a hard-coded
  // `/tmp/base/marker.log` never appears in the result. Measured on the windows leg.
  const base = path.join('/tmp', 'base')
  const logPath = path.join(base, 'marker.log')
  const name = hostileTmpdirName(base, logPath)
  assert.equal(name.includes("'"), true, 'no single quote: the JS-literal and sh -c shapes go unmeasured')
  assert.equal(name.includes(' '), true, 'no space: word-splitting and URL-encoding defects go unmeasured')
  assert.match(name, /\$\(/, 'no command substitution: nothing distinguishes a broken command from an executed one')
  assert.ok(name.length > 70, `no length hazard: sun_path is not exercised (${name.length} bytes)`)
  // The substitution must WRITE somewhere the caller named, or the sweep cannot count anything.
  assert.ok(name.includes(logPath), name)
  assert.deepEqual([...HAZARDS].sort(), ['command substitution', 'length', 'single quote', 'space'])
})

// The count is the verdict, not the suite's exit code: a test can go GREEN having executed the
// injected command, which is exactly what 4 of the 17 measured executions did.
test('any injection at all fails the sweep, green suite or not', () => {
  assert.equal(sweepVerdict({ injections: 1, suiteCode: 0 }).ok, false)
  assert.match(sweepVerdict({ injections: 1, suiteCode: 0 }).reason, /executed/)
  assert.equal(sweepVerdict({ injections: 0, suiteCode: 1 }).ok, false)
  assert.equal(sweepVerdict({ injections: 0, suiteCode: 0 }).ok, true)
})

// On win32 the sweep would measure nothing and say PASS, which is worse than not running: TMPDIR
// is not how Windows chooses a temp directory (TMP/TEMP are), and cmd.exe expands neither `$( )`
// nor single quotes, so the injection could not fire even from a site that has the defect. It
// refuses by name instead, so a green Windows CI leg never reads as "swept clean".
test('the sweep refuses win32 rather than reporting a clean run it cannot measure', () => {
  assert.equal(sweepSupported('win32').ok, false)
  assert.match(sweepSupported('win32').reason, /TMPDIR|cmd\.exe/)
  assert.equal(sweepSupported('linux').ok, true)
  assert.equal(sweepSupported('darwin').ok, true)
})

test('CI runs the sweep, and not on the leg that cannot measure it', async () => {
  const wf = await readFile(new URL('.github/workflows/test.yml', root), 'utf8')
  assert.match(wf, /test:hostile-tmpdir/, 'the sweep must run somewhere, or it is a script nobody runs')
  const step = wf.slice(wf.indexOf('test:hostile-tmpdir') - 400, wf.indexOf('test:hostile-tmpdir') + 80)
  assert.match(step, /runner\.os\s*!=\s*'Windows'/, 'the sweep must be skipped on the leg where it can measure nothing')
})

test('npm exposes the sweep, and the script it names exists', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const s = pkg.scripts['test:hostile-tmpdir']
  assert.ok(s, 'the sweep must be runnable by name, or it is a measurement nobody re-runs')
  assert.match(s, /scripts\/hostile-tmpdir-sweep\.mjs/)
  assert.ok(existsSync(new URL('scripts/hostile-tmpdir-sweep.mjs', root)), 'the script the npm script names must exist')
  // Same constraint the other npm scripts carry: Windows CI runs these under cmd.exe.
  assert.doesNotMatch(s, /[|>]|&&|\bgrep\b/, 'the sweep must not depend on shell features cmd.exe lacks')
})
