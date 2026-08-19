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

// A missing touch record is absence of evidence, not evidence of absence: no worktree is
// registered for the branch, so nothing looked at whether files are being edited. Reported as a
// measured stall it fired exit 1 on the first heartbeat of any phase dispatched without worktree
// isolation, with both teammates actively working and simply not having committed yet.
test('a stale tip with no worktree record reads unknown rather than a measured stall', () => {
  const row = rowFor({ tip: { branch: 'teammates/r1/T1', at: NOW - 90 * MIN } })
  assert.equal(row.state, 'unknown')
  assert.equal(row.unknownReason, 'no-worktree-measurement')
})

// The walk ran and read nothing — a worktree directory deleted without `git worktree prune` is
// the shape that produces it. Nothing was measured, so it is the same answer as no record at all.
test('a touch record carrying no measurement reads unknown', () => {
  const row = rowFor({
    tip: { branch: 'teammates/r1/T1', at: NOW - 90 * MIN },
    touch: { branch: 'teammates/r1/T1', at: null, floored: false },
  })
  assert.equal(row.state, 'unknown')
  assert.equal(row.unknownReason, 'no-worktree-measurement')
})

test('a fresh tip with no worktree record still reads working', () => {
  const row = rowFor({ tip: { branch: 'teammates/r1/T1', at: NOW - 1 * MIN } })
  assert.equal(row.state, 'working')
  assert.equal(row.unknownReason, null)
})

test('the two unmeasured shapes are told apart by unknownReason', () => {
  const capped = rowFor({
    tip: { branch: 'b', at: NOW - 90 * MIN },
    touch: { branch: 'b', at: NOW - 90 * MIN, floored: true },
  })
  assert.equal(capped.unknownReason, 'walk-capped')
  const measured = rowFor({
    tip: { branch: 'b', at: NOW - 90 * MIN },
    touch: { branch: 'b', at: NOW - 90 * MIN, floored: false },
  })
  assert.equal(measured.state, 'stalled')
  assert.equal(measured.unknownReason, null)
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

// Both signals measured and equally old, so the boundary is the only thing under test: a row that
// left the touch signal unmeasured would read `unknown` on the far side and say nothing about
// where the threshold falls.
test('the threshold is inclusive at exactly staleMinutes and stalls one millisecond past it', () => {
  const measured = (ageMs) => rowFor({
    tip: { branch: 'b', at: NOW - ageMs },
    touch: { branch: 'b', at: NOW - ageMs, floored: false },
    staleMinutes: 20,
  })
  assert.equal(measured(20 * MIN).state, 'working')
  assert.equal(measured(20 * MIN + 1).state, 'stalled')
})

test('livenessRows throws on a non-numeric clock rather than reporting every task stalled', () => {
  assert.throws(() => livenessRows({ tasks, now: undefined }), /numeric clock/)
  assert.throws(() => livenessRows({ tasks, now: 'now' }), /numeric clock/)
  assert.throws(() => livenessRows({ tasks, now: NaN }), /numeric clock/)
})

test('the default threshold applies when none is given', () => {
  assert.equal(DEFAULT_STALE_MINUTES, 20)
  const age = (DEFAULT_STALE_MINUTES + 1) * MIN
  const row = rowFor({
    tip: { branch: 'b', at: NOW - age },
    touch: { branch: 'b', at: NOW - age, floored: false },
  })
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

test('renderLiveness attaches the stall hint to the stalled row only, exactly once', () => {
  const rows = livenessRows({
    tasks: [{ id: 'T1' }, { id: 'T2' }],
    tips: { T1: { branch: 'b1', at: NOW - 3 * MIN }, T2: { branch: 'b2', at: NOW - 60 * MIN } },
    touches: { T2: { branch: 'b2', at: NOW - 60 * MIN, floored: false } },
    now: NOW,
    staleMinutes: 20,
  })
  assert.equal(rows[0].state, 'working')
  assert.equal(rows[1].state, 'stalled')
  const out = renderLiveness(rows, { staleMinutes: 20 })
  const hintOccurrences = out.split('\n').filter((line) => /likely cause/.test(line))
  assert.equal(hintOccurrences.length, 1)
  const lines = out.split('\n')
  const workingLineIndex = lines.findIndex((line) => /^T1\s/.test(line))
  const stalledLineIndex = lines.findIndex((line) => /^T2\s/.test(line))
  assert.match(lines[workingLineIndex + 1] ?? '', /^T2\s/, 'no hint line directly follows the working row')
  assert.match(lines[stalledLineIndex + 1] ?? '', /likely cause/, 'the hint line directly follows the stalled row')
})

// A terminal ACTS on control bytes, and `taskId` comes from the plan a planning agent wrote. An
// id carrying `ESC [ 2 K` `ESC [ 1 A` erases the row reporting it and the line above it while the
// command still exits 1 — the operator reads a clean board and acts on nothing. This renderer is
// where that matters most: `liveness` exists to say a teammate has gone quiet.
//
// Asserted on BYTES, not by regex over the rendered string: a regex matches happily while the
// payload is still sitting in the output.
test('renderLiveness neutralises control bytes in a plan-authored task id', () => {
  const ESC = String.fromCharCode(0x1b)
  // 0x9B is CSI in an 8-bit terminal — built from its code point rather than pasted, so the
  // byte never sits raw in this file the way it would in a plan.
  const CSI = String.fromCharCode(0x9b)
  const rows = [{
    taskId: `T1${ESC}[2K${ESC}[1A`,
    branch: 'b1',
    tipAgeMs: 60000,
    touchAgeMs: 60000,
    floored: false,
    state: 'stalled',
    unknownReason: null,
  }]
  const out = renderLiveness(rows, { staleMinutes: 20 })
  assert.ok(!out.includes(ESC), 'no raw ESC reaches the rendered board')
  assert.ok(!out.includes(CSI), 'no raw CSI reaches the rendered board')
  // The id is still reported — neutralised, not dropped, or the row it names would go missing.
  assert.match(out, /T1/)
  // And the stall it was hiding is still on the board.
  assert.match(out, /likely cause/)
})

// The same ids reach a terminal by a second route, so wrapping only the renderer would leave this
// line as the way to erase what the renderer printed.
test('renderLiveness state is neutralised too, not only the id', () => {
  const ESC = String.fromCharCode(0x1b)
  const out = renderLiveness([{
    taskId: 'T1', branch: 'b1', tipAgeMs: 1, touchAgeMs: 1, floored: false,
    state: `working${ESC}[2K`, unknownReason: null,
  }], { staleMinutes: 20 })
  assert.ok(!out.includes(ESC))
})

test('hasStall is true only when some row is stalled', () => {
  assert.equal(hasStall([{ state: 'working' }, { state: 'not started' }]), false)
  assert.equal(hasStall([{ state: 'working' }, { state: 'stalled' }]), true)
  assert.equal(hasStall([]), false)
  assert.equal(hasStall(), false)
})
