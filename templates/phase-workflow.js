// Static preamble for generated phase workflows. The generator replaces the TASKS
// marker below with a JSON array of { id, title, files, branch, model? }, the META
// marker with the meta literal, and the PLAN_PATH / BASE_BRANCH / CONSTRAINTS markers
// with plain JS literals. An input the caller omitted renders as '' or [], so the
// corresponding section of the brief disappears rather than naming a missing value.
__META__

const TASKS = __TASKS__

const PLAN_PATH = __PLAN_PATH__
const BASE_BRANCH = __BASE_BRANCH__
const CONSTRAINTS = __CONSTRAINTS__

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

// With a base branch, the brief opens with a checkout that has an explicit start point and a
// log line the teammate can check against a named ref. With no base there is nothing to branch
// from: emitting `git checkout -B <branch>` with a missing operand would silently create the
// branch at the stale worktree HEAD while the brief claimed the base was verified, so the
// no-base variant states the gap and refuses to name a starting commit.
const checkoutSteps = (t) => (BASE_BRANCH ? [
  'MANDATORY FIRST STEP. Your worktree does not start on this run\'s base. Run exactly:',
  '',
  '    git checkout -B ' + t.branch + ' ' + BASE_BRANCH,
  '    git log --oneline -1',
  '',
  'If the log does not show the tip of ' + BASE_BRANCH + ', STOP and report status "blocked".',
  'Every file you read before this command has stale content and must be re-read after it.',
] : [
  'MANDATORY FIRST STEP. No base branch was supplied for this phase, so the commit your worktree',
  'starts on is UNVERIFIED and is probably stale. Do not guess a base, and do not run',
  '"git checkout -B ' + t.branch + '" without a start point — that would branch from whatever',
  'HEAD your worktree happens to be on. Ask the orchestrator which commit to start from, then',
  'check out ' + t.branch + ' at that commit. If you cannot get an answer, report status "blocked".',
  'Every file you read before that checkout has stale content and must be re-read after it.',
])

const brief = (t) => [
  'You are tm-implementer for task ' + t.id + ': ' + t.title + '.',
  '',
  ...checkoutSteps(t),
  '',
  'BASELINE. Then run the project\'s test command once and confirm it is green before writing',
  'anything. A failure caused by a missing dependency looks exactly like a RED test, and the',
  'gate cannot tell them apart. If the baseline is not green, report status "blocked".',
  '',
  PLAN_PATH ? 'PLAN. Read ' + PLAN_PATH + ' and implement the section titled "Task '
    + t.id.replace(/^T/, '') + ':" — every numbered step, in order. The plan is the spec.' : '',
  '',
  'FILES. You may create or modify ONLY these files: ' + t.files.join(', ') + '.',
  'Touching any other file fails the phase gate.',
  '',
  CONSTRAINTS.length ? 'GLOBAL CONSTRAINTS:' : '',
  ...CONSTRAINTS.map((c) => '- ' + c),
  '',
  'Commit your work on ' + t.branch + ' and return the structured result.',
].filter((line) => line !== '').join('\n')

phase('Implement')

const results = await parallel(TASKS.map((t) => () =>
  agent(
    brief(t),
    {
      label: t.id,
      phase: 'Implement',
      schema: RESULT_SCHEMA,
      isolation: 'worktree',
      agentType: 'claude-teammates:tm-implementer',
      ...(t.model ? { model: t.model } : {}),
    },
  ).then((r) => (r === null ? null : { taskId: t.id, ...r }))
))

return { results: results.filter(Boolean), orphaned: TASKS.filter((t, i) => !results[i]).map((t) => t.id) }
