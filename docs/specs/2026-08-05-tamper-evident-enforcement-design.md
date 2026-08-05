# Tamper-Evident Enforcement — Final Scope

Date: 2026-08-05
Status: approved, pre-implementation
Supersedes `2026-08-05-boundary-enforcement-design.md` and closes the sequence begun in
`2026-08-05-runtime-enforcement-design.md`.

## What happened, briefly

Four designs were attempted. Three were defeated, each one layer below the last, and every
defeat was reproduced by running it:

| Design | Authority it trusted | How it fell |
|---|---|---|
| Runtime enforcement | `status.json` | Teammate rewrites it; `integrated` resets the baseline. |
| Adversarial enforcement | Git ancestry | Teammate plants a tag shadowing a branch (diff reads empty); teammate fast-forwards the run branch and creates the other tasks' branches, so every phase reads integrated and no check runs. |
| Boundary enforcement | A command allowlist in a harness hook | Every permitted verb executes teammate-authored code: `npm test` via `package.json`, `git commit` via `.git/hooks/`, **`git status` via `core.fsmonitor`**, `node --test` by definition. Three files were written outside the clone by approved commands. |

The pattern is not a sequence of oversights. It is one fact surfacing repeatedly:

> A `tm-implementer` must write code and execute it. Executing teammate-authored code **is**
> arbitrary execution. No allowlist can separate "run your tests" from "run anything",
> because they are the same operation.

Preventing that requires containing execution — an OS-level sandbox — which is infrastructure
this plugin does not have and will not acquire here. Everything short of it raises the cost of
an attack without preventing one.

So this spec stops claiming prevention.

## What this delivers

**Tamper-evident enforcement.** The gate detects violations that arise from drift, confusion,
mistakes, and attacks that are not specifically aimed at the gate. It records what it checked
and what it found. It does not stop a teammate that is deliberately targeting it.

That is a smaller claim than the previous specs made, and it is the one the code can keep.

### Enforced, and verified by tests

- **V1 fileset** — each task branch, resolved through a fully-qualified `refs/heads/` name to
  a sha, diffed against the run anchor. Any changed path outside the task's declared files is
  a violation. Renames report both pre- and post-image.
- **V2 ownership** — no task branch may be the run branch under any alias spelling; the main
  worktree must be clean; every commit on the run branch since the anchor must be reachable
  from a task branch.
- **V3 completion** — `complete` recomputes the gate rather than reading a recorded verdict.
  A forged or stale `status.json` PASS buys nothing.
- **Phase derivation** — from what is actually merged, never from a stored field. Out-of-order
  integration is an error, not a guess.
- **Fail-closed inputs** — unresolvable refs, missing branches, git errors, and a phase that
  selects zero tasks are all failures, never passes.

### Not defended against — the honest list

These are known, reproduced, and deliberately out of scope. Each must appear in the docs
where the corresponding claim is made:

- **A teammate that runs arbitrary code.** It has Bash with the user's permissions. It can
  write any file, including its own `package.json`, `.git/hooks/`, and `.git/config`.
- **Self-integration.** A teammate can fast-forward the run branch to its own tip and create
  branches named for tasks it does not own, making phases read as integrated so no check runs.
  Confirmed.
- **A teammate that forges run state.** `.teammates/` is writable. Nothing reads it for a
  verdict, so this buys little — but the digest and supervision output can be made to lie.
- **Uncommitted work.** The gate reads commits. The claim is precisely "committed changes
  stayed in the declared set".
- **A teammate that edits the enforcement code.** Out of reach in a normal install, where the
  CLI lives at `CLAUDE_PLUGIN_ROOT`; reachable in this repo, which is its own plugin.
- **A compromised orchestrator.**

## Documentation rule

Every place the plugin asserts an enforcement guarantee must state its limit in the same
breath. Specifically:

- `agents/tm-implementer.md` — "this is checked" is accurate; add that the check reads
  committed changes.
- `skills/phase-gate/SKILL.md` — a section stating the model: catches drift and mistakes,
  not a determined agent, with the reason (running a teammate's tests is arbitrary execution).
- `README.md` — one paragraph, so the claim is visible before install rather than discovered
  during a review.

A guarantee stated without its limit is the defect that started this work:
`tm-implementer.md` claimed the gate enforced a file set when no such check existed.

## What is dropped

- `hooks/pre-tool-use.mjs` and the `PreToolUse` wiring — not built.
- `scripts/boundary.mjs` and `tests/boundary.test.mjs` — not merged. The work was correct for
  what it was asked to do; the approach cannot deliver the guarantee. `teammates/bnd/T1` is
  abandoned.
- Clone isolation, `prepare-clone`, `collect` — not built. Teammates keep worktrees.

## What is kept from completed work

Both are merged into the remaining plan and are independently valuable:

- `scripts/git.mjs` (`teammates/bnd/T2`) — the six ancestry methods, `resolveRef` requiring a
  fully-qualified ref, `teammateRef`, `fetchRefspec` with `--no-tags`, and the trailing `--`
  on the commands that accept it. **This closes the confirmed tag-shadowing bypass**, which
  matters under the tamper-evident model too: a stray tag is exactly the kind of accident this
  model is meant to catch.
- `scripts/enforce.mjs` (`teammates/bnd/T3`) — convention-only branch resolution, the
  `{phase}|{error}` derivation, reachability-shaped ownership, `verdictCoversTree`, `planHash`.

## Remaining work

1. `scripts/gate-runner.mjs` — derived `fileset` and `ownership` checks over resolved shas;
   prototype-safe dispatch; a throwing check becomes a recorded failure.
2. `scripts/cli.mjs` — `gate` and `complete` recompute; `integrated` deleted; `--no-fleet` is
   the only skip; `status.json` written as a report.
3. `teammates.gate.json` and `inferGateConfig` — ship both checks.
4. Prose — the documentation rule above, across agents, skills, and README.
5. Adversarial tests — each documented attack that IS defended asserts failure; each attack
   that is NOT defended gets a test asserting the current behavior, so the limit is pinned
   rather than assumed.

Item 5 matters most. A limit that is written down but untested drifts into a claim.

## Global constraints

- Node stdlib only; Node >= 24.2; ESM named exports; injectable side effects
- `scripts/enforce.mjs` stays import-free
- Every rev argument fully qualified and resolved to a sha before use
- No subcommand may mutate enforcement authority
