# `usage` — per-run token reporting — implementation plan

Spec: `docs/specs/2026-08-24-usage-reporting-design.md`

## Global Constraints

- Node >= 20
- Zero new runtime dependencies
- No shell pipelines in npm scripts — Windows CI runs them under `cmd.exe`
- Paths resolved with `fileURLToPath`, never a file URL's `.pathname`
- Commit messages: conventional-commit style, English

## Destination

A repeatable command reports where a run's tokens went, broken down by agent role, so a token
optimization is proven by measurement rather than argued from a plausible story.

## Not Yet Specified

- Should `usage` report the main session alongside its subagents, or is the orchestrator's own
  context a separate question?
- What is the right way to compare two runs — does this command grow a diff mode, or does the
  reader keep the numbers?

## Out of Scope

- Cost estimates in currency — rates change and differ per tier and per cache state, so the
  command reports tokens and leaves rates to the reader.
- Any hook change — recording usage at SubagentStop would couple the plugin to a payload shape
  it does not control, and the files already exist on disk.
- Restricting any agent's tool set — that is the change this command exists to measure, and
  shipping both together would leave the saving unproven.

### Task 1: the usage module

**Files:**
- Create: `scripts/usage.mjs`
- Test: `tests/usage.test.mjs`

**Model:** mid

- [ ] **Step 1:** Create `scripts/usage.mjs` exporting `projectSlug(root)`. It takes an absolute
      project path and returns the harness's directory name for it: the path with every `/` and
      `\` replaced by `-`. Example: `/home/u/Work/proj` becomes `-home-u-Work-proj`.

      ```js
      export function projectSlug(root) {
        return String(root).replace(/[/\\]/g, '-')
      }
      ```

- [ ] **Step 2:** Export `summarizeTranscript(lines)`. It takes an array of already-parsed JSON
      records and returns `{ turns, prefix, input, output, cacheRead, cacheWrite }`. A record
      contributes only when `record.message.usage` is an object.

      ```js
      // `prefix` is the MINIMUM context observed, not the first message's. A minimum cannot be
      // inflated by ordering or by a retried first turn, and this number is the per-turn tax a
      // dispatch pays before doing any work — the quantity a change like restricting an agent's
      // tool set actually moves.
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
      ```

- [ ] **Step 3:** Export `renderUsage(report)` taking
      `{ sessionId, agents, unreadable }` where each agent is
      `{ agentType, model, turns, prefix, cacheRead, output }`. Return the table from the spec:
      a header line naming the session and the agent count, a column header, one row per agent,
      a rule, a TOTAL row, and a final line giving the fixed prefix as a percentage of all cache
      reads. Right-align every number and format with `toLocaleString('en-US')`. When
      `unreadable` is non-empty, append one line per entry as `  ! <name>: <reason>` and a final
      `N transcript(s) unreadable` line.

- [ ] **Step 4:** In `renderUsage`, compute the percentage as
      `Math.round(sumPrefixTurns / sumCacheRead * 100)` and print
      `fixed prefix = N% of all cache reads`. When `sumCacheRead` is 0, print
      `fixed prefix = n/a (no cache reads recorded)` rather than dividing by zero.

- [ ] **Step 5:** Write `tests/usage.test.mjs` importing `projectSlug`, `summarizeTranscript` and
      `renderUsage`. Add a test `projectSlug replaces both separator kinds`, asserting
      `projectSlug('/home/u/p')` is `'-home-u-p'` and `projectSlug('C:\\Users\\u\\p')` is
      `'C:-Users-u-p'`.

- [ ] **Step 6:** Add a test `summarizeTranscript sums every usage category`. Feed three records
      whose `message.usage` values are
      `{ input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }`,
      `{ input_tokens: 2, output_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 }`
      and `{ input_tokens: 3, output_tokens: 30, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }`.
      Assert `turns` is 3, `input` 6, `output` 60, `cacheRead` 600, `cacheWrite` 5.

- [ ] **Step 7:** Add a test `prefix is the minimum context, not the first message's`. Feed three
      records whose contexts are 900, 400 and 700 — the smallest is NOT first — and assert
      `prefix` is 400. Feed a second array whose contexts ascend 400, 700, 900 and assert
      `prefix` is 400 there too, so the test distinguishes minimum from first.

- [ ] **Step 8:** Add a test `records without usage are ignored, not counted as turns`. Feed one
      record with `message.usage`, one `{ type: 'system' }`, and one `{ message: {} }`. Assert
      `turns` is 1.

- [ ] **Step 9:** Add a test `renderUsage reports the prefix share of cache reads`. Build a report
      with two agents: `{ agentType: 'tm-reviewer', model: 'opus', turns: 10, prefix: 100, cacheRead: 2000, output: 50 }`
      and `{ agentType: 'tm-integrator', model: 'sonnet', turns: 2, prefix: 500, cacheRead: 2000, output: 5 }`.
      Prefix×turns is 1000 + 1000 = 2000 of 4000 cache reads. Assert the output matches
      `/fixed prefix = 50% of all cache reads/`, contains both agent types, and contains `2,000`
      with a thousands separator.

- [ ] **Step 10:** Add a test `renderUsage does not divide by zero when nothing was cached`. Build
      a report whose single agent has `cacheRead: 0`, and assert the output matches `/n\/a/` and
      does not match `/NaN|Infinity/`.

