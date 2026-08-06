import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generatePhaseWorkflow } from '../scripts/workflow-gen.mjs'

const tasks = [
  { id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 },
  { id: 'T2', title: 'db schema', files: ['src/db.ts'], phase: 1 },
]

test('generated source declares a meta literal with the run and phase', async () => {
  const src = await generatePhaseWorkflow({ runId: '3f2a', phase: 1, tasks, maxParallel: 4 })
  assert.match(src, /export const meta = \{/)
  assert.match(src, /name: 'teammates-3f2a-phase-1'/)
})

test('every task appears with its id, title and files', async () => {
  const src = await generatePhaseWorkflow({ runId: '3f2a', phase: 1, tasks, maxParallel: 4 })
  for (const t of tasks) {
    assert.ok(src.includes(t.id), `missing ${t.id}`)
    assert.ok(src.includes(t.title), `missing ${t.title}`)
    assert.ok(src.includes(t.files[0]), `missing ${t.files[0]}`)
  }
})

test('agents are spawned in parallel with worktree isolation', async () => {
  const src = await generatePhaseWorkflow({ runId: '3f2a', phase: 1, tasks, maxParallel: 4 })
  assert.match(src, /await parallel\(/)
  assert.match(src, /isolation: 'worktree'/)
})

test('the .then handler propagates null instead of spreading it, so a dead agent stays falsy', async () => {
  const src = await generatePhaseWorkflow({ runId: '3f2a', phase: 1, tasks, maxParallel: 4 })
  assert.match(src, /\.then\(\(r\) => \(r === null \? null : \{ taskId: t\.id, \.\.\.r \}\)\)/)
})

test('the generated body is syntactically valid javascript', async () => {
  const src = await generatePhaseWorkflow({ runId: '3f2a', phase: 1, tasks, maxParallel: 4 })
  const body = src.replace(/^export const meta = /m, 'const meta = ')
  assert.doesNotThrow(() => new Function(`return (async () => { ${body} })`))
})

test('generating a phase with no tasks throws', async () => {
  await assert.rejects(
    () => generatePhaseWorkflow({ runId: 'x', phase: 1, tasks: [], maxParallel: 4 }),
    /no tasks for phase 1/,
  )
})

test('task titles containing quotes do not break the source', async () => {
  const tricky = [{ id: 'T1', title: "don't break", files: ['a.ts'], phase: 1 }]
  const src = await generatePhaseWorkflow({ runId: 'x', phase: 1, tasks: tricky, maxParallel: 2 })
  const body = src.replace(/^export const meta = /m, 'const meta = ')
  assert.doesNotThrow(() => new Function(`return (async () => { ${body} })`))
})

test('a task with a tiered model resolves to that model in the generated source', async () => {
  const tiered = [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1, tier: 'cheap' }]
  const src = await generatePhaseWorkflow({
    runId: 'x',
    phase: 1,
    tasks: tiered,
    maxParallel: 2,
    tierModels: { cheap: 'haiku' },
  })
  assert.match(src, /"model": "haiku"/)
})

// Evaluates the generated body with stubbed workflow primitives and returns every
// options object the generated code passed to agent(). This exercises the dispatch
// half of the feature: a model that reaches TASKS but never reaches agent() would
// leave the dispatch inheriting the session model, which is the bug this guards.
async function captureAgentOptions(src) {
  const body = src.replace(/^export const meta = /m, 'const meta = ')
  const captured = []
  const phase = () => {}
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const agent = (prompt, options) => {
    captured.push(options)
    return Promise.resolve({ status: 'done', branch: 'b', filesChanged: [], summary: 's', blockers: [] })
  }
  const run = new Function(
    'phase',
    'parallel',
    'agent',
    `return (async () => { ${body} })`,
  )(phase, parallel, agent)
  await run()
  return captured
}

test('the resolved model is passed through to the agent() dispatch, not just the task list', async () => {
  const tiered = [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1, tier: 'cheap' }]
  const src = await generatePhaseWorkflow({
    runId: 'x',
    phase: 1,
    tasks: tiered,
    maxParallel: 2,
    tierModels: { cheap: 'haiku' },
  })
  const captured = await captureAgentOptions(src)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].model, 'haiku', 'agent() options must carry the resolved model')
})

test('agent() options carry each task its own resolved model', async () => {
  const mixed = [
    { id: 'T1', title: 'cheap task', files: ['a.ts'], phase: 1, tier: 'cheap' },
    { id: 'T2', title: 'capable task', files: ['b.ts'], phase: 1, tier: 'capable' },
  ]
  const src = await generatePhaseWorkflow({
    runId: 'x',
    phase: 1,
    tasks: mixed,
    maxParallel: 2,
    tierModels: { cheap: 'haiku', capable: 'sonnet' },
  })
  const captured = await captureAgentOptions(src)
  assert.deepEqual(
    captured.map((o) => [o.label, o.model]),
    [
      ['T1', 'haiku'],
      ['T2', 'sonnet'],
    ],
  )
})

test('agent() options omit model entirely when no tier resolves', async () => {
  const src = await generatePhaseWorkflow({ runId: 'x', phase: 1, tasks, maxParallel: 4 })
  const captured = await captureAgentOptions(src)
  assert.equal(captured.length, 2)
  for (const options of captured) {
    assert.ok(!('model' in options), 'agent() options must not carry a model key when none resolves')
  }
})

