# Update notification

Tell an operator when the plugin's version changed under them, and when a newer one is published.

Claude Code auto-updates plugins in the background, and there is no built-in "update available"
signal — `plugins-reference.md` documents the version resolution and update mechanics but no
notification. So the common case is a version arriving silently. The primary need is therefore
"you are now on 0.2.0, here is what changed", and only secondarily "0.3.0 exists".

## Global Constraints

- Node >= 24.2.0
- Zero new runtime dependencies
- Hook scripts are bash, extensionless, invoked through `hooks/run-hook.cmd`
- ESM only, `.mjs` for scripts, no TypeScript
- Commit messages: single-line, commitlint style, English
- Every new module gets a `tests/<name>.test.mjs` run by `npm test`
- No `console.log` in `scripts/` — output goes through the `io.out` seam that `cli.mjs` already uses
- **A hook must never exit non-zero and never block.** `hooks/session-start` already ends `exit 0`
  unconditionally; every path added by this plan keeps that property.

## Design decisions, and why

**The opt-out is an environment variable, not a config key.** `teammates.gate.json` and
`teammates.local.json` are per-project. An update notice is per-install: the same plugin copy
serves every repository you open. A config key would have to be set in every project separately to
silence one notice, which is the wrong scope. `CLAUDE_TEAMMATES_UPDATE_CHECK=0` disables the
network check for the whole install.

**The network call lives in a separate async hook that emits nothing.** `hooks/hooks.json` declares
the existing `SessionStart` hook with `"async": false`, so it blocks session start. A fetch there
would add latency to every session and fail visibly when offline. Instead:

- `hooks/update-check` (new, `"async": true`) does the throttled fetch and writes a cache file. It
  writes no output and its result is never awaited.
- `hooks/session-start` (existing, sync) reads two local files — the last-seen marker and that
  cache — and folds a notice into the context it already emits. It makes no network call.

The consequence is deliberate and must be documented: a newly published version is reported one
session *after* the check that discovered it. That is the price of never blocking, and it is the
right trade for a notification.

**State lives beside Claude's own config**, at `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-teammates/`.
Not in the plugin directory: that path is replaced on every update, so a marker there would be
destroyed by the very event it exists to detect.

---

### Task 1: the async remote update check

**Files:**
- Create: `hooks/update-check`

**Model:** capable

- [ ] **Step 1:** Create `hooks/update-check` as a bash script with the same defensive preamble the
  existing hook uses, and make it executable (`chmod +x`). It must produce no stdout at all — it is
  wired `"async": true` and its output is not consumed.

```bash
#!/usr/bin/env bash
# Async SessionStart hook: checks whether a newer claude-teammates is published.
#
# Emits NOTHING. It writes a cache file that hooks/session-start reads on a later
# session. Keeping the network call out of the emitting hook is the whole point:
# session-start is declared "async": false and blocks, so a fetch there would add
# latency to every session and fail visibly offline.

set -uo pipefail
```

- [ ] **Step 2:** Resolve the state directory and exit silently when the check is disabled. Do this
  before anything else so an opted-out user's machine never touches the network:

```bash
STATE_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/claude-teammates"
CACHE="${STATE_DIR}/update-check.json"
THROTTLE_SECONDS=86400
RAW_URL="https://raw.githubusercontent.com/andreymudri/claude-teammates/master/.claude-plugin/plugin.json"

# Opt-out is checked first: a disabled install makes no request at all.
case "${CLAUDE_TEAMMATES_UPDATE_CHECK:-1}" in
  0|false|no|off) exit 0 ;;
esac
```

- [ ] **Step 3:** Throttle on the cache file's age. `stat` differs between GNU and BSD, so try both
  and treat an unreadable mtime as "stale" rather than failing:

```bash
now=$(date +%s 2>/dev/null) || exit 0
if [ -f "${CACHE}" ]; then
  mtime=$(stat -c %Y "${CACHE}" 2>/dev/null || stat -f %m "${CACHE}" 2>/dev/null || echo 0)
  if [ "${mtime}" -gt 0 ] 2>/dev/null && [ $((now - mtime)) -lt "${THROTTLE_SECONDS}" ]; then
    exit 0
  fi
fi
```

- [ ] **Step 4:** Fetch with a hard timeout, and give up silently on any failure. A user offline, on
  a captive portal, or behind a proxy must see nothing:

```bash
command -v curl >/dev/null 2>&1 || exit 0
body=$(curl -fsS --max-time 5 "${RAW_URL}" 2>/dev/null) || exit 0
[ -n "${body}" ] || exit 0
```