- [ ] **Step 11:** Add a test `renderUsage names every unreadable transcript and counts them`.
      Pass `unreadable: [{ name: 'agent-x.jsonl', reason: 'Unexpected end of JSON input' }]` and
      assert the output contains `agent-x.jsonl`, contains the reason, and matches
      `/1 transcript\(s\) unreadable/`. Silently skipping a transcript understates a total, and
      an understated total is how this tool would appear to prove a saving nobody made.

### Task 2: read the transcript store

**Files:**
- Create: `scripts/usage-store.mjs`
- Test: `tests/usage-store.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Create `scripts/usage-store.mjs` exporting
      `async function readSessionUsage({ projectsDir, root, sessionId = null })`. It resolves
      `path.join(projectsDir, projectSlug(root))`, and returns
      `{ sessionId, agents, unreadable }` shaped for `renderUsage`.

- [ ] **Step 2:** When the project directory does not exist, throw an `Error` whose message is
      ``no transcripts found at ${dir} — this is a harness-internal layout and may have changed``.
      Do not return an empty report: a zero reads as "no usage", which would be false.

- [ ] **Step 3:** When `sessionId` is null, choose the session directory with the newest mtime
      among the immediate subdirectories of the project directory. When none exists, throw the
      same error naming the project directory.

- [ ] **Step 4:** Read `<session>/subagents/`. For each `agent-<id>.jsonl`, parse the file line by
      line, skipping blank lines, and collect the parsed records. Pair it with
      `agent-<id>.meta.json` when that file exists and parses, taking `agentType` and `model`
      from it. When the meta file is absent or unparseable, use `agentType: '(unknown)'` and
      `model: '(unknown)'` — the tokens were still spent, so the row must still appear.

- [ ] **Step 5:** When a transcript file cannot be read, or a line cannot be parsed, push
      `{ name, reason }` onto `unreadable` and continue with the remaining files. Use the error's
      `message` as the reason.

- [ ] **Step 6:** Call `summarizeTranscript` on each transcript's records and build the agent rows,
      sorted by `prefix * turns` descending so the largest per-turn tax is the first row read.

- [ ] **Step 7:** Write `tests/usage-store.test.mjs`. Build a fixture store under
      `mkdtemp(path.join(tmpdir(), 'tm-usage-'))` with a project directory named by
      `projectSlug(root)` for a fake root, one session directory, and a `subagents/` directory
      holding two transcripts and one meta file. Remove the directory in a `finally`. No test may
      read the developer's real `~/.claude`.

- [ ] **Step 8:** Add a test `reads per-agent totals and takes the role from the meta file`,
      asserting the returned `agents` carries `agentType: 'claude-teammates:tm-reviewer'` for the
      transcript that has a meta file.

- [ ] **Step 9:** Add a test `a transcript with no meta file is reported as unknown, not dropped`,
      asserting an agent row exists with `agentType: '(unknown)'` and non-zero `turns`.

- [ ] **Step 10:** Add a test `an unparseable transcript is reported, not skipped`: write a file
      containing `{"message":` and assert the result's `unreadable` has one entry naming that
      file, and that the readable transcript still produced a row.

- [ ] **Step 11:** Add a test `a missing project directory throws, naming the path`, asserting the
      rejection message contains the directory and the phrase `may have changed`.

- [ ] **Step 12:** Add a test `rows are ordered by prefix times turns, descending`, using two
      transcripts where the one with fewer turns has the larger prefix — the shape that produced
      the real finding — and asserting it sorts first.

### Task 3: wire the usage subcommand into the CLI

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/usage-cli.test.mjs`

**Depends:** T1, T2

- [ ] **Step 1:** In `scripts/cli.mjs`, import `readSessionUsage` from `./usage-store.mjs` and
      `renderUsage` from `./usage.mjs`.

- [ ] **Step 2:** Add `usage` to the `USAGE` banner string's command list, and add the line
      `  usage    [--session <id>] [--json] [--root <path>]` to the per-command usage block.

- [ ] **Step 3:** Register the command's argument rules alongside the existing entries: no
      required flags, and allowed flags `['session', 'json', 'root']`.

- [ ] **Step 4:** Implement the handler. Resolve the projects directory as
      `path.join(homedir(), '.claude', 'projects')`, call `readSessionUsage`, and print either
      `JSON.stringify(report, null, 2)` when `--json` is passed or `renderUsage(report)`
      otherwise. Return 0. Catch an `Error` from the store, print its message, and return 1.

- [ ] **Step 5:** Create `tests/usage-cli.test.mjs`. Build the same fixture store as Task 2 under
      a temp directory, and invoke the CLI handler with the projects directory pointed at the
      fixture. Assert exit 0 and that the printed table names both agents.

- [ ] **Step 6:** Add a test `usage exits 1 and names the path when no transcripts exist`, pointing
      the projects directory at an empty temp directory and asserting the exit code is 1 and the
      printed message contains `may have changed`.

- [ ] **Step 7:** Add a test `usage --json emits the same numbers as the table`, asserting the
      parsed JSON's agent rows carry the same `turns` and `cacheRead` values that the table
      renders, so the two outputs cannot drift apart.
