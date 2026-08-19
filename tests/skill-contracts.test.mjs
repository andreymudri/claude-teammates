import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCli } from '../scripts/cli.mjs'
import { collectReviewResults } from '../scripts/reviews.mjs'
import {
  assertClaim,
  assertCode,
  assertNoStatement,
  assertStatement,
  parseDoc,
  splitFrontmatter,
} from './md-contract.mjs'

const dir = new URL('../skills/', import.meta.url)

// The prose assertions in this file run against the structural model in md-contract.mjs —
// sections, blocks, statements — instead of regexes over a whitespace-normalised whole document.
// Read that module's header before trusting a green run here: it states precisely which insertions
// it detects and which it cannot, and contradiction detection in general is not one of them.

export async function allSkills() {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

export async function skill(name) {
  const text = await readFile(new URL(`${name}/SKILL.md`, dir), 'utf8')
  const { fields, body } = splitFrontmatter(text, name)
  return { fields, body, doc: parseDoc(body, `${name}/SKILL.md`) }
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
    const { doc } = await skill(name)
    assertStatement(doc, /Adapted from the MIT-licensed superpowers plugin/, `${name}: missing attribution line`)
  }
})

test('parallel-execution documents all three model tiers and the --models flag', async () => {
  const { doc } = await skill('parallel-execution')
  assert.match(doc.text, /\bcheap\b/)
  assert.match(doc.text, /\bmid\b/)
  assert.match(doc.text, /\bcapable\b/)
  assert.match(doc.text, /--models/)
})

test('phase-gate documents the fix decision and the cost-bound framing', async () => {
  const { doc } = await skill('phase-gate')
  const onFail = doc.section('On FAIL')
  assertStatement(onFail, /fix decision/, 'phase-gate must name the fix decision')
  assertStatement(
    onFail,
    /one of three decisions — none, retry, or escalate —/i,
    'phase-gate must document all three decisions in one statement',
  )
  assertClaim(onFail, {
    label: 'round budget',
    // One statement: the splitter does not break `... security bound. fixRounds lives in ...`
    // because the next word is lowercase once the backticks are normalised away, and
    // under-splitting is the safe direction. The pattern therefore spans both halves.
    claim: /^The round budget is a cost bound, not a security bound\. fixRounds lives in status\.json, which is written by the agents the gate enforces\b/i,
    then: /A teammate that rewrites its own count buys itself more retries — wasted tokens, not a false PASS/i,
    subject: /cost bound|security bound|tamper-evident/i,
    allow: [/Do not describe the loop as tamper-evident; only fileset and ownership carry that property/i],
  })
})

// `unableToVerify` and `unprobed` are the two `claims` results that are not findings. An
// orchestrator that never learns of them reads a bounded, or an unrun, review as a clean one —
// which is the same class of defect the lens exists to catch, one level up.
test('phase-gate documents the two claims results that are not findings', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  assertStatement(
    section,
    /collect-reviews acts on both/i,
    'phase-gate must say collect-reviews acts on both keys, since it now does',
  )
  assertStatement(
    section,
    /reads `?lens`?, `?stamp`?, `?findings`?, `?unableToVerify`? and `?unprobed`?, and ignores every other key/i,
    'phase-gate must say what collectReviewResults reads, in the verb that is true of it',
  )
  assertStatement(
    section,
    /`?stamp`? is consumed to reject a stale file and then dropped from the emitted result/i,
    'phase-gate must not let "reads" be misread as "keeps" for stamp',
  )
  assertStatement(
    section,
    /unableToVerify means the reviewer could not build the phase.s tree or get a green baseline/i,
    'phase-gate must say what unableToVerify means',
  )
  // The replacement for "collected today as a pass". The refusal is the whole point of the
  // change, so the skill has to name all three of its observable parts — refused like a missing
  // lens, nothing emitted, exit 4 naming the lens and its reason — or an orchestrator reading
  // only this section would still not know what to do when it happens.
  assertStatement(
    section,
    /refused exactly like a lens with no file at all/i,
    'phase-gate must say an unableToVerify lens is refused the way a missing one is',
  )
  assertStatement(
    section,
    /nothing is emitted, `?collect-reviews`? names the lens and its reason and exits 4/i,
    'phase-gate must say what the refusal looks like from the CLI, including the exit code',
  )
  // The empty-string carve-out is behaviour a reader would otherwise have to guess at, and
  // guessing it the other way would have them respawn a lens that did its work.
  assertStatement(
    section,
    /an empty string is not a report of failure and collects normally/i,
    'phase-gate must say that the key\'s mere presence is not what refuses a lens',
  )
  // The third route is behaviour an orchestrator meets only when something is already wrong, so
  // the section has to say the key is read as a string and nothing else — otherwise the response
  // to it is guessed at, and both guesses are wrong.
  assertStatement(
    section,
    /the key is read only as a reason string/i,
    'phase-gate must say which shape of unableToVerify is actually read',
  )
  assertStatement(
    section,
    /the fix is to the file rather than a respawn/i,
    'phase-gate must say a malformed key is not answered by respawning the review',
  )
  assertStatement(
    section,
    /unprobed lists claims it enumerated and did not reach/i,
    'phase-gate must say what unprobed lists',
  )
  assertStatement(
    section,
    /the count is surfaced in the emitted check.s `?output`?/i,
    'phase-gate must say where unprobed reaches the operator, now that it does',
  )
  // The two keys fail the same way, so the section must not document a shape rule for one and
  // leave the other looking permissive — that asymmetry is what let `unprobed: 32` be counted as
  // nothing while `unableToVerify: 32` was refused.
  assertStatement(
    section,
    /it is read only in its documented shape, a list/i,
    'phase-gate must say unprobed is read only as a list, as it says of unableToVerify',
  )
  assertStatement(
    section,
    /an empty list is a review that reached everything it enumerated, and collects silently/i,
    'phase-gate must say an empty unprobed is not the malformed case',
  )
})

// The statements above are claims about code, so they are pinned against the code rather than
// only against themselves. If `collectReviewResults` ever stops refusing an `unableToVerify`
// lens, this fails and the skill sentences saying it does have to be rewritten — which is the
// direction of drift that produced this finding in the first place.
test('collect-reviews really does refuse an unableToVerify claims review rather than passing it', async () => {
  // The stamp has to EXIST for the refusal to be an assertion about the key rather than about
  // staleness. Without it the file would be rejected before `unableToVerify` was ever consulted,
  // and the test would pass whatever the code did with that key — which is this project's
  // signature defect committed one level up, inside the test written to close an instance of it.
  // `expected` matches, so the file is current and reaches the point where the key decides.
  const stamp = { phase: '1', lens: 'claims', branches: ['teammates/r1/T1@abc123'] }
  const out = collectReviewResults({
    lenses: ['claims'],
    expected: { phase: '1', branches: ['teammates/r1/T1@abc123'] },
    files: [{ lens: 'claims', stamp, findings: [], unableToVerify: 'the baseline suite was red', unprobed: ['a.mjs:1'] }],
  })
  assert.deepEqual(out.stale, [], 'the fixture must not be rejected as stale, or it proves nothing')
  assert.deepEqual(out.results, [], 'a lens that verified nothing must emit no result at all')
  assert.deepEqual(out.unverified, [{ lens: 'claims', reason: 'the baseline suite was red' }])
  // Unaccounted for in the same sense a lens with no file is, which is what the skill says.
  assert.deepEqual(out.missing, ['claims'])
})

