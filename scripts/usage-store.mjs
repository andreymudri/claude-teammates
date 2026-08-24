// Per-run token reporting: the half that touches disk.
//
// THE LAYOUT THIS READS IS HARNESS-INTERNAL AND NOT A PUBLIC API:
//
//   <projectsDir>/<projectSlug(root)>/<session-id>/subagents/agent-<id>.jsonl
//   <projectsDir>/<projectSlug(root)>/<session-id>/subagents/agent-<id>.meta.json
//
// Anthropic can change it without notice. Every failure below is therefore reported rather than
// absorbed: when the store is missing this throws NAMING THE PATH, and never returns an empty
// report, because a zero reads as "no usage" and would be a lie the reader has no way to catch.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { projectSlug, summarizeTranscript } from './usage.mjs'

function missing(dir) {
  return new Error(`no transcripts found at ${dir} — this is a harness-internal layout and may have changed`)
}

async function newestSession(projectDir) {
  let entries
  try {
    entries = await readdir(projectDir, { withFileTypes: true })
  } catch {
    throw missing(projectDir)
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  if (dirs.length === 0) throw missing(projectDir)
  const stamped = await Promise.all(dirs.map(async (name) => ({
    name,
    mtime: (await stat(path.join(projectDir, name))).mtimeMs,
  })))
  stamped.sort((a, b) => b.mtime - a.mtime)
  return stamped[0].name
}

export async function readSessionUsage({ projectsDir, root, sessionId = null }) {
  // `root` is resolved here rather than trusted. The CLI passes `flags.root ?? process.cwd()`
  // verbatim, so `--root .` arrives as the literal ".", whose slug is "." — and `path.join`
  // then collapses to the projects directory itself, where the newest PROJECT gets mistaken for
  // a session. Resolving is idempotent for a path that is already absolute.
  const projectDir = path.join(projectsDir, projectSlug(path.resolve(root)))
  const session = sessionId ?? await newestSession(projectDir)
  const subagentsDir = path.join(projectDir, session, 'subagents')

  let entries
  try {
    entries = await readdir(subagentsDir)
  } catch {
    throw missing(subagentsDir)
  }

  const agents = []
  const unreadable = []
  for (const name of entries.filter((f) => f.endsWith('.jsonl')).sort()) {
    const full = path.join(subagentsDir, name)
    let records
    try {
      const body = await readFile(full, 'utf8')
      records = body.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
    } catch (err) {
      // Named and counted, then carry on with the rest. Skipping silently would understate the
      // totals this command exists to make trustworthy.
      unreadable.push({ name, reason: err.message })
      continue
    }

    // A transcript with no readable meta is still an agent that spent tokens, so it gets a row
    // with its role unknown rather than being dropped.
    let agentType = '(unknown)'
    let model = '(unknown)'
    try {
      const meta = JSON.parse(await readFile(full.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
      if (typeof meta.agentType === 'string') agentType = meta.agentType
      if (typeof meta.model === 'string') model = meta.model
    } catch { /* no meta, or unreadable: the row stays, the role does not */ }

    agents.push({ name, agentType, model, ...summarizeTranscript(records) })
  }

  // Largest per-turn tax first. Ordering by a total would bury exactly the finding this command
  // was built to surface: an agent with few turns and a large prefix.
  agents.sort((a, b) => (b.prefix * b.turns) - (a.prefix * a.turns))
  return { sessionId: session, agents, unreadable }
}
