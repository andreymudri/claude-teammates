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