// The other half of the same contract, and the reason the fixture above proves anything: with the
// one key removed, the identical file collects. Without this, "refused because of
// `unableToVerify`" would be indistinguishable from "refused for some unrelated reason", and the
// three key-absence assertions below would have nowhere left to live once the result went away.
test('the same claims file without unableToVerify collects, and keeps none of the three read keys', async () => {
  const stamp = { phase: '1', lens: 'claims', branches: ['teammates/r1/T1@abc123'] }
  const out = collectReviewResults({
    lenses: ['claims'],
    expected: { phase: '1', branches: ['teammates/r1/T1@abc123'] },
    files: [{ lens: 'claims', stamp, findings: [], unprobed: ['a.mjs:1'] }],
  })
  assert.deepEqual(out.stale, [], 'the fixture must not be rejected as stale, or it proves nothing')
  assert.deepEqual(out.unverified, [])
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].status, 'pass')
  // Read, and then not kept: neither key survives into the emitted result as a key, so nothing
  // downstream of the CLI can recover the list. What survives of `unprobed` is a count in
  // `output`, which is what the skill says and is asserted here rather than merely described.
  assert.equal('unableToVerify' in out.results[0], false)
  assert.equal('unprobed' in out.results[0], false)
  assert.match(out.results[0].output, /1 enumerated claim\(s\) NOT reached/)
  // `stamp` is read — `reviewStale` consumes it — and then dropped from the result just like the
  // two keys above. The skill said "keeps lens, stamp and findings", which overstated by one key
  // in the very sentence written to correct an overstatement. This is what makes the corrected
  // wording checkable rather than merely more careful.
  assert.equal('stamp' in out.results[0], false)
})

test('phase-gate says plainly what a none decision means and does not mean', async () => {
  const { doc } = await skill('phase-gate')
  const onFail = doc.section('On FAIL')
  // `none` and its disclaimer must be adjacent statements of the same paragraph, and every other
  // sentence in the section that mentions `none` has to be one of the two listed below. A new
  // sentence about `none` fails whatever it says — no vocabulary of negations is consulted.
  assertClaim(onFail, {
    label: 'the none decision',
    // Both `claim:` and `then:` are anchored end-to-end for the same reason as the `allow`
    // entries below: `assertClaim`'s subject screen exempts BOTH the claim statement and its
    // `then` consequence from the inventory check (it would otherwise flag itself), so an
    // unanchored pattern on either one is the one place a clause appended to that exact sentence
    // — e.g. turning "it is never permission to integrate" into "... unless the gate already ran
    // once" — goes unscreened everywhere else in this test.
    claim: /^On none, the decision engine found no failing check in the verdict you handed it\.$/i,
    then: /^This does not mean "the failure needs no fix" and it is never permission to integrate\.$/i,
    subject: /\bnone\b/i,
    // Every entry below is anchored end-to-end (^...$), not just at the front or not at all.
    // An unanchored — or front-only-anchored — pattern waives any statement that merely CONTAINS
    // or STARTS WITH the approved text, so a mutated tail appended to an otherwise-approved
    // sentence (e.g. "... never on `none` unless the gate already ran once, in which case none
    // is enough to integrate on.") would still match and sail through, admitting the exact
    // inversion this lock exists to catch. Anchoring forces the whole statement to equal what
    // was reviewed.
    allow: [
      /^Hand it the run, the failing phase, the run root, and the verdict JSON you just produced; it prints one of three decisions — none, retry, or escalate — and exits 0 for all three, so read the decision field rather than the exit status\.$/i,
      /^Feeding that record in today degenerates harmlessly, because the persisted object carries no results key and the decision comes back none; that is incidental, not guaranteed\.$/i,
      /^You reached this section because the gate failed, so a none decision means the verdict you passed is not the one that failed — a stale file, the wrong phase, the wrong run root, or a verdict written before the last check completed\.$/i,
      /^Integrate only on a freshly recomputed PASS, never on none\.$/i,
      // Reviewed: this documents the `fix` exit-code contract (Exit 0 covers all three
      // decisions), not the semantics of a `none` decision itself — unrelated to the claim above.
      /^Exit 0 covers none, retry, and escalate alike, so the exit status never tells them apart — only the decision field does\.$/i,
    ],
  })
  assertStatement(
    onFail,
    /Re-derive the verdict by running the gate again from scratch and ask again/i,
    '`none` must say to re-derive the verdict',
  )
  assertStatement(
    onFail,
    /Integrate only on a freshly recomputed PASS, never on none/i,
    '`none` is never permission to integrate',
  )
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
  const { doc } = await skill('phase-gate')
  // One statement carries the whole rule: the source of the verdict, the prohibition, and the
  // path it forbids. Three independent regexes over the section could each match while the text
  // between them said the opposite.
  assertClaim(doc.section('On FAIL'), {
    label: 'verdict provenance',
    claim: /The verdict you hand it must be the JSON this gate printed in this same pass, and must never be read back from \.teammates\//i,
    then: /The only verdict persisted on disk lives in status\.gates\[<phase>\]/i,
    subject: /status\.gates/i,
  })
})

test('phase-gate documents the real fix invocation and its exit-code contract', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('On FAIL')
  assertCode(section, /fix --run <runId> --phase <n> --verdict <path>/, 'phase-gate must show the fix invocation')
  assertClaim(section, {
    label: 'fix exit codes',
    // Anchored end-to-end, both patterns: the subject screen exempts the claim statement AND its
    // `then` consequence from the inventory check, so leaving either open at the end lets a
    // clause appended to that exact sentence pass unscreened, the same hole the `allow` entry
    // below was fixed for.
    claim: /^--verdict names a file holding that same JSON, and --phase must match its own phase field — a mismatch exits 2 rather than adjudicating the wrong phase's findings, and so does a malformed teammates\.gate\.json\.$/i,
    then: /^Exit 1 means the run has no plan at all or the verdict file could not be read: an argument error, not a decision\.$/i,
    subject: /\bexit 0\b|\bexit 1\b|\bexit 2\b/i,
    allow: [
      /^Exit 0 covers none, retry, and escalate alike, so the exit status never tells them apart — only the decision field does\.$/i,
    ],
  })
})

