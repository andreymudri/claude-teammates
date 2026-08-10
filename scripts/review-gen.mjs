import { reviewFileName } from './reviews.mjs'
// A pure string check — no filesystem, no resolution — so importing it does not cost this module
// its own purity. It is the same screen `withMergePreview` runs before it links anything, which
// is what makes "a manifest this refuses has no working merge preview either" checkable rather
// than reassuring.
import { validateLinkPaths } from './preview-links.mjs'

// Generates the reviewer dispatches for a phase, the way `workflow-gen` generates the
// implementer ones.
//
// Every rule encoded here was learned from a loss, and each one previously lived only as prose
// the orchestrator had to reassemble per phase: dispatch without a `name` (a named reviewer
// becomes an addressable teammate and goes idle without emitting, taking the whole review with
// it), the fixed `capable` tier unless the tracked manifest says otherwise, effort inherited
// rather than defaulted, a per-lens findings path to recover from, and a scratch worktree
// outside the repository (one created inside it failed `ownership` for a whole run).
//
// It is pure: no filesystem, no git, no config reading. The caller resolves the phase's
// branches, the configured tier and effort, and the scratch root, then feeds them in — which is
// what makes the whole thing testable without a repository.

// A lens name alone tells a reviewer what to look for, not how to find it. For most lenses that
// is enough — reading a diff for correctness is a thing a reviewer already knows how to do.
//
// `claims` is not one of those. Seven of the twelve findings in run `followups` were a comment,
// skill sentence or spec line asserting a guarantee the adjacent code did not deliver, and none
// of them surfaced from reading the diff: they looked correct, which is why they survived review
// in the first place. What found them was mutating what the claim protected and checking whether
// anything noticed. A lens named `claims` with the generic prompt would be a fourth reader.
//
// A lens absent from this map produces the generic prompt byte for byte.
//
// Null-prototyped AND read through Object.hasOwn. On a bare literal read bare, a lens of
// `toString` resolves to Object.prototype.toString and appends its call result to the prompt,
// and `__defineGetter__` resolves to a function that throws where a dispatch-validation message
// is expected. `scripts/gate-runner.mjs` carries the same fix for check kinds, and the lens
// array is the same hand-written manifest field.
//
// Measured, not assumed: either guard alone is sufficient, so removing one does not fail a test.
// Both are kept because whichever is removed later will be removed as the redundant one, and the
// tests above pin only the behaviour, which the survivor still delivers — until it too goes.
const LENS_METHODS = Object.assign(Object.create(null), {
  claims: ({ testCommand, mutationCap, linkPaths, scratchWorktree, runBranch, branches }) => [
    '',
    'This lens has a method, and it is not the generic one. A claim is any sentence in the diff asserting a guarantee: a code comment, a skill sentence, a spec line. Reading a claim cannot tell you whether the code delivers it. Mutating what it protects can.',
    '',
    `1. Build the tree this phase would integrate: create your scratch worktree at ${scratchWorktree} from ${runBranch}, then merge ${branches.join(', ')} into it. No single ref holds the whole diff you are reviewing, so a worktree based on any one of them is not the tree under review — mutating it would answer a question nobody asked. If that merge conflicts, STOP: return zero findings and an "unableToVerify" key naming the conflict.`,
    `2. Establish a green baseline BEFORE mutating anything.${linkPaths.length > 0 ? ` First link these paths in from the repository root so the suite can run: ${linkPaths.join(', ')}.` : ''} Run \`${testCommand}\` unmodified in that worktree. If it is not green, STOP: return zero findings and an "unableToVerify" key naming the failure. Every mutation below reads as "nothing pins this claim" when the suite cannot run, so findings from a red baseline would be fabrications.`,
    '3. Enumerate every claim in the diff, citing each as file:line.',
    '4. Rank them by assertion strength. A claim that a window is closed, that a list is exhaustive, or that every case is covered outranks a descriptive comment.',
    `5. Take the top ${mutationCap} and probe them ONE AT A TIME. For each: break what the claim protects — delete the filter, widen the guard, remove the branch — run \`${testCommand}\`, then REVERT that mutation before probing the next. Mutations left in place accumulate, and the first claim that really is pinned turns the suite red for every claim probed after it, which reads as though all of them were pinned.`,
    '6. A claim whose mutation leaves the suite green is a finding. Quote the claim, name the mutation that survived, and cite file:line.',
    `7. List every claim you enumerated but did NOT probe, by file:line, under an "unprobed" key in your findings JSON. You probed at most ${mutationCap} of what you found, and a bounded review that reports as though it were exhaustive is the exact defect this lens exists to catch.`,
    '8. Clean up in this order: remove every link you created FIRST, then remove the worktree, and never with `--force`. On Windows a linked build input is a junction, and removing a worktree that still contains one deletes the contents of the REAL directory it points at rather than the link.',
    '',
    'Severity: an unpinned claim about an enforcement or security guarantee is high. A descriptive comment that has merely drifted from the code is low.',
  ].join('\n'),
})

