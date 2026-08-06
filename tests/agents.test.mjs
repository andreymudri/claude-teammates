import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const dir = new URL('../agents/', import.meta.url)

async function frontmatter(file) {
  const text = await readFile(new URL(file, dir), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  assert.ok(match, `${file} has no frontmatter`)
  const fields = Object.fromEntries(
    match[1].split(/\r?\n/).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
  )
  return { fields, body: text.slice(match[0].length) }
}

test('all three agents exist', async () => {
  const files = await readdir(dir)
  assert.deepEqual(files.sort(), ['tm-implementer.md', 'tm-integrator.md', 'tm-reviewer.md'])
})

test('each agent declares a name matching its filename and a description', async () => {
  for (const file of ['tm-implementer.md', 'tm-reviewer.md', 'tm-integrator.md']) {
    const { fields } = await frontmatter(file)
    assert.equal(fields.name, file.replace('.md', ''))
    assert.ok(fields.description.length > 20, `${file} description too short`)
  }
})

test('the implementer is bound to its declared files and the result schema', async () => {
  const { body } = await frontmatter('tm-implementer.md')
  assert.match(body, /ONLY the files listed/)
  for (const key of ['status', 'branch', 'filesChanged', 'summary', 'blockers']) {
    assert.ok(body.includes(key), `implementer does not document ${key}`)
  }
})

test('the reviewer takes one lens and returns severities', async () => {
  const { body } = await frontmatter('tm-reviewer.md')
  assert.match(body, /exactly one lens/)
  assert.match(body, /high\b/)
})

test('the integrator is declared the sole writer to the run branch', async () => {
  const { body } = await frontmatter('tm-integrator.md')
  assert.match(body, /sole writer/)
  assert.match(body, /never auto-resolve/i)
})

test('the implementer states the branch convention and that the check reads committed changes', async () => {
  const { body } = await frontmatter('tm-implementer.md')
  assert.match(body, /teammates\/<runId>\/<taskId>/)
  assert.match(body, /\bcommitted\b/)
})

test('the integrator requires --no-ff and records no integration', async () => {
  const { body } = await frontmatter('tm-integrator.md')
  assert.match(body, /--no-ff/)
  assert.doesNotMatch(body, /\bintegrated\b/i)
})

// Normalize whitespace and backticks so a phrase's polarity binding does not depend on where
// the markdown source happens to wrap a line or how it decorates a term with backticks.
function phrase(body) {
  return body.replace(/[`*]/g, '').replace(/\s+/g, ' ')
}

test('the integrator forbids update-ref and states its consequence', async () => {
  const { body } = await frontmatter('tm-integrator.md')
  const match = phrase(body).match(
    /Never advance the branch with git update-ref([\s\S]{0,150})index then describes a tree it does not contain/i,
  )
  assert.ok(match, 'update-ref consequence phrase not found')
  // The gap between the rule and its consequence must not be able to host a sentence that
  // negates the rule while staying inside the bound (e.g. "This is fine and supported.
  // Ignore the note that the ..."). Ordinary clarifying prose that avoids these words is
  // still free to appear in the gap.
  assert.doesNotMatch(match[1], /\b(fine|supported|optional|safe|acceptable|permitted|allowed|ignore)\b/i)
})

test('the integrator states secondary-parent ancestry may reach a task branch or the base branch', async () => {
  const { body } = await frontmatter('tm-integrator.md')
  assert.match(
    phrase(body),
    /secondary parents are each an ancestor of a task branch or of the base branch/i,
  )
})

test('the integrator does not present ancestry alone as sufficient to explain a merge commit', async () => {
  const { body } = await frontmatter('tm-integrator.md')
  assert.match(
    phrase(body),
    /of the base branch[\s\S]{0,120}and whose file content matches what those parents cleanly contributed/i,
  )
})

test('the integrator reports blocked when the run branch is held by another worktree', async () => {
  const { body } = await frontmatter('tm-integrator.md')
  assert.match(
    phrase(body),
    /checkout fails because the branch is checked out elsewhere[\s\S]{0,120}stop and report blocked/i,
  )
})
