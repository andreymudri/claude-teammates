# Handoff — 2026-08-24, end of session

Everything below is on `master` and pushed. Working tree clean, one branch, one worktree.
`v1.1.1` is tagged at `b36b821`, which is `master` — nothing is unreleased.

## Read this first

**One measurement is pending, and it needs a fresh session to take — that is why this handoff
exists.** Agent definitions are loaded by Claude Code at session start, so the `tools:` lines
added to `tm-implementer` and `tm-integrator` today could not take effect in the session that
wrote them.

**First job next session:**

    node scripts/cli.mjs usage --root .          # note the numbers, then dispatch anything
    # dispatch one trivial tm-implementer, then:
    node scripts/cli.mjs usage --root .

If the `tm-implementer` prefix has dropped from **27,499** to roughly **7,900**, the loop is
closed and the saving is real. If it is still ~27,499, the declaration is not being honoured and
the finding below needs re-explaining, not re-asserting.

## What the measurement already established

Measured this session with the identical probe prompt, identical model, same session — the only
variable being whether the agent's `tools:` declaration was already active:

| agent | `tools:` active | prefix per turn |
|---|---|---|
| `tm-reviewer` | yes (predates the session) | **7,867** |
| `tm-implementer` | no (edit not yet loaded) | **27,499** |

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
| tool declarations | **shipped, activation unverified** — see above |
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

    npm test                              # expect 1874 tests, 1871 pass, 0 fail, 3 skipped
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
