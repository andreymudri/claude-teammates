import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const hookScript = fileURLToPath(new URL('../hooks/session-start', import.meta.url))
const updateCheckScript = fileURLToPath(new URL('../hooks/update-check', import.meta.url))

// Every invocation gets its own CLAUDE_CONFIG_DIR. Without it the hook reads and
// WRITES the developer's real ~/.claude — the update-notice marker would leak out
// of the suite, and whether a notice appears would depend on test order and on
// whether the machine had run the hook before.
function runHook(env) {
  const configDir = mkdtempSync(path.join(tmpdir(), 'tm-hook-'))
  try {
    return execFileSync('bash', [hookScript], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_CONFIG_DIR: configDir, ...env },
    })
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}

const installedVersion = JSON.parse(
  readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
).version

// Runs the hook against a caller-owned state dir so a test can observe what the
// hook wrote, or seed state and run again. Returns the parsed context string.
function contextWith(configDir, env = {}) {
  const out = execFileSync('bash', [hookScript], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_CONFIG_DIR: configDir, ...env },
  })
  const parsed = JSON.parse(out)
  assert.equal(Object.keys(parsed).length, 1, 'hook must emit exactly one context field')
  return parsed.hookSpecificOutput.additionalContext
}

function stateDir(configDir) {
  return path.join(configDir, 'claude-teammates')
}

function withConfigDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tm-state-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('hooks.json declares a SessionStart matcher', async () => {
  const cfg = JSON.parse(await readFile(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(cfg.hooks.SessionStart))
  assert.match(cfg.hooks.SessionStart[0].matcher, /startup/)
})

test('emits valid JSON containing the entrypoint content', () => {
  const parsed = JSON.parse(runHook({}))
  const ctx = parsed.hookSpecificOutput.additionalContext
  assert.match(ctx, /using-teammates/)
  assert.match(ctx, /Using \[skill\]|routing|Skill/i)
})

test('emits exactly one context field for Claude Code', () => {
  const parsed = JSON.parse(runHook({}))
  assert.ok(parsed.hookSpecificOutput, 'expected hookSpecificOutput')
  assert.equal(parsed.additional_context, undefined)
  assert.equal(parsed.additionalContext, undefined)
})

test('emits the cursor field shape when CURSOR_PLUGIN_ROOT is set', () => {
  const parsed = JSON.parse(runHook({ CURSOR_PLUGIN_ROOT: root }))
  assert.ok(typeof parsed.additional_context === 'string')
  assert.equal(parsed.hookSpecificOutput, undefined)
})

test('a missing entrypoint file produces a loud warning, valid JSON, and exit 0', () => {
  const out = runHook({ CLAUDE_PLUGIN_ROOT: '/nonexistent-plugin-root' })
  const parsed = JSON.parse(out)
  const ctx = parsed.hookSpecificOutput.additionalContext
  assert.match(ctx, /claude-teammates/i)
  assert.match(ctx, /not active|missing|WARNING/i)
  assert.match(ctx, /using-teammates\/SKILL\.md/)
})

// --- update notice -------------------------------------------------------
//
// The notice is produced by session-start reading two local files. The network
// fetch lives in hooks/update-check, which is wired "async": true and emits
// nothing, so none of these tests touch the network.

test('reports the installed version once when no marker exists, and writes the marker', () => {
  withConfigDir((dir) => {
    const ctx = contextWith(dir)
    assert.ok(ctx.includes(`claude-teammates ${installedVersion} is active`))
    assert.ok(ctx.includes(`releases/tag/v${installedVersion}`))
    const marker = readFileSync(path.join(stateDir(dir), 'last-seen-version'), 'utf8').trim()
    assert.equal(marker, installedVersion)
  })
})

test('does not repeat the notice on a second run — once per version is the feature', () => {
  withConfigDir((dir) => {
    contextWith(dir)
    const second = contextWith(dir)
    assert.doesNotMatch(second, /is active/)
    assert.doesNotMatch(second, /updated:/)
  })
})

test('reports an upgrade when the marker holds an older version', () => {
  withConfigDir((dir) => {
    mkdirSync(stateDir(dir), { recursive: true })
    writeFileSync(path.join(stateDir(dir), 'last-seen-version'), '0.0.1\n')
    const ctx = contextWith(dir)
    assert.ok(ctx.includes(`updated: 0.0.1 -> ${installedVersion}`))
  })
})

test('reports a newer published version from the async check cache', () => {
  withConfigDir((dir) => {
    mkdirSync(stateDir(dir), { recursive: true })
    writeFileSync(path.join(stateDir(dir), 'last-seen-version'), `${installedVersion}\n`)
    writeFileSync(path.join(stateDir(dir), 'update-check.json'), '{"published":"999.0.0","checkedAt":1}')
    const ctx = contextWith(dir)
    assert.match(ctx, /999\.0\.0 is available/)
    assert.match(ctx, /\/plugin update claude-teammates/)
  })
})

// The direction check. A plain string comparison reports an OLDER published
// version as available, which is why the hook uses `sort -V`.
test('does not report an older published version as available', () => {
  withConfigDir((dir) => {
    mkdirSync(stateDir(dir), { recursive: true })
    writeFileSync(path.join(stateDir(dir), 'last-seen-version'), `${installedVersion}\n`)
    writeFileSync(path.join(stateDir(dir), 'update-check.json'), '{"published":"0.0.1","checkedAt":1}')
    const ctx = contextWith(dir)
    assert.doesNotMatch(ctx, /is available/)
  })
})

// 0.10.0 sorts BEFORE 0.9.0 as a string and AFTER it as a version. This is the
// case the naive comparison gets wrong, so it is pinned explicitly.
test('orders versions numerically, not lexically: 0.10.0 is newer than 0.9.0', () => {
  withConfigDir((dir) => {
    mkdirSync(stateDir(dir), { recursive: true })
    writeFileSync(path.join(stateDir(dir), 'last-seen-version'), `${installedVersion}\n`)
    writeFileSync(path.join(stateDir(dir), 'update-check.json'), '{"published":"0.10.0","checkedAt":1}')
    const ctx = contextWith(dir)
    // Only meaningful while the installed version is below 0.10.0; assert that premise.
    assert.ok(installedVersion < '0.10.0' || installedVersion.startsWith('0.'), 'premise')
    assert.match(ctx, /0\.10\.0 is available/)
  })
})

test('a notice never breaks the emitted JSON or adds a second context field', () => {
  withConfigDir((dir) => {
    mkdirSync(stateDir(dir), { recursive: true })
    writeFileSync(path.join(stateDir(dir), 'update-check.json'), '{"published":"999.0.0","checkedAt":1}')
    // contextWith asserts the single-field property itself; reaching here means it held.
    const ctx = contextWith(dir)
    assert.match(ctx, /999\.0\.0 is available/)
    assert.match(ctx, /using-teammates/)
  })
})

// --- update-check (the async, network-touching hook) ---------------------

function runUpdateCheck(configDir, env = {}) {
  return execFileSync('bash', [updateCheckScript], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...env },
  })
}

