# NOTICE

This plugin's skill content draws on [superpowers](https://github.com/obra/superpowers)
(version 6.2.0, © Jesse Vincent, MIT License). See `LICENSE-THIRD-PARTY` for the
full license text.

## Adapted skills

The following skills are adapted from superpowers skills of the same name:

| Skill | Adapted from |
|---|---|
| `brainstorming` | superpowers `brainstorming` |
| `executing-plans` | superpowers `executing-plans` |
| `receiving-code-review` | superpowers `receiving-code-review` |
| `systematic-debugging` | superpowers `systematic-debugging` |
| `test-driven-development` | superpowers `test-driven-development` |
| `writing-skills` | superpowers `writing-skills` |

## Original skills

The following skills are original to `claude-teammates` and are not adaptations
of any superpowers skill:

- `using-teammates`
- `writing-plans`
- `finishing-a-development-branch`
- `fleet-lifecycle`
- `parallel-execution`
- `phase-gate`
- `fleet-supervision`

Three of these original skills additionally absorb guidance from superpowers
skills that have no direct counterpart in this plugin:

- `parallel-execution` absorbs guidance from superpowers `subagent-driven-development`
  and `using-git-worktrees`.
- `fleet-lifecycle` absorbs guidance from superpowers `dispatching-parallel-agents`.
- `phase-gate` absorbs guidance from superpowers `verification-before-completion`
  and `requesting-code-review`.
