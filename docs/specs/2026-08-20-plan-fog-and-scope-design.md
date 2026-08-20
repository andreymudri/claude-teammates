# Fog of war and out-of-scope in plans (2026-08-20)

Repo: `C:\projetos\claude-teammates`, branch `feat/plan-fog-and-scope`, based on `master` at
`03f664f` (v1.0.1).

Ported from the fog-of-war and out-of-scope ideas in Matt Pocock's `wayfinder` skill, evaluated on
2026-08-19. That evaluation's verdict was **do not adopt the skill** — it charts decision tickets on
an issue tracker and hands off before execution begins, which conflicts with `.teammates/<run>/` as
the single coordination store and with the gate as sole authority. Two of its ideas survived the
evaluation, and this spec is those two and nothing else.

---

## 1. What this solves

A plan written up front carries tasks for phases that will not run for hours. By the time a later
phase dispatches, earlier fix rounds have moved the interfaces those tasks describe. Two records in
this project's memory are the same failure:

- A later phase's brief encoded interfaces earlier fix rounds had already changed.
- A later task's acceptance criteria still demanded behaviour a security fix had removed, so an
  implementer following the plan would have **weakened the fix to go green**.

Both were written at charting time as fully specified tasks, when what the author actually had was
a question. The fix is not better foresight. It is a place to write a question down *as a question*,
so it carries no file list and no acceptance criteria to be wrong about.

Separately: work consciously ruled out of a run has nowhere to live. It comes back as a finding in
the next run, gets re-argued, and is ruled out again. Runs `followups`, `followups2` and
`followups3` exist partly because of this.

## 2. Destination fixes the scope

"Out of scope" means *beyond the destination*. Without a written destination it is unjudgeable and
becomes a place to park anything inconvenient. So a plan that uses `## Out of Scope` needs a
`## Destination`.

The destination is **judgeable scope only**. It is parsed, stored, and shown to the operator. It is
deliberately NOT carried into any teammate's brief and NOT read by any check. Adding it to briefs
was considered and rejected: briefs already run ~5,700 characters per teammate, and a teammate's job
is its task, not the run's purpose.

## 3. The plan format

Three new optional header sections, alongside `## Global Constraints`, before the first task:

```markdown
## Destination

The gate can answer "is this run landable" without an operator reading any prose.

## Not Yet Specified

- How should finish report a phase whose reviewers disagreed?
- Does the map's coupling data belong in the gate at all?

## Out of Scope

- Replacing `.teammates/` with a real datastore — swapping it invalidates every check that
  reads it, and the coordination store is not what this destination is about.
```

All three are optional, with one dependency between them: a plan that carries `## Out of Scope` must
also carry `## Destination`, because §2 is what makes an out-of-scope entry judgeable. That
dependency is enforced (§3.2, §5), not merely recommended. Fog needs no destination — a question is
answerable without one.

A plan with none of the three parses exactly as it does today. This is a compatibility requirement,
not a nicety: `docs/plans/` holds plans from every prior run and none of them may become
unparseable.

### 3.1 The fog-or-task test

Stated in `writing-plans`, and the rule the whole feature rests on:

> Can you state the question precisely **now** — not answer it. If yes, it is a task, even when it
> is blocked and cannot be worked yet. If no, it is Not Yet Specified.

With the consequence spelled out: do not pre-slice fog into task-shaped pieces. One fog entry may
graduate into three tasks, or into none.

### 3.2 The mechanical rules

Three rules, each encoding a section's purpose, each checkable by shape alone:

| Section | Rule | Refused | Accepted |
|---|---|---|---|
| `## Out of Scope` | must carry a reason clause | `- Caching` | `- Caching — the destination is the gate verdict, not latency` |
| `## Out of Scope` | requires a `## Destination` in the plan | the section with no destination | the section with one |
| `## Not Yet Specified` | must end with `?` | `- Rewrite scripts/reviews.mjs` | `- Should reviews keep per-lens verdicts?` |

**A reason clause is defined by shape, not by judgement:** the entry contains a separator — an em
dash (`—`), an en dash (`–`), a spaced hyphen (` - `), or a spaced double hyphen (` -- `) — with at
least one non-whitespace character after it. Nothing checks that the text after the separator is a
*good* reason; that is not decidable and the spec does not pretend otherwise. What the rule buys is
that a boundary cannot be recorded as a bare noun.

The question-mark rule reads the entry's final non-whitespace character, after the same
normalisation the rest of the parser applies, so a trailing backtick or emphasis marker does not
defeat it.

