# Rename to `fleetmates` and publish on npm — design

Date: 2026-09-13. Release: **2.0.0** (every on-disk name changes; the migration below is what keeps
it from being a hard break).

## Decisions already made

| Question | Decision |
|---|---|
| How deep does the rename go? | Everything, including on-disk names, with old names migrated rather than dual-read. |
| What is the npm package for? | Plugin distribution only. No `bin`; skills keep calling `node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs"`. |
| How is it published? | CI on a `v*` tag, npm trusted publishing (GitHub OIDC), `--provenance`. First publish is manual. |
| How are old names handled? | Auto-migrate on first CLI touch, with the refusals in section 2. |

## 1. Name map

| Old | New |
|---|---|
| npm package / plugin / marketplace / GitHub repo `claude-teammates` | `fleetmates` |
| plugin namespace `claude-teammates:*` (e.g. `claude-teammates:tm-reviewer`) | `fleetmates:*` |
| skills `using-teammates`, `teammates-config` | `using-fleetmates`, `fleetmates-config` |
| `teammates.gate.json`, `teammates.local.json` | `fleetmates.gate.json`, `fleetmates.local.json` |
| `.teammates/<run>/` | `.fleetmates/<run>/` |
| task branches `teammates/<run>/<task>` | `fleetmates/<run>/<task>` |
| claim refs `refs/teammates/<run>/<task>` | `refs/fleetmates/<run>/<task>` |
| hook state `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-teammates/` | `…/fleetmates/` — starts fresh, not migrated (it holds a last-seen version and an update cache) |
| agents `tm-implementer`, `tm-integrator`, `tm-reviewer` | unchanged |

**One module owns every spelling.** `scripts/names.mjs` exports `NAMES` (the new spellings) and
`LEGACY` (the old ones). Today they are defined separately at `scripts/config.mjs:6-7`,
`scripts/gate-config.mjs:5`, `scripts/enforce.mjs:9`, `scripts/state.mjs:40`,
`scripts/git.mjs:750` and `scripts/cli.mjs:2747`; each of those imports from `names.mjs` instead.
`LEGACY` is imported by `scripts/migrate.mjs` and nothing else. `enforce.mjs` currently imports
nothing so the SubagentStop hook's module graph stays small; `names.mjs` must also import nothing
to preserve that.