- [ ] **Step 5:** Extract the published version with a grep/sed pair rather than a JSON parser —
  bash has none, and the field is a flat string. Reject anything that is not a plain
  dot-and-digit version so a redirect to an HTML error page cannot write junk into the cache:

```bash
published=$(printf '%s' "${body}" \
  | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -n 1 \
  | sed 's/.*"\([^"]*\)"$/\1/')
case "${published}" in
  ''|*[!0-9.]*) exit 0 ;;
esac
```

- [ ] **Step 6:** Write the cache atomically — a session-start hook may read it concurrently, and a
  half-written file must never be observable. Touch the file even when nothing is new, so the
  throttle covers unsuccessful-but-completed checks too:

```bash
mkdir -p "${STATE_DIR}" 2>/dev/null || exit 0
tmp="${CACHE}.$$"
printf '{"published":"%s","checkedAt":%s}\n' "${published}" "${now}" > "${tmp}" 2>/dev/null || exit 0
mv -f "${tmp}" "${CACHE}" 2>/dev/null || rm -f "${tmp}" 2>/dev/null
exit 0
```

- [ ] **Step 7:** Confirm the script ends with an unconditional `exit 0` on every path, and that no
  branch writes to stdout or stderr. Run it directly with a bogus `RAW_URL` and with
  `CLAUDE_TEAMMATES_UPDATE_CHECK=0` and confirm both produce no output and exit 0.

---

### Task 2: the local version-change notice

**Files:**
- Modify: `hooks/session-start`

**Model:** capable

This task adds a purely local notice to the existing hook. It makes no network call and reads only
two files. The hook's existing contract — always exit 0, emit exactly one context field, fail
loudly but never fatally — is preserved exactly.

- [ ] **Step 1:** After `PLUGIN_ROOT` is resolved and before the context is built, add a function
  that reads the installed version out of the plugin manifest. A missing or unreadable manifest
  yields an empty string and disables the whole notice:

```bash
STATE_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/claude-teammates"
SEEN_FILE="${STATE_DIR}/last-seen-version"
CACHE_FILE="${STATE_DIR}/update-check.json"

read_json_string() {
    # $1 = file, $2 = key. Flat string fields only; bash has no JSON parser and
    # these two files are written by this plugin, not by a user.
    [ -r "$1" ] || return 1
    grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$1" 2>/dev/null \
      | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/'
}

installed=$(read_json_string "${PLUGIN_ROOT}/.claude-plugin/plugin.json" version || true)
```

- [ ] **Step 2:** Build the notice. Two independent cases, both optional, neither fatal:

```bash
notice=""

# Case 1: the installed version changed since this machine last saw it.
if [ -n "${installed}" ]; then
    seen=""
    [ -r "${SEEN_FILE}" ] && seen=$(head -n 1 "${SEEN_FILE}" 2>/dev/null)
    if [ "${seen}" != "${installed}" ]; then
        if [ -n "${seen}" ]; then
            notice="claude-teammates updated: ${seen} -> ${installed}"
        else
            notice="claude-teammates ${installed} is active"
        fi
        notice="${notice}"$'\n'"Release notes: https://github.com/andreymudri/claude-teammates/releases/tag/v${installed}"
        mkdir -p "${STATE_DIR}" 2>/dev/null && printf '%s\n' "${installed}" > "${SEEN_FILE}" 2>/dev/null
    fi
fi

# Case 2: the async check found a newer published version. Reported one session
# after the check that discovered it — the check never blocks this hook.
published=$(read_json_string "${CACHE_FILE}" published || true)
if [ -n "${published}" ] && [ -n "${installed}" ] && [ "${published}" != "${installed}" ]; then
    newest=$(printf '%s\n%s\n' "${installed}" "${published}" | sort -V 2>/dev/null | tail -n 1)
    if [ "${newest}" = "${published}" ]; then
        [ -n "${notice}" ] && notice="${notice}"$'\n'
        notice="${notice}claude-teammates ${published} is available (installed: ${installed}). Run /plugin update claude-teammates"
    fi
fi
```

  `sort -V` is what keeps `0.10.0` from being reported as older than `0.9.0`. Where `sort -V` is
  unavailable it returns non-zero and `newest` is empty, so the comparison fails closed and no
  notice is emitted — silence is the correct failure mode here.

- [ ] **Step 3:** Fold the notice into the context that already gets emitted, without disturbing the
  existing entrypoint injection or the warning branch. Append rather than replace, so a session
  that both carries a notice and fails to read the entrypoint still reports both:

