// The brief IS the task specification. This module exists to become the single composer, so
// that the plan pointer, the mandatory checkout, the location record, the baseline run, the
// declared file set, the global constraints and the self-verification stop being present on
// one dispatch path and missing on another.
//
// That unification has NOT landed yet. Nothing outside tests/brief.test.mjs imports this
// module: `templates/phase-workflow.js` still carries its own copy, and the two already
// differ — this one emits the locate and complete steps, the template's copy emits neither,
// so a workflow-dispatched implementer is currently never told to run `cli.mjs locate`.
// Task 6 rewires the generator and the template onto `composeBrief` and adds the cross-file
// check that pins them byte-identical; until it lands, the template's copy is still live and
// is what a `Workflow` dispatch actually renders.
//
// One command this module emits is also not built yet: `cli.mjs` has no `locate`. See the
// note above `locateStep`. Nothing here can be dispatched for real until both that command
// and the rewiring land, and in that order.
//
// Pure: no I/O, no filesystem, no process access. That is what lets the generator substitute
// finished text into generated workflow scripts, which run without filesystem or module access
// and so could never import this at workflow runtime.
//
// What actually pins it, exactly: a source-level test in tests/brief.test.mjs strips comments
// and string literals — keeping `${...}` substitutions, which are code — and asserts the
// remaining executable source contains no static import, no dynamic `import(`, no `require(`,
// no `process` or `globalThis` reference, and no `eval`/`Function` constructor. A behavioural
// assertion cannot do this: an unused import changes no rendered output. The check bounds the
// named routes to the host; it is not a proof of purity in general.

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
// is most likely to break without touching. Rendered only when the caller supplied a NON-EMPTY
// list, so a repository with no history, or a task whose files are new, shows no section rather
// than a header with nothing under it — the `.length` test is what distinguishes an empty array
// from an absent key, and both cases are pinned in tests/brief.test.mjs.
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
//
// PREREQUISITE: `cli.mjs` has no `locate` command yet — a later task adds it. Whoever wires a
// dispatch path onto this module must land that command FIRST, or every brief it renders sends
// its teammate to an invocation the CLI rejects. This is the same standard applied to
// `--enforcement-only`, which the verify step deliberately does not emit because `complete`
// does not accept it yet; the difference is that flag can simply be omitted, while the locate
// step is the record the hook resolves through and has to be emitted. The rendered text below
// states the requirement rather than describing the interface as though it already existed.
const locateStep = (task, runId) => (runId ? [
  'RECORD YOUR WORKTREE. Immediately after the checkout above, run:',
  '',
  '    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" locate --run ' + runId + ' --task ' + task.id,
  '',
  'It is to take no path arguments: it must read your worktree and branch from where you run',
  'it. This is how your work is identified if you stop before finishing, so do not skip it.',
  'If the CLI answers that it does not know the command, that command has not landed yet:',
  'report status "blocked" naming it rather than inventing a substitute or skipping the step.',
  '',
] : [])

// The instruction the stop-time hook backstops. It needs both a run id and a plan path; with
// either missing the command could not run, so the section is dropped rather than rendered
// with an empty flag value.
//
// The exit codes below are read out of `complete` in scripts/cli.mjs, not inferred:
//   0  the task passes and is marked done in status.json
//   1  the gate passed but status.json is missing or does not list the task — bookkeeping
//   2  TWO unrelated things: teammates.gate.json is present and MALFORMED (configuration), or
//      the invocation itself was rejected — a missing required argument, an unknown flag, a
//      refused flag spelling, an empty --root, a --run escaping .teammates/ (which prints
//      `--run <value> escapes the run directory`). The argument errors are the teammate's own
//      to fix, and on one it has verified nothing at all, so the brief discriminates all five
//      by the printed line the same way it does for exit 4. The escape case is narrow — a
//      runId carrying a traversal cannot come from `init-run`, so it reaches a teammate only
//      through a caller composing a brief with an unvalidated runId — but it is listed in the
//      rendered text because this comment claims it is, and an unlisted marker falls through
//      to the malformed-manifest line: a false configuration diagnosis for a rejected
//      invocation on which nothing was verified.
//   4  FOUR different situations: no gate manifest, an underivable context, a task the plan
//      does not contain, and — the case that matters most — the recomputed gate REJECTING
//      this task, which prints a first line beginning `gate does not pass for phase`.
// So the code alone cannot separate "your work is wrong" from "this run cannot be verified":
// only that printed first line can. The brief therefore keys the teammate off what it can
// actually observe. A teammate told that 4 means "proceed" would return done on a failing
// fileset check. Reading a printed line is fine for an agent, which reads text anyway; what
// must never be built on text is a programmatic decision, which is why the hook gets a
// distinct exit code in a later phase and why that is not solved here.
const verifyStep = (task, runId, planPath) => (runId && planPath ? [
  'BEFORE YOU RETURN "done". Run the task gate on your own work, in the FOREGROUND:',
  '',
  '    ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")',
  '    node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" complete \\',
  '      --run ' + runId + ' --task ' + task.id + ' --plan ' + planPath + ' --root "$ROOT"',
  '',
  'ROOT must be the MAIN worktree, which is what that command computes — run from inside your',
  'own worktree the CLI would resolve the run branch to your task branch and answer the wrong',
  'question. Read BOTH the exit code and the first line it printed — exit 4 covers four',
  'different situations and only the printed line tells them apart:',
  '  exit 0 — your task passes. Return "done".',
  '  exit 4, output beginning "gate does not pass for phase" — the gate recomputed your task',
  '           and REJECTED it. That is your work, not a configuration problem.',
  '           Fix exactly the checks it names, then run the command again.',
  '           Returning "done" on this wastes the phase: the phase gate recomputes the same',
  '           thing and will reject it.',
  '  exit 4, output "no gate manifest", "cannot verify completion" or "no task ' + task.id + ' in the',
  '           plan" — the run cannot be verified from here. That is the run configuration, not',
  '           your work. Quote what it printed in your summary and proceed; do not loop on it,',
  '           and do not report "blocked" for it when the work itself is finished.',
  '  exit 2 — read the printed line here too: two unrelated things share this code.',
  '           Output naming an argument means YOUR INVOCATION was wrong, not the configuration:',
  '             "missing required argument:"   "unsupported flag spelling:"',
  '             "complete does not take"       "--root must not be empty"',
  '             "escapes the run directory"',
  '           None of those mention the manifest, and on any of them you have verified NOTHING',
  '           yet — the gate never ran. Fix the command you typed and run it again.',
  '           Any other exit 2 means teammates.gate.json itself is malformed. That one is',
  '           configuration, not your work: quote it and report it; do not loop.',
  '  exit 1 — the gate passed, but the run\'s status file is missing or does not list your task.',
  '           Your work is verified; quote the message and report it.',
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
