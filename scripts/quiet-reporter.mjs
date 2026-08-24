// A test reporter that prints failures and one summary line, and nothing else.
//
// WHY THIS EXISTS. Token cost in a fleet run is dominated by cache reads, not by what is sent
// once: measured across three real agents of run `fog`, fresh input was 212 tokens and cache
// reads were 2,190,488. Cache reads scale with turns x context, so every token sitting in an
// agent's context is paid for again on each later turn. The largest single contributor was this
// project's own test command — 161,489 chars, of which 1,843 lines were `✔ <name>` that nothing
// reads. The `claims` reviewer lens runs it about nine times per review, implementers at least
// twice, and the gate once per phase. Measured with this reporter in place: ~99 tokens on a
// green run, down from ~40,372.
//
// The saving comes ENTIRELY from the success path. Failures keep their full detail, stderr is
// passed through untouched, and the summary prints either way — a reporter that made a failing
// run harder to read would have traded the only output anyone reads for the output nobody does.

// Failure detail is never shortened. See above: the success path is where the noise is, so
// there is nothing to gain by abbreviating a stack and a diagnostic to lose by doing it.
function renderFailure(data) {
  const error = data.details?.error
  const body = error?.stack ?? error?.message ?? String(error)
  return `✖ ${data.name}\n${body}\n\n`
}

// Printed on green AND red. It is what satisfies this project's evidence rule — a claim that
// tests pass requires output showing the count and zero failures — so summarising only on
// success would leave a failing run unable to state its own counts. `success` is reported beside
// them so a run can never read as green while its exit code says otherwise.
//
// A missing root summary is reported as a failure rather than as silence: a run that crashed
// before emitting one would otherwise produce clean-looking output with no counts in it, which
// reads exactly like a pass.
function renderSummary(summary) {
  if (!summary) return '\nno test summary was emitted; treat this run as failed\n'
  const c = summary.counts
  const parts = [
    `${c.tests} tests`,
    `${c.passed} pass`,
    `${c.failed} fail`,
    `${c.skipped} skipped`,
  ]
  if (c.cancelled > 0) parts.push(`${c.cancelled} cancelled`)
  if (c.todo > 0) parts.push(`${c.todo} todo`)
  return `\n${parts.join(' | ')}${summary.success ? '' : '  FAILED'}\n`
}

export default async function* quietReporter(source) {
  let rootSummary = null
  for await (const event of source) {
    if (event.type === 'test:fail') {
      yield renderFailure(event.data)
      continue
    }
    if (event.type === 'test:stderr' || event.type === 'test:stdout') {
      yield event.data.message
      continue
    }
    // THE ROOT SUMMARY IS THE ONE WITH NO `file`. The runner emits one summary per file and one
    // for the whole run, and only the latter aggregates. Counting `test:pass` events instead is
    // the obvious implementation and it is wrong: a parent suite emits its own alongside its
    // children, which measured 5 where the truth was 4. A wrong count is worse than a verbose
    // one, because the evidence rule depends on the number being true.
    if (event.type === 'test:summary' && event.data.file === undefined) {
      rootSummary = event.data
    }
  }
  yield renderSummary(rootSummary)
}
