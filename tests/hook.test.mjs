import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const hookScript = fileURLToPath(new URL('../hooks/session-start', import.meta.url))

function runHook(env) {
  return execFileSync('bash', [hookScript], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, ...env },
  })
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
