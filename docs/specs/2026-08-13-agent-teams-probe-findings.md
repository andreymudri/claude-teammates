# Probe findings — TeammateIdle / worktree isolation (2026-08-13)

Repo: `C:\projetos\claude-teammates`, branch `master` at `39d4191`, clean.
Context: closing the three blocking questions in
`docs/specs/2026-08-10-agent-teams-adoption-design.md`.

This began as a session handoff and was copied here to survive session-scoped scratchpads.
Sections 1–5 are as measured; section 6 was added afterwards and **supersedes the "Open next
step" in section 3**.

---

## 1. The probe results that opened this session

Pasted in from a worktree-isolated agent:

```
pwd:                             /c/projetos/claude-teammates/.claude/worktrees/agent-a1e5827720707b4dc
git rev-parse --abbrev-ref HEAD: worktree-agent-a1e5827720707b4dc
```

**Reading:** re-confirms spec blocker 1 — `isolation: 'worktree'` survives agent-teams mode
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). It adds nothing beyond what memory
`worktree-isolation-survives-teams-mode` already recorded, including the fact that the harness
names the branch `worktree-agent-<hash>` itself — **not** `teammates/<runId>/<taskId>`.

That naming is the thing that breaks the hook's task resolution.

## 2. State of the armed probe — *disarmed as of section 8*

- Handler: `…\07fd1b50-57bd-4dd0-9b2f-78c9df058765\scratchpad\probe-teammate-idle.mjs`
  Logs payload + git facts to `teammate-idle-probe.jsonl` beside it. Always exits 0.
  `touch block-once` next to it → exits 2 once, to test whether blocking actually works.
- Declared in `C:\projetos\claude-teammates\.claude\settings.local.json` under **both**
  `TeammateIdle` and `SubagentStop`. Safe to write: `.gitignore` ignores all of `.claude/`.
- Paths point at session `07fd1b50`'s scratchpad. They still resolve; the probe is reusable as-is.
- Hooks load at session start, so testing it always needs a fresh session.

## 3. What this session measured (the new part)

Spawned a worktree-isolated `tm-implementer` as a pure measurement probe (no branch, no commit,
no edit), then read the jsonl delta. Landed in
`.claude/worktrees/agent-a0cd56002a852d30c`, `--git-dir` = `.git/worktrees/agent-a0cd56002a852d30c`,
common-dir `.git`, locked.

Log now has 5 entries:

| # | event | agent_type | payload `cwd` | branch there |
|---|---|---|---|---|
| 0 | (hand-fed fake, `session_id: "s1"`) | tm-implementer | main repo | master |
| 1–3 | SubagentStop | `""` | main repo | master |
| 4 | SubagentStop | `claude-teammates:tm-implementer` | **the worktree** | `worktree-agent-a0cd…` |

### Findings

1. **`TeammateIdle` has never fired.** Zero real instances in five entries. No evidence the event
   exists in this harness build. *This*, not payload shape, is what blocks spec question 2.
   — *Superseded by section 6: the event does exist in 2.1.231; it is gated on team context, which
   an `Agent`-spawned subagent never has. "Never fires for us" stands; "no evidence it exists"
   does not.*
2. **`SubagentStop` fires and its `cwd` does track the worktree.** An earlier reading in this
   session said `cwd` was pinned to the session cwd — that was wrong. Entries 1–3 showed the main
   repo because those agents were plain non-isolated subagents. Entry 4 (isolated) shows the
   worktree, and `agent_type` is populated only for the isolated spawn.
3. **`cwd` still doesn't yield a task id.** The branch at that `cwd` is `worktree-agent-<hash>`.
   A hook can locate the worktree and still not name the task → resolve from the claim record,
   per memory `teammate-idle-cannot-see-a-do-nothing-teammate`.
4. **`background_tasks` in the payload lists the stopping agent itself as `status: "running"`.**
   Do not treat that array as "other teammates still working".