// The skill's exit-1 sentence names two distinct causes ("no plan at all" and "the verdict file
// could not be read"); the other two documented codes (0 and 2) are pinned by `decideFix`'s own
// unit tests and by the derived-context / gateConfig plumbing elsewhere, but nothing previously
// ran `fix` through the CLI itself to pin exit 1. Invoking `runCli` directly, the same pattern
// `tests/cli.test.mjs` uses, so a rename of either `return 1` in scripts/cli.mjs's `fix` handler
// breaks this test rather than only the prose.
test('the CLI actually exits 1 for both causes phase-gate documents under exit 1 for fix', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-skill-fix-'))
  const io = { out: () => {}, err: () => {} }
  try {
    // No `init-run` has happened for this run id at all: no plan exists.
    const noPlanCode = await runCli(
      ['fix', '--run', 'ghost-run', '--phase', '1', '--verdict', path.join(root, 'verdict.json'), '--root', root],
      io,
    )
    assert.equal(noPlanCode, 1, 'fix must exit 1 when the run has no plan')

    // A run WITH a plan, but a --verdict path that cannot be read.
    const planPath = path.join(root, 'plan.md')
    await writeFile(planPath, '### Task 1: A\n\n**Files:**\n- Create: `a.mjs`\n', 'utf8')
    assert.equal(await runCli(['init-run', planPath, '--run', 'r1', '--root', root], io), 0)
    const badVerdictCode = await runCli(
      ['fix', '--run', 'r1', '--phase', '1', '--verdict', path.join(root, 'missing-verdict.json'), '--root', root],
      io,
    )
    assert.equal(badVerdictCode, 1, 'fix must exit 1 when the verdict file cannot be read')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tm-implementer forbids weakening a test to satisfy a fix-round finding', async () => {
  const text = await readFile(new URL('../agents/tm-implementer.md', import.meta.url), 'utf8')
  const { body } = splitFrontmatter(text, 'tm-implementer.md')
  assertStatement(
    parseDoc(body, 'tm-implementer.md'),
    /do not weaken or delete a test/i,
    'tm-implementer must forbid weakening a test',
  )
})

test('phase-gate documents --results flag and rejects computed checks', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  assertCode(section, /--results/, 'phase-gate must document the --results flag on the gate command')
  // One statement, not three loose matches: `--results`, `command.*fileset.*ownership` and
  // `entry is rejected` all still match text that inverts the rule ("only an agent or mcp entry
  // is rejected"), because nothing ties their sense together. The sentence boundary does.
  assertClaim(section, {
    label: 'supplied results',
    claim: /^Only agent and mcp checks may be supplied; a command, fileset, or ownership entry is rejected\b/i,
    then: /The verdict is recomputed from the merged set, so a recorded PASS is always CLI-computed/i,
    subject: /may be supplied|entry is rejected/i,
  })
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
  const { doc } = await skill('phase-gate')
  const section = doc.section(/merge check does/)
  assertStatement(
    section,
    /A conflict fails the merge check and names both branches and the conflicting paths/i,
    'phase-gate must document the merge check on conflicts',
  )
  assertClaim(section, {
    label: 'conflict handling',
    claim: /Treat a conflict like a process violation: escalate it, do not retry/i,
    then: /No single teammate can fix a conflict between two file sets, so redispatching one owner cannot resolve it/i,
    subject: /escalate it|do not retry|redispatching/i,
  })
})

test('phase-gate documents preview.link and states links are shared, not copied', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section(/merge check does/)
  assertStatement(section, /preview\.link is not consulted/, 'phase-gate must mention preview.link')
  assertCode(section, /"preview":\s*\{\s*"link"/, 'phase-gate must show the preview.link config shape')
  // The subject lock replaces `doesNotMatch(/links are copie/i)`: every sentence in this section
  // about copying has to be listed, so a claim that links are copies fails however it is phrased.
  assertClaim(section, {
    label: 'link semantics',
    claim: /^Links are shared, not copies\b/i,
    then: /A check that writes into node_modules writes to the real one, because it is the same directory/i,
    subject: /\bcop(y|ies|ied|ying)\b/i,
    allow: [/That is the cost of linking; copying a real dependency tree is minutes per gate run/i],
  })
})

test('phase-gate states that a failed link fails the merge check', async () => {
  const { doc } = await skill('phase-gate')
  assertClaim(doc.section(/merge check does/), {
    label: 'link failure routing',
    claim: /A link that cannot be made is reported as a merge failure rather than left to surface as a command-check failure/i,
    subject: /is reported as a (merge|command-check) failure/i,
  })
})

// The earlier version of this rule said to prune the moment a teammate returned. `phase-gate`
// resumes that same teammate on a `retry` decision, and a resumed agent whose worktree is gone
// fails to start at all — so following both skills in order foreclosed the recovery path the
// gate depends on. The rule now holds the worktree until the phase passes, and names the one
// case that still needs an early removal: handing the task to a fresh implementer.
// Unnamed dispatch is the first-line remedy for a reviewer that idles without emitting; the
// file drop covers a returning dispatch that dies anyway. Both halves have to be stated, and
// the missing-result case must never be recorded as an empty findings array — "no result" and
// "no findings" are different facts and only one of them is a pass.
test('phase-gate gives each reviewer a findings path and reads it before respawning', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  assertStatement(
    section,
    /name a findings path per lens/i,
    'each reviewer dispatch must carry the path it writes to',
  )
  assertStatement(
    section,
    /read that file before respawning/i,
    'an idle reviewer must be recovered from its file, not paid for twice',
  )
  assertStatement(
    section,
    /a missing result is never an empty findings array/i,
    'phase-gate must forbid scoring a lost review as a clean pass',
  )
})

test('parallel-execution keeps a returned teammate’s worktree until its phase passes the gate', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  assertClaim(section, {
    label: 'worktree pruning',
    claim: /^Prune after the phase passes its gate, not when a teammate returns:.*a resumed teammate whose worktree is gone cannot start/i,
    then: /Remove the worktree once the phase has a recorded PASS \(git worktree remove <path>\), then git worktree prune/i,
    subject: /\bprun(e|es|ed|ing)\b/i,
    allow: [
      /^Only prune worktrees belonging to this run\.$/i,
      /^If a task must go to a fresh implementer instead — because resuming stalled — prune that task's worktree first, since a returned teammate's worktree keeps its branch checked out and the new dispatch would fail with "already used by worktree"; then restate the findings, the branch and the file set in its dispatch, because none of that survives the handover\.$/i,
      // Reviewed: the command bullet states the same rule mechanically — it recomputes each
      // phase's gate and removes only worktrees whose phase passes — so it reinforces the claim
      // rather than qualifying it.
      /^Prune with the command rather than by hand:$/i,
      /^It recomputes each phase's gate, removes only this run's worktrees whose phase passes, and names every one it left alone and why\.$/i,
      /^Without --yes it reports and removes nothing\.$/i,
      // Reviewed: `--enforcement-only` documentation below. Neither sentence qualifies this
      // claim — the first only names `prune-run` as one of the two callers the flag speeds up,
      // the second reinforces the same "PASS resting on a skipped check is not prunable" guardrail
      // in `--enforcement-only`'s own terms rather than contradicting it.
      /^finish and prune-run otherwise recompute every command check of every phase — for a five-phase run, five full test suites — to answer a question that usually does not need them\.$/i,
      /^And it will not let prune-run remove a worktree for a phase whose PASS rests on a check the flag skipped — a cheap verdict is enough to report, not enough to delete\.$/i,
    ],
  })
  assertStatement(
    section,
    /Only prune worktrees belonging to this run/i,
    'the guarantee must state its limit: only this run’s worktrees',
  )
  assertStatement(
    section,
    /prune that task's worktree first/i,
    'the one case needing an early removal — a fresh implementer on that task — must be named',
  )
  assertStatement(
    section,
    /restate the findings, the branch and the file set in its dispatch/i,
    'a fresh implementer inherits nothing, so the dispatch must carry what the resume would have',
  )
})

