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
  // Polarity requires a literal phrase, not scattered tokens. Assert the exact claim and its negation.
  assert.match(body, /shared, not copies?/i, 'phase-gate must state "shared, not copies"')
  assert.doesNotMatch(body, /links are copie/i, 'phase-gate must not claim links are copied')
})

test('phase-gate states that a failed link fails the merge check', async () => {
  const { body } = await skill('phase-gate')
  // Polarity requires a literal phrase, not scattered tokens. Assert the exact claim and its negation.
  // The sentence must state the link IS reported as a merge failure.
  assert.match(body, /is reported as a merge failure/i, 'phase-gate must state "is reported as a merge failure"')
  // The sentence must NOT state the link is reported as a command-check failure.
  assert.doesNotMatch(body, /link[^.]*is reported as a command-check failure/i, 'phase-gate must not state a link is reported as a command-check failure')
})

// The four assertions below cover procedures discovered by hand during a run that existed in no
// skill. Each binds its polarity in one contiguous phrase: an ordered chain of tokens scattered
// across the document is satisfied by text stating the opposite, so scattered matching is not
// evidence that the claim is present.
function phrase(body) {
  return body.replace(/[`*]/g, '').replace(/\s+/g, ' ')
}

test('parallel-execution says to prune a worktree when a teammate returns, not only after merge', async () => {
  const { body } = await skill('parallel-execution')
  const text = phrase(body)
  assert.match(
    text,
    /prune as soon as a teammate returns, not only after merge/i,
    'parallel-execution must state, in one phrase, that pruning happens when a teammate returns',
  )
  assert.match(
    text,
    /already used by worktree/i,
    'parallel-execution must name the failure a stale worktree causes on the next dispatch',
  )
  assert.match(text, /git worktree remove/, 'parallel-execution must name the command that prunes')
  assert.match(
    text,
    /only prune worktrees belonging to this run/i,
    'the guarantee must state its limit: only this run’s worktrees',
  )
})

test('parallel-execution requires detaching the main worktree before dispatching the integrator', async () => {
  const { body } = await skill('parallel-execution')
  const text = phrase(body)
  assert.match(body, /--detach/, 'parallel-execution must name --detach')
  // Bounded gap, not strict adjacency: an inserted clarifying sentence between the heading and
  // the instruction is ordinary editing, not a regression, but an unbounded gap would let the
  // two halves drift into unrelated sections and stop binding anything.
  assert.match(
    text,
    /before dispatching tm-integrator.{0,120}?detach the main worktree first: git checkout --detach/i,
    'parallel-execution must bind --detach to the step before the integrator dispatch, in one phrase',
  )
  assert.match(
    text,
    /cannot check it out while the main worktree holds it/i,
    'parallel-execution must say why the integrator needs the branch released',
  )
  assert.match(text, /git update-ref/, 'parallel-execution must name the unsupported workaround it prevents')
})

test('parallel-execution states an amendment committed only on the run branch does not move the anchor', async () => {
  const { body } = await skill('parallel-execution')
  const text = phrase(body)
  assert.match(
    text,
    /an amendment committed only on the run branch changes nothing: the merge-base does not move/i,
    'the polarity must live in one contiguous phrase, not in tokens spread across the section',
  )
  assert.match(
    text,
    /commit it on the base branch/i,
    'parallel-execution must say an authoritative amendment goes on the base branch',
  )
  assert.doesNotMatch(
    text,
    /commit(ting)? (it )?(only )?on the run branch (is enough|suffices|makes it authoritative)/i,
    'parallel-execution must not claim a run-branch-only amendment is authoritative',
  )
})

test('parallel-execution states the limit of the anchored plan read in the same breath', async () => {
  const { body } = await skill('parallel-execution')
  const text = phrase(body)
  // The guarantee ("a teammate cannot widen its own file set by editing the plan") holds only for
  // the working tree. A teammate that can move refs/heads/<base> can commit a widened file set for
  // itself, and that commit is exactly the step the amendment procedure prescribes — the anchor
  // then reads it. One contiguous phrase, so text asserting the opposite cannot satisfy it.
  assert.match(
    text,
    /a working-tree edit is inert, but a commit on the base branch is authoritative by design and is not distinguishable from an amendment the user made/i,
    'parallel-execution must state the base-branch limit in the same breath as the guarantee',
  )
  assert.match(
    text,
    /write access to the base branch/i,
    'parallel-execution must name what actually bounds the guarantee',
  )
  assert.doesNotMatch(
    text,
    /a teammate cannot widen its own file set by editing the plan\./i,
    'the guarantee must not be stated unqualified',
  )
})

test('parallel-execution documents the base-merge amendment route and whose operation a rebuild is', async () => {
  const { body } = await skill('parallel-execution')
  const text = phrase(body)
  // tm-integrator does checkout plus --no-ff merge and reports blocked otherwise, so "rebuild the
  // run branch, via tm-integrator" prescribes an operation its contract does not cover. The route
  // the gate's ownership check actually accepts is a base merge: its secondary parent is an
  // ancestor of the base, and it moves mergeBase(base, runBranch).
  assert.match(
    text,
    /merge the base into the run branch with --no-ff: that moves the merge-base onto the new base tip, and ownership accepts the merge because its secondary parent is an ancestor of the base/i,
    'parallel-execution must document the base-merge route in one contiguous phrase',
  )
  assert.match(
    text,
    /every secondary parent is checked, so a rogue parent riding alongside the base parent still fails/i,
    'the acceptance must state its limit in the same breath',
  )
  assert.match(
    text,
    /rebuilding the run branch is the orchestrator's operation, not the integrator's/i,
    'parallel-execution must assign the rebuild fallback to the orchestrator',
  )
  assert.doesNotMatch(
    text,
    /rebuild the run branch on the new base tip, via tm-integrator/i,
    'parallel-execution must not dispatch the integrator to rebuild the run branch',
  )
})

test('phase-gate states reviewers are dispatched without a name and a named one loses its result', async () => {
  const { body } = await skill('phase-gate')
  const text = phrase(body)
  assert.match(
    text,
    /without a name\. A named reviewer becomes an addressable teammate that goes idle without emitting its result, and the review is lost/i,
    'phase-gate must bind "no name" to "the result is lost" in one contiguous phrase',
  )
  assert.match(
    text,
    /unnamed reviewers return normally/i,
    'phase-gate must state the positive half of the rule too',
  )
  assert.doesNotMatch(
    text,
    /dispatch one tm-reviewer per lens[^.]*with a name/i,
    'phase-gate must not tell the reader to name a reviewer',
  )
})
