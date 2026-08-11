// Assembling the `gate --results` file out of the findings files reviewers drop.
//
// The returned response stays the interface: a reviewer writes its findings file and returns the
// same JSON, and the orchestrator reads the response first. This module covers the case that
// motivated the file at all — a reviewer that goes idle without emitting, taking a completed
// review with it. What it produces is caller input to the gate, never a verdict: `aggregateVerdict`
// still computes that, and `--results` still refuses computed check kinds.
//
// One rule shapes everything here: a lens with no file is a review that was LOST, which is a
// different fact from a review that found nothing. Collecting it as an empty pass would hand the
// gate the vacuous PASS that leaving the check `pending` exists to prevent. A lens whose file
// says it could not verify anything is the same fact arriving by a different route, and takes the
// same route out.

// A lens name reaches the filesystem, so it is validated as a filename component and nothing
// else — no separators, no traversal, no absolute path, non-empty.
export function reviewFileName(phase, lens) {
  if (typeof lens !== 'string' || lens === '' || /[\\/]/.test(lens) || lens === '.' || lens === '..') {
    throw new Error(`a lens must be a non-empty name with no path separators, got ${JSON.stringify(lens)}`)
  }
  return `${phase}-${lens}.json`
}

// Reviewer findings describe a diff, and a diff is only identified by the branch tips it was
// taken from. Without that, a second review round's collect-reviews reads the first round's
// files and reports findings about code that no longer exists — worked around by hand three
// times during run `codemap` by deleting the files between rounds, which is exactly the kind of
// manual step this design removes everywhere else.
//
// The stamp is tamper-evident, not proof, the same distinction this repository draws for the
// map-notes header. It is self-reported: the reviewer that writes the findings file is the same
// reviewer that reads its own tips and stamps them on, so a reviewer that errors out — or one
// that stamps before it reads anything — can `git rev-parse` the current tips, emit `{findings:
// [], stamp: {...}}`, and pass `reviewStale` while having judged nothing. What the stamp rules
// out is a *stale* file surviving into a round it was never written for; it does not rule out a
// *fabricated* one, because the reviewer computed the very tips it is graded against. This is not
// a regression — an unstamped file passed the same collection with the same blind trust before
// the stamp existed — but the stamp must not be read as closing that gap. Nothing short of the
// orchestrator computing the diff itself and handing the reviewer a digest it cannot derive would
// close it.
export function reviewStamp({ phase, lens, branchShas = {} }) {
  const names = Object.keys(branchShas).sort()
  return { phase: String(phase), lens, branches: names.map((n) => `${n}@${branchShas[n]}`) }
}

// Returns a reason string when the file describes a different tree, or null when it matches.
// A file with no stamp at all is stale, never "probably current": an unstamped file is the
// artefact this design refuses to trust everywhere else.
export function reviewStale(file, expected) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return 'the findings file is not an object'
  const stamp = file.stamp
  if (!stamp) return 'the findings file carries no stamp, so nothing says which diff it judged'
  if (String(stamp.phase) !== String(expected.phase)) {
    return `the findings describe phase ${stamp.phase}, not phase ${expected.phase}`
  }
  if (stamp.lens !== expected.lens) return `the findings are for lens ${stamp.lens}, not ${expected.lens}`
  const a = (stamp.branches ?? []).join(' ')
  const b = (expected.branches ?? []).join(' ')
  if (a !== b) return `the findings judged ${a || '(nothing)'}, but this phase is at ${b || '(nothing)'}`
  return null
}

// A reviewer that could not verify anything says so in `unableToVerify`, and the honest answer is
// a reason string. Any non-empty value counts — a bare `true` is still a reviewer saying it did
// not look — but an EMPTY string is not a report of failure, so the key's presence alone is never
// enough to refuse a lens that did its work.
function cannotVerify(file) {
  const why = file?.unableToVerify
  if (typeof why === 'string') return why.trim() === '' ? null : why
  if (!why) return null
  return 'the reviewer reported it could not verify this lens'
}

export function collectReviewResults({ checkName = 'review', lenses = [], files = [], blockOn = ['high'], expected = null } = {}) {
  const blocking = new Set(blockOn ?? [])
  const byLens = new Map()
  const unexpected = []
  const stale = []
  const unverified = []
  for (const file of files) {
    // Order matters: an unexpected lens is recorded and then dropped, so its findings can never
    // reach the verdict. A file naming a lens the manifest did not ask for is a mistake worth
    // seeing — a stale file from an earlier phase, a typo in a dispatch — not content to merge.
    if (!lenses.includes(file.lens)) { unexpected.push(file.lens); continue }
    if (expected) {
      const why = reviewStale(file, { ...expected, lens: file.lens })
      if (why) { stale.push({ lens: file.lens, reason: why }); continue }
    }
    // A lens that reports it verified nothing is dropped here, before it can be recorded. It is
    // the same fact as a lens with no file at all — the review did not happen — so it takes the
    // same route out: nothing emitted, the lens named, the reason reported.
    const why = cannotVerify(file)
    if (why) { unverified.push({ lens: file.lens, reason: why }); continue }
    byLens.set(file.lens, {
      findings: Array.isArray(file.findings) ? file.findings : [],
      unprobed: Array.isArray(file.unprobed) ? file.unprobed : [],
    })
  }

  const missing = lenses.filter((lens) => !byLens.has(lens))
  // Nothing is emitted while any lens is unaccounted for. A partial result would be indis-
  // tinguishable from a complete one by the time it reached the gate, and the check would pass
  // on the strength of the lenses that happened to survive. An unverified lens is unaccounted
  // for in exactly that sense, and is named separately so the caller can say why.
  if (missing.length > 0 || unverified.length > 0) return { results: [], missing, unexpected, stale, unverified }

  const all = []
  for (const lens of lenses) {
    for (const finding of byLens.get(lens).findings) all.push({ ...finding, lens })
  }
  const blockers = all.filter((f) => blocking.has(f?.severity))

  // What the review did NOT reach, carried to where the verdict is read. A lens bounded by its
  // mutation cap that got to 8 of 40 claims emits the same status as an exhaustive one, so the
  // status alone cannot carry this and the operator would have to open the findings file.
  const bounded = lenses
    .map((lens) => ({ lens, count: byLens.get(lens).unprobed.length }))
    .filter((u) => u.count > 0)
  const boundedNote = bounded.length === 0
    ? ''
    : `; ${bounded.reduce((n, u) => n + u.count, 0)} enumerated claim(s) NOT reached`
      + ` (${bounded.map((u) => `${u.lens}: ${u.count}`).join(', ')}) — this review is bounded, not exhaustive`

  return {
    results: [{
      name: checkName,
      kind: 'agent',
      status: blockers.length > 0 ? 'fail' : 'pass',
      findings: all,
      // Provenance: recovered from the reviewers' files rather than from their returned
      // responses. It does not change the verdict; it records that this review was nearly lost.
      source: 'file',
      output: (blockers.length > 0
        ? `${blockers.length} finding(s) at a blocking severity, recovered from the reviewers' findings files`
        : `${all.length} finding(s), none blocking, recovered from the reviewers' findings files`) + boundedNote,
    }],
    missing,
    unexpected,
    stale,
    unverified,
  }
}
