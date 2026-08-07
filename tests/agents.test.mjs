import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import {
  assertClaim,
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

test('the reviewer takes one lens and returns severities', async () => {
  const { doc } = await agent('tm-reviewer.md')
  assertStatement(doc, /exactly one lens/i, 'reviewer must take exactly one lens')
  assert.match(doc.text, /high\b/)
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