A reason clause is what makes a boundary reviewable — an entry without one is a word, not a
decision. A question mark is what keeps fog from becoming a dumping ground for work nobody wanted to
size: a work item wearing a note's clothes fails, and a genuine question passes.

**A rule considered and dropped:** "an entry may not name a file path," on the theory that naming a
file means it is really a task. It misfires on legitimate prose in both sections — the `.teammates/`
example above names a path in its reason clause, and `Should scripts/reviews.mjs keep per-lens
verdicts?` is exactly what fog is for. The two entry-shape rules above target the same abuse without the false
refusals.

### 3.3 Neither section ever produces a task

`scripts/phases.mjs` reads an empty file list as "conflicts with nothing," so every task with no
declared files lands in phase 1. If a fog or out-of-scope entry ever leaked into the task list, each
one would become a phase-1 teammate with no declared files, dispatched against a note. This is the
single most important regression to pin, and it gets a test of its own (§8).

## 4. Module contract

New module `scripts/plan-sections.mjs`, owning exactly one thing: header sections of a plan.

```js
export function bulletSection(markdown, heading)   // -> [{ text, line }]
export function proseSection(markdown, heading)    // -> string | null
export function parsePlanSections(markdown)        // -> { destination, notYetSpecified, outOfScope }
export class PlanSectionError extends Error        // carries line, entry, reason
```

`bulletSection` is the generalized body of today's `parseConstraints` (`scripts/cli.mjs:589`), which
becomes a thin call into it. That function already carries hard-won behaviour, each of which must
survive the move:

- The section terminates at the next heading of **any** level, not just `##`. Terminating only on
  `##` would sweep every task's `**Files:**` bullets into the constraints handed to every teammate.
- A bullet wrapped over two lines is one entry. Keeping only the first line hands a reader the
  opening clause of a rule and drops the rest, invisibly, because what remains reads as a complete
  sentence.
- Both patterns use `[^\n]` rather than `.`, because `.` does not match U+2028/U+2029 while `\s`
  does — a bullet containing one was dropped entirely, with no diagnostic.

Why a new module rather than extending `cli.mjs`: `cli.mjs` is already the largest file in the
project, and the new sections need per-entry validation with line numbers, which `parseConstraints`
has no notion of. Why not `scripts/plan-parser.mjs`: `parsePlan` returns an array of tasks, so adding
header sections there means changing its return type and every caller, and its loop is
task-and-fence oriented. Header sections are a different job with a different shape.

## 5. Refusal is loud

`parsePlanSections` throws; `init-run` catches and exits 2 without creating the run:

```
plan defect: Out of Scope entry 2 (line 34) has no reason.
An entry without a reason is not a scope boundary — it is a word.
Write what it is, and why it is beyond the destination.

  - Caching

exit 2 — run not created
```

The same treatment applies to the other two refusals: a fog entry that does not end in `?`, and an
`## Out of Scope` section in a plan with no `## Destination` — that one names the missing section
rather than an entry, since there is no offending line to quote.

This matches how the project already treats a plan defect — `parsePlan` throws on a duplicate task
id (`scripts/plan-parser.mjs:58`). The alternatives were considered and rejected:

- **Warn and compile anyway.** A dropped entry is invisible downstream and a warning inside a long
  `init-run` output is a warning nobody reads. Silently dropping is already how a malformed file
  line loses a task's entire declared set.
- **Compile verbatim, check in a separate subcommand.** A check that must be invoked is a check that
  is not run. This project already has a memory titled "no CLI path to record completed checks"
  about precisely that fate.

The cost of a hard refusal is one line of markdown, paid before the run exists, so nothing is lost.

## 6. Data flow

```
docs/plans/....md
   ## Destination / ## Not Yet Specified / ## Out of Scope
        |
   init-run  ──> parsePlanSections()  ──> throws ──> exit 2, run not created
        |
   .teammates/<run>/plan.json
        + destination: string|null
        + notYetSpecified: [{ text, line }]
        + outOfScope: [{ text, line }]
        |
        ├─> phases.mjs   UNCHANGED — never sees them
        ├─> brief.mjs    UNCHANGED — teammates get no new prose
        └─> finish       reports destination + open fog, never blocks
```

`finish` prints them after the verdict, as a record for the operator:

```
run substop — landable

Destination: the gate can answer "is this run landable" without an operator
             reading prose.

Not yet specified (2 open):
  - How should finish report a phase whose reviewers disagreed?
  - Does the map's coupling data belong in the gate at all?
```

### 6.1 What deliberately does not happen

No check reads these fields. No verdict depends on them. No teammate is handed them.

`finish` **reports** open fog; it does not refuse to call a run landable while fog is open. Making a
verdict turn on these fields would put the run's landability behind free-text prose that the
enforced agents can write — the same shape as the `.teammates/`-is-teammate-writable boundary that
`SECURITY.md` already documents as a weakness. A gate verdict comes from something recomputed out of
git, and none of this is.

This is also what keeps `writing-plans` honest. The most common defect class in this project's two
largest runs was prose claiming a guarantee the adjacent code does not provide. Because nothing here
is enforced, the skill must say so in as many words: these sections are a record for the human, not
a checked thing. The two mechanical rules in §3.2 are the only enforcement, and they check *shape*,
not truth.

### 6.2 Out of scope does not answer a finding

An entry in `## Out of Scope` is a scoping act recorded when the plan is charted or at a gate. It is
not a way to close a reviewer's finding. A finding relocated into this section is still a finding,
and moving it there changes nothing about whether it is real. `writing-plans` states this outright,
because the mechanical rules cannot: a well-formed entry with a plausible reason is exactly what
silencing a finding would look like to a parser.

## 7. Graduation is the existing amendment path

When a fog entry sharpens into a task mid-run, that is a plan amendment, and
`skills/parallel-execution/SKILL.md` already documents that operation in full:

1. Edit the plan: delete the entry from `## Not Yet Specified`, add a `### Task N`.
2. Commit it on the **base** branch — a working-tree edit is inert, because the gate reads the plan
   with `git show <mergeBase(base, runBranch)>:<planPath>`.
3. Merge the base into the run branch with `--no-ff`, which moves the merge-base onto the new base
   tip.
4. Re-run `init-run` so `plan.json` is recompiled — brief and dispatch read the compiled plan, not
   the markdown.
5. Rebase any in-flight task branch so it carries the amended plan.

No new mechanism, no new command. A `graduate` subcommand was considered and rejected: it could
rewrite the markdown and re-run `init-run`, but it cannot commit on the base branch, which is the
half that confers authority. It would automate the inert half and hide the half that matters.

`parallel-execution` gains one paragraph saying fog graduation is this operation.

## 8. Testing

- **Refactor safety net.** The existing `parseConstraints` tests must pass **untouched**. They are
  the proof that generalizing into `bulletSection` did not drop the terminator rule, the wrapped-
  bullet join, or the U+2028 handling. Needing to edit one is the signal that behaviour changed.
- **The leak regression (§3.3).** A plan with three fog entries and two out-of-scope entries must
  produce a task list identical to the same plan with those sections deleted.
- **Each refusal on its own**: missing reason, missing question mark, out-of-scope with no
  destination, and the line number in the message. Each with its anchor asserted — the malformed
  entry must actually be present in the fixture — so a refusal that silently stops firing cannot
  read as a passing test.
- **Each separator form** accepted by the reason rule (§3.2), and a bare noun refused. Testing only
  the em dash would leave three of the four forms unexercised, and the spec claims all four.
- **Optionality.** A plan with none of the three sections parses exactly as today, and `plan.json`
  carries `destination: null` with two empty arrays.
- **Skill contract.** `writing-plans` states the fog-or-task test, the three mechanical rules, the
  not-enforced disclaimer (§6.1), and the finding-silencer rule (§6.2). `parallel-execution` states
  that graduating fog is the amendment operation.

## 9. Out of scope for this spec

- **Reducing the plugin's token usage.** Measured on 2026-08-20 and worth its own spec: nine briefs
  for run `substop` total 51,376 characters, `parallel-execution` is 23,006 and `phase-gate` 17,558,
  and `using-teammates` costs 5,600 on every session start, clear and compact. Also measured:
  `caveman` briefs are 156 characters **larger** than full ones, every time — it reduces a teammate's
  output, not the dispatch prompt. None of that is what this destination is about.
- **Adopting the rest of `wayfinder`** — the tracker-as-canonical-store, one-ticket-per-session, and
  claim-by-assignee. Ruled out by the 2026-08-19 evaluation; they conflict with fleet parallelism and
  with the gate as sole authority.
- **Enforcing fog at the gate.** §6.1 states why, and it does not become in scope by being asked for
  again without a way to recompute it from git.