test('parallel-execution requires detaching the main worktree before dispatching the integrator', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Before dispatching tm-integrator')
  // The structural form of "the paragraph introducing the command block states Y": the claim is a
  // statement of a prose block, and the block immediately after it is the code block it
  // introduces. A paragraph or code block inserted between them fails; so does any other sentence
  // in the section that speaks about detaching.
  assertClaim(section, {
    label: 'detach before dispatch',
    claim: /^Detach the main worktree first:?$/i,
    introduces: /git checkout --detach/,
    subject: /\bdetach\w*\b/i,
  })
  assertStatement(
    section,
    /cannot check it out while the main worktree holds it/i,
    'parallel-execution must say why the integrator needs the branch released',
  )
  assertStatement(
    section,
    /reaches for git update-ref/i,
    'parallel-execution must name the unsupported workaround it prevents',
  )
})

test('parallel-execution states an amendment committed only on the run branch does not move the anchor', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Amending a plan mid-run')
  assertClaim(section, {
    label: 'run-branch-only amendment',
    claim: /an amendment committed only on the run branch changes nothing: the merge-base does not move/i,
    subject: /committed only on the run branch/i,
    forbid: [/commit(ting)? (it )?(only )?on the run branch (is enough|suffices|makes it authoritative)/i],
  })
  assertStatement(
    section,
    /Commit it on the base branch/i,
    'parallel-execution must say an authoritative amendment goes on the base branch',
  )
})

test('parallel-execution states the limit of the anchored plan read in the same breath', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Amending a plan mid-run')
  // The guarantee ("a teammate cannot widen its own file set by editing the plan") holds only for
  // the working tree. A teammate that can move refs/heads/<base> can commit a widened file set for
  // itself, and that commit is exactly the step the amendment procedure prescribes — the anchor
  // then reads it. One statement, so text asserting the opposite cannot satisfy it.
  assertClaim(section, {
    label: 'anchored plan read',
    claim: /State the limit with the guarantee: the plan is read from git at the anchor, so a working-tree edit is inert, but a commit on the base branch is authoritative by design and is not distinguishable from an amendment the user made/i,
    then: /A teammate has Bash; if it can move refs\/heads\/<base>/i,
    forbid: [/a teammate cannot widen its own file set by editing the plan\./i],
  })
  assertStatement(
    section,
    /What bounds this is write access to the base branch, not the plan read/i,
    'parallel-execution must name what actually bounds the guarantee',
  )
})

test('parallel-execution documents the base-merge amendment route and whose operation a rebuild is', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Amending a plan mid-run')
  // tm-integrator does checkout plus --no-ff merge and reports blocked otherwise, so "rebuild the
  // run branch, via tm-integrator" prescribes an operation its contract does not cover. The route
  // the gate's ownership check actually accepts is a base merge: its secondary parent is an
  // ancestor of the base, and it moves mergeBase(base, runBranch).
  assertClaim(section, {
    label: 'base-merge route',
    claim: /Merge the base into the run branch with --no-ff: that moves the merge-base onto the new base tip, and ownership accepts the merge because its secondary parent is an ancestor of the base/i,
    then: /The limit on that acceptance: every secondary parent is checked, so a rogue parent riding alongside the base parent still fails/i,
  })
  // The base merge is likewise not an integrator dispatch. tm-integrator merges teammate branches
  // only after a gate PASS and stops on files outside a task's declared set; an amendment has no
  // PASS (the failing gate is why it exists), the base is no teammate branch, and the merge carries
  // planPath, which no task declares. A contracted integrator refuses, so the orchestrator does it.
  assertClaim(section, {
    label: 'base merge ownership',
    claim: /Merging the base into the run branch is the orchestrator's operation, not a tm-integrator dispatch/i,
    forbid: [/(so|then) dispatch tm-integrator, which is the sole writer to it/i],
  })
  assertClaim(section, {
    label: 'rebuild ownership',
    claim: /Rebuilding the run branch is the orchestrator's operation, not the integrator's/i,
    forbid: [/rebuild the run branch on the new base tip, via tm-integrator/i],
  })
})

test('parallel-execution gives the rebase step a rationale runFilesetCheck does not contradict', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Amending a plan mid-run')
  // runFilesetCheck diffs each task branch from `await git.mergeBase(runSha, sha)` — the branch's
  // own fork point off the run branch, never the run anchor. So an un-rebased in-flight branch
  // still diffs to its own changes only, and the fileset failure the old rationale predicted
  // cannot occur. The step is still right; a false reason invites skipping it.
  assertClaim(section, {
    label: 'rebase rationale',
    claim: /never from the anchor, so an un-rebased branch still diffs to its own changes only/i,
    then: /Rebase because the branch needs the amended plan and the interfaces earlier phases merged/i,
    forbid: [/or its diff against the new anchor will contain every file the earlier phases merged/i],
  })
})

test('phase-gate states reviewers are dispatched without a name and a named one loses its result', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  assertClaim(section, {
    label: 'unnamed reviewers',
    claim: /dispatch one tm-reviewer per lens in parallel over the phase diff, without a name/i,
    then: /A named reviewer becomes an addressable teammate that goes idle without emitting its result, and the review is lost; unnamed reviewers return normally/i,
    subject: /\b(name|named|unnamed)\b/i,
    allow: [
      /Six consecutive named dispatches were lost this way in run preview/i,
      /^The file is \{ "results"/i,
      // Reviewed: this "name" is the findings path the dispatch carries, not the agent name the
      // claim above forbids. The two uses are unrelated and the fallback does not weaken the
      // unnamed-dispatch rule — it covers the case where an unnamed reviewer dies anyway.
      /^Name a findings path per lens in the dispatch/i,
      // Reviewed: this "name" is a CHECK name out of the gate manifest, listed among the values
      // printed through `printable`. It says nothing about how a reviewer is dispatched, so it
      // cannot weaken the unnamed-dispatch rule the claim above states.
      /^Where a line quotes a value an agent wrote/i,
    ],
    forbid: [/dispatch one tm-reviewer per lens[^.]*with a name/i],
  })
})

test('parallel-execution states the blast radius is context, not an enforced file set', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('The map')
  // The no-edit rule needs its own inventory lock: as a bare assertStatement it stayed green
  // while a later sentence in the same section granted the permission back ("when the task
  // requires it, a teammate should go ahead and edit those files too"). Locking on `edit` makes
  // any second sentence in this section about editing a reviewed decision.
  assertClaim(section, {
    label: 'blast radius files are not editable',
    claim: /they are outside the file set, so the teammate may not edit them/i,
    subject: /\bedit(s|ed|ing)?\b/i,
  })
  assertClaim(section, {
    label: 'coupling is correlation, not enforcement',
    claim: /^Coupling is correlation in history, not a dependency\b/i,
    then: /Nothing enforces it and no gate reads it/i,
    // The subject must name what is being claimed about, not repeat the `then` pattern — a
    // subject copied from `then` can only ever match the statement `then` already exempts, so it
    // locks nothing and deleting it changes no outcome.
    subject: /coupling|blast radius/i,
    allow: [
      /^Every generated brief carries a blast radius/i,
      /^Coupling for a brief is computed over a fixed window/i,
      /^A brief with no blast radius section usually means new files/i,
    ],
  })
})

