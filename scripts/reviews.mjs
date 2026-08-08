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
// gate the vacuous PASS that leaving the check `pending` exists to prevent.

// A lens name reaches the filesystem, so it is validated as a filename component and nothing
// else — no separators, no traversal, no absolute path, non-empty.
export function reviewFileName(phase, lens) {
  if (typeof lens !== 'string' || lens === '' || /[\\/]/.test(lens) || lens === '.' || lens === '..') {
    throw new Error(`a lens must be a non-empty name with no path separators, got ${JSON.stringify(lens)}`)
  }
  return `${phase}-${lens}.json`
}

export function collectReviewResults({ checkName = 'review', lenses = [], files = [], blockOn = ['high'] } = {}) {
  const blocking = new Set(blockOn ?? [])
  const byLens = new Map()
  const unexpected = []
  for (const file of files) {
    // Order matters: an unexpected lens is recorded and then dropped, so its findings can never
    // reach the verdict. A file naming a lens the manifest did not ask for is a mistake worth
    // seeing — a stale file from an earlier phase, a typo in a dispatch — not content to merge.
    if (!lenses.includes(file.lens)) { unexpected.push(file.lens); continue }
    byLens.set(file.lens, Array.isArray(file.findings) ? file.findings : [])
  }

  const missing = lenses.filter((lens) => !byLens.has(lens))
  // Nothing is emitted while any lens is unaccounted for. A partial result would be indis-
  // tinguishable from a complete one by the time it reached the gate, and the check would pass
  // on the strength of the lenses that happened to survive.
  if (missing.length > 0) return { results: [], missing, unexpected }

  const all = []
  for (const lens of lenses) {
    for (const finding of byLens.get(lens)) all.push({ ...finding, lens })
  }
  const blockers = all.filter((f) => blocking.has(f?.severity))

  return {
    results: [{
      name: checkName,
      kind: 'agent',
      status: blockers.length > 0 ? 'fail' : 'pass',
      findings: all,
      // Provenance: recovered from the reviewers' files rather than from their returned
      // responses. It does not change the verdict; it records that this review was nearly lost.
      source: 'file',
      output: blockers.length > 0
        ? `${blockers.length} finding(s) at a blocking severity, recovered from the reviewers' findings files`
        : `${all.length} finding(s), none blocking, recovered from the reviewers' findings files`,
    }],
    missing,
    unexpected,
  }
}
