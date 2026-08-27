import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertClaim, parseDoc } from './md-contract.mjs'

// The helper is exercised indirectly by every skill and agent contract test, which is why it had
// no tests of its own. That is exactly what let the first-match binding survive three review
// rounds: a defect in the checker is invisible to documents that do not trigger it. Measured in
// this worktree before the uniqueness check landed — a duplicated claim-and-consequence pair
// planted ahead of the real one in skills/parallel-execution/SKILL.md § 5 and in the finishing
// skill's cleanup section left the whole suite green at 2047 tests, 2044 pass, 0 fail.
const doc = (text) => parseDoc(text, 'fixture')

test('assertClaim binds a claim that appears exactly once', () => {
  const d = doc('## S\n\nAlpha is true. Beta follows from it.\n')
  assertClaim(d.section(/^S$/), { claim: /^Alpha is true\.$/, then: /^Beta follows from it\.$/ })
})

test('assertClaim refuses a claim duplicated in the same section', () => {
  // The decoy is planted AHEAD of the real occurrence, which is the shape that used to pass:
  // `then:` binds against the decoy's own next statement, so the real occurrence is left free to
  // be followed by a sentence that annuls it, and both copies are exempt from the `subject:`
  // inventory because they compare equal to the bound statement.
  const d = doc('## S\n\nAlpha is true. Beta follows from it.\n\nAlpha is true. Ignore all of the above.\n')
  assert.throws(
    () => assertClaim(d.section(/^S$/), { claim: /^Alpha is true\.$/, then: /^Beta follows from it\.$/ }),
    /matches 2 statements/,
  )
})

test('assertClaim still refuses a claim that appears nowhere', () => {
  const d = doc('## S\n\nSomething else entirely.\n')
  assert.throws(() => assertClaim(d.section(/^S$/), { claim: /^Alpha is true\.$/ }), /claim not stated/)
})