```bash
if [ -n "${notice}" ]; then
    session_context="${session_context}\n\n$(escape_for_json "${notice}")"
fi
```

  Place this after the existing `if [ -r "${ENTRYPOINT}" ] … else … fi` block and before the
  platform-specific `printf` that emits the JSON.

- [ ] **Step 4:** Verify the hook still ends with an unconditional `exit 0`, still emits exactly one
  of the three context fields, and that its output remains valid JSON when a notice is present —
  the notice goes through `escape_for_json` like everything else, and a version string cannot
  contain a quote or newline, but the assertion is what proves it.

---

### Task 3: wire the async hook and test both paths

**Files:**
- Modify: `hooks/hooks.json`
- Test: `tests/hook.test.mjs`

**Depends:** T1, T2

**Model:** mid

- [ ] **Step 1:** Add a second `SessionStart` entry to `hooks/hooks.json` for the update check. It
  carries the same matcher as the existing hook and `"async": true`, so it never blocks:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start",
            "shell": "bash",
            "async": false
          },
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" update-check",
            "shell": "bash",
            "async": true
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2:** Add tests to `tests/hook.test.mjs` for the notice, reusing the existing `runHook`
  helper shape but pointing `CLAUDE_CONFIG_DIR` at a fresh `mkdtemp` directory per test so no test
  reads or writes the developer's real `~/.claude`:
  - with no `last-seen-version` file, the emitted context contains the installed version and the
    release-notes URL, and the marker file is created containing that version;
  - running the hook a second time against the same state directory emits **no** notice — the
    once-only property is the whole feature;
  - with a marker holding an older version, the context reads `updated: <old> -> <installed>`;
  - with a cache file whose `published` is higher, the context contains `is available` and
    `/plugin update`;
  - with a cache file whose `published` is **lower** than installed, no availability notice appears
    (this is the `sort -V` direction check, and it is the one a naive string compare gets wrong);
  - in every case the output still parses as JSON and carries exactly one context field.

- [ ] **Step 3:** Add tests for `hooks/update-check` that never touch the network. Invoke it with
  `CLAUDE_TEAMMATES_UPDATE_CHECK=0` and assert it exits 0, writes nothing to stdout, and creates no
  cache file. Then invoke it with a fresh `CLAUDE_CONFIG_DIR` and a `PATH` containing no `curl`
  (prepend an empty temp dir and clear the rest) and assert the same — exit 0, no output, no crash.

- [ ] **Step 4:** Add a test asserting `hooks/hooks.json` declares exactly two `SessionStart`
  commands, that the `session-start` one is `"async": false` and the `update-check` one is
  `"async": true`. That ordering and asyncness is the property that keeps the network off the
  blocking path, and it is invisible in any behavioural test.

- [ ] **Step 5:** Run the full suite and confirm it is green. Note that `tests/hook.test.mjs` fails
  under a PowerShell wrapper on Windows with `status: 127` because the invoked bash mangles the
  worktree path; it is green under Git Bash. That is pre-existing and unrelated — do not attempt to
  fix it, and do not let it mask a real failure you introduce.

---

### Task 4: document the notice and disclose the network call

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`

**Depends:** T1, T2

**Model:** mid

- [ ] **Step 1:** Add a short README section, after Install, covering: that the plugin reports its
  own version once when it changes; that a background check reports a newer published version one
  session after discovering it; where the state lives
  (`${CLAUDE_CONFIG_DIR:-~/.claude}/claude-teammates/`); and how to turn the network check off:

```
    CLAUDE_TEAMMATES_UPDATE_CHECK=0
```

- [ ] **Step 2:** In that section, state plainly what the check does on the network: a single
  `GET` to `raw.githubusercontent.com` for the published `plugin.json`, at most once every 24
  hours, with a 5-second timeout, sending no data about the user or their project. An operator
  deciding whether to disable it needs the specifics, not a reassurance.

- [ ] **Step 3:** In `SECURITY.md`, add an entry recording that the plugin makes one outbound
  request, what it fetches, how often, what it sends (nothing beyond the request itself), and how
  to disable it. This repository treats a false documented guarantee as a security issue, so the
  description must match `hooks/update-check` exactly — read the script and describe what it does,
  not what this plan says it should do.

- [ ] **Step 4:** Note in `SECURITY.md` that the cache file at
  `${CLAUDE_CONFIG_DIR:-~/.claude}/claude-teammates/update-check.json` is written by the plugin and
  read by the session-start hook, that its only effect is a printed string, and that a hostile value
  there cannot reach a gate verdict — it is not read by `gate`, `complete` or `fix`. The version
  string is filtered to digits and dots on write, so it cannot carry markup into the context.
