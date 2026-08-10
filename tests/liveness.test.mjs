import { test } from 'node:test'
import assert from 'node:assert/strict'
import { livenessRows, renderLiveness, hasStall, hasUnknown, DEFAULT_STALE_MINUTES } from '../scripts/liveness.mjs'

const NOW = 1_700_000_000_000
const MIN = 60 * 1000
const tasks = [{ id: 'T1' }]

function rowFor({ tip, touch, staleMinutes }) {
  const [row] = livenessRows({
    tasks,
    tips: tip === undefined ? {} : { T1: tip },
    touches: touch === undefined ? {} : { T1: touch },
    now: NOW,
    staleMinutes,
  })
  return row
}

test('a fresh tip with a stale worktree reads working', () => {
  const row = rowFor({
    tip: { branch: 'teammates/r1/T1', at: NOW - 2 * MIN },
    touch: { branch: 'teammates/r1/T1', at: NOW - 90 * MIN, floored: false },
  })
  assert.equal(row.state, 'working')
  assert.equal(row.branch, 'teammates/r1/T1')
})

test('a stale tip with a fresh worktree reads working', () => {
  // The commonest true shape: a teammate mid-edit has written nothing to git yet.
  const row = rowFor({
    tip: { branch: 'teammates/r1/T1', at: NOW - 90 * MIN },
    touch: { branch: 'teammates/r1/T1', at: NOW - 1 * MIN, floored: false },
  })
  assert.equal(row.state, 'working')
})

test('a stale tip and a stale worktree read stalled', () => {
  const row = rowFor({
    tip: { branch: 'teammates/r1/T1', at: NOW - 90 * MIN },
    touch: { branch: 'teammates/r1/T1', at: NOW - 90 * MIN, floored: false },
  })
  assert.equal(row.state, 'stalled')
  assert.equal(row.tipAgeMs, 90 * MIN)
  assert.equal(row.touchAgeMs, 90 * MIN)
})

test('no branch and no worktree reads not started rather than stalled', () => {
  const row = rowFor({})
  assert.equal(row.state, 'not started')
  assert.equal(row.branch, null)
  assert.equal(row.tipAgeMs, null)
  assert.equal(row.touchAgeMs, null)
})

test('a worktree with no commits and a stale mtime reads stalled', () => {
  const row = rowFor({ touch: { branch: 'teammates/r1/T1', at: NOW - 45 * MIN, floored: false } })
  assert.equal(row.state, 'stalled')
  assert.equal(row.tipAgeMs, null)
  assert.equal(row.branch, 'teammates/r1/T1')
})

// A floored walk stopped early, so the newest file may be one it never reached: "stalled" is
// unsayable. "working" is equally unsayable, and saying it was the bug — on a repository whose
// worktree always floors, every row read working and the stall signal could never fire at all.
test('a floored touch with nothing fresh reads unknown, not working and not stalled', () => {
  const row = rowFor({
    tip: { branch: 'teammates/r1/T1', at: NOW - 5000 * MIN },
    touch: { branch: 'teammates/r1/T1', at: NOW - 5000 * MIN, floored: true },
  })
  assert.equal(row.state, 'unknown')
  assert.equal(row.floored, true)
})

test('a floored touch with no touch measurement at all still reads unknown', () => {
  const row = rowFor({ touch: { branch: 'teammates/r1/T1', at: null, floored: true } })
  assert.equal(row.state, 'unknown')
})

// The tip is a measurement in its own right, and a commit inside the window settles the question
// whatever the walk did — so a floored row is not automatically unknown.
test('a fresh tip settles a row as working even when the worktree walk floored', () => {
  const row = rowFor({
    tip: { branch: 'teammates/r1/T1', at: NOW - 1 * MIN },
    touch: { branch: 'teammates/r1/T1', at: NOW - 5000 * MIN, floored: true },
  })
  assert.equal(row.state, 'working')
})

test('hasUnknown is true only when some row was not measured', () => {
  assert.equal(hasUnknown([{ state: 'working' }, { state: 'stalled' }]), false)
  assert.equal(hasUnknown([{ state: 'working' }, { state: 'unknown' }]), true)
  assert.equal(hasUnknown([]), false)
  assert.equal(hasUnknown(), false)
})

test('the threshold is inclusive at exactly staleMinutes and stalls one millisecond past it', () => {
  const at = { staleMinutes: 20 }
  const exact = rowFor({ tip: { branch: 'b', at: NOW - 20 * MIN }, ...at })
  assert.equal(exact.state, 'working')
  const past = rowFor({ tip: { branch: 'b', at: NOW - 20 * MIN - 1 }, ...at })
  assert.equal(past.state, 'stalled')
})

test('livenessRows throws on a non-numeric clock rather than reporting every task stalled', () => {
  assert.throws(() => livenessRows({ tasks, now: undefined }), /numeric clock/)
  assert.throws(() => livenessRows({ tasks, now: 'now' }), /numeric clock/)
  assert.throws(() => livenessRows({ tasks, now: NaN }), /numeric clock/)
})

test('the default threshold applies when none is given', () => {
  assert.equal(DEFAULT_STALE_MINUTES, 20)
  const row = rowFor({ tip: { branch: 'b', at: NOW - (DEFAULT_STALE_MINUTES + 1) * MIN } })
  assert.equal(row.state, 'stalled')
})

test('renderLiveness names the threshold, every task and its state', () => {
  const rows = livenessRows({
    tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }],
    tips: { T1: { branch: 'b1', at: NOW - 3 * MIN }, T2: { branch: 'b2', at: NOW - 60 * MIN } },
    touches: {
      T2: { branch: 'b2', at: NOW - 60 * MIN, floored: false },
      T3: { branch: 'b3', at: NOW - 99 * MIN, floored: true },
    },
    now: NOW,
    staleMinutes: 20,
  })
  const out = renderLiveness(rows, { staleMinutes: 20 })
  assert.match(out, /stale after 20m/)
  assert.match(out, /T1\s+3m\s+-\s+working/)
  assert.match(out, /T2\s+60m\s+60m\s+stalled/)
  assert.match(out, /T3\s+-\s+99m \(floor\)\s+unknown/)
})

test('hasStall is true only when some row is stalled', () => {
  assert.equal(hasStall([{ state: 'working' }, { state: 'not started' }]), false)
  assert.equal(hasStall([{ state: 'working' }, { state: 'stalled' }]), true)
  assert.equal(hasStall([]), false)
  assert.equal(hasStall(), false)
})
