import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const dir = new URL('../agents/', import.meta.url)

async function frontmatter(file) {
  const text = await readFile(new URL(file, dir), 'utf8')
  const match = /^---\n([\s\S]*?)\n---/.exec(text)
  assert.ok(match, `${file} has no frontmatter`)
  const fields = Object.fromEntries(
    match[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
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
