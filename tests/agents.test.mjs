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

const dir = new URL('../agents/', import.meta.url)

// The prose assertions below run against the structural model in md-contract.mjs — sections,
// blocks, statements — rather than against regexes over the whole body. See that module's header
// for what the structure can and cannot detect; in particular it does not solve contradiction
// detection in general, and says so.
async function agent(file) {
  const text = await readFile(new URL(file, dir), 'utf8')
  const { fields, body } = splitFrontmatter(text, file)
  return { fields, body, doc: parseDoc(body, file) }
}

test('all three agents exist', async () => {
  const files = await readdir(dir)
  assert.deepEqual(files.sort(), ['tm-implementer.md', 'tm-integrator.md', 'tm-reviewer.md'])
})

test('each agent declares a name matching its filename and a description', async () => {
  for (const file of ['tm-implementer.md', 'tm-reviewer.md', 'tm-integrator.md']) {
    const { fields } = await agent(file)
    assert.equal(fields.name, file.replace('.md', ''))
    assert.ok(fields.description.length > 20, `${file} description too short`)
  }
})

test('the implementer is bound to its declared files and the result schema', async () => {
  const { doc } = await agent('tm-implementer.md')
  assertStatement(doc, /ONLY the files listed/, 'implementer must be bound to its declared files')
  for (const key of ['status', 'branch', 'filesChanged', 'summary', 'blockers']) {
    assert.ok(doc.text.includes(key), `implementer does not document ${key}`)
  }
})

test('the implementer must run its tests in the foreground', async () => {
  const { doc } = await agent('tm-implementer.md')
  assertStatement(
    doc,
    /Run the test command in the FOREGROUND and wait for it/,
    'implementer must be told to wait on its own test run',
  )
  assertStatement(
    doc,
    /nothing notifies you when a backgrounded command finishes/,
    'the reason must be stated, not just the rule',
  )
})

test('the implementer reports blocked rather than improvising a branch', async () => {
  const { doc } = await agent('tm-implementer.md')
  assertStatement(
    doc,
    /If your task's branch is checked out in another worktree, report status: "blocked" naming it/,
    'implementer must not invent a branch when its own is held',
  )
  assertStatement(
    doc,
    /work anywhere but teammates\/<runId>\/<taskId> is invisible to it and merges as a no-op/,
    'the consequence of working on the wrong ref must be stated',
  )
})

test('the implementer returns repo-relative paths', async () => {
  const { doc } = await agent('tm-implementer.md')
  assert.match(doc.text, /repo-relative, never absolute worktree paths/)
})

// The read-only rule is prose, and prose is not enforcement: a reviewer holding the full tool
// set can do exactly what the rule forbids. Narrowing the declared tools removes the editing
// tools outright. It does not close the class — Bash is required for the git reads a diff
// review needs, and Bash can also write — so this is a narrowing, and the contract still
// carries the rule.
test('the reviewer declares a tool set with no editing tools', async () => {
  const { fields } = await agent('tm-reviewer.md')
  assert.ok(fields.tools, 'reviewer must declare an explicit tool set')
  const tools = fields.tools.split(',').map((t) => t.trim())
  assert.ok(tools.includes('Read'), 'reviewer must be able to read the diff')
  assert.ok(tools.includes('Bash'), 'reviewer needs git to read a diff across branches')
  assert.ok(tools.includes('Write'), 'reviewer must be able to drop its findings file')
  for (const forbidden of ['Edit', 'NotebookEdit']) {
    assert.ok(!tools.includes(forbidden), `reviewer must not hold ${forbidden}`)
  }
})

test('the reviewer takes one lens and returns severities', async () => {
  const { doc } = await agent('tm-reviewer.md')
  assertStatement(doc, /exactly one lens/i, 'reviewer must take exactly one lens')
  assert.match(doc.text, /high\b/)
})

// A reviewer holds full tool access and, before this rule existed, merged seven task branches
// into the main branch with no gate PASS — the exact state the gate exists to prevent, and one
// it cannot catch, since it runs before integration. The prohibition and the reason it matters
// must sit in one block; the subject lock keeps any later sentence about writing refs reviewed.
test('the reviewer is read-only and may not write to any ref', async () => {
  const { doc } = await agent('tm-reviewer.md')
  const boundaries = doc.section('Boundaries')
  assertClaim(boundaries, {
    label: 'reviewer write prohibition',
    claim: /^You are read-only\b/,
    then: /Never write to any ref/i,
    subject: /update-ref/i,
  })
})

test('the reviewer runs cross-branch checks in a scratch worktree, never in the main worktree', async () => {
  const { doc } = await agent('tm-reviewer.md')
  const boundaries = doc.section('Boundaries')
  assertStatement(
    boundaries,
    /never run git checkout in the main worktree/i,
    'reviewer must not check anything out in the main worktree',
  )
  assertStatement(
    boundaries,
    /scratch worktree outside the repository/i,
    'reviewer must be told where cross-branch verification happens',
  )
  assertStatement(
    boundaries,
    /report the finding unverified/i,
    'reviewer must have a sanctioned way out when it cannot verify read-only',
  )
})

