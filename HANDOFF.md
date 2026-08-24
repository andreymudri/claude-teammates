# Handoff — 2026-08-24, end of session

Everything below is on `master` and pushed. One branch, one worktree. `v1.1.2` is tagged at
`master` — nothing is unreleased.

## Read this first

**The measurement is taken and the loop is closed.** A `tm-implementer` dispatched with the
`tools:` declaration actually loaded carries a **9,610**-token prefix, against **27,499** for the
same agent from the pinned snapshot that lacked the line — **17,889 tokens per turn, 65%**.

    node scripts/cli.mjs usage --root .   # run 389bd517: tm-implementer, sonnet, 1 turn, 9,610

Higher than the ~7,900 the previous session predicted, and the prediction was the wrong shape
rather than the measurement being off: 7,900 came from `tm-reviewer`, which declares five tools
to `tm-implementer`'s seven and has a shorter definition. The number to carry forward is the
**delta**, not either absolute.

The cache is at `1.1.1`, pinned at `c3c6937` — `master` at the time of the refresh — and
`installed_plugins.json` agrees. This session loaded it: both agent types arrived with their
restricted tool sets in force.

**Standing rule this exposed:** editing `agents/`, `skills/`, `hooks/` or `scripts/` in this repo
changes nothing about the running session. It loads a pinned snapshot from
`~/.claude/plugins/cache/claude-teammates/claude-teammates/<version>/`, copied at the SHA in
`~/.claude/plugins/installed_plugins.json`. Before measuring any such change, check
`claude plugin list` against `.claude-plugin/plugin.json`, then:

    claude plugin update claude-teammates@claude-teammates   # bare name fails; @marketplace is required

and restart. An unbumped version means the update is a no-op. **This applies to the `usage` fix
below: it is not in the running snapshot.**

## Released in v1.1.2 — the `usage` session-selection fix

`usage --root .` reported on the harness's `memory/` directory, which sits beside the session
directories inside the project directory. `newestSession` chose the newest *directory*, and
`memory/` is written every session, so it won every mtime comparison — the command failed with
`no transcripts found at .../memory/subagents`, which reads as "that session is empty" rather than
"that was never a session".

A session is now identified by the `subagents/` store it carries, ordered by the later of the
session directory's and the store's mtime, and the no-store failure names the layout rather than
whichever directory happened to be newest. Two tests cover it; the suite is **1876 tests, 1873
pass, 0 fail, 3 skipped** locally.

Green on Linux, macOS and Windows, merged via PR #14, and released as `v1.1.2`. **The running
harness still has the broken selection until `claude plugin update` and a restart** — the rule
above applies to this release like any other.

## What the measurement already established

Measured with a no-tool probe prompt on `sonnet`, the only variable being whether the agent's
`tools:` declaration was active. The first two rows are from one session; the third is from the
session after the cache refresh, so it is a cross-session comparison and the probe prompt differs
slightly — the 17,889 delta is far outside anything that accounts for.

| agent | `tools:` active | prefix per turn |
|---|---|---|
| `tm-reviewer` | yes (predates the session) | **7,867** |
| `tm-implementer` | no (absent from the loaded snapshot) | **27,499** |
| `tm-implementer` | yes (cache refreshed to 1.1.1) | **9,610** |

**19,632 tokens per turn**, of which the agent-definition size difference explains only ~604.
The prefix is re-read on every turn, so for a fleet the size of run `fog` — 7 implementers at
~46 turns — that is on the order of **6.3M cache-read tokens**.

**Two of my explanations along the way were wrong; do not inherit them:**

1. "It is ~50 unused tool schemas." **No.** Tools arrive *deferred* — all 56 names total 1,966
   chars (~491 tokens). The real mechanism is that a restricted agent gets a substantially
   smaller system prompt.
2. "The zero delta between my two probes disproves it." **No.** That experiment was invalid: the
   restricted probe's own transcript still listed 56 deferred tools including Gmail MCP entries,
   so the declaration was never in force.

