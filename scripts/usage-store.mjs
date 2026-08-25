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

import { printable } from './reviews.mjs'
import { projectSlug, summarizeTranscript } from './usage.mjs'

function missing(dir) {
  return new Error(`no transcripts found at ${dir} — this is a harness-internal layout and may have changed`)
}

// A session is identified by the store it carries, not by being the newest directory. The project
// directory holds more than sessions — the harness keeps `memory/` beside them — and that one is
// written on every session, so it won every mtime comparison and the command reported on a
// directory that can never hold a transcript. Requiring `subagents/` is the same test the read
// below performs, moved to where the choice is made.
async function newestSession(projectDir) {
  let entries
  try {
    entries = await readdir(projectDir, { withFileTypes: true })
  } catch {
    throw missing(projectDir)
  }
  const sessions = []
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const dir = path.join(projectDir, entry.name)
    let store
    try {
      store = await stat(path.join(dir, 'subagents'))
    } catch {
      continue
    }
    if (!store.isDirectory()) continue
    // The later of the two: the session directory is stamped when its store is created, the store
    // when a transcript is added to it. Taking the max keeps the current session ahead of an older
    // one whichever of the two the harness last touched.
    const own = (await stat(dir)).mtimeMs
    sessions.push({ name: entry.name, mtime: Math.max(own, store.mtimeMs) })
  }
  // Named for the layout rather than for whichever directory happened to be newest, which would
  // read as "that session is empty" instead of "no session here has a store at all".
  if (sessions.length === 0) throw missing(path.join(projectDir, '<session-id>', 'subagents'))
  sessions.sort((a, b) => b.mtime - a.mtime)
  return sessions[0].name
}