test('the implementer must prove its work is on the conventional branch before returning done', async () => {
  const { doc } = await agent('tm-implementer.md')
  assertStatement(
    doc,
    /git merge-base/,
    'implementer must run the fork-point diff, not a tip-vs-tip diff',
  )
  assertStatement(
    doc,
    /empty diff means your commits landed on another ref/i,
    'implementer must be told what an empty contribution proves',
  )
})

// A reviewer that goes idle without emitting takes its whole review with it: the work is done
// and unrecoverable, and the phase's `review` check stays pending, which scores as FAIL. The
// file is a fallback for that case only — the returned response stays the interface.
test('the reviewer writes its findings to a file as well as returning them', async () => {
  const { doc } = await agent('tm-reviewer.md')
  const section = doc.section('Return value')
  assertStatement(
    section,
    /write that same JSON to the findings path your prompt names/i,
    'reviewer must drop its findings to a file before returning',
  )
  assertStatement(
    section,
    /before you return, not after/i,
    'the write must happen while the reviewer is still alive to do it',
  )
})

// review-dispatch appends `stampInstruction`, which tells a reviewer to write its stamp under a
// "stamp" key; collect-reviews refuses a file whose top-level shape is a bare array, since a bare
// array has nowhere to carry that stamp. Across two phases of run `gaps`, five reviewers produced
// four different file shapes because this card described a different one than the collector
// requires. `forbid`ing one exact sentence opening is the wrong shape for this pin — a reword
// that avoids that literal phrase but keeps prescribing a bare array would still pass — so the
// claim is a positive one ("exactly one shape ... never a bare array").
//
// `subject` is a VOCABULARY lock, not a semantic one: it fires only on a statement naming one of
// the specific nouns below, and a hatch that avoids every one of them passes silently — e.g.
// "when the wrapper object is awkward, emit the findings themselves as the whole document" names
// no shape at all and is not caught by this test. `array`, `list`, and `sequence` are the nouns
// checked; each was chosen because it is a plausible synonym a reworded escape hatch would reach
// for, and none of them forced a new `allow` entry for a sentence the card legitimately carries —
// widening further risks that trade and was not done here, so this is a deliberately bounded net,
// not a claim of catching every wording. `BACK_REFERENCE` (see tests/md-contract.mjs) is a second,
// independent net for the same insertion class and shares the same limitation: it is a lexicon,
// not a guarantee, and its own header says so.
//
// The claim alone does not bind the example a reviewer actually copies: `assertCode` below takes
// the FIRST code block matching its pattern in the whole section, so a bare-array block inserted
// ahead of the real one — as a new "longer form"/"older collectors" example, or promoted to the
// head of the section — left the claim's prose intact and the subject lock silent, and still
// showed a reviewer a bare array as the first example under the claim. `introduces` requires the
// block immediately after the claim's own paragraph to be the stamped example, which adjacency
// breaks no matter which side the extra block is inserted on. Adjacency alone misses a SECOND
// example appended after the correct one, so every code block in the section is checked directly
// below instead of counting them: none may parse as a bare top-level JSON array, and every one
// that parses as JSON must carry exactly `stamp` and `findings` as its top-level keys. A code
// block that is not JSON at all — a file path, a shell command — fails to parse, is skipped, and
// does not trip this check.
test('the reviewer card commits to one shape and locks out every other array/list/sequence mention', async () => {
  const { doc } = await agent('tm-reviewer.md')
  const section = doc.section('Return value')
  assertClaim(section, {
    label: 'one shape, never a bare array',
    claim: /exactly one shape[\s\S]*never a bare array of findings/i,
    introduces: /"stamp"/,
    subject: /\barray\b|\blist\b|\bsequence\b/i,
    allow: [/an empty findings array is a real result/i],
  })
  for (const block of section.code) {
    let parsed
    try {
      parsed = JSON.parse(block.code)
    } catch {
      continue // not JSON — e.g. a file path or shell example — out of scope for this check
    }
    assert.ok(
      !Array.isArray(parsed),
      `reviewer card must not show a bare top-level JSON array as a findings-file example, found: ${block.code}`,
    )
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ['findings', 'stamp'],
      `every JSON example in Return value must have exactly stamp and findings as its top-level keys, found: ${JSON.stringify(Object.keys(parsed))}`,
    )
  }
})

