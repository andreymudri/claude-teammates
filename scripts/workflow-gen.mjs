import { readFile } from 'node:fs/promises'

const TEMPLATE = new URL('../templates/phase-workflow.js', import.meta.url)
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function jsString(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

// Serializes a plain JS value (string/number/boolean/null/array/object) as a JS
// literal with unquoted identifier keys and single-quoted strings, matching the
// "pure literal" meta declaration expected by the generated workflow source.
function jsLiteral(value, indent = '') {
  const nextIndent = indent + '  '
  if (typeof value === 'string') return jsString(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((v) => `${nextIndent}${jsLiteral(v, nextIndent)}`).join(',\n')
    return `[\n${items}\n${indent}]`
  }
  const keys = Object.keys(value)
  if (keys.length === 0) return '{}'
  const entries = keys
    .map((key) => {
      const keyLiteral = IDENTIFIER.test(key) ? key : jsString(key)
      return `${nextIndent}${keyLiteral}: ${jsLiteral(value[key], nextIndent)}`
    })
    .join(',\n')
  return `{\n${entries}\n${indent}}`
}

export async function generatePhaseWorkflow({
  runId, phase, tasks, maxParallel, tierModels,
  planPath = '', baseBranch = '', constraints = [],
}) {
  if (!tasks || tasks.length === 0) throw new Error(`no tasks for phase ${phase}`)

  const meta = {
    name: `teammates-${runId}-phase-${phase}`,
    description: `Run phase ${phase} of teammates run ${runId} (${tasks.length} tasks, max ${maxParallel} parallel)`,
    phases: [{ title: 'Implement', detail: `${tasks.length} worktree-isolated implementers` }],
  }

  // The branch name is computed once here rather than derived again inside the template,
  // so the brief's `checkout -B` and the dispatch cannot disagree about the string.
  const slim = tasks.map(({ id, title, files, tier }) => {
    const model = tierModels?.[tier]
    const base = { id, title, files, branch: `teammates/${runId}/${id}` }
    return model ? { ...base, model } : base
  })
  const template = await readFile(TEMPLATE, 'utf8')

  // Use function replacers, not string replacements: String.prototype.replace treats
  // $&, $`, $', $$ and $<n> in a *string* replacement as special patterns, which would
  // silently corrupt output for a task title/file containing e.g. "$&". Function
  // replacers insert their return value literally.
  return template
    .replace('__META__', () => `export const meta = ${jsLiteral(meta)}`)
    .replace('__TASKS__', () => JSON.stringify(slim, null, 2))
    .replace('__PLAN_PATH__', () => jsLiteral(planPath))
    .replace('__BASE_BRANCH__', () => jsLiteral(baseBranch))
    .replace('__CONSTRAINTS__', () => jsLiteral(constraints))
}
