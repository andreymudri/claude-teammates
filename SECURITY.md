# Security

## What this plugin does and does not defend against

Read this before reporting something, because the honest answer to a whole class of reports is
already written down: **the phase gate is tamper-evident, not tamper-proof.**

A teammate runs its own tests. Running a teammate's code is arbitrary execution, so a determined
teammate can do anything you can — including editing the manifest the gate reads, or moving refs.
The gate reliably catches drift, mistakes, and attacks that are not aimed at it. It is not a
security boundary and must not be relied on as one.

`docs/specs/2026-08-05-tamper-evident-enforcement-design.md` lists what is explicitly out of
scope, and `tests/adversarial.test.mjs` pins each of those limits with a test.

So the following are **known and documented**, not vulnerabilities:

- A teammate executing arbitrary code during its own task or its own test run.
- A teammate editing `teammates.gate.json` in the working tree — command checks are shell strings
  read from that file.
- A teammate writing `.teammates/` state. No check reads it when deciding a verdict; the worst it
  buys is wasted fix rounds, not a false PASS.
- A teammate writing `teammates.local.json`. That file is gitignored, so a teammate can write it
  during its own task and `git status` stays clean: neither `fileset` nor `ownership` will ever
  see it. Read the next two paragraphs as the actual boundary rather than as a reassurance.

  **It cannot change a verdict.** `gate`, `complete` and `fix` read the tracked manifest through
  `loadGateConfig` and never the merged config, so no key in the local layer reaches a check, a
  check's `blockOn`, the lens, the merge preview, or the fix-round budget. Every key that could
  is rejected there by name: `phases`, `lens`, `preview`, and — read this one specifically —
  **`agents.reviewer.tier` and `agents.reviewer.effort`**. The reviewer produces the verdict for
  every `agent`-kind check, so its tier and effort decide how good the judge is; allowing them in
  the gitignored layer would let a teammate weaken the reviewer grading its own diff. Those live
  only in the tracked `teammates.gate.json`.

  **It can still influence how later work is dispatched, and that influence leaves no evidence.**
  A teammate that writes `{"agents":{"implementer":{"tier":"cheap","effort":"low"}},"caveman":"ultra"}`
  keeps `git status --porcelain` empty and nonetheless sets every later implementer's tier and
  effort, gets that downgraded tier stamped into `plan.json` as `configured` so `fix` escalates
  from it on retry, and rewrites every later dispatch brief through `caveman`. That is real
  influence over the run — worse work, dispatched more cheaply, briefed more tersely — bounded
  only by the fact that the gate still grades the result at full strength from the tracked
  manifest. It is accepted for the same reason arbitrary execution is: a teammate that can run
  code can write this file. Note that setting the same keys in the tracked manifest does not
  close this — the local layer is resolved *over* the gate layer for every ergonomics key, which
  is what makes it a local override. The only thing standing between that influence and a false
  PASS is the verdict boundary above, so a way across that boundary is worth reporting.
- Anything requiring write access to a shared ref, which is outside the model.

## The one outbound request

This plugin makes exactly one network request, and only for update notices. It is described here
rather than in the list above because it is not a teammate capability — it runs on your machine at
session start, whether or not a fleet is running.

`hooks/update-check` issues a single `GET` to
`https://raw.githubusercontent.com/andreymudri/claude-teammates/master/.claude-plugin/plugin.json`,
with `curl -fsS --max-time 5`, at most once every 24 hours. It sends nothing beyond the request:
no identifiers, no project path, no telemetry. On any failure — offline, proxied, no `curl`, a
non-200, a malformed body — it exits 0 silently and writes nothing.

Set `CLAUDE_TEAMMATES_UPDATE_CHECK=0` to disable it. The opt-out is checked before anything else in
that script, so a disabled install makes no request at all rather than making one and discarding
the result.

The hook is declared `"async": true` in `hooks/hooks.json` and emits no output. It writes only
`${CLAUDE_CONFIG_DIR:-~/.claude}/claude-teammates/update-check.json`, which `hooks/session-start`
reads on a later session. That file's only effect is a string printed into session context:

- It is not read by `gate`, `complete` or `fix`, so nothing in it can reach a verdict.
- The version it stores is filtered on write to digits and dots only, so a redirect to an HTML
  error page — or any value carrying markup — is rejected rather than cached, and a hostile value
  cannot carry markup into the context.
- `hooks/session-start` makes no network request of its own. It reads two local files.

## What is worth reporting

- A way to get a **PASS on a phase whose content is not explained by a task branch or the base** —
  that is the property the whole design rests on.
- A check that reads `.teammates/` when deciding a verdict, letting the enforced party supply its
  own evidence.
- A path escape from the merge preview: a `preview.link` entry, or any other input, that creates a
  link or writes outside the repository.
- Injection into generated workflow source from plan markdown, a branch name, or a task field.
- A documented guarantee that is simply false — where a skill or agent contract promises something
  the code does not do. In this project that counts as a security issue, because agents act on
  that prose.

## Reporting

Open a [security advisory](https://github.com/andreymudri/claude-teammates/security/advisories/new)
rather than a public issue, and include the concrete path: what an attacker controls, what they
do, and what they get. A finding without a reproduction is hard to act on.

If you are unsure whether something is in scope, report it anyway and say why you are unsure —
an over-reported issue costs a reply, and the alternative costs more.

Expect an initial response within a week. This is a personal project, not a funded one; there is
no bounty.