Measured composition of the 27,499-token prefix:

    ~22,800  harness system prompt (not this plugin's)
      2,815  skill listing — 32 skills, of which this plugin contributes ~1,900 chars over 14
      1,400  agent definition
        491  deferred tool roster

## Where token work stands

| lever | status |
|---|---|
| quiet test reporter | **shipped, proven** — `npm test` output 40,372 → 126 tokens (99.7%) |
| `usage` command | **shipped** — reproduces the original ad-hoc numbers exactly |
| tool declarations | **shipped and verified active** — 27,499 → 9,610 per implementer turn |
| skill descriptions | **measured and rejected** — ~144 tokens/turn against real routing risk |
| agent verbosity (`caveman`) | **unexplored, and the largest remaining lever** |

On the last row: the `claims` reviewer emitted 22,900 output tokens, **10,132 of them thinking**,
and output accumulates into context and is re-read every later turn. I earlier dismissed
`caveman` as "not a lever" because it makes a *brief* 3% larger — that was the wrong
measurement. A brief is paid once; accumulated output is paid every turn. But this is a genuine
quality trade-off, unlike everything above: those thinking tokens are what found the unpinned
`if (notes)` guard by mutation. **Measure before assuming a saving.**

## Traps this session hit — all mine, all the same shape

Four platform or environment assumptions, each caught only by running the real thing:

- **`NODE_TEST_CONTEXT=child-v8`** is set in every test process. A nested `node --test` that sees
  it switches to the internal serialised protocol and **ignores `--test-reporter`**, exiting 0
  with empty stdout — which reads as "the reporter printed nothing", not "the reporter was never
  asked". Scrub it from any child env.
- **`--test-reporter` is resolved by the ESM loader.** An absolute Windows path begins `D:\`, and
  the drive letter is read as a URL scheme. Pass a `file://` URL. (`.pathname` is wrong the other
  way — it keeps the leading `/C:/`.)
- **A colon cannot appear in a Windows filename.** `projectSlug` now strips it; whether the real
  harness does the same is unverified against a Windows install.
- **`--root` arrives as the literal string.** `flags.root ?? process.cwd()` does not resolve, so
  `--root .` collapsed `path.join` to the projects directory and the newest *project* was
  mistaken for a session. Resolve before deriving anything from it.

**Windows CI broke three times today on this class of thing, and every one was a test asserting
POSIX semantics.** The suite is green on Linux long before it is green on Windows — check CI
after pushing rather than trusting a local pass.

## Release state

`v1.1.1` is tagged at `b36b821` and pushed; `master`, the tag, `package.json` and
`.claude-plugin/plugin.json` all agree. Nothing is unreleased.

One judgement recorded rather than hidden: `usage` is a **new CLI subcommand**, and by the
reasoning that made v1.1.0 a minor bump — `init-run` gained a refusal it did not have — this
would conventionally have been `v1.2.0`. It was tagged as a patch at the user's request.
Retagging is cheap if that reads wrong later.

## Verify before trusting anything above

    npm test                              # expect 1876 tests, 1873 pass, 0 fail, 3 skipped
    gh run list --limit 1                 # the last push must be green on all three platforms
    node scripts/cli.mjs usage --root .   # the measurement tool

CI was watched through `cfc7de6` — the tip of `master` — and is green on Linux, macOS and
Windows. Nothing on this branch is unverified.

## Still open, unchanged

- `docs/followups/2026-08-22-fog-open-findings.md` — most sections are now closure records. What
  genuinely remains is the **accepted bidi exposure**, which is a recorded decision rather than a
  gap, and the plan's own `## Not Yet Specified` entries, which are questions for the operator.
- Run `fog` landed on **a verified fresh test pass, not a recorded gate PASS** — no reviewer
  lenses were dispatched for the inline follow-up work. Same for every inline change since.
