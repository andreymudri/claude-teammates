import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { assertClaim, parseDoc, splitFrontmatter } from './md-contract.mjs'

const body = async () => readFile(new URL('../skills/finishing-a-development-branch/SKILL.md', import.meta.url), 'utf8')

// Structural model of the skill, used by the cleanup-section assertions below instead of a
// whole-body regex: a regex over the raw text is satisfied by tokens drawn from anywhere in the
// document, so a sentence that inverts a claim can sit right next to (or in place of) the
// original and the old assertions never noticed. `assertClaim` binds a claim to one statement,
// optionally to its very next statement (`then`), which an inserted or reworded sentence cannot
// satisfy by accident. See tests/md-contract.mjs for what this can and cannot detect.
const doc = async () => {
  const { body: text } = splitFrontmatter(await body(), 'finishing-a-development-branch')
  return parseDoc(text, 'finishing-a-development-branch/SKILL.md')
}
const cleanup = async () => (await doc()).section(/^Worktree and branch cleanup$/)
const taxonomy = async () => (await doc()).section(/^Branch taxonomy$/)

test('requires a recorded gate PASS before presenting work as finished', async () => {
  const b = await body()
  assert.match(b, /status\.gates|recorded PASS/i)
})

test('distinguishes teammate branches from the run branch', async () => {
  const b = await body()
  assert.match(b, /teammate branch/i)
  assert.match(b, /run branch/i)
})

test('names tm-integrator as the sole writer of the run branch', async () => {
  assert.match(await body(), /tm-integrator/)
})

test('deletes a teammate branch only for a worktree it removes, once the run branch provably contains it — a whole-section deletion lexicon, not a lock on one sentence', async () => {
  const scope = await taxonomy()
  assertClaim(scope, {
    claim: /^Each teammate does its work on its own branch, inside its own worktree, and that branch is deleted by prune-run for each worktree it removes, once the run branch provably contains it\.$/,
    // Wide on purpose: `claim:` alone only guards the sentence it is bound to, so a second,
    // unreviewed sentence about deleting a teammate branch — by any verb form, or a hand-run
    // `git branch -D` — could sit right next to it. `subject:` makes every such sentence in this
    // section go through `allow`, the way T8's inventory lock does for its own section.
    subject: /branch -D|delet(e|es|ed|ing)|disposable/,
  })
})

test('states the --yes flag is destructive and link-following before showing the command, with the dry-run companion adjacent', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^The --yes flag runs git worktree remove --force on every worktree it lists as prunable, and that discards uncommitted and untracked changes in it without asking\.$/,
    then: /^It also follows any link a worktree holds out to somewhere else, so a worktree provisioned with a shortcut back into the repository — the kind a fresh worktree's own dependency install might create, such as a junction into the repository's real node_modules — has that target's contents deleted too, not just the worktree's own\.$/,
    // Anchored to the WHOLE code block, not a substring: `pattern.test(code)` alone is satisfied
    // by the pinned line sitting anywhere inside a bigger block, including one sandwiched between
    // an `rm -rf` line above it and a `git branch -D $(...)` line below it. `^...$` refuses both.
    introduces: /^node "\$CLAUDE_PLUGIN_ROOT\/scripts\/cli\.mjs" prune-run --run <runId> --plan <planPath> --root <project root> --yes$/,
    subject: /--yes|--force/,
    allow: [
      /^Do not sweep by hand: a hand-run git worktree remove --force or git branch -D supplies neither the recomputed phase gate nor the ancestry proof above/,
      /^Without --yes the command removes nothing, and it prints the same worktree and branch list --yes would act on/,
      /^That proof is only as good as the run branch's name being unambiguous, so before --yes confirm/,
    ],
  })
})

test('the link-following limit leads into the dry-run sentence, which no longer overstates what the dry run shows', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^It also follows any link a worktree holds out to somewhere else, so a worktree provisioned with a shortcut back into the repository — the kind a fresh worktree's own dependency install might create, such as a junction into the repository's real node_modules — has that target's contents deleted too, not just the worktree's own\.$/,
    then: /^Without --yes the command removes nothing, and it prints the same worktree and branch list --yes would act on, but not which of those branches would actually be deleted — that verdict is computed only inside the removal itself\.$/,
  })
})