// `assert.match(section.text, /"stamp"/)` proves the substring appears anywhere in the section's
// concatenated text — including inside a fenced example where "stamp" was moved to sit under each
// finding instead of at the top level, which a reviewer copying the example would reproduce and
// collect-reviews would then refuse. Parse the fenced example itself and check its top-level keys.
test('the fenced findings-file example has stamp and findings as its only top-level keys', async () => {
  const { doc } = await agent('tm-reviewer.md')
  const section = doc.section('Return value')
  const block = assertCode(section, /"stamp"/, 'reviewer card must show a JSON example carrying a stamp')
  const example = JSON.parse(block.code)
  assert.deepEqual(Object.keys(example).sort(), ['findings', 'stamp'])
})

// The prose instruction to copy the stamp verbatim, with an inventory lock over every other
// sentence in the section that mentions "stamp" — the defence against a sentence appended
// anywhere in Return value that quietly waives the rule (e.g. "the stamp key may be omitted when
// the dispatch prompt does not supply one"), which a bare `assertStatement` cannot see because it
// only checks that ITS OWN pattern matches somewhere, never that nothing else contradicts it.
// The lock also covers "collect"/"collector" wording: an escape hatch can name the collector
// without naming the stamp at all ("if collection fails, return whatever the collector accepts"),
// and the only existing sentence in this section that says "collected" already names the stamp
// too and is already on the allow list below — so widening costs no new entries.
test('the reviewer card requires copying the stamp verbatim, with no unreviewed stamp caveat', async () => {
  const { doc } = await agent('tm-reviewer.md')
  const section = doc.section('Return value')
  assertClaim(section, {
    label: 'copy the stamp verbatim',
    claim: /the stamp object is supplied verbatim in your dispatch prompt/i,
    then: /copy it unchanged into the JSON you write.*never construct or edit it yourself/i,
    subject: /\bstamp\b|\bcollect/i,
    allow: [
      /exactly one shape[\s\S]*never a bare array of findings/i,
      /if your dispatch prompt carries no stamp[\s\S]*inventing a stamp/i,
      /a reviewer that fabricates a stamp asserts it judged tips it may never have read/i,
      /the stamp is tamper-evident, not proof of review/i,
    ],
  })
})

test('the integrator is declared the sole writer to the run branch', async () => {
  const { doc } = await agent('tm-integrator.md')
  assertStatement(doc, /sole writer/, 'integrator must be declared the sole writer')
  assertStatement(doc, /never auto-resolve/i, 'integrator must never auto-resolve a semantic conflict')
})

test('the implementer states the branch convention and that the check reads committed changes', async () => {
  const { doc } = await agent('tm-implementer.md')
  assert.match(doc.text, /teammates\/<runId>\/<taskId>/)
  assert.match(doc.text, /\bcommitted\b/)
})

test('the integrator requires --no-ff and records no integration', async () => {
  const { doc } = await agent('tm-integrator.md')
  assertStatement(doc, /--no-ff/, 'integrator must require --no-ff')
  // Covers every block, code included: no wording anywhere may suggest an integration is recorded.
  assert.doesNotMatch(doc.text, /\bintegrated\b/i)
})

test('the integrator forbids update-ref and states its consequence', async () => {
  const { doc } = await agent('tm-integrator.md')
  // The prohibition and its consequence must be adjacent statements of one block. A sentence
  // inserted between them — "This rule is obsolete; do it." and anything else, negating or not —
  // breaks adjacency and fails, which the old `[\s\S]{0,150}` window could not do. The subject
  // lock additionally rejects any other sentence in the section that speaks about `update-ref`.
  assertClaim(doc.section('Reaching the run branch'), {
    label: 'update-ref prohibition',
    claim: /^Never advance the branch with git update-ref\b/i,
    then: /index then describes a tree it does not contain/i,
    subject: /update-ref/i,
  })
})

test('the integrator states secondary-parent ancestry may reach a task branch or the base branch', async () => {
  const { doc } = await agent('tm-integrator.md')
  assertStatement(
    doc.section('Rules'),
    /secondary parents are each an ancestor of a task branch or of the base branch/i,
    'ownership must accept a secondary parent from a task branch or the base branch',
  )
})

test('the integrator does not present ancestry alone as sufficient to explain a merge commit', async () => {
  const { doc } = await agent('tm-integrator.md')
  // One statement carries both halves, so "ancestry is enough" cannot be assembled out of two
  // sentences the way a whole-body regex with a bounded gap allowed.
  assertClaim(doc.section('Rules'), {
    label: 'ownership explanation',
    claim: /of the base branch.*and whose file content matches what those parents cleanly contributed/i,
    subject: /ownership check explains/i,
  })
})

test('the integrator reports blocked when the run branch is held by another worktree', async () => {
  const { doc } = await agent('tm-integrator.md')
  assertClaim(doc.section('Reaching the run branch'), {
    label: 'blocked on a held branch',
    claim: /If the checkout fails because the branch is checked out elsewhere, stop and report blocked/i,
    then: /Do not work around it/i,
    subject: /checked out elsewhere/i,
  })
})
