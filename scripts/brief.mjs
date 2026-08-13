// The brief IS the task specification. Every consumer composes it here so that the
// plan pointer, the mandatory checkout, the baseline run, the declared file set and the
// global constraints cannot be present on one dispatch path and missing on another.
//
// Pure: no I/O, no filesystem, no process access. Generated workflow scripts run without
// module access, so the generator substitutes the finished text rather than importing this
// at workflow runtime.

// With a base branch, the brief opens with a checkout that has an explicit start point and a
// log line the teammate can check against a named ref. With no base there is nothing to branch
// from: emitting `git checkout -B <branch>` with a missing operand would silently create the
// branch at the stale worktree HEAD while the brief claimed the base was verified, so the
// no-base variant states the gap and refuses to name a starting commit.
const checkoutSteps = (task, baseBranch) => (baseBranch ? [
  'MANDATORY FIRST STEP. Your worktree does not start on this run\'s base. Run exactly:',
  '',
  '    git checkout -B ' + task.branch + ' ' + baseBranch,
  '    git log --oneline -1',
  '',
  'If the log does not show the tip of ' + baseBranch + ', STOP and report status "blocked".',
  'Every file you read before this command has stale content and must be re-read after it.',
] : [
  'MANDATORY FIRST STEP. No base branch was supplied for this phase, so the commit your worktree',
  'starts on is UNVERIFIED and is probably stale. Do not guess a base, and do not run',
  '"git checkout -B ' + task.branch + '" without a start point — that would branch from whatever',
  'HEAD your worktree happens to be on. Ask the orchestrator which commit to start from, then',
  'check out ' + task.branch + ' at that commit. If you cannot get an answer, report status "blocked".',
  'Every file you read before that checkout has stale content and must be re-read after it.',
])

// Files that have historically changed alongside this task's declared set. They are OUTSIDE the
// set, so the teammate may not edit them — the point is the opposite: they are what its change
// is most likely to break without touching. Rendered only when the caller supplied any, so a
// repository with no history, or a task whose files are new, shows no section rather than an
// empty one.
const blastRadius = (task) => (task.neighbours && task.neighbours.length ? [
  'BLAST RADIUS. These files are not yours and you may not edit them. They have changed together',
  'with your files in the past, so they are where your change is most likely to break something:',
  ...task.neighbours.map((n) => '  ' + Math.round(n.confidence * 100) + '%  ' + n.path),
  'This is a statistic about history, not a dependency list: it can be wrong in both directions.',
  'Read the ones that look relevant. If your task cannot be done without editing one, that is a',
  'file-set problem — report status "blocked" naming it rather than editing it.',
  '',
] : [])

// Written before the work, not after. The stop-time hook maps a cwd back to a task through
// this record; resolving through the checked-out branch instead would miss a teammate that
// never created its branch, which is the failure the hook exists to catch. With no run id
// there is no record to write, so the section disappears rather than emitting `--run ` empty.
const locateStep = (task, runId) => (runId ? [
  'RECORD YOUR WORKTREE. Immediately after the checkout above, run:',
  '',
  '    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" locate --run ' + runId + ' --task ' + task.id,
  '',
  'It takes no path arguments: it reads your worktree and branch from where you run it.',
  'This is how your work is identified if you stop before finishing. Do not skip it.',
  '',
] : [])

// The instruction the stop-time hook backstops. It needs both a run id and a plan path; with
// either missing the command could not run, so the section is dropped rather than rendered
// with an empty flag value.
const verifyStep = (task, runId, planPath) => (runId && planPath ? [
  'BEFORE YOU RETURN "done". Run the task gate on your own work, in the FOREGROUND:',
  '',
  '    ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")',
  '    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" complete \\',
  '      --run ' + runId + ' --task ' + task.id + ' --plan ' + planPath + ' --root "$ROOT"',
  '',
  'ROOT must be the MAIN worktree, which is what that command computes — run from inside your',
  'own worktree the CLI would resolve the run branch to your task branch and answer the wrong',
  'question. Exit 0 means your task passes. Anything else: fix what it names and run it again.',
  'Returning "done" on a non-zero result wastes the phase, because the gate recomputes exactly',
  'this and will reject it.',
  '',
] : [])