test('update-check makes no request and writes nothing when opted out', () => {
  withConfigDir((dir) => {
    const out = runUpdateCheck(dir, { CLAUDE_TEAMMATES_UPDATE_CHECK: '0' })
    assert.equal(out, '', 'the async hook must emit nothing')
    assert.equal(existsSync(path.join(stateDir(dir), 'update-check.json')), false)
  })
})

test('update-check writes the published version to its cache', () => {
  withConfigDir((dir) => {
    const fixture = path.join(dir, 'published.json')
    writeFileSync(fixture, '{"name":"claude-teammates","version":"0.9.9"}')
    const out = runUpdateCheck(dir, {
      CLAUDE_TEAMMATES_UPDATE_URL: `file:///${fixture.split(path.sep).join("/")}`,
    })
    assert.equal(out, '')
    const cache = JSON.parse(readFileSync(path.join(stateDir(dir), 'update-check.json'), 'utf8'))
    assert.equal(cache.published, '0.9.9')
    assert.ok(Number.isInteger(cache.checkedAt))
  })
})

test('update-check refuses a version that is not digits and dots', () => {
  withConfigDir((dir) => {
    const fixture = path.join(dir, 'published.json')
    writeFileSync(fixture, '<html>"version": "not-a-version"</html>')
    runUpdateCheck(dir, { CLAUDE_TEAMMATES_UPDATE_URL: `file:///${fixture.split(path.sep).join("/")}` })
    assert.equal(
      existsSync(path.join(stateDir(dir), 'update-check.json')),
      false,
      'an HTML error page must not be cached as a version',
    )
  })
})

test('update-check throttles: a fresh cache is not overwritten', () => {
  withConfigDir((dir) => {
    const fixture = path.join(dir, 'published.json')
    const url = `file:///${fixture.split(path.sep).join("/")}`
    writeFileSync(fixture, '{"version":"0.9.9"}')
    runUpdateCheck(dir, { CLAUDE_TEAMMATES_UPDATE_URL: url })
    writeFileSync(fixture, '{"version":"1.2.3"}')
    runUpdateCheck(dir, { CLAUDE_TEAMMATES_UPDATE_URL: url })
    const cache = JSON.parse(readFileSync(path.join(stateDir(dir), 'update-check.json'), 'utf8'))
    assert.equal(cache.published, '0.9.9', 'the second run must be throttled out')
  })
})

test('hooks.json wires update-check async and session-start sync', async () => {
  const cfg = JSON.parse(await readFile(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  const entries = cfg.hooks.SessionStart[0].hooks
  const sync = entries.find((h) => h.command.includes('session-start'))
  const async = entries.find((h) => h.command.includes('update-check'))
  assert.ok(sync && async, 'both hooks must be declared')
  // This asyncness is the property that keeps the network off the blocking path,
  // and no behavioural test can observe it.
  assert.equal(sync.async, false)
  assert.equal(async.async, true)
})