test('parallel-execution states the coupling window is bounded, not the whole history', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('The map')
  // Correction to the plan: the brief's window is not a default and not settable — the workflow
  // path hardcodes 500 and `--commits` reaches only the standalone `map` command. Two contiguous
  // patterns, no `.*` between the halves of either claim: a character gap is exactly the hole
  // md-contract.mjs exists to close, and a single sentence spanning it can keep both anchor
  // phrases while cancelling the claim in between.
  assertStatement(
    section,
    /Coupling for a brief is computed over a fixed window of the last 500 commits, which the workflow path hardcodes and no flag changes/i,
    'the skill must state the brief window is fixed at 500 commits, not a settable default',
  )
  assertStatement(
    section,
    /--commits sets the window for the standalone map command only, and workflow --commits is swallowed without complaint/i,
    'the skill must confine --commits to the map command and say workflow silently ignores it',
  )
  // The support floor, not an empty repository, is the ordinary reason a brief has no section.
  assertStatement(
    section,
    /a declared file needs at least three commits of its own history before coupling counts it/i,
    'the skill must name the support floor so a section-less brief does not read as a broken dispatch',
  )
})

test('parallel-execution documents --enforcement-only and what it is for', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  // Why the flag exists at all. Without this a reader sees the guardrails below but never learns
  // what the flag buys — the whole reason `finish` and `prune-run` recompute every command check
  // of every phase in the first place.
  assertStatement(
    section,
    /^finish and prune-run otherwise recompute every command check of every phase — for a five-phase run, five full test suites — to answer a question that usually does not need them\.$/i,
    '--enforcement-only must state what it is for',
  )
})

// The three `subject:` locks below (scope, refusal, prune guard) each catch a contradicting
// neighbour that uses the vocabulary the subject names — "ownership check", "refus-", "remove" /
// "delete". A sentence that negates the pinned claim without using any of that vocabulary passes
// unreviewed, the same limit `tests/md-contract.mjs:41-52` documents for this whole module: this
// is a vocabulary lock, not a semantic one, and no amount of widening turns it into one. Piling on
// more subject words to chase completeness is the wrong fix — it only pulls more legitimate
// neighbours into each `allow` list, which is how a lock stops locking. An accurate note about a
// partial lock, not a wider vocabulary, is the stable end state.
test('parallel-execution states --enforcement-only drops only command checks', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  assertClaim(section, {
    label: 'enforcement-only scope',
    claim: /^It drops only command checks; fileset, ownership, and the merge check the gate computes for itself still run\.$/i,
    // Widened from a phrase unique to this sentence ("drops only", which nothing else could ever
    // repeat) to the check-kind nouns a contradicting neighbour would actually use. Proven by
    // mutation: "It also skips the ownership check, and it refuses nothing when a phase declares
    // no checks at all." is caught by this subject — it names "ownership check" — though it
    // shares none of the claim's own wording.
    subject: /\b(fileset|ownership|command check)/i,
    allow: [
      // Reviewed: the refusal claim below. It names fileset and ownership as what a manifest must
      // declare for the flag to answer at all, consistent with — not qualifying — the claim that
      // both checks still run.
      /^It REFUSES with exit 2 when a phase's manifest declares no fileset and no ownership check, because with nothing else to verify the result would be meaningless\.$/i,
      // Reviewed: the purpose sentence. It says finish/prune-run normally run every command
      // check of every phase; it says nothing about what --enforcement-only itself drops or
      // keeps, so it does not qualify this claim.
      /^finish and prune-run otherwise recompute every command check of every phase — for a five-phase run, five full test suites — to answer a question that usually does not need them\.$/i,
    ],
  })
})

test('parallel-execution states every check --enforcement-only drops is reported as skip', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  assertStatement(
    section,
    /^Every dropped check is reported as skip, never silently omitted\.$/i,
    '--enforcement-only must state dropped checks are always reported, never silently omitted',
  )
})

test('parallel-execution states --enforcement-only refuses a phase with no enforcement check', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  assertClaim(section, {
    label: 'enforcement-only refusal',
    claim: /^It REFUSES with exit 2 when a phase's manifest declares no fileset and no ownership check, because with nothing else to verify the result would be meaningless\.$/i,
    // Widened from the case-sensitive, claim-only /\bREFUSES\b/ (which even "refuses" missed) to
    // every inflection of the verb, case-insensitively. Proven by mutation: "...and it refuses
    // nothing when a phase declares no checks at all" is caught.
    subject: /\brefus(e|es|ed|ing)\b/i,
  })
})

test('parallel-execution states --enforcement-only never authorises a prune on a skipped check', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Worktree mechanics')
  assertClaim(section, {
    label: 'enforcement-only prune guard',
    claim: /^And it will not let prune-run remove a worktree for a phase whose PASS rests on a check the flag skipped — a cheap verdict is enough to report, not enough to delete\.$/i,
    // Widened from "not enough to delete", a phrase unique to this sentence, to every inflection
    // of remove/delete — the verbs a contradicting neighbour would actually use. Proven by
    // mutation: "In practice, pass --yes as well and it will remove the worktree regardless." is
    // caught, though it shares none of the claim's own wording.
    subject: /\b(remov(e|es|ed|ing)|delet(e|es|ed|ing))\b/i,
    allow: [
      // Reviewed: the prune-run command bullet's own description of its ordinary removal
      // behaviour, for a PASS it computed itself — a different claim than this flag's guardrail
      // on a PASS resting on what the flag skipped.
      /^It recomputes each phase's gate, removes only this run's worktrees whose phase passes, and names every one it left alone and why\.$/i,
      /^Without --yes it reports and removes nothing\.$/i,
      // Reviewed: the worktree-pruning bullet's own removal instruction for the ordinary case of
      // a recorded PASS — again a different claim than this flag's guardrail.
      /^Remove the worktree once the phase has a recorded PASS \(git worktree remove <path>\), then git worktree prune\.$/i,
    ],
  })
})

test('fleet-lifecycle states who writes the map notes and that nothing enforced reads them', async () => {
  const { doc } = await skill('fleet-lifecycle')
  const section = doc.section('Map notes')
  assertStatement(
    section,
    /a teammate never writes this file, and nothing enforced ever reads it/i,
    'the skill must keep map notes out of both the write path and the enforcement path',
  )
})

test('fleet-lifecycle states the Explore prompt filters directory names before they render', async () => {
  const { doc } = await skill('fleet-lifecycle')
  const section = doc.section('Map notes')
  // Correction to the plan: the Explore prompt is handed to an agent with Bash and no gate, so
  // the skill has to say the directory names it carries are filtered, not merely listed. The
  // claim is anchored end-to-end AND subject-locked: an unanchored substring stayed green while
  // the same sentence trailed off into "…but the filter is advisory and the raw names are used
  // when it returns nothing".
  assertClaim(section, {
    label: 'carried directory names are filtered',
    claim: /^The directory names that prompt carries are filtered — anything that is not a plain path segment is dropped — because that prompt is handed to an agent that has Bash and is gated by nothing\.$/i,
    subject: /filter(s|ed|ing)?\b|directory names/i,
  })
})