test('a task whose tier is absent from tierModels emits no model key', async () => {
  const tiered = [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1, tier: 'capable' }]
  const src = await generatePhaseWorkflow({
    runId: 'x',
    phase: 1,
    tasks: tiered,
    maxParallel: 2,
    tierModels: { cheap: 'haiku' },
  })
  assert.ok(!src.includes('"model"'), 'expected no model key when tier is absent from tierModels')
})

test('calling with no tierModels at all emits no model key', async () => {
  const tiered = [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1, tier: 'cheap' }]
  const src = await generatePhaseWorkflow({ runId: 'x', phase: 1, tasks: tiered, maxParallel: 2 })
  assert.ok(!src.includes('"model"'), 'expected no model key when tierModels is not supplied')
})

// Evaluates the generated body with stubbed primitives and returns every prompt the
// generated code passed to agent(). The brief is assembled at run time by string
// concatenation, so a line like the checkout command exists only once the generated
// code runs — asserting on the source text alone would never see it.
async function captureAgentPrompts(src) {
  const body = src.replace(/^export const meta = /m, 'const meta = ')
  const captured = []
  const phase = () => {}
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const agent = (prompt) => {
    captured.push(prompt)
    return Promise.resolve({ status: 'done', branch: 'b', filesChanged: [], summary: 's', blockers: [] })
  }
  const run = new Function('phase', 'parallel', 'agent', `return (async () => { ${body} })`)(phase, parallel, agent)
  await run()
  return captured
}

test('the brief opens with a verifiable checkout of the task branch off the base branch', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks: [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 }],
    maxParallel: 2,
    baseBranch: 'main',
  })
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(
    prompt.includes('git checkout -B teammates/r1/T1 main'),
    'brief must spell out the exact checkout command',
  )
  assert.ok(prompt.includes('git log --oneline -1'), 'brief must ask the teammate to verify the checkout')
})

test('the brief names the plan path when one is given', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks: [{ id: 'T1', title: 'auth middleware', files: ['src/auth.ts'], phase: 1 }],
    maxParallel: 2,
    planPath: 'docs/plans/2026-08-06-thing.md',
  })
  assert.ok(src.includes('docs/plans/2026-08-06-thing.md'), 'plan path must reach the generated source')
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(prompt.includes('PLAN. Read docs/plans/2026-08-06-thing.md'), 'brief must point at the plan')
  assert.ok(prompt.includes('"Task 1:"'), 'brief must name the task section to implement')
})

test('omitting planPath, baseBranch and constraints renders no undefined anywhere', async () => {
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2 })
  assert.ok(!src.includes('undefined'), 'omitted inputs must render empty, never the string undefined')
  const prompts = await captureAgentPrompts(src)
  for (const prompt of prompts) {
    assert.ok(!prompt.includes('undefined'), 'brief must not contain undefined')
    assert.ok(!prompt.includes('PLAN. Read'), 'no plan section without a plan path')
    assert.ok(!prompt.includes('GLOBAL CONSTRAINTS'), 'no constraints section without constraints')
  }
})

test('every constraint passed in appears in the generated source and in the brief', async () => {
  const constraints = ['Node >= 24.2.0', 'Zero new runtime dependencies', 'Tests use node:test']
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2, constraints })
  for (const c of constraints) assert.ok(src.includes(c), `missing constraint: ${c}`)
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(prompt.includes('GLOBAL CONSTRAINTS:'), 'brief must head the constraints section')
  for (const c of constraints) assert.ok(prompt.includes('- ' + c), `constraint missing from brief: ${c}`)
})

test('a constraint containing $& survives the function replacer verbatim', async () => {
  const constraints = ['never write $& into the log']
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2, constraints })
  assert.ok(src.includes('never write $& into the log'), '$& must not be read as a replacement pattern')
  const [prompt] = await captureAgentPrompts(src)
  assert.ok(prompt.includes('- never write $& into the log'), '$& must reach the brief verbatim')
})

test('the dispatch names a real agent type and keeps worktree isolation', async () => {
  const src = await generatePhaseWorkflow({ runId: 'r1', phase: 1, tasks, maxParallel: 2 })
  assert.ok(src.includes("agentType: 'claude-teammates:tm-implementer'"), 'missing agentType')
  assert.ok(src.includes("isolation: 'worktree'"), 'missing worktree isolation')
  const captured = await captureAgentOptions(src)
  for (const options of captured) {
    assert.equal(options.agentType, 'claude-teammates:tm-implementer')
    assert.equal(options.isolation, 'worktree')
  }
})

test('the generated source parses as a real module', async () => {
  const src = await generatePhaseWorkflow({
    runId: 'r1',
    phase: 1,
    tasks,
    maxParallel: 2,
    planPath: 'docs/plans/p.md',
    baseBranch: 'main',
    constraints: ["don't break $& things"],
  })
  // The workflow body ends in a top-level `return`, which is legal in the workflow host
  // but not in an ES module, so wrap the body in a function. Every other byte — the whole
  // brief included — is then parsed by the real module parser, which is exactly what the
  // substring assertions above cannot do.
  const split = src.indexOf('\nconst TASKS')
  assert.ok(split > 0, 'expected a TASKS declaration after the meta literal')
  const wrapped = `${src.slice(0, split)}\nexport const run = async (phase, parallel, agent) => {${src.slice(split)}\n}\n`
  const dir = await mkdtemp(join(tmpdir(), 'workflow-gen-'))
  try {
    const file = join(dir, 'phase.mjs')
    await writeFile(file, wrapped, 'utf8')
    const mod = await import(pathToFileURL(file).href)
    assert.equal(mod.meta.name, 'teammates-r1-phase-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