test('routes worktree removal through the recomputed phase gate and branch deletion through the ancestry proof, immediately bounded by the run-branch-name caveat', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^It removes a task's worktree only where that task's phase gate recomputes to PASS, and it deletes the worktree's branch only where git merge-base --is-ancestor proves the run branch already contains it\.$/,
    then: /^That proof is only as good as the run branch's name being unambiguous, so before --yes confirm git rev-parse --abbrev-ref HEAD prints the run branch's plain name — anything longer \(heads\/<name>, refs\/heads\/<name>\) means a tag or a branch named heads\/<name> exists and the deletion would be proved against that ref instead\.$/,
    subject: /merge-base --is-ancestor|rev-parse --abbrev-ref HEAD/,
  })
})

test('the run-branch-name caveat leads into what a bare git branch -D actually does — refusing a checked-out branch, never proving ancestry', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^That proof is only as good as the run branch's name being unambiguous, so before --yes confirm git rev-parse --abbrev-ref HEAD prints the run branch's plain name — anything longer \(heads\/<name>, refs\/heads\/<name>\) means a tag or a branch named heads\/<name> exists and the deletion would be proved against that ref instead\.$/,
    then: /^That proof is not something a bare git branch -D makes on its own: -D deletes whatever branch it is given without asking whether the run branch contains it — it refuses only a branch a registered worktree still holds checked out, which is why prune-run removes the worktree first — and the plain -d measures "merged" against the branch's upstream or your current HEAD, never against the run branch\.$/,
    subject: /git branch -D|-d measures/,
    allow: [/^Do not sweep by hand: a hand-run git worktree remove --force or git branch -D supplies neither the recomputed phase gate nor the ancestry proof above/],
  })
})

test('never touches the main worktree or another run\'s task worktree, but does reap a leaked merge-preview worktree from any run', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^It never touches the main worktree, and it never removes another run's task worktree, but it does force-remove a leaked merge-preview worktree — a scratch worktree under the system temp directory — regardless of which run's gate created it, because a killed gate cannot run its own cleanup\.$/,
    then: /^Every worktree it examines and declines to remove is printed with the reason; it examines worktrees, not bare branches, so a task branch whose worktree is already gone is not reported either way\.$/,
    subject: /main worktree|another run's task worktree|merge-preview worktree/,
  })
})

test('names the phase gate and ancestry proof, not junction-following, as the reason to avoid a hand-run remove, and covers an rm -rf escape hatch too', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^Do not sweep by hand: a hand-run git worktree remove --force or git branch -D supplies neither the recomputed phase gate nor the ancestry proof above — it only does what the flag itself says, on whatever you point it at\.$/,
    // `rm -rf`/`rm -fr` added: an escape-hatch paragraph recommending it instead of the two named
    // commands is exactly the kind of insertion `by hand` alone would miss, since it names
    // neither `git worktree remove` nor `git branch -D`.
    subject: /sweep by hand|by hand|rm -rf|rm -fr/,
  })
})

test('says .teammates is kept deliberately, and the very next statement makes it the operator\'s to delete rather than any command\'s, naming only the command that actually reads it', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^What this does not clean up: \.teammates\/<run-id>\/ stays on disk on purpose\.$/,
    then: /^Delete it yourself when you no longer want the record — resume reads it, and it is gitignored\.$/,
  })
})

test('is original and carries no upstream attribution', async () => {
  assert.doesNotMatch(await body(), /Adapted from the MIT-licensed superpowers plugin/)
})

test('handles an inline run with no recorded gates by running the test suite fresh', async () => {
  const b = await body()
  assert.match(b, /gates.*(?:absent|empty)|(?:absent|empty).*gates/i)
  assert.match(b, /full test suite/i)
})

test('handles the case where no run directory exists at all', async () => {
  assert.match(await body(), /no run directory/i)
})