test('fleet-lifecycle claims only what map-notes verifies, and names every exit code', async () => {
  const { doc } = await skill('fleet-lifecycle')
  const section = doc.section('Map notes')
  // mapNotesStale compares a header the writing agent was TOLD to copy against HEAD. Nothing
  // observes which tree that agent read and nothing detects a later edit, so exit 0 is evidence
  // of provenance, not proof — the same tamper-evident/tamper-proof distinction SECURITY.md and
  // phase-gate keep elsewhere.
  assertClaim(section, {
    label: 'exit 0 is provenance, not proof',
    claim: /^Exit 0 means the stored notes declare the commit the repository is on; the header is a string the writing agent was told to copy, so this is tamper-evident provenance and not proof/i,
    subject: /\bexit 0\b/i,
  })
  // An orchestrator branching on `code === 4` alone reads the exit-2 git failure as "current".
  assertStatement(
    section,
    /^Exit 4 means there are none, they carry no header at all, they name a different commit, they were written for a different run, or the file could not be read/i,
    'the skill must name every condition that produces exit 4, not only the missing-notes case',
  )
  assertClaim(section, {
    label: 'exit 2 is unknown, not current',
    claim: /^Exit 2 means git could not be read, so no comparison happened at all — read that as unknown, never as current\.$/i,
    subject: /\bexit 2\b/i,
  })
})

test('fleet-lifecycle states the orchestrator writes the map, not the agent', async () => {
  const { doc } = await skill('fleet-lifecycle')
  const section = doc.section('Map notes')
  // Anchored end-to-end: an unanchored (or prefix-only) pattern here waives any statement that
  // merely CONTAINS this text, so a mutated tail — "... or let a teammate write `map.md` in
  // place, with the same command and --write:" — would still match and pass, directly
  // contradicting the pinned claim below and naming the locked subject (map.md) while doing it.
  const dispatchPattern =
    /^Dispatch a read-only agent with the printed prompt; it RETURNS the map and you write it to that path yourself, with the same command and --write:$/i
  assertStatement(
    section,
    dispatchPattern,
    'the skill must not tell a read-only agent to write a file',
  )
  assertClaim(section, {
    label: 'map notes writer',
    // Anchored end-to-end: `assertClaim`'s `subject:` inventory screen exempts the claim
    // statement itself (it would otherwise flag itself), so an unanchored `claim:` is the one
    // pattern nothing else in this check screens — a clause appended to this exact sentence
    // ("... unless you dispatch one with Bash and tell it to.") still matches an unanchored
    // pattern as a substring and passes uncaught. Anchoring forces the whole statement to equal
    // what was reviewed, the same fix already applied to the `allow` entries in this file.
    claim: /^A teammate never writes this file, and nothing enforced ever reads it\.$/,
    subject: /writes this file|map\.md/i,
    allow: [dispatchPattern],
  })
})

test('phase-gate states that findings are stamped with the tips they judged', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  assertStatement(
    section,
    /refuses a file whose stamp names different tips/,
    'the skill must state that stale findings are refused',
  )
  assertStatement(
    section,
    /findings about the old tree are not findings about this one/,
    'the reason must be stated, not just the rule',
  )
})

test('phase-gate documents finish taking per-phase results', async () => {
  const { doc } = await skill('phase-gate')
  const section = doc.section('Finish the pending checks')
  // A whole-document regex with `.*` gaps is exactly what tests/md-contract.mjs exists to
  // replace: /phases.*1.*results/s is satisfied by "results" drifting in from an unrelated later
  // sentence, so mutating the documented shape to { "phases": { "1": [...] } } — which `finish`
  // itself rejects with "--results phase 1 must be an object with a results array" — stayed
  // green. Lock the one statement that carries the shape instead.
  assertStatement(
    section,
    /^Hand it the same results, keyed by phase: \{ "phases": \{ "1": \{ "results": \[\.\.\.\] \} \} \}\.$/i,
    'the skill must state the exact --results shape finish expects, keyed by phase',
  )
  assertStatement(
    section,
    /A phase that passed on supplied results is marked \(review supplied\) in its output/,
    'a reader must be able to tell a recomputed pass from a reported one',
  )
})

test('parallel-execution states a run bases off the default branch, not another run branch', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Amending a plan mid-run')
  // Step 1 of the procedure in this section commits the amendment on the BASE branch. If the base
  // is another run's deliverable branch, those commits land on it, and `ownership` evaluated for
  // THAT run reports them as reachable from no task branch of it and from no ancestor of its base
  // — which is what they are. The limit is procedural and belongs beside the step that causes it.
  // `subject:` rather than a `doesNotMatch` on the retracted phrase. A phrase pin binds exactly one
  // spelling: "run/claims can never again pass its own gate", inserted anywhere in this section,
  // reinstates the retracted claim with the whole suite green. The inventory lock fails on any
  // unlisted sentence about the report's permanence, whatever its wording.
  assertClaim(section, {
    label: 'stacked-run base',
    claim: /Branch a run's base from the default branch, not from another run's branch/i,
    then: /Step 1 commits the amendment on the base, so if the base is another run's deliverable branch the amendment lands there/i,
    subject: /(permanent|permanently|forever|never (again )?(pass|go green)|does not last|not last|preserve the finding|its own gate|passes on run\/claims)/i,
    allow: [
      /That report does not last/i,
      /ownership now passes on run\/claims — so do not count on the check to preserve the finding/i,
    ],
  })
  assertStatement(
    section,
    /Run followups2 based on run\/claims did exactly this, and ownership gated on run\/claims named five unowned commits/i,
    'parallel-execution must name the run that paid for this and the number of commits it left',
  )
  // Measured against base `master`: the anchor equals the run tip, the range is empty, and
  // `ownership` passes. A skill promising the report survives would send a reader to a green check
  // as evidence of a violation it no longer reports.
  assertStatement(
    section,
    /the derived anchor moved onto the run tip, the commit range emptied, and ownership now passes on run\/claims/i,
    'parallel-execution must state that the ownership report does not survive the run landing',
  )
  assertStatement(
    section,
    /If work genuinely stacks, land the first run before starting the second/i,
    'parallel-execution must give the alternative for genuinely stacked work',
  )
})

test('parallel-execution states the integrator merges in dependency order because a consumer cannot build alone', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Import coupling across tasks')
  assertClaim(section, {
    label: 'import coupling',
    claim: /A task whose file set imports a symbol another task introduces cannot build on its own branch/i,
    then: /merging it first produces a commit whose tree cannot load/i,
  })
  assertStatement(
    section,
    /A revert of the providing task breaks every consumer, not only the feature that motivated it/i,
    'parallel-execution must state that a revert propagates to consumers',
  )
  // The softer form leaves the tree loading and only the prose wrong, so no build catches it. It
  // still has to be judged on the merge, which is the same rule the load failure produces.
  assertStatement(
    section,
    /The softer form leaves the tree loading and only a comment wrong/i,
    'parallel-execution must record the softer form, not only the load failure',
  )
  assertStatement(
    section,
    /the integrator merges in dependency order, and a reviewer judging a cross-task claim judges it on the merge, not on one branch/i,
    'parallel-execution must state the rule both forms share',
  )
})

