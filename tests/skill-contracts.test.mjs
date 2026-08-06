import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const dir = new URL('../skills/', import.meta.url)

export async function allSkills() {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

export async function skill(name) {
  const text = await readFile(new URL(`${name}/SKILL.md`, dir), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  assert.ok(match, `${name} has no frontmatter`)
  const fields = Object.fromEntries(
    match[1].split(/\r?\n/).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  )
  return { fields, body: text.slice(match[0].length) }
}

test('every skill directory contains a SKILL.md with valid frontmatter', async () => {
  const names = await allSkills()
  assert.ok(names.length >= 5, 'expected at least the five fleet skills')
  for (const name of names) {
    const { fields } = await skill(name)
    assert.equal(fields.name, name, `${name}: frontmatter name must match folder`)
    assert.match(fields.description, /^Use when/, `${name}: description must start with "Use when"`)
  }
})

test('no skill invokes the CLI by a relative path', async () => {
  for (const name of await allSkills()) {
    const { body } = await skill(name)
    assert.ok(
      !/(?<!\$\{?CLAUDE_PLUGIN_ROOT\}?\/scripts\/)cli\.mjs/.test(body.replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?\/scripts\/cli\.mjs/g, 'OK')),
      `${name}: invokes cli.mjs without CLAUDE_PLUGIN_ROOT`,
    )
  }
})

test('adapted skills credit the upstream project', async () => {
  const ADAPTED = ['brainstorming', 'executing-plans', 'receiving-code-review', 'systematic-debugging', 'test-driven-development', 'writing-skills']
  const present = await allSkills()
  for (const name of ADAPTED.filter((n) => present.includes(n))) {
    const { body } = await skill(name)
    assert.match(body, /Adapted from the MIT-licensed superpowers plugin/, `${name}: missing attribution line`)
  }
})

test('parallel-execution documents all three model tiers and the --models flag', async () => {
  const { body } = await skill('parallel-execution')
  assert.match(body, /\bcheap\b/)
  assert.match(body, /\bmid\b/)
  assert.match(body, /\bcapable\b/)
  assert.match(body, /--models/)
})

test('phase-gate documents the fix decision and the cost-bound framing', async () => {
  const { body } = await skill('phase-gate')
  assert.match(body, /fix decision/)
  for (const decision of ['none', 'retry', 'escalate']) {
    assert.match(body, new RegExp('`' + decision + '`'), `phase-gate must document the ${decision} decision`)
  }
  assert.match(body, /cost bound, not a security bound/)
})

test('phase-gate says plainly what a none decision means and does not mean', async () => {
  const { body } = await skill('phase-gate')
  const start = body.indexOf('## On FAIL')
  const end = body.indexOf('## What the enforcement checks')
  assert.ok(start >= 0 && end > start, 'On FAIL section not found')
  const onFail = body.slice(start, end)
  const noneStart = onFail.indexOf('On `none`')
  assert.ok(noneStart >= 0, 'On FAIL must have a `none` branch')
  const none = onFail.slice(noneStart, onFail.indexOf('On `retry`'))
  assert.match(none, /never permission to integrate/i, '`none` must not read as "no fix needed"')
  assert.match(none.replace(/\s+/g, ' '), /gate again from scratch/i, '`none` must say to re-derive the verdict')
})

// A subcommand exists only if the CLI dispatches on it. Matching any quoted token in cli.mjs
// is too loose: `'status'` appears there several times as a state-file key, so a doc naming
// `cli.mjs status` would pass while describing a subcommand the CLI never routes to.
function dispatchedSubcommands(cli) {
  const subs = new Set()
  const usage = /usage:\s*cli\.mjs\s*<([^>]+)>/.exec(cli)
  if (usage) for (const sub of usage[1].split('|')) subs.add(sub.trim())
  for (const [, sub] of cli.matchAll(/command\s*===\s*'([a-z-]+)'/g)) subs.add(sub)
  return subs
}

test('the subcommand check reads dispatch sites, not every quoted token', async () => {
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  const subs = dispatchedSubcommands(cli)
  assert.ok(subs.has('gate'), 'gate is dispatched and must be recognised')
  assert.ok(!subs.has('fix-decision'), 'an unimplemented subcommand must not be recognised')
  assert.ok(cli.includes("'status'"), 'precondition: status appears quoted in cli.mjs')
  assert.ok(!subs.has('status'), 'status is a state-file key, not a dispatched subcommand')
})

test('phase-gate names no cli subcommand that scripts/cli.mjs does not dispatch', async () => {
  const { body } = await skill('phase-gate')
  const subs = dispatchedSubcommands(await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8'))
  for (const [, sub] of body.matchAll(/cli\.mjs["']?\s+([a-z-]+)/g)) {
    assert.ok(subs.has(sub), `phase-gate documents undispatched subcommand ${sub}`)
  }
})

test('phase-gate requires the fix decision to use this pass’s verdict, never the on-disk record', async () => {
  const { body } = await skill('phase-gate')
  const start = body.indexOf('## On FAIL')
  const end = body.indexOf('## What the enforcement checks')
  assert.ok(start >= 0 && end > start, 'On FAIL section not found')
  const onFail = body.slice(start, end).replace(/\s+/g, ' ')
  assert.match(onFail, /printed in this same pass/i, 'must pin the verdict to the current gate pass')
  assert.match(onFail, /never.{0,80}\.teammates\//i, 'must forbid reading the verdict from .teammates/')
  assert.match(onFail, /status\.gates/, 'must name the on-disk record it forbids')
})

test('phase-gate marks the fix-decision invocation as pending, not missing', async () => {
  const { body } = await skill('phase-gate')
  const start = body.indexOf('## On FAIL')
  const onFail = body.slice(start, body.indexOf('## What the enforcement checks')).replace(/\s+/g, ' ')
  assert.match(onFail, /pending, not missing/i, 'a reader who cannot find the command must know it is pending')
})

test('tm-implementer forbids weakening a test to satisfy a fix-round finding', async () => {
  const body = await readFile(new URL('../agents/tm-implementer.md', import.meta.url), 'utf8')
  assert.match(body, /do not weaken or delete a test/i)
})

test('phase-gate documents --results flag and rejects computed checks', async () => {
  const { body } = await skill('phase-gate')
  assert.match(body, /--results/, 'phase-gate must document the --results flag')
  // A single bound phrase, not three independent substring matches: three loose regexes
  // (`--results`, `command.*fileset.*ownership`, `entry is rejected`) all still match text
  // that inverts the rule ("only an agent or mcp entry is rejected"), because nothing ties
  // their sense together. This phrase carries its own polarity.
  const normalized = body.replace(/\s+/g, ' ')
  assert.match(
    normalized,
    /only `?agent`? and `?mcp`? checks may be supplied/i,
    'phase-gate must state, in one phrase, that only agent and mcp checks may be supplied',
  )
  assert.match(body, /entry is\s+rejected/, 'phase-gate must state that entries are rejected')
})

// Naming a subcommand the CLI dispatches is not enough: a flag can be renamed (e.g.
// `flags.results` -> `flags.supplied`) without touching the subcommand list, and the skill's
// invocation would then be silently wrong — the CLI would parse the renamed flag as a boolean
// and swallow the next token as a positional. Bind the flags the skill documents for `gate` to
// the flags scripts/cli.mjs actually declares for `gate` in its own USAGE string.
function gateUsageFlags(cli) {
  const usage = /const USAGE = `([\s\S]*?)`/.exec(cli)
  assert.ok(usage, 'cli.mjs must define a USAGE string')
  const gateLine = usage[1].split(/\r?\n/).find((l) => l.trim().startsWith('gate '))
  assert.ok(gateLine, 'cli.mjs USAGE must document the gate subcommand')
  return new Set([...gateLine.matchAll(/--[a-z-]+/g)].map((m) => m[0]))
}

test('phase-gate names no cli.mjs flag for gate that scripts/cli.mjs does not declare', async () => {
  const { body } = await skill('phase-gate')
  const cli = await readFile(new URL('../scripts/cli.mjs', import.meta.url), 'utf8')
  const acceptedFlags = gateUsageFlags(cli)

  let checked = 0
  for (const line of body.split(/\r?\n/)) {
    if (!/cli\.mjs["']?\s+gate\b/.test(line)) continue
    for (const [flag] of line.matchAll(/--[a-z-]+/g)) {
      checked++
      assert.ok(acceptedFlags.has(flag), `phase-gate documents ${flag} for gate, which scripts/cli.mjs USAGE does not declare`)
    }
  }
  assert.ok(checked > 0, 'precondition: phase-gate must document at least one cli.mjs gate flag')
})

test('phase-gate states that conflicts are escalated rather than retried', async () => {
  const { body } = await skill('phase-gate')
  assert.match(body, /merge.*check/i, 'phase-gate must document the merge check')
  const normalized = body.replace(/\s+/g, ' ')
  assert.match(normalized, /conflict.*escalate.*do not retry/i, 'phase-gate must state that conflicts are escalated and not retried')
})

test('phase-gate documents preview.link and states links are shared, not copied', async () => {
  const { body } = await skill('phase-gate')
  assert.match(body, /preview\.link/, 'phase-gate must mention preview.link')
  assert.match(body, /shared.*not.*copies?/i, 'phase-gate must state links are shared, not copies')
})

test('phase-gate states that a failed link fails the merge check', async () => {
  const { body } = await skill('phase-gate')
  const normalized = body.replace(/\s+/g, ' ')
  assert.match(normalized, /link.*fail.*merge.*check/i, 'phase-gate must state, in one phrase, that a failed link fails the merge check')
})
