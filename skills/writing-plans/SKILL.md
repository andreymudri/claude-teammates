---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task, before touching code - produces a plan this plugin can parse, phase, and dispatch to a fleet.
---

# Writing Plans

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

## Save location

Save the plan to `docs/plans/YYYY-MM-DD-<feature-name>.md`.

## Global Constraints

Every plan needs a **Global Constraints** section in its header, before the first task — the
project-wide requirements every task inherits: version floors, dependency limits, naming
conventions, commit-message style, anything a task shouldn't have to restate. One line per
constraint, with the exact value, not a vague pointer:

```markdown
## Global Constraints

- Node >= 20
- Zero new runtime dependencies
- Commit messages: single-line, commitlint style, English
```

A task's own requirements are on top of this, not instead of it — every task implicitly
carries the Global Constraints too. That's why `parallel-execution` dispatch hands each
implementer the global constraints alongside its task brief: they're plan-wide, not
per-task, so nothing downstream has to look them up separately.

## Machine-readable task format

This plugin parses its own plans. `scripts/plan-parser.mjs` reads a `**Files:**` block under
each `### Task N: <title>` heading, and only three file-line forms are recognised:

- `- Create: \`path\``
- `- Modify: \`path\``
- `- Test: \`path\``

Any other bullet form is silently dropped, leaving the task with no declared files. Phase
assignment (`scripts/phases.mjs`) reads an empty file list as "conflicts with nothing" — so
every such task lands in phase 1 and its implementers edit the same files simultaneously.
Use the three forms exactly, one file per bullet.

## Dependencies are mandatory where they exist

A task that builds on another must carry `**Depends:** T1, T3`. Without it, the dependent
work is scheduled concurrently with the task it depends on, and a fleet will run them in
parallel worktrees regardless of what the prose says.

When a task has no dependencies, omit the **Depends:** line entirely — that is the intended
way to say "nothing." A sentinel like `**Depends:** none` is tolerated by the parser, but
omission is the documented form; don't rely on the sentinel.

## Declared files are the enforced write set

An implementer may only create or modify the files its task declares. This is the permitted
write set for that task — a stray path outside it is caught at merge and fails the phase gate.

## The example plan

<!-- example-plan -->
```markdown
### Task 1: add user model

**Files:**
- Create: `src/models/user.mjs`
- Test: `tests/user.test.mjs`

- [ ] **Step 1:** Define the `User` class with `id`, `email`, `createdAt`.

### Task 2: add user repository

**Files:**
- Create: `src/repositories/user-repository.mjs`
- Modify: `src/models/user.mjs`
- Test: `tests/user-repository.test.mjs`

**Depends:** T1

- [ ] **Step 1:** Implement `findById` and `save` backed by an in-memory map.
```

## Self-check before dispatch

Before handing a plan to a fleet, run it through the parser and phase assigner yourself:

```
node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" init-run docs/plans/<file>.md --run plancheck --root <project root>
```

Read the printed phase breakdown and confirm it matches intent — tasks that should run
sequentially must not land in the same phase. Then remove the scratch run directory; it was
only for this check, not for the real run.

## Task right-sizing, bite-sized steps, no placeholders

Match the discipline this plan itself follows: each task should be sized so one implementer
can finish it without touching another task's files. Each step is one action. Code steps carry
actual code, not a description of code. Never write "TBD" or "similar to Task N" — write out
the content, even if it repeats a pattern from an earlier task.

## Self-review

Before handing the plan off, check:

- **Spec coverage** — every requirement in the spec maps to at least one task.
- **Placeholder scan** — no "TBD", "similar to Task N", or other stand-ins remain.
- **Type consistency** — the same field, function, or shape is described identically wherever
  it appears across tasks.
