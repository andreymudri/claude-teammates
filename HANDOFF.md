# Handoff — 2026-08-29, end of session

`v1.2.0` is tagged at `master` and released. Nothing is unreleased.

It closes the two behavioural hazards that runs `purge` and `purgefix` were built to close, and
it ships one **breaking** change: `collect-reviews` now writes its results to a file, and the
`> results.json` redirect the docs used to teach no longer round-trips. See CHANGELOG.md.

## Read this first

**The record of these two runs is `docs/followups/2026-08-27-purge-open-findings.md`.** Read that,
not this file, for what closed, what was carried and what is still open. Every finding in it keeps
its reviewer's own reproduction, and `.teammates/purgefix/reviews/*.json` is the authority for any
finding's wording.

Two runs, eleven tasks, five phases, every phase gated PASS — but not cleanly. Phase 3 needed
**nine** review rounds and phase 4 needed **five**, each carrying non-blocking findings forward
rather than spinning further. Only the last gate of the last phase was clean at first ask. The
suite is 2190 | 2187 pass | 0 fail | 3 skipped; the three skips are two win32-only tests and one
`no UNC target on this host`.

## What to do first

**Nothing is required.** The release is cut, pushed and tagged. If you are picking this up cold,
the two things most likely to bite you:

- **`collect-reviews` does not persist in the installed 1.1.6 plugin.** If your installed plugin
  is older than this release, redirect its stdout to a file and pass `gate --results <path>`.
  After updating to 1.2.0, pass the path the command prints — and do **not** capture stdout, for
  the reason in the CHANGELOG.
- **`claude plugin update claude-teammates` installs from `origin/master`.** That is now this
  release, so updating is safe. It was not before: for the whole of these two runs, updating would
  have installed *older* code than the working tree.

## Still open, and deliberately so

- **Four pre-existing defects no task in the plan owned**, each with a measured reproduction —
  including a `TMPDIR`-derived path interpolated into a JS string inside a `shell: true` command
  with two levels of quoting and neither applied. All four are in the followups document.
- **A bind mount over the reviews directory is not seen by the containment walk.** `lstat` and
  `realpath` both see through it; only `/proc/self/mountinfo` would, on one of three target
  platforms. Proved under `unshare -Urm`, and now **pinned as a stated boundary** by a Linux-only
  test rather than closed.
- **Two declared residuals in `skills/phase-gate/SKILL.md`** — an indented code block and a
  lexicon-free paragraph can each teach the retracted workflow while the suite stays green. The
  prose route is structurally unclosable; the code-block route needs machinery whose
  over-tightness risk nobody has assessed. Both were declared in-tree *before* a reviewer went
  looking, which is the behaviour to keep.

## Tooling defects found while running, not yet fixed

- **The generated `brief` cannot be used verbatim for a fix round.** Its MANDATORY FIRST STEP is
  `git checkout -B <branch> <base>`, which **resets the task branch and destroys the work being
  fixed**. Every fix dispatch in these runs had to say so explicitly. Wants a `--fix-round` flag.
- **The gate's `test` check shells out to `npm test`,** so a broken interpreter and a red suite
  land in the same verdict cell. This happened: `mise` had no global `node` pin, so the `node`
  shim resolved by fallback while `npm` refused, and the gate reported `FAIL failed:["test"]` on a
  green suite. Read a failing check's `output` before believing its verdict.
- The `SubagentStop`/worktree guard stops a teammate inspecting or removing another worktree, so
  freeing a branch held by a reaped agent is necessarily the orchestrator's job.
- `npm install` generates an untracked `package-lock.json` — this project has no dependencies —
  and dirties a teammate's worktree.

## The lesson worth carrying into the next run

**The orchestrator's claims are the only input to the tree that nothing reviews.** Four lenses
check an implementer's output; nothing checks what the implementer was told. Nine orchestrator
claims had to be corrected across these runs, two of them landing in code comments an implementer
transcribed *because of where they came from*.

Two of the nine came not from mid-run invention but from **durable artifacts written earlier and
trusted later** — a memory asserting nine forbidden commit trailers existed when zero did, and a
prior handoff citing a plan line that was three lines off. A claim written down earlier arrives
wearing the authority of a record.

The instruction that demonstrably worked, and belongs in **every** dispatch rather than added after
being burned: *treat a bare assertion from me as a claim to check, not a fact to transcribe.* The
first relay error caught **before** it landed was the one whose brief carried that sentence. By the
end, reviewers were volunteering the bounds of their own answers unasked, refusing to inflate a
cosmetic asymmetry into a finding, and correcting the orchestrator's greps.

Which includes this file. Re-derive before relying on it.
