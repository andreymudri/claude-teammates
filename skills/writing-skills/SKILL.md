---
name: writing-skills
description: Use when creating new skills, editing existing skills, or verifying skills work before deployment.
---

# Writing Skills

_Adapted from the MIT-licensed superpowers plugin by Jesse Vincent. See NOTICE.md._

## Overview

**Writing a skill is Test-Driven Development applied to process documentation.** Watch an
agent fail without the skill (baseline), write the skill, then watch a fresh agent comply.
If you never watched the failure, you don't know whether the skill teaches the right thing —
or whether there was anything to teach at all.

A skill is a reusable technique, pattern, or reference — not a narrative about how you solved
something once. Don't create one for a one-off fix or a project-specific convention (put that
in the project's own instructions file instead).

## Start from the template

Copy `templates/SKILL.template.md` as the starting structure for a new skill. It carries the
required frontmatter shape and the section skeleton (When to use / Process / Red flags) —
fill it in rather than improvising frontmatter from scratch.

## Rules this plugin's test suite enforces

These are checked mechanically by `tests/skills.test.mjs` and `tests/skill-contracts.test.mjs`
on every skill under `skills/` — get them wrong and the suite fails, not just a reviewer:

- **`name` matches the containing folder exactly.** `skills/writing-skills/SKILL.md` must
  declare `name: writing-skills`.
- **`description` starts with `Use when`.** It states triggering conditions, not what the
  skill does — see "Write the description as a trigger" below.
- **Every CLI subcommand named in the body must actually exist.** Only `init-run`, `gate`,
  `digest`, `claim`, `unclaim`, and `workflow` are real subcommands of the CLI entrypoint.
  Naming a subcommand that doesn't exist fails the suite, not just the reader.
- **Every `tm-*` agent named in the body must actually exist.** Only `tm-implementer`,
  `tm-reviewer`, and `tm-integrator` exist under `agents/`.
- **The CLI is always invoked through `$CLAUDE_PLUGIN_ROOT`**, never a relative path:
  `node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" <subcommand> --root <project root>`. A relative
  invocation works from the author's shell and breaks for everyone else.

## Write the description as a trigger, not a summary

The description is what a future agent reads to decide whether to load the skill at all — it
answers "should I read this right now?", not "what will I learn if I do?" Name concrete
situations: symptoms, error messages, the moment in a workflow where the need arises. Don't
summarize the skill's process or steps in the description — an agent that reads a workflow
summary in the description will sometimes act on the summary and skip the body, which is worse
than not finding the skill at all.

```yaml
# BAD: abstract capability, not a triggering situation
description: Use when working with async tests

# GOOD: concrete symptom
description: Use when tests have race conditions, timing dependencies, or pass/fail inconsistently

# BAD: summarizes the workflow instead of the trigger
description: Use when executing plans - dispatches one implementer per task with review between tasks

# GOOD: trigger only
description: Use when you have a written implementation plan to execute in a separate session with review checkpoints
```

## A skill must be verified to trigger

Writing a skill and shipping it without confirming it fires is not done. Start a fresh session,
give it a prompt that matches the situations named in the description, and confirm the skill
actually loads and is followed — don't just re-read the description and judge by eye whether it
sounds like it would match.

**A skill that never triggers is worse than no skill.** It sits in the directory creating false
confidence that a process is covered, while every real invocation silently falls through to
default behavior. No skill at all is at least honestly absent.

## Red flags

| Thought | Reality |
|---------|---------|
| "The description is close enough, no need to test triggering" | Close enough to you is not close enough to the matcher. An untested description is an unverified claim that the skill will ever run. |
| "This is a small edit, I don't need to re-verify" | An edit that changes the description or the triggering conditions can silently break discovery. Re-verify triggering after any change to those sections. |
| "I'll skip the template, my frontmatter is fine" | The template's frontmatter shape is exactly what the suite checks. Freehand frontmatter is how a missing field or a name/folder mismatch slips through. |

## Applying this

Both authoring a brand-new skill and editing an existing one under `skills/` go through this
cycle: start from `templates/SKILL.template.md`, write to the rules the suite enforces, write
the description as a trigger, and verify the skill actually fires in a fresh session before
calling it done.