test('fleet-supervision states liveness detects an absence of progress and names both stall causes', async () => {
  const { doc } = await skill('fleet-supervision')
  const section = doc.section('When a teammate stalls')
  assertStatement(
    section,
    /what it detects is an absence of progress/i,
    'fleet-supervision must say what liveness measures, not what its hint guesses',
  )
  assertNoStatement(
    section,
    /liveness detects (a )?backgrounded command/i,
    'the hint names a likely cause; the skill must not promote it to a diagnosis',
  )
  assertClaim(section, {
    label: 'two stall causes',
    claim: /That names a likely cause; it is a guess, not a diagnosis/i,
    then: /Two causes produce the same board, and the hint names only one of them/i,
  })
  assertStatement(
    section,
    /the harness moved it to the background at the harness timeout of 120 seconds/i,
    'the second cause is the harness backgrounding a foreground command at its own timeout',
  )
  // No relative frequency exists, so neither cause may be ranked. Of the two stalls this repository
  // records, only one attributes a cause: docs/plans/2026-08-08-tooling-gaps.md names run `codemap`
  // as teammates backgrounding the suite themselves, while
  // docs/specs/2026-08-10-claims-liveness-distinct-refs-design.md records run `claims` as three
  // stalls with no cause attributed. The harness-timeout cause rests on in-session reports only.
  // Ranking it above the first also countermands `agents/tm-implementer.md`, which tells a teammate
  // not to background its suite.
  //
  // `subject:` rather than a `doesNotMatch` on "is the common one": that phrase pin binds one
  // spelling, and "the second is the usual one for a long test suite" restores the unmeasured
  // ranking with the suite green. The inventory lock fails on any unlisted sentence in this section
  // that speaks about frequency or ranking.
  assertClaim(section, {
    label: 'stall cause ranking',
    claim: /Neither cause is ranked above the other, because no relative frequency has been measured/i,
    subject: /\b(rank|ranks|ranked|ranking|frequency|count|counts|counted|common|usual|usually|typical|typically|often|majority|mostly|rare|rarer)\b/i,
    allow: [
      /do not assume disobedience without checking which cause applies/i,
    ],
  })
  assertStatement(
    section,
    /of the two stalls this repository records, one attributes the first cause \(run codemap\) and one names no cause at all \(run claims\)/i,
    'fleet-supervision must say what the repository actually records, not attribute both stalls to one cause',
  )
  assertStatement(
    section,
    /the second cause has been reported by teammates in session and never written down/i,
    'fleet-supervision must say the second cause has no written record',
  )
  assertStatement(
    section,
    /do not assume disobedience without checking which cause applies/i,
    'the caution must be conditional, so it does not countermand the implementer contract',
  )
  assertStatement(
    section,
    /pass an explicit longer timeout on the long-running command rather than relying on the default/i,
    'fleet-supervision must give the dispatch-time fix, not only the recovery',
  )
})

test('fleet-supervision states the stall recovery resumes that agent rather than respawning it', async () => {
  const { doc } = await skill('fleet-supervision')
  const section = doc.section('When a teammate stalls')
  assertClaim(section, {
    label: 'stall recovery',
    claim: /The recovery is to resume THAT agent with an instruction to re-run in the foreground with an explicit longer timeout/,
    then: /Do not respawn it: a respawn discards the task's whole context, and a returned teammate's worktree keeps its branch checked out, so a fresh dispatch fails with "already used by worktree" until that worktree is pruned/i,
  })
})

// The direct-dispatch instructions in parallel-execution build each teammate's brief from
// `cli.mjs brief` rather than composing it by hand. The invocation carries the CLAUDE_PLUGIN_ROOT
// prefix a skill CLI call must (see the relative-path test above), so the closing quote sits
// between `cli.mjs` and `brief`; binding the literal keeps the dispatch instructions from drifting
// away from the CLI they call.
test('parallel-execution names the brief command its direct dispatches are built from', async () => {
  const { body } = await skill('parallel-execution')
  assert.ok(body.includes('cli.mjs" brief'), 'parallel-execution must name the cli.mjs brief command')
})

// SubagentStop fires only when a teammate actually stops; a stalled or parked teammate never
// reaches it, and `liveness` is the only check that sees an absence of progress with no stop. No
// skill or agent may claim otherwise: any sentence that names both SubagentStop and a stall or a
// parked teammate must also name liveness, so a contract cannot quietly promote the backstop into a
// stall detector. The guard matches both `stall` and `park` because the property it protects covers
// a teammate that never stops for either reason, and the test name asserts exactly that coverage.
test('no skill or agent claims SubagentStop catches a stalled or parked teammate', async () => {
  const agentsDir = new URL('../agents/', import.meta.url)
  const docs = []
  for (const name of await allSkills()) docs.push((await skill(name)).doc)
  for (const file of await readdir(agentsDir)) {
    const text = await readFile(new URL(file, agentsDir), 'utf8')
    const { body } = splitFrontmatter(text, file)
    docs.push(parseDoc(body, file))
  }
  for (const doc of docs) {
    for (const s of doc.statements) {
      if (/SubagentStop/.test(s.text) && /\b(?:stall|park)/i.test(s.text)) {
        assert.match(
          s.text,
          /liveness/i,
          `a sentence naming SubagentStop and a stall or a parked teammate must also name liveness (${doc.label}): ${s.text}`,
        )
      }
    }
  }
})

// These two tests lock the EXACT STATEMENT INVENTORY of the two blocks that describe the run-branch
// record and the SubagentStop guard. Not a subject lexicon — an ordered list.
//
// The lexicon approach was tried and failed four times. A subject alternation is escapable by
// writing the reversal in words it does not name, and each escape was answered by adding the noun
// it leaned on: branch, verdict, layer, then manifest, fileset, ownership, task-scoped, merge,
// pending. The fifth escape used the paragraph's own opening sentence, which names none of them.
// Separately, an `allow` entry is permissive: a sentence that exists only as an allow entry can be
// DELETED outright and nothing fails, which was demonstrated on the "never read a stop that was
// allowed as a verdict" caution.
//
// An ordered inventory closes both classes at once, because it is not a filter over what happens to
// be written — it is the whole text of the section, from its first statement to its last. Any
// sentence added, removed, reworded or reordered fails, in any vocabulary, whether or not it
// mentions the subject, and wherever in the section it is placed.
//
// The block-kind sequence is locked alongside it. `statementsOf` builds statements only from
// paragraphs and list items, so a heading or a fenced code block contributes none and could
// otherwise carry false prose between two locked statements without changing the inventory.
//
// The cost is that every legitimate prose edit must update the list here. That is the review step,
// and it is the point: this section made 45 findings across fifteen rounds, almost all of them
// claims that were true of some paths and false of others. A maintainer editing it should have to
// say so in the test.
//
// No entry may contain a backtick: normalize() strips them before matching.

const RECORD_SHAPE = ['paragraph', 'code', 'paragraph', 'paragraph', 'paragraph', 'paragraph']
const GUARD_SHAPE = [
  'paragraph', 'code', 'paragraph', 'paragraph', 'paragraph', 'paragraph',
  'code', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph',
]