export async function readSessionUsage({ projectsDir, root, sessionId = null }) {
  // `root` is resolved here rather than trusted. The CLI passes `flags.root ?? process.cwd()`
  // verbatim, so `--root .` arrives as the literal ".", whose slug is "." — and `path.join`
  // then collapses to the projects directory itself, where the newest PROJECT gets mistaken for
  // a session. Resolving is idempotent for a path that is already absolute.
  const projectDir = path.join(projectsDir, projectSlug(path.resolve(root)))
  const session = sessionId ?? await newestSession(projectDir)
  // Checked before it is joined, and checked here rather than only at the CLI: `--session` is not
  // the only way a name reaches this line. `newestSession` returns a directory name that is
  // joined again, so a directory an attacker can create under the projects directory is the same
  // primitive. Unvalidated, `../` walked out of the store entirely and read .jsonl files
  // elsewhere on disk, disclosing the first bytes of one through a parse-error line.
  // `reviewFileName` (scripts/reviews.mjs) refuses a lens on exactly these grounds; this is that
  // rule applied to the one component this module joins.
  if (typeof session !== 'string' || session === '' || /[\\/]/.test(session) || session === '.' || session === '..') {
    throw new Error(`a session must be a non-empty name with no path separators, got ${JSON.stringify(printable(session))}`)
  }
  const subagentsDir = path.join(projectDir, session, 'subagents')

  // The walk has to RECURSE, because a workflow-dispatched run keeps its transcripts under
  // `subagents/<wf-id>/` rather than flat, and a flat read reported five real transcripts as zero.
  // It is written out by hand rather than using `readdir(..., { recursive: true })`, for three
  // reasons — each found by review after the recursive read shipped:
  //
  //   1. Node's recursive readdir FOLLOWS DIRECTORY SYMLINKS. One link planted inside the store
  //      made this command read and report transcripts from anywhere on disk, and the walk
  //      re-entered itself until ELOOP, multiplying every total. The session-name check above
  //      cannot help: it validates the one component this module joins, while that traversal
  //      happens inside the walk. `withFileTypes` + `isDirectory()` is false for a symlink, so a
  //      link is neither descended nor read as a transcript.
  //   2. It propagates a NESTED failure to the caller. One unreadable subdirectory aborted the
  //      whole report, and the catch relabelled it "no transcripts found" — dropping a readable
  //      transcript sitting in the directory that message names, and blaming a layout change that
  //      had not happened. A directory removed mid-walk does the same, during exactly the live run
  //      an operator reports on.
  //   3. It is unbounded. The cap is cheap insurance, and this repo's worktree walk carries one.
  //
  // Only the TOP-LEVEL read failing is the "layout has changed" case; that is the one that throws.
  const MAX_ENTRIES = 20_000
  const transcripts = []
  const unreadable = []
  const pending = ['']
  let budget = MAX_ENTRIES
  let readAnything = false
  while (pending.length > 0 && budget > 0) {
    const relative = pending.shift()
    let entries
    try {
      entries = await readdir(relative === '' ? subagentsDir : path.join(subagentsDir, relative), { withFileTypes: true })
      readAnything = true
    } catch {
      if (relative === '') break
      unreadable.push({ name: relative, reason: 'directory could not be read', dropped: 0, kept: 0 })
      continue
    }
    for (const entry of entries) {
      if (budget-- <= 0) break
      // Kept with `/` regardless of platform: it is a display name and a `path.join` argument,
      // and `path.join` accepts a forward slash on Windows.
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) pending.push(name)
      // `agent-` as well as the extension: the walk reaches a workflow's `journal.jsonl`, which is
      // valid JSONL carrying no usage and produced a phantom row of zeros for an agent that never
      // ran. The header above names the transcript file `agent-<id>.jsonl`; that is the filter.
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.startsWith('agent-')) transcripts.push(name)
    }
  }
  if (!readAnything) throw missing(subagentsDir)

  const agents = []
  for (const name of transcripts.sort()) {
    const full = path.join(subagentsDir, name)
    let body
    try {
      body = await readFile(full, 'utf8')
    } catch (err) {
      // Named and counted, then carry on with the rest. Skipping silently would understate the
      // totals this command exists to make trustworthy.
      unreadable.push({ name, reason: 'could not be read', dropped: 0, kept: 0 })
      continue
    }

    // Per line, not per file. A transcript is appended to while its session runs, so reading one
    // during a live fleet run — exactly when an operator reports on it — catches a half-written
    // last line. Parsing the whole file in one try sent every record in it here, so an agent's
    // entire spend vanished while `fixed prefix = N%` was still computed from what survived.
    const records = []
    let dropped = 0
    for (const raw of body.split('\n')) {
      if (raw.trim() === '') continue
      try {
        records.push(JSON.parse(raw))
      } catch {
        // The count, never the parse message: that message quotes the offending source text back,
        // and the source is the operator's real transcript, so the snippet put private
        // conversation content into a printed report.
        dropped += 1
      }
    }
    if (dropped > 0) {
      unreadable.push({
        name,
        reason: `${dropped} of ${dropped + records.length} line(s) did not parse`,
        dropped,
        kept: records.length,
      })
    }
    // Nothing parsed at all: there is no spend to attribute, so no row. An EMPTY file reaches here
    // with `dropped === 0`, so it recorded nothing and vanished from the report entirely — and
    // alone in a store it tripped the empty-report throw below and blamed a layout change that had
    // not happened. It is the ordinary state between a dispatch creating the transcript and the
    // first turn being appended, which is exactly when an operator reports on a live run.
    if (records.length === 0) {
      if (dropped === 0) unreadable.push({ name, reason: 'no records yet', dropped: 0, kept: 0 })
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

  // The invariant the header states, enforced at the one place it can be: a store that yielded no
  // transcript AND no unreadable file is not a session that cost nothing, it is a session whose
  // transcripts are not where this module looked. Returning `agents: []` rendered a table of zeros
  // at exit 0 — the lie the reader has no way to catch. A report carrying unreadable entries is
  // NOT empty: it names what it could not read, which is the whole point of carrying them.
  if (agents.length === 0 && unreadable.length === 0) throw missing(subagentsDir)

  // Largest per-turn tax first. Ordering by a total would bury exactly the finding this command
  // was built to surface: an agent with few turns and a large prefix.
  agents.sort((a, b) => (b.prefix * b.turns) - (a.prefix * a.turns))
  return { sessionId: session, agents, unreadable }
}
