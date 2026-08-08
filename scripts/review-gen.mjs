import { reviewFileName } from './reviews.mjs'

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
}) {
  if (!Array.isArray(lenses) || lenses.length === 0) {
    throw new Error(`a review dispatch needs at least one lens, got ${JSON.stringify(lenses)}`)
  }
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new Error(`a review dispatch needs at least one task branch to review, got ${JSON.stringify(branches)}`)
  }

  const model = tierModels?.[tier]
  const severities = (blockOn ?? []).join(', ')

  const reviewers = lenses.map((lens) => {
    // Throws on a lens that cannot be a filename — before it is written into a path, not after.
    const fileName = reviewFileName(phaseName, lens)
    const findingsPath = `${findingsDir}/${fileName}`
    const scratchWorktree = `${scratchRoot}/tm-review-${runId}-${phaseName}-${lens}`

    const prompt = [
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