// Interpolated into a numbered list of instructions the reviewer executes, so a newline in the
// command turns into extra instructions. Verified: a crafted `run` produced a prompt whose steps
// carried the injected sentences. The whole C0 range plus DEL, because the argument for refusing
// a newline is the argument for refusing anything else a terminal or a parser acts on.
function hasControlChar(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function generateReviewDispatch({
  runId,
  phaseName,
  checkName = 'review',
  lenses = [],
  blockOn = ['high'],
  tier = 'capable',
  effort = '',
  tierModels = null,
  runBranch,
  branches = [],
  findingsDir,
  scratchRoot,
  testCommand = '',
  testCommandName = '',
  mutationCap = 8,
  linkPaths = [],
}) {
  if (!Array.isArray(lenses) || lenses.length === 0) {
    throw new Error(`a review dispatch needs at least one lens, got ${JSON.stringify(lenses)}`)
  }
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new Error(`a review dispatch needs at least one task branch to review, got ${JSON.stringify(branches)}`)
  }
  // Screened on every dispatch, not only the ones that emit these paths, and screened here
  // rather than trusted from the caller: `previewLinks` tests Array.isArray and nothing else, so
  // an entry of '../../../../Users/someone/.ssh' would otherwise reach a prompt that tells the
  // reviewer to link it into a worktree and later remove that worktree — and removing a worktree
  // through a junction deletes the target's contents, which this repository has recorded and
  // tested. Screening unconditionally costs a phase nothing it had: `withMergePreview` runs this
  // same check before it links anything, so a manifest refused here has no merge preview either.
  const badLink = validateLinkPaths(linkPaths)
  if (badLink) throw new Error(badLink)

  if (lenses.includes('claims')) {
    // Thrown at generation time, not degraded into a weaker prompt. Without a command to run, the
    // method above collapses into "read the claims and reason about them" — which is the static
    // review the mutation step exists to replace, delivered under a name that says otherwise.
    if (!testCommand) {
      throw new Error('the claims lens mutates code and runs the suite, so it needs a test command; this phase declares no command check to take one from')
    }
    if (hasControlChar(testCommand)) {
      const named = testCommandName ? `the command check ${JSON.stringify(testCommandName)}` : 'the command check this phase declares'
      throw new Error(`${named} has a run string containing a control character, and the claims method interpolates it into instructions the reviewer executes; refused rather than emitted`)
    }
  }

  const model = tierModels?.[tier]
  const severities = (blockOn ?? []).join(', ')

  const reviewers = lenses.map((lens) => {
    // Throws on a lens that cannot be a filename — before it is written into a path, not after.
    const fileName = reviewFileName(phaseName, lens)
    const findingsPath = `${findingsDir}/${fileName}`
    const scratchWorktree = `${scratchRoot}/tm-review-${runId}-${phaseName}-${lens}`

    const basePrompt = [
      `Review the phase ${phaseName} diff of teammates run ${runId} through exactly one lens: ${lens}.`,
      '',
      `The diff under review is these task branches against the run branch ${runBranch}:`,
      ...branches.map((b) => `  ${b}`),
      `Diff each against its own fork point (git merge-base ${runBranch} <branch>), never tip against tip.`,
      '',
      `Report only ${lens} defects you can tie to a concrete failure: specific input or state producing a specific wrong result. Rate each finding high, medium or low. Findings rated ${severities} block this phase, so reserve those. Cite file:line for every finding. No findings is a valid and common result.`,
      '',
      `You are read-only. Never write to any ref — no commit, merge, rebase, reset, push or update-ref — on the base branch, the run branch, or any task branch, and never run git checkout in the main worktree. If you need to execute code across branches, create your scratch worktree at ${scratchWorktree}, which is outside the repository, and remove it when you are done. If you cannot verify a finding without writing to a shared ref, report it unverified and say what you would have run.`,
      '',
      `Write your findings JSON to ${findingsPath} before you return, then return the same JSON as your final output. The response is the interface; the file is what makes your review recoverable if you go idle before emitting it.`,
    ].join('\n')

    const build = Object.hasOwn(LENS_METHODS, lens) ? LENS_METHODS[lens] : null
    const method = build ? build({ testCommand, mutationCap, linkPaths, scratchWorktree, runBranch, branches }) : ''
    const prompt = method ? `${basePrompt}\n${method}` : basePrompt

    const dispatch = {
      lens,
      // Explicitly null rather than omitted: "dispatch this without a name" is the instruction,
      // and an absent key reads as an oversight the next caller helpfully fills in.
      name: null,
      agentType: 'claude-teammates:tm-reviewer',
      findingsPath,
      scratchWorktree,
      prompt,
    }
    if (model) dispatch.model = model
    // Absent, not empty: unset effort means the dispatch inherits the session's, and an empty
    // string would be passed through as if it were a level.
    if (effort) dispatch.effort = effort
    return dispatch
  })

  return { runId, phase: phaseName, check: checkName, blockOn, tier, reviewers }
}