**Historical documents are not rewritten.** `docs/specs/*` and `docs/followups/*` dated before
this spec, `docs/plans/*`, and past `CHANGELOG.md` entries describe what was true when written.
Live documents — `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, every `skills/**/SKILL.md`,
`agents/*.md`, `templates/*` — are rewritten.

## 2. Auto-migration

`migrate(root, io)` in `scripts/migrate.mjs`. `scripts/cli.mjs` calls it once, after argv
parsing and before dispatching any command that reads a name. It is a no-op when no legacy name
exists (one `lstat` per legacy path, plus one `for-each-ref` for branches and refs). When it
acts it prints one line per rename, in this order:

1. **Refuse, exit 2, nothing changed** if:
   - any legacy run has a task that `livenessRows` reports as live (touched within
     `DEFAULT_STALE_MINUTES`), computed for each run directory under `.teammates/` exactly as the
     `liveness` command computes it. A teammate on the old plugin version keeps writing to
     `.teammates/` after the move and splits the run. The message names each live run and task and
     says to wait until they go stale or stop the fleet, then re-run.
   - both a legacy and a new spelling of the same thing exist (`.teammates/` and `.fleetmates/`,
     or both gate manifests). The message names both paths; the operator resolves it by hand.

   Hooks never migrate: `scripts/subagent-stop.mjs` fires inside running teammates, does not
   import `migrate.mjs`, and reads only the new names.
2. **Branches.** For every `refs/heads/teammates/*`: `git branch -m teammates/<r>/<t>
   fleetmates/<r>/<t>`. Measured on git 2.55.0: exits 0 while a linked worktree has the branch
   checked out, and that worktree's `HEAD` follows (`refs/heads/fleetmates/r1/T1`).
3. **Claim refs.** For every `refs/teammates/*`: `git update-ref refs/fleetmates/<…> <sha>` then
   `git update-ref -d refs/teammates/<…> <sha>`. These refs never back a worktree, so
   `update-ref -d`'s missing checked-out refusal (measured 2026-09-13, recorded at the prune-run
   comment in `scripts/cli.mjs`) does not apply.
4. **Stored names.** In every `*.json` under `.teammates/`, rewrite string values of the keys
   `branch`, `findingsPath`, `verdictFile` and `file` only: a `teammates/` prefix becomes
   `fleetmates/`, `refs/teammates/` becomes `refs/fleetmates/`, and a `.teammates/` path segment
   becomes `.fleetmates/`. Free text (`brief`, `prompt`, `failureScenario`, `summary`, …) is
   history and is left alone. Without this, `scripts/state.mjs:486` discards every recorded branch
   because it no longer equals `taskBranchName(runId, taskId)`. Each file is written temp-then-
   rename, as `state.mjs` already does.
5. **State directory.** `rename('.teammates', '.fleetmates')`, then `git worktree repair <path>`
   for every registered worktree whose path was under `.teammates/`. Measured: after the move
   `git worktree list` marks such a worktree `prunable`; `repair` on the new path restores it.
6. **Manifests.** `teammates.gate.json` → `fleetmates.gate.json` with `git mv` when tracked,
   `rename` otherwise; same for `teammates.local.json` (normally untracked).
7. **`.gitignore`.** For each legacy line present (`.teammates/`, `teammates.local.json`), append
   the new spelling with `ensureGitignored` (`scripts/config.mjs:318`). No code adds `.teammates/`
   today, so a user-written ignore line is the only thing keeping run state and the local config
   out of commits; dropping it would expose both.

**Failure mid-way.** Steps run in the order above. On the first failure `migrate` stops, prints
every step already performed with the command that reverses it, and the command exits 4. It
never retries, and it never continues past a failed step. On Windows a `rename` of a directory
with an open handle fails (`EBUSY`/`EPERM`); that surfaces here as a stop, not a partial move.

**Idempotence.** A second run after success finds no legacy name and does nothing. A run after a
reported failure sees whatever was left and either resumes (steps 2–7 are each safe to re-run on a
tree where they already happened) or refuses on a both-spellings conflict.

## 3. npm package, release, and existing installs

### Package

`package.json`: `name: "fleetmates"`, `version: "2.0.0"`, repository/homepage/bugs URLs to
`github.com/andreymudri/fleetmates`, and a `files` allowlist:
`.claude-plugin/`, `agents/`, `hooks/`, `scripts/`, `skills/`, `templates/`, `README.md`,
`LICENSE`, `LICENSE-THIRD-PARTY`, `NOTICE.md`, `CHANGELOG.md`. No `bin`, no `dependencies`
(there are none today). Measured with npm 11.19.0: `npm pack` preserves the `0755` mode of
`hooks/run-hook.cmd`, `hooks/session-start` and `hooks/update-check`, which `hooks/hooks.json`
executes directly.

`.claude-plugin/plugin.json`: `name: "fleetmates"`, `version: "2.0.0"`, URLs updated.

`.claude-plugin/marketplace.json`: marketplace `name: "fleetmates"`; its one plugin
`name: "fleetmates"` with `source: { "source": "npm", "package": "fleetmates" }`.

**Development loop.** With an npm source, `/plugin marketplace add /path/to/checkout` installs the
published package, not the working copy. Local testing uses `claude --plugin-dir .` (flag
confirmed present in this Claude Code build). `CONTRIBUTING.md` says so.

### Update check

`hooks/update-check` reads `https://registry.npmjs.org/fleetmates/latest` and takes `.version`,
replacing the `raw.githubusercontent.com/…/plugin.json` fetch at `hooks/update-check:32`. npm is
now where releases come from, so it is the source of truth. The release-notes link in
`hooks/session-start` points at `github.com/andreymudri/fleetmates/releases`.

### Release workflow

`.github/workflows/release.yml`, on `push: tags: ['v*']`:

- `test` — the same ubuntu/macos/windows matrix as `test.yml`.
- `publish` — `needs: test`, ubuntu, `permissions: { contents: read, id-token: write }`. Fails
  unless the tag equals `v` + `package.json` version. If `npm view fleetmates@<version> version`
  already returns that version, it prints `fleetmates@<version> is already on npm — nothing to
  publish` and exits 0; a re-pushed tag or the hand-published 2.0.0 is not a failure. Otherwise
  it runs `npm publish --provenance --access public`. Authentication is npm trusted publishing; no
  token secret exists. Trusted publishing
  needs npm ≥ 11.5.1 — the job prints `npm --version` and fails below that rather than falling
  back.

### Order of outward steps

Each is outward-facing and is confirmed at the time it is done, not by approval of this spec.

1. Open the implementation PR and get the matrix green.
2. **You:** `npm login`, then `npm publish --access public` from the PR's head commit. This claims
   the name and publishes 2.0.0; trusted publishing can only be linked to a package that exists.
3. Merge the PR with `--ff-only`, so `master` is byte-identical to what was published.
4. **You:** on npmjs.com, `fleetmates` → Settings → Trusted publisher → GitHub, repo
   `andreymudri/fleetmates`, workflow `release.yml`.
5. `gh repo rename fleetmates`. GitHub redirects the old URLs; nothing in this design relies on
   those redirects.
6. Tag `v2.0.0` on that commit and push the tag. The publish job finds 2.0.0 already on npm and
   skips (see below); 2.0.1 is the first CI publish.

`marketplace.json` names an npm source, so it must not reach GitHub `master` before the package
exists — a marketplace pointing at a missing package breaks `/plugin install`. That is why step 2
publishes from the PR head and step 3 merges after it.

### Existing installs

A user with `claude-teammates` installed who adds the `fleetmates` marketplace ends up with both
plugins enabled: two SessionStart injections, and two SubagentStop hooks, the old one still
looking for `.teammates/` after a migration. `hooks/session-start` detects a
`claude-teammates@*` key in `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/installed_plugins.json`
(present on this machine as `claude-teammates@claude-teammates`) and emits a warning that names
`/plugin uninstall claude-teammates`. A missing or unreadable file means no warning, never an
error — the same rule the hook already applies to its update notice.

The `README.md` gets a "Coming from claude-teammates" section: uninstall the old plugin, install
`fleetmates`, and run any CLI command once per repo to migrate.

## 4. Testing

- `tests/migrate.test.mjs`, each case in a scratch git repo:
  - every step 2–7 on its own, asserting the new name exists AND the legacy one is gone;
  - a linked worktree checked out on a legacy branch survives step 2 on the new branch;
  - a worktree under `.teammates/` is not `prunable` after step 5;
  - a claims record naming `teammates/r1/T1` is read back with that branch (not null) after step 4;
  - `.gitignore` gains `.fleetmates/` and `fleetmates.local.json` only where the legacy line was;
  - each refusal in step 1 exits 2 and leaves the tree byte-identical;
  - an injected failure at each step stops there, exits 4, and prints a reverse command for every
    earlier step;
  - a second run is a no-op.
- `tests/names.test.mjs`: no `teammates` spelling is used as a name outside `scripts/names.mjs`
  and `scripts/migrate.mjs` — a source-text assertion over `scripts/` and `hooks/` that strips
  comments first, because the comment explaining a name otherwise counts as a use.
- A pack test: `npm pack --dry-run --json` lists no path under `tests/` or `docs/`, and lists
  `.claude-plugin/plugin.json`, `hooks/hooks.json` and `skills/using-fleetmates/SKILL.md`.
- The existing suite, renamed mechanically; `npm run test:hostile-tmpdir`; the CI matrix,
  including Windows for step 5's rename.

## Out of scope

- A `fleetmates` CLI binary.
- Renaming the `tm-*` agents.
- Renaming the local checkout directory. The auto-memory path for this project is keyed on it,
  so a move is its own decision.
- Dual-read of legacy names anywhere other than `migrate.mjs`.
