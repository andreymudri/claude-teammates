// Per-run token reporting: the pure half. Reads nothing and writes nothing, so every rule below
// is testable without touching a real transcript store.
//
// WHY THIS EXISTS. Cache reads dominate a fleet run's token cost — measured at 2,190,488 against
// 212 tokens of fresh input across three agents — and they scale with turns x context, because
// every token in an agent's context is re-read on each later turn. The number that matters is
// therefore not a total but the FIXED PREFIX: the system prompt, agent definition, tool schemas
// and dispatch prompt an agent carries before doing any work. It was 40% of all cache reads, and
// a totals-only report hid it completely: the integrator looked cheapest by cache reads while
// carrying a 5x larger prefix than a reviewer whose prompt was longer.

// The harness's directory name for a project: its absolute path with the separators replaced.
// Both separator kinds are replaced rather than `path.sep` alone, because the answer must not
// depend on which platform is asking about which path.
export function projectSlug(root) {
  return String(root).replace(/[/\\]/g, '-')
}

// `prefix` is the MINIMUM context observed, not the first message's. A minimum cannot be inflated
// by ordering or by a retried first turn — the same reasoning the quiet reporter applies when it
// takes counts from the root summary rather than from whichever event arrived first. Prefer the
// definition that cannot be fooled.
export function summarizeTranscript(records) {
  const totals = { turns: 0, prefix: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let min = null
  for (const record of records) {
    const usage = record?.message?.usage
    if (!usage || typeof usage !== 'object') continue
    totals.turns += 1
    totals.input += usage.input_tokens ?? 0
    totals.output += usage.output_tokens ?? 0
    totals.cacheRead += usage.cache_read_input_tokens ?? 0
    totals.cacheWrite += usage.cache_creation_input_tokens ?? 0
    const context = (usage.input_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0)
      + (usage.cache_creation_input_tokens ?? 0)
    if (min === null || context < min) min = context
  }
  totals.prefix = min ?? 0
  return totals
}

const n = (value) => Number(value ?? 0).toLocaleString('en-US')

export function renderUsage(report) {
  const agents = report?.agents ?? []
  const unreadable = report?.unreadable ?? []
  const lines = [`run ${report?.sessionId ?? '(unknown)'}  (${agents.length} subagent${agents.length === 1 ? '' : 's'})`, '']

  const cols = [
    ['agentType', 32, (a) => a.agentType ?? '(unknown)', false],
    ['model', 9, (a) => a.model ?? '(unknown)', false],
    ['turns', 7, (a) => n(a.turns), true],
    ['prefix', 9, (a) => n(a.prefix), true],
    ['prefix×turns', 14, (a) => n((a.prefix ?? 0) * (a.turns ?? 0)), true],
    ['cache_rd', 12, (a) => n(a.cacheRead), true],
    ['output', 9, (a) => n(a.output), true],
  ]
  // Truncated, not just padded. A value wider than its column runs into the next one and the
  // table stops being readable in exactly the case that matters — a fully-qualified agent type
  // like `claude-teammates:tm-integrator` is 30 characters. One trailing space keeps a truncated
  // cell from touching its neighbour.
  const fit = (text, width, right) => {
    const value = String(text)
    const cell = value.length > width - 1 ? `${value.slice(0, width - 2)}…` : value
    return right ? cell.padStart(width) : cell.padEnd(width)
  }
  lines.push(cols.map(([title, width, , right]) => fit(title, width, right)).join(''))
  for (const agent of agents) {
    lines.push(cols.map(([, width, read, right]) => fit(read(agent), width, right)).join(''))
  }

  const totalWidth = cols.reduce((sum, [, width]) => sum + width, 0)
  lines.push('─'.repeat(totalWidth))

  const prefixTurns = agents.reduce((sum, a) => sum + (a.prefix ?? 0) * (a.turns ?? 0), 0)
  const cacheRead = agents.reduce((sum, a) => sum + (a.cacheRead ?? 0), 0)
  lines.push([
    fit('TOTAL', cols[0][1], false),
    fit('', cols[1][1], false),
    fit(n(agents.reduce((s, a) => s + (a.turns ?? 0), 0)), cols[2][1], true),
    fit('', cols[3][1], true),
    fit(n(prefixTurns), cols[4][1], true),
    fit(n(cacheRead), cols[5][1], true),
    fit(n(agents.reduce((s, a) => s + (a.output ?? 0), 0)), cols[6][1], true),
  ].join(''))

  // Guarded rather than computed blind: with no cache reads recorded the share is undefined, and
  // printing NaN or Infinity in the one line a reader takes a decision from is worse than saying
  // the question has no answer here.
  lines.push(cacheRead > 0
    ? `fixed prefix = ${Math.round(prefixTurns / cacheRead * 100)}% of all cache reads`
    : 'fixed prefix = n/a (no cache reads recorded)')

  // Named and counted, never skipped. A dropped agent understates a total, and an understated
  // total is how this tool would appear to prove a saving nobody made.
  if (unreadable.length > 0) {
    lines.push('')
    for (const entry of unreadable) lines.push(`  ! ${entry.name}: ${entry.reason}`)
    lines.push(`${unreadable.length} transcript(s) unreadable`)
  }
  return lines.join('\n')
}
