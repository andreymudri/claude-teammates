# Quiet test reporter — design

## Destination

`npm test` reports failures and one summary line instead of 1,843 pass lines, so the command
every agent is told to run stops being the largest single source of context in a fleet run.

## Why

Token usage was measured across three real agents from run `fog` (two reviewers and one
integrator), read from their harness transcripts:

| category | tokens |
|---|---|
| fresh input | 212 |
| cache **read** | 2,190,488 |
| cache write | 200,558 |
| output | 36,461 |

Fresh input is a rounding error. The cost is cache reads, and cache reads scale with
**turns × context size**: every token sitting in an agent's context is re-read on every
subsequent turn. Average context was ~20k tokens/turn across all three agents.

So the question is not "what do we send once" but "what accumulates, and how many turns follow
it". The answer is the test command:

- `npm test` emits **161,489 chars (~40,372 tokens)**, of which **1,843 lines are `✔ <name>`**.
- The `claims` reviewer lens runs it about nine times — a green baseline plus one run per
  mutation, and its instructions say to run the command unmodified.
- Implementers run it at least once for their BASELINE step, and again to verify.
- The gate's `test` check runs it once per phase, inside the merge preview.

Nothing reads those 1,843 lines. They are pure noise that, once in context, is paid for on
every later turn of that agent.

Measured with a prototype: **~40,372 tokens → ~99 tokens on a green run, a 99.8% reduction**,
with failure detail and exit codes unchanged.

## What it is

One file, `scripts/quiet-reporter.mjs`, exporting a default async generator that Node's test
runner drives. No dependencies and no shell involvement — which is what makes it behave
identically under `cmd.exe` on Windows CI, where a `| grep` pipeline would not.

Wiring, in `package.json`:

    "test":         "node --test --test-reporter=./scripts/quiet-reporter.mjs tests/*.test.mjs",
    "test:verbose": "node --test tests/*.test.mjs"

`npm test` stays the command the gate manifest, the skills and every brief already name. That is
the point: the saving has to reach agents that were told to run it unmodified, so it cannot be
something a caller opts into. `test:verbose` keeps the full spec output one command away.

## Output contract

| run | output |
|---|---|
| green | one line: `1846 tests \| 1843 pass \| 0 fail \| 3 skipped` |
| red | `✖ <name>` plus the error's stack and diff, per failure, then the same summary |
| either | `test:stderr` and `test:stdout` passed through verbatim |
| either | process exit code unchanged (0 green / 1 red) |

Three properties are load-bearing, each because it is a way this could quietly go wrong:

1. **The summary always prints, including on red.** It is what satisfies this project's evidence
   rule — a claim that tests pass requires output showing the count and zero failures. A
   reporter that summarised only on success would leave a failing run unable to state its own
   counts.
2. **Failure detail is never abbreviated.** Error reports keep their full content. That rule
   does not bend for a token saving; the whole saving comes from the success path, which is
   where the noise is.
3. **stderr passes through.** The prototype surfaced a genuine blast-radius warning from the
   repository itself. Suppressing stderr to shrink output would hide real diagnostics.

## Counting: the one non-obvious decision

**Counts come from the root `test:summary` event, never from tallying `test:pass` events.**

Tallying inflates the count, because a parent suite emits its own `test:pass` alongside its
children. Measured on a nested fixture (one `describe` with two tests, plus a test with one
subtest):

- `node --test`'s own spec reporter: `tests 4, pass 4, suites 1`
- a prototype that tallied `test:pass`: **`5 tests | 5 pass`**

The runner emits `test:summary` twice: once per file (carrying a `file` field) and once for the
whole run (no `file`). The root one is the aggregate, and on the real suite it reported
`tests: 1846, passed: 1843, skipped: 3` — matching the spec reporter exactly.

A wrong count is worse than a verbose one, because the evidence rule depends on the number being
true. This is the first thing the tests pin.

The root summary also carries `success`, which is reported beside the counts so a run can never
read as green while its exit code says otherwise.

## Error handling

- **A test file that fails to load** emits no test events at all, but the runner still counts it
  as `failed: 1` with `success: false` and exits 1, and the loader's stack reaches the terminal
  through stderr passthrough. Verified: there is no silent-green path.
- **Skipped tests** are counted in the summary and not named. This repository has three. If which
  ones matters, `npm run test:verbose` answers it.
- **The reporter itself throwing** would lose output without changing the run's exit code, so the
  implementation stays deliberately small: four counters, the root summary, and no I/O, parsing,
  or other state.

## Testing

Behaviour is pinned by mutation, in the manner the rest of this repository uses — a test that has
never failed has not proven it can catch anything.

| test | what it pins |
|---|---|
| green run | one summary line, no per-test lines, exit 0 |
| failing run | `✖ name`, stack and diff present; summary still printed; exit 1 |
| **nested suites** | counts match the root summary rather than the inflated tally — the 4-vs-5 case |
| skipped | counted in the summary, not named |
| stderr | passed through verbatim |
| load failure | non-zero exit and a visible reason |

The nested-suite test is the one that matters most: it is the bug the prototype actually hit, and
without it the naive tallying implementation passes every other test here.

## Out of Scope

- Changing what the `claims` lens does — capping how many times it re-runs the suite is a
  separate question about that lens, not about the reporter.
- Trimming skills, agent definitions or briefs — a real lever (context is re-read per turn) but a
  different change with different risks.
- A `usage` CLI subcommand that reads transcripts and reports per-run token totals — worth
  building, and the transcripts are already proven to carry the data, but not needed to make
  this change or to measure it.
- Reducing agent output tokens — the existing `caveman` setting already targets those, and
  measured it makes a brief 3% LARGER on the input side, so it is not a lever for this.

## Not Yet Specified

- Should the gate manifest's `test` check use `test:verbose` when a phase FAILS, so a failing
  gate captures maximum detail on the retry?
- Does the summary line's format need to stay stable for anything that greps it, or is it for
  human and agent reading only?
