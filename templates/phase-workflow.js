// Static preamble for generated phase workflows. The generator replaces the TASKS
// marker below with a JSON array of { id, title, files } and the META marker with
// the meta literal.
__META__

const TASKS = __TASKS__

const RESULT_SCHEMA = {
  type: 'object',
  required: ['status', 'branch', 'filesChanged', 'summary', 'blockers'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    branch: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
}

phase('Implement')

const results = await parallel(TASKS.map((t) => () =>
  agent(
    [
      'You are tm-implementer for task ' + t.id + ': ' + t.title + '.',
      'You may create or modify ONLY these files: ' + t.files.join(', ') + '.',
      'Touching any other file fails the phase gate.',
      'Commit your work on your worktree branch and return the structured result.',
    ].join('\n'),
    { label: t.id, phase: 'Implement', schema: RESULT_SCHEMA, isolation: 'worktree' },
  ).then((r) => ({ taskId: t.id, ...r }))
))

return { results: results.filter(Boolean), orphaned: TASKS.filter((t, i) => !results[i]).map((t) => t.id) }
