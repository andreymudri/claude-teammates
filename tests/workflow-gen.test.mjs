import { test } from 'node:test'
import assert from 'node:assert/strict'
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
