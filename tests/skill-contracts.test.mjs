import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import {
  assertClaim,
  assertCode,
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

test('phase-gate says plainly what a none decision means and does not mean', async () => {
  const { doc } = await skill('phase-gate')
  const onFail = doc.section('On FAIL')
  // `none` and its disclaimer must be adjacent statements of the same paragraph, and every other
  // sentence in the section that mentions `none` has to be one of the two listed below. A new
  // sentence about `none` fails whatever it says — no vocabulary of negations is consulted.
  assertClaim(onFail, {
    label: 'the none decision',
    claim: /^On none, the decision engine found no failing check in the verdict you handed it\b/i,
    then: /This does not mean "the failure needs no fix" and it is never permission to integrate/i,
    subject: /\bnone\b/i,
    allow: [
      /one of three decisions — none, retry, or escalate —/i,
      /the decision comes back none; that is incidental, not guaranteed/i,
      /a none decision means the verdict you passed is not the one that failed/i,
      /Integrate only on a freshly recomputed PASS, never on none/i,
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

test('phase-gate marks the fix-decision invocation as pending, not missing', async () => {
  const { doc } = await skill('phase-gate')
  assertClaim(doc.section('On FAIL'), {
    label: 'pending invocation',
    claim: /The exact invocation and that exit-0-for-all-three contract are specified by the task that adds the decision subcommand/i,
    then: /Until then the command is not there to run: pending, not missing/i,
  })
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
      /Only prune worktrees belonging to this run/i,
      /prune that task's worktree first/i,
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
    ],
    forbid: [/dispatch one tm-reviewer per lens[^.]*with a name/i],
  })
})
