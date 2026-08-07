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
- Anything requiring write access to a shared ref, which is outside the model.

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