`SubagentStop` payload keys (14): `agent_id`, `agent_transcript_path`, `agent_type`,
`background_tasks`, `cwd`, `effort`, `hook_event_name`, `last_assistant_message`,
`permission_mode`, `prompt_id`, `session_crons`, `session_id`, `stop_hook_active`,
`transcript_path`.

### Open next step — closed, see section 6

Determine whether `TeammateIdle` exists at all in this build. If it does not, any design that
depends on it needs to fall back to `SubagentStop` — which fires only on stop, not on idle, so it
cannot see a teammate that is parked and doing nothing. That distinction is the whole point of the
memory note above.

## 4. Worktree cleanup done this session

`git worktree list` had ~23 leaked worktrees from the followups2 / followups3 runs.

Before removing, established:

- Every leaked worktree's **HEAD was already contained in `master`** — committed work had landed
  (PRs #9 / #10).
- But every one also carried **staged (`M `) edits to real source files** — `scripts/cli.mjs`,
  `scripts/finish.mjs`, `scripts/reviews.mjs`, `tests/*.test.mjs`, `skills/*/SKILL.md` — whose
  content **differed from master's version of those same files**, referenced by no commit.
  `git worktree remove --force` would have destroyed it unrecoverably.
- All targets were real directories, not Windows junctions, so the hazard in memory
  `worktree-remove-follows-junctions` did not apply this time. **Re-check that before any future
  reap** — it wipes the real target through a junction.

Preserved all 22 twice before removing:

- `refs/rescue/agent-<hash>` — a commit per worktree, parented on its HEAD, carrying the staged tree.
- `scratchpad/worktree-rescue/agent-<hash>.patch` — `git diff --cached HEAD` per worktree.

Then removed and pruned. Repo now has **one** worktree (main, `master`, clean); all **22 rescue
refs intact**.

Recovery:

```
git show refs/rescue/agent-<hash>            # inspect
git diff master refs/rescue/agent-<hash>     # what it changes vs what landed
git cherry-pick refs/rescue/agent-<hash>     # or apply the scratchpad patch
```

**Caveat:** `refs/rescue/*` is outside `refs/heads`. `git log --all` won't show it and `git push`
won't carry it — local-only until moved to a branch. `gc` won't collect it; refs count as roots.

**Unjudged:** whether those staged states are stale pre-final edits or work that never got
committed. Worth diffing `refs/rescue/agent-a7e86f747e22c73fc` (8 files) and
`refs/rescue/agent-ad678fbc564a3e841` (8 files) against master before calling the followups runs
closed. — *Judged in section 7: every blob was already in master's history, and the refs were
deleted. The "22 rescue refs intact" line above and the recovery commands below no longer hold.*

## 5. Memory updated

`worktree-isolation-survives-teams-mode` now records the split question-2 result, the corrected
`cwd` finding, the `background_tasks` quirk, and the probe's current armed state.

## 6. Why it never fired — read out of the binary (added after sections 1–5)

Sections 1–5 leave open whether `TeammateIdle` exists in this build. It does. Evidence is the
installed single-file binary, `~/.local/share/claude/versions/2.1.231` (Claude Code 2.1.231),
searched with `LC_ALL=C grep -a -o -E`.

**It exists.** `TeammateIdle` appears in the hook event table `U4` alongside `SubagentStop`,
`SubagentStart`, `WorktreeCreate` and `WorktreeRemove`; it has an executor
(`executeTeammateIdleHooks` -> `iRn`), a payload builder, and a `"TeammateIdle hook prevented
continuation"` path. So the event is real and blockable.

**It is gated on team membership, not on the environment variable:**

```js
if (B_()) { let Y = Nk() ?? "", W = ph() ?? ""; … let Z = iRn(Y, W, k, …) }

function B_(){ if (t3()) return true;
               return !!(q9.dynamicTeamContext?.agentId && q9.dynamicTeamContext?.teamName) }
```

`Nk()` is the agent name, `ph()` the team name. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` does not
put a session in team context; an `Agent`-spawned subagent has none, so `B_()` is false and the
event is skipped. That is the whole reason for the zero instances in five entries — **not** that
the event is absent. With `TeamCreate` removed from the harness, this plugin has no way to reach
it at all.

**Its payload is not the documented one.** `{...fg(i.session, Vt(), r), hook_event_name:
"TeammateIdle", teammate_name: e, team_name: t}` — `fg` sources `agent_id` / `agent_type` from a
fourth argument that this call site does not pass, so both are `undefined`. It carries
`teammate_name` and `team_name` instead. The design doc's task resolution is written against
`agent_id` / `agent_type`.

**Both events fire at the same moment.** `TeammateIdle` is dispatched from inside the Stop
executor, immediately after the Stop hooks and beside `TaskCompleted`. "Idle" there means *the
session ended its turn*, which is when `SubagentStop` fires too. So the framing that
`SubagentStop` "fires on stop, not idle, and therefore cannot see a parked do-nothing teammate" is
correct about the gap but wrong to treat it as a difference between the two events: **neither**
sees a parked agent. A stalled teammate never ends a turn, so no stop-path hook runs. That case
stays `liveness`'s alone, as the design doc's own §Skill changes already states.

### What this does to the design

- `SubagentStop` is the reachable equivalent of the intended enforcement point, and it needs no
  experimental flag: payload carries `agent_id`, `agent_type` and a `cwd` that tracks worktree
  isolation (section 3, finding 2), and it supports `preventContinuation` / `blockingError`
  identically. The loader even rewrites a subagent's `Stop` hook to `SubagentStop`
  (`"subagents trigger SubagentStop"`).
- The design doc's **Fan-out** section loses its rationale. It exists because `Workflow` agents
  cannot be teammates — but `Agent`-spawned agents are not teammates either, so teams mode buys no
  addressability that direct dispatch does not already have (a direct spawn returns an id usable
  with `SendMessage`). The section should be dropped, not made conditional.
- **Detection** shrinks to a `doctor` line. With fan-out gone there is no branch left for a
  `teams-mode` exit code to gate.
- Newly visible and plugin-relevant: `SubagentStart` (stamp the claim with the real `cwd` at the
  moment work begins, which is what closes the do-nothing-teammate hole) and `WorktreeCreate` /
  `WorktreeRemove` (the natural home for the junction unlink a leaked preview needs).

Method note: these are strings and call sites in a minified bundle, not documented interfaces.
They are evidence about 2.1.231 and nothing else, and the standing risk in the design doc's last
section applies with full force — do not encode version-specific behaviour that cannot be detected
at runtime.

## 7. Rescue refs — verified duplicate (added after sections 1–5)

Section 4 left it unjudged whether the 22 rescue refs held unlanded work. They did not.

Each rescue commit's staged delta was compared file-by-file against every earlier commit of that
same path in master's history: **58 of 58 blobs matched exactly**. Every "staged edit" was the file
as it stood at an earlier master commit — a mid-run index, not lost work. The alarming
diff-vs-master figures in section 4 (34 files, ~6000 deletions) are an artifact of comparing old
worktree HEADs against a master that had moved on; the staged delta against each ref's *own parent*
is the meaningful measure, and it is small and wholly duplicated.

Recorded before deletion. If anything ever needs recovering, these are the commits — once the refs
are gone they are unreachable and survive only until gc reaps them:

```
07257cde09ee193441b99b5cc60a4d5c9c9efcab refs/rescue/agent-a030a386f2399a1ab
080aac991ac93987334a99c4dabca6b2e5497a5d refs/rescue/agent-a0a07d50f0517c68c
06c2b4f50103dbeea9123daf001d685fd03450c2 refs/rescue/agent-a0f7cba153386cb7e
ed5c3e7871d93e205eaf5e4a3d697ebd4ad973ca refs/rescue/agent-a11e8a8263b8f08e9
858d500c8a991d7e45449a06c626a19bfc1d437d refs/rescue/agent-a27af45613299e91e
cf4f7e83f9cc92591553d1085651f8647ba53337 refs/rescue/agent-a35b226ccdd072d32
53862fa90ac88f78858baf5e4f25b9837a233832 refs/rescue/agent-a39e60e1db488821e
33ea6d30c94188ba215de8bb73425f888f20b3f9 refs/rescue/agent-a519942e36ea8f77d
fc336576e5bd18cbaa94ac8504c978b1a0436e18 refs/rescue/agent-a528216014cffc726
384b71eaff39316c45014e9bc9b7a8e3050810c0 refs/rescue/agent-a556dc8e1ab9342e3
c5ad94e607acaf5587931711877b831de7e30043 refs/rescue/agent-a583701ec63727dd3
29939452bda1db7e383b6ef40a7ad9de9c0c18a2 refs/rescue/agent-a5aef38c15cf2876f
3f160190deacebf3f76ef5afd3f455c2006834f8 refs/rescue/agent-a7a75adc238ebb577
a13ae441f22ff52d0958ad07c579d6f2d3acfe81 refs/rescue/agent-a7e86f747e22c73fc
326b1f308e49cfb731dc3fa9deda679dc8adeab1 refs/rescue/agent-a8e289b67bf0e13a2
066f83d4d2bd29e47b6296aae9a2feecfb29e8cd refs/rescue/agent-a980797053f524ec2
379821b9ed7bad79140c0a44f33b6547e9ecb10c refs/rescue/agent-aa2afd2544bf2bc70
d20780d20cbe86c53d2dff375749407b52182b5d refs/rescue/agent-ac6bb7158df9203ed
c46644497ae554f2280a542a905dd0560b6b03fa refs/rescue/agent-ac928c055170606c5
1cbd2c7d3d8743823f801d8c813fc34f20374160 refs/rescue/agent-ad678fbc564a3e841
11f9f50f21cf4bb8ce3b425d07c57caddc56341a refs/rescue/agent-ae889a08755e3d07d
8d42c10a36d9790ac71af57922e023ccca5eae6d refs/rescue/agent-afbf2b5fe3f11f71c
```

## 8. Blocking confirmed end-to-end (2026-08-13, probe disarmed after)

Section 6 read the blocking mechanism out of the binary. It was then measured. A worktree-isolated
`tm-implementer` was spawned with the `block-once` sentinel in place, so the handler exited 2 exactly
once. All three signals the design rests on came back positive:

| Signal | Result |
|---|---|
| Does exit 2 block a **subagent** stop | Yes — the agent quoted the handler's stderr verbatim in its next message |
| Does the block force another turn | Yes — two `SubagentStop` firings for one agent, 9 s apart |
| Does the harness set `stop_hook_active` on the re-stop | Yes — `false` on the first firing, `true` on the second |

So a handler keying on `stop_hook_active` gets exactly the "one block per stop" behaviour the
harness documents, and the stderr it writes is delivered into the teammate's context rather than
discarded.

**What a block does not buy.** The probe agent read the injected text, acknowledged it, and still
returned `status: "done"`. A block costs the teammate one extra turn and hands it the reason; it
cannot compel a fix. That is the whole reason the phase gate remains the thing that decides, and why
the handler is specified as an early catch rather than an authority.

Two payload details confirmed alongside, both relied on by the handler:

- `cwd` is the agent's own worktree, and `git rev-parse` there resolves `--git-common-dir` to the
  main repository's `.git` — so the handler can derive the main worktree root from `cwd` alone.
- `agent_type` is populated for an isolated spawn (`claude-teammates:tm-implementer`) and empty for
  a plain subagent. The handler keys on `cwd`, not on this, so the inconsistency costs nothing —
  but do not build on `agent_type` being present.

The probe was disarmed afterwards: `.claude/settings.local.json` is now `{}`. The handler and its
log lived in a session-scoped scratchpad and will not survive cleanup; re-arming means rewriting the
handler, which is a small script whose whole behaviour is described in section 2.
