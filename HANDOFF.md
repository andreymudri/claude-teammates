# Handoff — 2026-08-24, end of session

Everything below is on `master` and pushed. One branch, one worktree. `v1.1.3` is tagged at
`master` — nothing is unreleased.

## Read this first

**The measurement is taken and the loop is closed.** A `tm-implementer` dispatched with the
`tools:` declaration actually loaded carries a **9,610**-token prefix, against **27,499** for the
same agent from the pinned snapshot that lacked the line — **17,889 tokens per turn, 65%**.

    node scripts/cli.mjs usage --root .   # run 389bd517: tm-implementer, sonnet, 1 turn, 9,610

Higher than the ~7,900 the previous session predicted, and the prediction was the wrong shape
rather than the measurement being off: 7,900 came from `tm-reviewer`, which declares five tools
to `tm-implementer`'s six and has a shorter definition. The number to carry forward is the
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
| agent verbosity (`caveman`) | **measured 2026-08-25 and rejected** — reaches ~5-8% of one role's output |

On the last row — **measured 2026-08-25, and the answer is no.** Four facts, each read from code
or from the real transcripts in session `314b4caf`, not estimated:

1. `caveman` has two readers, and `composeBrief` (`scripts/brief.mjs`) has two call sites —
   `scripts/workflow-gen.mjs` and `scripts/cli.mjs:2153` (the `brief` subcommand) — but **both
   produce implementer briefs**. The second reader, `renderDigest` (`scripts/digest.mjs:45`, called
   at `cli.mjs:2017`), shortens the digest this CLI prints to the operator; it reaches no agent's
   output at all. What carries the argument is unchanged: `scripts/review-gen.mjs` has no caveman
   path, so the `claims` reviewer that emitted 22,900 output tokens — the whole motivating example
   — never receives the instruction.

   *(Corrected 2026-08-25. The original read "read only by `composeBrief`, called only from
   `workflow-gen.mjs`"; both halves were false, found by a `claims` reviewer. The conclusion below
   survives the correction, because it rests on `review-gen.mjs` having no caveman path, which
   holds.)*
2. The terse brief's STYLE block scopes the style to "summary and blockers": the returned result,
   not intermediate turns and not thinking.
3. That summary is the **last** assistant message — turn 49/49 and 46/46 in the two real
   multi-turn agents — so it is re-read **zero** times by the agent that wrote it. "Output
   accumulates and is re-paid every turn" is true of thinking and tool_use, and false of exactly
   the part caveman targets.
4. The terse brief is **+156 chars (+2.8%)**, and a brief sits in the prefix, so *that* cost is
   re-read every turn: +39 tokens x turns.

Measured composition of agent output (`~tok` from chars/4; thinking is the residual, as the
stored thinking blocks carry a signature but no text):

| agent | turns | output | thinking | tool_use | visible text | final summary |
|---|---|---|---|---|---|---|
| `tm-reviewer` (claims) | 49 | 22,900 | ~16,480 (72%) | ~4,646 | ~1,774 (8%) | 6,949 chars |
| `tm-reviewer` | 46 | 12,965 | ~9,817 (76%) | ~2,541 | ~607 (5%) | 2,374 chars |

**The premise held and the lever failed.** Own output really does drive the cost — 71% and 48% of
each agent's context growth, against 21% and 32% from tool results — and growth x turns is what
~1M cache reads per agent pay for. But 72-76% of that output is thinking, which a style
instruction cannot touch. `agents.<role>.effort` is the control for thinking; `caveman` is not.

What is still unmeasured is caveman's actual compression *ratio*, because no real (non-probe)
implementer transcript survives in any store. A two-agent A/B on the summary alone would settle
it; a fleet A/B would not be worth its cost for a lever with this ceiling.

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

`v1.1.3` is tagged at `master` and pushed; `master`, the tag, `package.json` and
`.claude-plugin/plugin.json` all agree. Nothing is unreleased. It is docs plus one test file —
the `caveman` measurement, merged as PR #15 and green on all three platforms — so the bump is a
patch on its own terms, not a judgement call. It exists so `claude plugin update` is not a no-op:
the corrected `teammates-config` text cannot reach a running fleet without a version to update to.

One judgement recorded rather than hidden: `usage` is a **new CLI subcommand**, and by the
reasoning that made v1.1.0 a minor bump — `init-run` gained a refusal it did not have — this
would conventionally have been `v1.2.0`. It was tagged as a patch at the user's request.
Retagging is cheap if that reads wrong later.

## Verify before trusting anything above

    npm test                              # expect 1882 tests, 1879 pass, 0 fail, 3 skipped
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