const full = ({ task, runId, planPath, baseBranch, constraints }) => [
  'You are tm-implementer for task ' + task.id + ': ' + task.title + '.',
  '',
  ...checkoutSteps(task, baseBranch),
  '',
  ...locateStep(task, runId),
  'BASELINE. Then bootstrap the worktree, before writing anything, in this order:',
  '1. Install the project\'s dependencies as the project requires.',
  '2. Copy over any untracked config the project needs (for example .env).',
  '3. Run the project\'s test command once, IN THE FOREGROUND, and confirm it is green.',
  '   Never background it: nothing notifies you when a backgrounded command finishes.',
  'A fresh worktree starts with none of that in place, and a failure caused by a missing',
  'dependency looks exactly like a RED test, which the gate cannot tell apart from a real one.',
  'Report status "blocked" only if the baseline cannot be made green.',
  '',
  planPath ? 'PLAN. Read ' + planPath + ' and implement the section titled "Task '
    + task.id.replace(/^T/, '') + ':" — every numbered step, in order. The plan is the spec.' : '',
  '',
  'FILES. You may create or modify ONLY these files: ' + task.files.join(', ') + '.',
  'Touching any other file fails the phase gate.',
  '',
  ...blastRadius(task),
  constraints.length ? 'GLOBAL CONSTRAINTS:' : '',
  ...constraints.map((c) => '- ' + c),
  '',
  ...verifyStep(task, runId, planPath),
  'Commit your work on ' + task.branch + ' and return the structured result.',
].filter((line) => line !== '').join('\n')

// The compressed variant reuses checkoutSteps verbatim and compresses only the connective
// prose. The MANDATORY FIRST STEP block, the checkout commands, the locate and complete
// commands, the BASELINE steps, the FILES list and the constraints all survive unchanged: a
// brief is the task specification, and compressing a specification drops the wording the gate
// then enforces. A command line is not connective prose.
const terse = ({ task, runId, planPath, baseBranch, constraints, caveman }) => [
  'You are tm-implementer. Task ' + task.id + ': ' + task.title + '.',
  '',
  ...checkoutSteps(task, baseBranch),
  '',
  ...locateStep(task, runId),
  'BASELINE. Before writing anything, in order:',
  '1. Install the project\'s dependencies as the project requires.',
  '2. Copy over any untracked config the project needs (for example .env).',
  '3. Run the project\'s test command once, IN THE FOREGROUND, and confirm it is green.',
  '   Never background it: nothing notifies you when a backgrounded command finishes.',
  'Fresh worktree has none of that. Missing dep looks exactly like RED test; gate cannot tell',
  'them apart. Report status "blocked" only if baseline cannot be made green.',
  '',
  planPath ? 'PLAN. Read ' + planPath + ' and implement the section titled "Task '
    + task.id.replace(/^T/, '') + ':" — every numbered step, in order. The plan is the spec.' : '',
  '',
  'FILES. You may create or modify ONLY these files: ' + task.files.join(', ') + '.',
  'Touching any other file fails the phase gate.',
  '',
  ...blastRadius(task),
  constraints.length ? 'GLOBAL CONSTRAINTS:' : '',
  ...constraints.map((c) => '- ' + c),
  '',
  ...verifyStep(task, runId, planPath),
  'STYLE. Write summary and blockers caveman-terse: drop articles and filler, keep every',
  'technical term, file path and error string exact. If skill caveman:caveman is available,',
  'use it at level ' + caveman + '. If not available, apply the style directly — its absence',
  'is not a blocker.',
  '',
  'Commit your work on ' + task.branch + ' and return the structured result.',
].filter((line) => line !== '').join('\n')

export function composeBrief({ task, runId = '', planPath = '', baseBranch = '', constraints = [], caveman = false }) {
  if (!task || typeof task.id !== 'string') throw new Error('composeBrief: task.id is required')
  if (!Array.isArray(task.files)) throw new Error(`composeBrief: task ${task.id} has no files array`)
  if (typeof task.branch !== 'string' || task.branch === '') {
    throw new Error(`composeBrief: task ${task.id} has no branch`)
  }
  const options = { task, runId, planPath, baseBranch, constraints, caveman }
  return caveman ? terse(options) : full(options)
}