const RECORD_BLOCK = [
  // The section lead-in. Locked too: an earlier version started the inventory at the sentence
  // below, which left everything above it free to contradict the locked text.
  "Create and check out this run's branch before initializing, then run init-run from it:",
  'This writes .teammates/<runId>/plan.json and status.json and prints the phase breakdown.',
  'Tasks land in the same phase only when their deps are satisfied and their file sets are disjoint.',
  'The order matters for enforcement, not just tidiness. init-run records a run branch by fill-if-absent: it records HEAD when the run has no runBranch recorded yet and HEAD is not the base branch, and it records nothing when HEAD is the base.',
  'A value already recorded always wins — writePlan resolves the field as carried ?? usable — so a re-init from a different branch keeps the old record and prints a note naming the branch it kept.',
  'Compare that name by bytes rather than by eye: the check is byte-wise, and zero-width and homoglyph characters render identically in a terminal.',
  'One input escapes that description: a recorded empty string is carried like any other, then dropped on write because it is falsy, so the field disappears, the note names no branch, and the run ends up with no record rather than the one it reports keeping.',
  'That record does not resolve a stopping teammate to its task — the worktree location record written by locate does that.',
  'What it decides is whether the stop-time checks are allowed to be a verdict: complete --enforcement-only compares the recorded run branch against the branch the main worktree has checked out, and when it is absent or different it reports that it cannot verify completion and the stop is allowed.',
  'Checking the run branch out before the first init-run is therefore what puts the record in place at the start of the run, on a run id that has none yet.',
  'It does not repair a run whose recorded branch is already wrong: no command overwrites that field.',
  'To correct one, remove runBranch from .teammates/<runId>/plan.json and run init-run again — from an attached branch.',
  'An absent record needs no hand-editing: some later commands fill it in and others only read it, so read runBranch in .teammates/<runId>/plan.json rather than predicting which.',
  'On a detached HEAD init-run records the literal string HEAD, which is not a run branch and which no command overwrites, so it disarms the second layer until the field is removed by hand.',
  'When init-run records nothing it prints a note directing you to check the run branch out before gating; the note concerns gate refusing to run from the base branch, and a checkout on its own records no run branch.',
]

const GUARD_BLOCK = [
  // The dispatch mechanics that precede the guard discussion. Locked for the same reason.
  'Phases with three or more tasks go through the Workflow tool:',
  'Write that source to a file and invoke Workflow with it.',
  "The Workflow tool needs the user's opt-in — ask once per run, then remember it for that run.",
  'If the user declines, or the Workflow tool is unavailable, do not stop.',
  "Fall back to the direct-agent path below for the whole phase: dispatch each task as its own background Agent with isolation: 'worktree', respecting maxParallel.",
  'The result contract is identical, so nothing downstream changes.',
  'Say which path you took.',
  "Phases with fewer than three tasks are dispatched as direct background Agent calls with isolation: 'worktree' and the tm-implementer persona.",
  'Same result contract either way.',
  "On either direct-Agent path — the fallback above and the fewer-than-three-task case — build each teammate's brief with the CLI rather than composing it by hand:",
  'The Workflow path already renders each brief from the same composer, so a hand-written dispatch is only ever a way to drift from what the gate enforces.',
  'On a pure direct-Agent phase a teammate can stop before any other lifecycle command has run.',
  'The SubagentStop hook does two cheap things at that moment: it blocks a teammate whose task branch does not exist, and it runs complete --enforcement-only.',
  'That run keeps every non-command check the manifest declares, plus merge, which the gate computes for itself rather than reading from the manifest — do not declare merge there, it finds no runner and lands as a blocking pending beside the computed result.',
  'Only a task-scoped failure blocks, meaning fileset or merge, so a blocked stop is not always about a file set; an ownership failure with no task-scoped failure beside it is reported without blocking.',
  'Treat both as best effort.',
  'The hook resolves a stopping teammate through records under .teammates/, which is gitignored and writable by every teammate, and it allows the stop on anything it cannot establish — a teammate it cannot resolve, a plan it cannot read, a recorded run branch that is not the branch checked out.',
  'That is deliberate.',
  'The hook can only ever add a block that would not otherwise happen, so declining to block on anything it cannot establish is what keeps it from blocking a teammate over state that teammate did not write — state any teammate can write.',
  'What this buys is a fast signal on the common honest mistake, not a barrier against a determined one.',
  'The enforcement is the phase gate: its fileset and ownership checks recompute from git and read nothing under .teammates/, whatever else the command around them reads.',
  'Do the §1 order because it is what lets complete --enforcement-only reach a verdict; the branch-existence check does not depend on it and blocks whether or not a run branch was ever recorded.',
  'Never read a stop that was allowed as a verdict.',
  // The section's trailing operational lines are locked too, so 'nothing may follow' stays exact.
  'Wait on completion notifications.',
  'Do not poll in a loop.',
]

// Lock the section's WHOLE statement list, not a suffix of it. An earlier version started at the
// block's first sentence, which left everything above it free — a paragraph inserted there
// contradicting the locked text shipped green.
function assertBlock(section, expected, label) {
  assert.deepEqual(
    section.statements.map((s) => s.text),
    expected,
    `${label}: the section's statements must match the locked inventory exactly — a sentence was `
      + 'added, removed, reworded or reordered, anywhere in the section. If the change is correct, '
      + 'update the list in this file; that is the review step, not a formality.',
  )
}

// And lock the sequence of block kinds. Headings and code blocks contribute no statements, so
// without this a heading or fenced block could sit between two locked statements carrying prose the
// inventory never sees.
function assertShape(section, kinds, label) {
  assert.deepEqual(
    section.blocks.map((b) => b.kind),
    kinds,
    `${label}: the section's block structure changed. A heading, code block, list item or paragraph `
      + 'was added, removed or reordered — including forms that carry no statement and so would '
      + 'otherwise be invisible to the statement inventory.',
  )
}

test('parallel-execution checks out the run branch before init-run to record it', async () => {
  const { doc } = await skill('parallel-execution')
  const section = doc.section('Initialize the run')

  // Order is read from the COMMAND BLOCK. indexOf over section text takes the first occurrence of
  // each string, so prose naming the checkout satisfies it regardless of what the block prescribes.
  const commandBlock = section.blocks.find((b) => b.kind === 'code' && b.code.includes('init-run <planPath>'))
  assert.ok(commandBlock, 'the Initialize section must contain a command block invoking init-run')
  const checkout = commandBlock.code.indexOf('git checkout -b')
  const initRun = commandBlock.code.indexOf('init-run <planPath>')
  assert.notEqual(checkout, -1, 'the command block must instruct checking out the run branch')
  assert.ok(
    checkout < initRun,
    `the checkout must come BEFORE init-run in the same command block: ${JSON.stringify(commandBlock.code)}`,
  )

  assertBlock(section, RECORD_BLOCK, 'the Initialize section')
  assertShape(section, RECORD_SHAPE, 'the Initialize section')
})

test('parallel-execution bounds the SubagentStop guard rather than describing its layers', async () => {
  const { doc } = await skill('parallel-execution')
  assertBlock(doc.section('Dispatch the phase'), GUARD_BLOCK, 'the Dispatch section')
  assertShape(doc.section('Dispatch the phase'), GUARD_SHAPE, 'the Dispatch section')

  // The claims fifteen rounds measured false, refused in both sections so a reversal cannot simply
  // move one heading down, where a per-section lock does not reach.
  for (const scope of [doc.section('Dispatch the phase'), doc.section('Record results')]) {
    assertNoStatement(
      scope,
      /blocked either way|blocks regardless|caught whether or not|on every dispatch path/i,
      'no section may claim a stop-time check fires unconditionally',
    )
    assertNoStatement(
      scope,
      /prune-run|rebuild-state|makes the stop-time checks\s*run at all|only ever turn a block into a non-block/i,
      'no section may enumerate the run-branch writers, nor invert the guard direction',
    )
    assertNoStatement(
      scope,
      /never fail-open|closed unconditionally|always armed|rely on the stop hook/i,
      'no section may present the guard as a barrier',
    )
    assertNoStatement(
      scope,
      /a verdict of completeness|allowed is a verdict|needs no further check/i,
      'no section may say an allowed stop implies the work was checked',
    )
  }

})
