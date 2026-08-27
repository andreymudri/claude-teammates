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

test('deletes a teammate branch only once the run branch provably contains it, never unconditionally', async () => {
  const scope = await taxonomy()
  assertClaim(scope, {
    claim: /^Each teammate does its work on its own branch, inside its own worktree, and that branch is deleted by prune-run once the run branch provably contains it\.$/,
    subject: /deleted by prune-run/,
  })
})

test('states the --yes flag is a destructive force-remove before showing the command, with the dry-run companion adjacent', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^The --yes flag runs git worktree remove --force on every worktree it lists as prunable, and that discards uncommitted and untracked changes in it without asking\.$/,
    then: /^Without --yes the command removes nothing and prints the same plan, which is what to run when you only want to see what is outstanding\.$/,
    introduces: /prune-run --run <runId> --plan <planPath> --root <project root> --yes/,
    subject: /--yes|--force/,
    allow: [/^Do not sweep by hand: a hand-run git worktree remove --force or git branch -D supplies neither the recomputed phase gate nor the ancestry proof above/],
  })
})

test('routes worktree removal through the recomputed phase gate and branch deletion through the ancestry proof, and states what git branch -D actually measures', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^It removes a task's worktree only where that task's phase gate recomputes to PASS, and it deletes the worktree's branch only where git merge-base --is-ancestor proves the run branch already contains it\.$/,
    then: /^That proof is not something a bare git branch -D makes on its own: -D deletes whatever branch it is given, unconditionally, and the plain -d measures "merged" against the branch's upstream or your current HEAD, never against the run branch\.$/,
    subject: /git branch -D|-d measures|merge-base --is-ancestor/,
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

test('names the phase gate and ancestry proof, not junction-following, as the reason to avoid a hand-run remove', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^Do not sweep by hand: a hand-run git worktree remove --force or git branch -D supplies neither the recomputed phase gate nor the ancestry proof above — it only does what the flag itself says, on whatever you point it at\.$/,
    subject: /sweep by hand|by hand/,
  })
})

test('says .teammates is kept deliberately, and the very next statement makes it the operator\'s to delete rather than prune-run\'s', async () => {
  const scope = await cleanup()
  assertClaim(scope, {
    claim: /^What this does not clean up: \.teammates\/<run-id>\/ stays on disk on purpose\.$/,
    then: /^Delete it yourself when you no longer want the record — resume and rebuild-state read it, and it is gitignored\.$/,
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
