# Plugin configuration

Implements `docs/specs/2026-08-07-plugin-configuration-design.md`.

## Global Constraints

- Node >= 24.2.0
- Zero new runtime dependencies
- ESM only, `.mjs` for scripts, no TypeScript
- Commit messages: single-line, commitlint style, English
- Concrete model names never appear in this repository or in `teammates.gate.json` — tiers only
- Every new module gets a `tests/<name>.test.mjs` run by `npm test`
- No `console.log` in `scripts/` — output goes through the `io.out` seam that `cli.mjs` already uses

---

### Task 1: config resolution module

**Files:**
- Create: `scripts/config.mjs`
- Test: `tests/config.test.mjs`

**Model:** capable

- [ ] **Step 1:** Create `scripts/config.mjs` with the vocabulary constants and file names:

```js
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defaultMaxParallel } from './gate-config.mjs'
import { TIERS } from './routing.mjs'

export const GATE_FILE = 'teammates.gate.json'
export const LOCAL_FILE = 'teammates.local.json'

export const CAVEMAN_LEVELS = ['lite', 'full', 'ultra']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const ROLES = ['implementer', 'reviewer', 'integrator']

// Keys that decide a verdict. They may appear only in the tracked manifest: the local file
// is gitignored, so anything it can change, a teammate can change without leaving the dirty
// worktree that `fileset` and `ownership` detect. See SECURITY.md — the gate is
// tamper-EVIDENT, and an untracked override surface is exactly what removes the evidence.
export const ENFORCEMENT_KEYS = ['phases', 'lens', 'preview']

export class ConfigError extends Error {}
```

- [ ] **Step 2:** Add the per-key validators. Each returns the coerced value or throws
  `ConfigError` naming the key and its permitted values, so a bad value never reaches a
  dispatch as a silent `undefined`:

```js
const VALIDATORS = {
  maxParallel: (v) => {
    if (!Number.isInteger(v) || v < 1) throw new ConfigError('maxParallel must be an integer >= 1')
    return v
  },
  caveman: (v) => {
    if (v === false) return v
    if (!CAVEMAN_LEVELS.includes(v)) {
      throw new ConfigError(`caveman must be false or one of ${CAVEMAN_LEVELS.join(', ')}`)
    }
    return v
  },
  tier: (v) => {
    if (!TIERS.includes(v)) throw new ConfigError(`tier must be one of ${TIERS.join(', ')}`)
    return v
  },
  effort: (v) => {
    if (!EFFORTS.includes(v)) throw new ConfigError(`effort must be one of ${EFFORTS.join(', ')}`)
    return v
  },
}
```

- [ ] **Step 3:** Add `validateLocal(local)`. It rejects an enforcement key by name and rejects
  an unknown key by name. Silence is not an option here: an operator who sets a key that is
  quietly dropped believes a setting took effect when it did not, and for an enforcement key
  that is the precise failure the two-file split exists to prevent.

```js
export function validateLocal(local) {
  if (local === null || typeof local !== 'object' || Array.isArray(local)) {
    throw new ConfigError(`${LOCAL_FILE} must contain a JSON object`)
  }
  for (const key of Object.keys(local)) {
    if (ENFORCEMENT_KEYS.includes(key)) {
      throw new ConfigError(
        `${key} is an enforcement key; it may only be set in ${GATE_FILE}`,
      )
    }
    if (!['maxParallel', 'caveman', 'agents'].includes(key)) {
      throw new ConfigError(`unknown key in ${LOCAL_FILE}: ${key}`)
    }
  }
  if (local.maxParallel !== undefined) VALIDATORS.maxParallel(local.maxParallel)
  if (local.caveman !== undefined) VALIDATORS.caveman(local.caveman)
  if (local.agents !== undefined) {
    if (local.agents === null || typeof local.agents !== 'object' || Array.isArray(local.agents)) {
      throw new ConfigError('agents must be an object keyed by role')
    }
    for (const [role, entry] of Object.entries(local.agents)) {
      if (!ROLES.includes(role)) throw new ConfigError(`unknown agent role: ${role}`)
      if (entry?.tier !== undefined) VALIDATORS.tier(entry.tier)
      if (entry?.effort !== undefined) VALIDATORS.effort(entry.effort)
    }
  }
  return local
}
```

- [ ] **Step 4:** Add `readLayer(root, file)` returning `null` on `ENOENT` and rethrowing every
  other error, matching how `loadGateConfig` already treats a missing manifest:

```js
export async function readLayer(root, file) {
  try {
    return JSON.parse(await readFile(path.join(root, file), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err instanceof SyntaxError) throw new ConfigError(`${file} is not valid JSON: ${err.message}`)
    throw err
  }
}
```

- [ ] **Step 5:** Add `loadConfig(root)`. It returns the merged view plus the provenance of every
  ergonomics key, so `config list` can print which layer won rather than a bare value:

```js
export async function loadConfig(root) {
  const gate = (await readLayer(root, GATE_FILE)) ?? {}
  const local = await readLayer(root, LOCAL_FILE)
  if (local) validateLocal(local)

  const sources = {}
  const pick = (key, fallback) => {
    if (local && local[key] !== undefined) { sources[key] = LOCAL_FILE; return local[key] }
    if (gate[key] !== undefined) { sources[key] = GATE_FILE; return gate[key] }
    sources[key] = 'default'
    return fallback
  }

  const agents = {}
  for (const role of ROLES) {
    const merged = { ...(gate.agents?.[role] ?? {}), ...(local?.agents?.[role] ?? {}) }
    if (local?.agents?.[role]) sources[`agents.${role}`] = LOCAL_FILE
    else if (gate.agents?.[role]) sources[`agents.${role}`] = GATE_FILE
    else sources[`agents.${role}`] = 'default'
    agents[role] = merged
  }

  return {
    gate,
    resolved: {
      maxParallel: pick('maxParallel', defaultMaxParallel()),
      caveman: pick('caveman', false),
      agents,
    },
    sources,
  }
}
```

- [ ] **Step 6:** Add dotted-path accessors. `config set agents.reviewer.tier capable` needs both:

```js
export function getKey(obj, dotted) {
  return dotted.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj)
}

export function setKey(obj, dotted, value) {
  const parts = dotted.split('.')
  const last = parts.pop()
  let cursor = obj
  for (const part of parts) {
    if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      cursor[part] = {}
    }
    cursor = cursor[part]
  }
  cursor[last] = value
  return obj
}

export function unsetKey(obj, dotted) {
  const parts = dotted.split('.')
  const last = parts.pop()
  let cursor = obj
  for (const part of parts) {
    if (cursor?.[part] === undefined) return obj
    cursor = cursor[part]
  }
  delete cursor[last]
  return obj
}
```

- [ ] **Step 7:** Add `validateKey(dotted, value)` that routes a dotted path to its validator and
  throws `ConfigError` for a path with no validator, so `config set` rejects a typo rather than
  writing a key nothing will ever read:

```js
export function validateKey(dotted, value) {
  if (dotted === 'maxParallel') return VALIDATORS.maxParallel(value)
  if (dotted === 'caveman') return VALIDATORS.caveman(value)
  const agentMatch = /^agents\.([a-z]+)\.(tier|effort)$/.exec(dotted)
  if (agentMatch) {
    const [, role, field] = agentMatch
    if (!ROLES.includes(role)) throw new ConfigError(`unknown agent role: ${role}`)
    return VALIDATORS[field](value)
  }
  throw new ConfigError(`unknown config key: ${dotted}`)
}

export function isEnforcementKey(dotted) {
  return ENFORCEMENT_KEYS.includes(dotted.split('.')[0])
}
```

- [ ] **Step 8:** Add `writeLayer(root, file, obj)` writing pretty JSON with a trailing newline,
  matching how `state.mjs` serializes.

```js
export async function writeLayer(root, file, obj) {
  await writeFile(path.join(root, file), `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
}
```

- [ ] **Step 9:** Add `ensureGitignored(root, entry)`. It returns `true` when it appended the
  entry and `false` when it was already covered. Without this, `teammates.local.json` is
  committed on the first write and the trust split silently inverts — the gitignored ergonomics
  layer becomes a tracked file whose contents a reviewer now has to police.

```js
export async function ensureGitignored(root, entry) {
  const file = path.join(root, '.gitignore')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  if (lines.includes(entry)) return false
  const prefix = text === '' || text.endsWith('\n') ? '' : '\n'
  await writeFile(file, `${text}${prefix}${entry}\n`, 'utf8')
  return true
}
```

- [ ] **Step 10:** Create `tests/config.test.mjs` covering: local beats gate for `maxParallel`;
  gate beats default; `sources` names the winning layer; an enforcement key in the local file
  throws naming that key; an unknown local key throws naming it; every `VALIDATORS` domain
  rejects an out-of-domain value and accepts an in-domain one; `getKey`/`setKey`/`unsetKey` on
  `agents.reviewer.tier`; `validateKey` rejects `agents.nobody.tier` and `nonsense`;
  `ensureGitignored` appends once, returns `false` on a second call, and handles a file with no
  trailing newline and a missing `.gitignore`.

---

### Task 2: project-level default reviewer lens

**Files:**
- Modify: `scripts/gate-config.mjs`
- Test: `tests/gate-config.test.mjs`

**Model:** mid

- [ ] **Step 1:** In `scripts/gate-config.mjs`, add the fallback lens constant next to the other
  module constants:

```js
const DEFAULT_LENS = ['correctness', 'security', 'tests']
```

- [ ] **Step 2:** Change `checksForPhase` so a check of kind `agent` with no `lens` of its own
  inherits the manifest's top-level `lens`, falling back to `DEFAULT_LENS`. Checks are returned
  as new objects so the caller cannot mutate the loaded manifest:

```js
export function checksForPhase(config, phaseName) {
  const phases = config?.phases ?? {}
  const checks = phases[phaseName]?.checks ?? phases.default?.checks ?? []
  const fallback = Array.isArray(config?.lens) && config.lens.length ? config.lens : DEFAULT_LENS
  return checks.map((check) => (
    check?.kind === 'agent' && !Array.isArray(check.lens)
      ? { ...check, lens: fallback }
      : check
  ))
}
```

- [ ] **Step 3:** In `inferGateConfig`, hoist the lens out of the inferred review check and emit
  it as the top-level `lens` instead, so a generated manifest demonstrates the new key rather
  than the per-check duplication it replaces. The review check keeps `blockOn` and loses `lens`:

```js
  checks.push({
    name: 'review',
    kind: 'agent',
    agent: 'tm-reviewer',
    blockOn: ['high'],
  })

  const config = {
    maxParallel: defaultMaxParallel(),
    lens: DEFAULT_LENS,
    phases: { default: { fixRounds: DEFAULT_FIX_ROUNDS, checks } },
  }
```

- [ ] **Step 4:** Add tests to `tests/gate-config.test.mjs`: an `agent` check with its own `lens`
  keeps it untouched; an `agent` check without one receives the manifest's top-level `lens`; with
  neither, it receives `DEFAULT_LENS`; a `command` check is returned unchanged and is the same
  object identity, proving no needless copying; an empty top-level `lens` array falls through to
  `DEFAULT_LENS` rather than dispatching zero reviewers.

---

### Task 3: caveman digest renderer

**Files:**
- Modify: `scripts/digest.mjs`
- Test: `tests/digest.test.mjs`

- [ ] **Step 1:** In `scripts/digest.mjs`, give `renderDigest` a third parameter `caveman` that
  defaults to `false`, so every existing two-argument call site keeps its current output byte for
  byte:

```js
export function renderDigest(status, now, caveman = false) {
```

- [ ] **Step 2:** Add a terse `describe` variant used when `caveman` is truthy. It keeps the
  information and drops the connective characters:

```js
function describeTerse(task, now) {
  if (task.state === 'running') {
    if (typeof task.startedAt !== 'number') return `${task.title}?`
    return `${task.title}${Math.floor((now - task.startedAt) / 60_000)}m`
  }
  if (task.state === 'blocked') return `${task.title}<${task.blockedBy}`
  return task.title
}
```

- [ ] **Step 3:** In `renderDigest`, select the describer and the header/footer forms from
  `caveman`. The unknown-state group is still emitted in both modes — a task missing from the
  digest is a task nobody chases, and that property must not depend on a formatting flag:

```js
  const say = caveman ? describeTerse : describe
  const lines = [caveman
    ? `${runId} p${phase}/${totalPhases} n${tasks.length}`
    : `run ${runId} · phase ${phase}/${totalPhases} · ${tasks.length} tasks`]
```

  and for each group body use `say`, with the label column unpadded when `caveman`:

```js
    lines.push(caveman
      ? `${label} ${group.length} ${body}`
      : `${label.padEnd(9)} ${String(group.length).padStart(1)}  ${body}`)
```

  and the footer:

```js
  lines.push(caveman ? `idle ${idle}` : `idle slots ${idle}`)
```

  where `idle` is the existing `Math.max(0, maxParallel - running)` extracted to a local.

- [ ] **Step 4:** Add tests to `tests/digest.test.mjs`: with `caveman` omitted the output is
  identical to the current expected strings; with `caveman: 'full'` the header, a running task, a
  blocked task and the footer take the terse forms; a task in an unrecognised state still appears
  under `unknown` in caveman mode; a running task with no `startedAt` renders `?` and never `NaN`.

---

### Task 4: caveman briefs and effort in the generated workflow

**Files:**
- Modify: `templates/phase-workflow.js`
- Modify: `scripts/workflow-gen.mjs`
- Test: `tests/workflow-gen.test.mjs`

**Model:** capable

- [ ] **Step 1:** In `templates/phase-workflow.js`, add two markers below the existing ones:

```js
const CAVEMAN = __CAVEMAN__
const EFFORT = __EFFORT__
```

  and update the header comment to name them alongside `PLAN_PATH` / `BASE_BRANCH` / `CONSTRAINTS`.

- [ ] **Step 2:** In the same file, keep the existing `brief` exactly as it is and add a terse
  variant beside it. The compressed variant reuses `checkoutSteps(t)` verbatim and compresses
  only the connective prose. The MANDATORY FIRST STEP block, the literal `git checkout -B` and
  `git log --oneline -1` lines, the BASELINE numbered steps, the FILES list, the sentence that
  touching another file fails the gate, and the global constraints all survive unchanged — a
  brief is the task specification, and compressing a specification drops the wording the gate
  then enforces:

```js
const briefTerse = (t) => [
  'You are tm-implementer. Task ' + t.id + ': ' + t.title + '.',
  '',
  ...checkoutSteps(t),
  '',
  'BASELINE. Before writing anything, in order:',
  '1. Install the project\'s dependencies as the project requires.',
  '2. Copy over any untracked config the project needs (for example .env).',
  '3. Run the project\'s test command once and confirm it is green.',
  'Fresh worktree has none of that. Missing dep looks exactly like RED test; gate cannot tell',
  'them apart. Report status "blocked" only if baseline cannot be made green.',
  '',
  PLAN_PATH ? 'PLAN. Read ' + PLAN_PATH + ' and implement the section titled "Task '
    + t.id.replace(/^T/, '') + ':" — every numbered step, in order. The plan is the spec.' : '',
  '',
  'FILES. You may create or modify ONLY these files: ' + t.files.join(', ') + '.',
  'Touching any other file fails the phase gate.',
  '',
  CONSTRAINTS.length ? 'GLOBAL CONSTRAINTS:' : '',
  ...CONSTRAINTS.map((c) => '- ' + c),
  '',
  'STYLE. Write summary and blockers caveman-terse: drop articles and filler, keep every',
  'technical term, file path and error string exact. If skill caveman:caveman is available,',
  'use it at level ' + CAVEMAN + '. If not available, apply the style directly — its absence',
  'is not a blocker.',
  '',
  'Commit your work on ' + t.branch + ' and return the structured result.',
].filter((line) => line !== '').join('\n')
```

- [ ] **Step 3:** In the same file, select the brief and spread `effort` into the dispatch:

```js
const compose = CAVEMAN ? briefTerse : brief

const results = await parallel(TASKS.map((t) => () =>
  agent(
    compose(t),
    {
      label: t.id,
      phase: 'Implement',
      schema: RESULT_SCHEMA,
      isolation: 'worktree',
      agentType: 'claude-teammates:tm-implementer',
      ...(t.model ? { model: t.model } : {}),
      ...(EFFORT ? { effort: EFFORT } : {}),
    },
  ).then((r) => (r === null ? null : { taskId: t.id, ...r }))
))
```

- [ ] **Step 4:** In `scripts/workflow-gen.mjs`, extend the marker regex to cover both new
  markers. It must stay a single alternation consumed by one global pass — a chain of
  per-marker replacements would rescan inserted text and turn a caller-supplied string into a
  substitution site:

```js
const MARKER = /__(?:META|TASKS|PLAN_PATH|BASE_BRANCH|CONSTRAINTS|CAVEMAN|EFFORT)__/g
```

- [ ] **Step 5:** In the same file, accept the two new options and emit them through the existing
  `jsLiteral` escaping, so a value that reaches the template is quoted the same way every other
  caller-supplied string is:

```js
export async function generatePhaseWorkflow({
  runId, phase, tasks, maxParallel, tierModels,
  planPath = '', baseBranch = '', constraints = [], caveman = false, effort = '',
}) {
```

  and in `substitutions`:

```js
    __CAVEMAN__: () => (caveman ? jsLiteral(caveman) : 'false'),
    __EFFORT__: () => jsLiteral(effort),
```

- [ ] **Step 6:** Add tests to `tests/workflow-gen.test.mjs`. With `caveman` omitted, the
  generated source contains the current full brief and `const CAVEMAN = false`. With
  `caveman: 'full'`, assert each of these substrings is still present verbatim in the output:
  `MANDATORY FIRST STEP`, `git checkout -B `, `git log --oneline -1`, `Report status "blocked"`,
  `FILES. You may create or modify ONLY these files:`, `Touching any other file fails the phase
  gate.`, and `GLOBAL CONSTRAINTS:` when constraints are supplied. Also assert `effort` is
  absent from the dispatch options when not supplied and present when it is, and that a
  `caveman` value containing a quote is escaped rather than breaking the generated source.

---

### Task 5: CLI wiring and the config subcommand

**Files:**
- Modify: `scripts/cli.mjs`
- Test: `tests/cli.test.mjs`

**Depends:** T1, T2, T3, T4, T8

The dependency on T8 is on a symbol, not a convention: Step 1 imports `assertSafeKey` and Step 7
calls it, and T8 is what creates it. Run in parallel with T8 the import would resolve against a
`scripts/config.mjs` that has no such export, and every test in the file would fail for a reason
that has nothing to do with this task.

- [ ] **Step 1:** Import the new module in `scripts/cli.mjs`:

```js
import {
  loadConfig, readLayer, writeLayer, validateKey, isEnforcementKey, assertSafeKey,
  getKey, setKey, unsetKey, ensureGitignored, ConfigError,
  GATE_FILE, LOCAL_FILE, ROLES,
} from './config.mjs'
```

- [ ] **Step 2:** Extend `USAGE` with the four config forms:

```
  config   list [--root <path>]
  config   get <key> [--root <path>]
  config   set <key> <value> [--root <path>] [--local]
  config   unset <key> [--root <path>] [--local]
```

  and add `config` to the pipe-separated command list on the first line.

- [ ] **Step 3:** Replace both `config?.maxParallel ?? defaultMaxParallel()` expressions — at the
  `init-run` status write and at the `workflow` dispatch — with the resolved value from
  `loadConfig(root)`, so the gitignored local layer actually takes effect at the two places
  `maxParallel` is consumed.

- [ ] **Step 4:** In the `workflow` command, pass the resolved caveman level and implementer
  effort into `generatePhaseWorkflow`:

```js
    const { resolved } = await loadConfig(root)
    // ...
    const src = await generatePhaseWorkflow({
      runId,
      phase,
      tasks: plan.tasks.filter((t) => t.phase === phase),
      maxParallel: resolved.maxParallel,
      tierModels,
      planPath,
      baseBranch,
      constraints: parseConstraints(planMarkdown),
      caveman: resolved.caveman,
      effort: resolved.agents.implementer.effort ?? '',
    })
```

- [ ] **Step 5:** In the `workflow` command, apply a configured implementer tier over the tier
  each task carries, before `tierModels` is consulted. A configured role tier is an explicit
  operator decision and outranks `inferTier`'s guess; per-task `**Model:**` in the plan stays
  authoritative over both, because it names a specific task the operator already reasoned about:

```js
    const roleTier = resolved.agents.implementer.tier
    const phaseTasks = plan.tasks
      .filter((t) => t.phase === phase)
      .map((t) => (roleTier && t.tierSource === 'inferred' ? { ...t, tier: roleTier } : t))
```

  and pass `phaseTasks` as `tasks`.

- [ ] **Step 6:** In the `digest` command, pass the resolved caveman level as the third argument
  to `renderDigest`.

- [ ] **Step 7:** Add the `config` command handler before the final unknown-command fallthrough.
  It reads the subcommand and key from `positional`, targets the layer from `--local`, and maps
  every `ConfigError` to exit 2 with the message on stdout — a skill branches on this exit code,
  so a validation failure must never surface as a stack trace:

```js
  if (command === 'config') {
    const [, sub, key, rawValue] = positional
    const local = flags.local !== undefined
    const file = local ? LOCAL_FILE : GATE_FILE
    try {
      if (sub === 'list') {
        const { resolved, sources } = await loadConfig(root)
        io.out(`maxParallel  ${resolved.maxParallel}  (${sources.maxParallel})`)
        io.out(`caveman      ${resolved.caveman}  (${sources.caveman})`)
        for (const role of ROLES) {
          const entry = resolved.agents[role]
          // Provenance is per FIELD, not per role: a role whose tier comes from the tracked
          // manifest and whose effort comes from the local file must not report one layer for
          // both. T8 keys `sources` as `agents.<role>.<field>` for exactly this reason.
          io.out(`agents.${role}.tier    ${entry.tier ?? '-'}  (${sources[`agents.${role}.tier`]})`)
          io.out(`agents.${role}.effort  ${entry.effort ?? '-'}  (${sources[`agents.${role}.effort`]})`)
        }
        return 0
      }
      if (sub === 'get') {
        if (!key) { io.out('config get needs a key'); return 2 }
        const { resolved } = await loadConfig(root)
        const value = getKey(resolved, key)
        if (value === undefined) { io.out(`unset: ${key}`); return 2 }
        io.out(String(value))
        return 0
      }
      if (sub === 'set' || sub === 'unset') {
        if (!key) { io.out(`config ${sub} needs a key`); return 2 }
        // assertSafeKey runs for BOTH set and unset, and before anything reads or writes a
        // layer. `unset` reaches the same `setKey`-family walk as `set`, so a key guarded on
        // only one of the two leaves the other as a live path to Object.prototype.
        assertSafeKey(key)
        if (local && isEnforcementKey(key)) {
          io.out(`${key} is an enforcement key; it may only be set in ${GATE_FILE}`)
          return 2
        }
        const layer = (await readLayer(root, file)) ?? {}
        if (sub === 'set') {
          if (rawValue === undefined) { io.out('config set needs a value'); return 2 }
          let parsed
          // JSON first so numbers and `false` arrive as themselves; a bare word that is not
          // valid JSON is the string the caller typed, so `set agents.reviewer.tier capable`
          // works without shell quoting.
          try { parsed = JSON.parse(rawValue) } catch { parsed = rawValue }
          setKey(layer, key, validateKey(key, parsed))
        } else {
          unsetKey(layer, key)
        }
        await writeLayer(root, file, layer)
        io.out(`wrote ${file}`)
        if (local && await ensureGitignored(root, LOCAL_FILE)) {
          io.out(`added ${LOCAL_FILE} to .gitignore`)
        }
        return 0
      }
      io.out('usage: config <list|get|set|unset>')
      return 2
    } catch (err) {
      if (err instanceof ConfigError) { io.out(err.message); return 2 }
      throw err
    }
  }
```

- [ ] **Step 8:** Add `config: []` to the `REQUIRED` map so the command is explicitly recorded as
  taking no required flags, rather than relying on the `?? []` fallthrough.

- [ ] **Step 9:** Add tests to `tests/cli.test.mjs`: `config list` prints all six rows with a
  source column; `config set maxParallel 12 --local` writes `teammates.local.json`, appends it to
  `.gitignore`, and reports both; a second `set` does not append a duplicate `.gitignore` line;
  `config set fixRounds 99 --local` exits 2 naming `fixRounds` as an enforcement key and writes
  nothing; `config set agents.reviewer.tier nonsense --local` exits 2 listing the valid tiers;
  `config set agents.reviewer.tier capable --local` then `config get agents.reviewer.tier` prints
  `capable`; `config get` on an unset key exits 2; `config bogus` exits 2 with the usage line;
  `workflow` with `caveman: 'full'` in the local layer emits a workflow whose brief still
  contains `MANDATORY FIRST STEP`; and a corrupt `teammates.local.json` exits 2 with a message
  rather than a `SyntaxError` stack.

---

### Task 6: config skill and per-role dispatch in the prose skills

**Files:**
- Create: `skills/teammates-config/SKILL.md`
- Modify: `skills/phase-gate/SKILL.md`
- Modify: `skills/parallel-execution/SKILL.md`
- Test: `tests/skills.test.mjs`

**Depends:** T5

- [ ] **Step 1:** Add `'config'` to the `known` subcommand list in `tests/skills.test.mjs`. That
  list is a hardcoded allowlist, and the test asserts every `cli.mjs <word>` occurrence in every
  skill body appears in it — without this, the new skill fails the suite on its own first line.

- [ ] **Step 2:** Create `skills/teammates-config/SKILL.md`. Frontmatter must satisfy
  `tests/skills.test.mjs`: `name` equal to the folder name, and a `description` beginning with
  the words `Use when`.

```markdown
---
name: teammates-config
description: Use when changing how the fleet runs — parallelism, model tier or effort per role, caveman output, or the project's default reviewer lens.
---
```

- [ ] **Step 3:** In the body, state the two-file split before anything else, because it is the
  rule the rest of the skill enforces: `teammates.gate.json` is tracked and holds enforcement
  policy; `teammates.local.json` is gitignored and holds ergonomics; an enforcement key never
  goes in the local file, and the CLI rejects the attempt.

- [ ] **Step 4:** In the body, document the read step as a single call, always with both roots:

```
node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" config list --root <project root>
```

- [ ] **Step 5:** In the body, instruct the skill to collect the key and the value with
  `AskUserQuestion` — one question for the key, one for the value, with the permitted values as
  the options — and then write through:

```
node "$CLAUDE_PLUGIN_ROOT/scripts/cli.mjs" config set <key> <value> --root <project root> --local
```

- [ ] **Step 6:** In the body, add the rule that this skill never edits `teammates.gate.json` or
  `teammates.local.json` directly with Write or Edit. Every write goes through `config set`, so
  validation has one implementation and the interactive path cannot produce a file the CLI
  would reject.

- [ ] **Step 7:** In `skills/phase-gate/SKILL.md`, where the `agent` check dispatch is described,
  add that each `tm-reviewer` dispatch carries the configured reviewer tier and effort, read from
  `config get agents.reviewer.tier` and `config get agents.reviewer.effort`, and that an unset
  value means the dispatch omits the option and inherits the session's. State in the same place
  that these two come from the tracked manifest only — the reviewer grades the diff, so allowing
  the gitignored layer to choose its tier would let the party being judged pick its own judge.

- [ ] **Step 8:** In `skills/parallel-execution/SKILL.md`, add the same two sentences for the
  `tm-integrator` dispatch, reading `agents.integrator.tier` and `agents.integrator.effort`.
  Without this the config would claim to set an integrator tier that nothing ever reads.

---

### Task 7: documentation, gitignore, and the adversarial test

**Files:**
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `NOTICE.md`
- Modify: `.gitignore`
- Test: `tests/adversarial.test.mjs`

**Depends:** T5

- [ ] **Step 1:** Add `teammates.local.json` to `.gitignore`, directly below the `.teammates/`
  entry, with a comment saying it holds machine-local ergonomics and must never be committed.

- [ ] **Step 2:** In `README.md`, add a Configuration section covering both files, the key table
  from the spec with each key's domain and default, and the four `config` subcommands with a
  worked `config set maxParallel 12 --local` example.

- [ ] **Step 3:** In `README.md`, note in that section that model names live in the dispatching
  skill's tier map and never in either config file, so a reader does not try to set one.

- [ ] **Step 4:** In `SECURITY.md`, under the "known and documented" list, add an entry recording
  that `teammates.local.json` is gitignored and therefore agent-writable, and that this buys
  nothing: it carries only `maxParallel`, `caveman`, and tier/effort for the **implementer and
  integrator**. Say explicitly that `agents.reviewer.tier` and `agents.reviewer.effort` are
  enforcement keys rejected in that file by name, because the reviewer produces the verdict for
  `agent`-kind checks. A report that "the local config can be edited" now has a written answer,
  and the one genuinely dangerous key is named rather than left for a reader to notice.

- [ ] **Step 5:** In `NOTICE.md`, list `teammates-config` among the original skills, matching how
  `writing-plans` and `using-teammates` are listed.

- [ ] **Step 6:** Add a test to `tests/adversarial.test.mjs`: with a passing manifest committed,
  write a `teammates.local.json` declaring `phases.default.checks` as an empty array plus a
  `fixRounds` of `99`, run the gate, and assert the verdict is unchanged from the run without
  that file — the local layer supplies no checks.

- [ ] **Step 7:** Add a second test to `tests/adversarial.test.mjs`: the same hostile
  `teammates.local.json` makes `config list` exit 2 naming `phases` as an enforcement key, so the
  file is rejected loudly rather than ignored quietly. A silently-ignored override is the failure
  mode that would let an operator believe the gate was reconfigured when it was not.

- [ ] **Step 8:** Add a third test to `tests/adversarial.test.mjs`: a `teammates.local.json`
  declaring `agents.reviewer.tier` is rejected by name. The reviewer judges `agent`-kind checks,
  so a local-layer reviewer tier would let the party being judged downgrade its own judge from a
  file that leaves no `fileset` or `ownership` evidence.

---

### Task 8: harden the config layer against prototype pollution and verdict-affecting keys

**Files:**
- Modify: `scripts/config.mjs`
- Test: `tests/config.test.mjs`

**Depends:** T1

**Model:** capable

Phase 1 review found four defects in the code Task 1 was given, all confirmed by running the
committed module. Task 1 implemented that code faithfully; the defects are in the specification,
not the implementation. Fix them before `cli.mjs` exposes any of it to a user-supplied key.

- [ ] **Step 1:** Add the unsafe-segment vocabulary and guard to `scripts/config.mjs`. Verified
  on the committed branch: `setKey({}, '__proto__.polluted', 'PWNED')` writes zero own keys to
  the target and leaves `({}).polluted === 'PWNED'` process-wide, because `obj['__proto__']` is a
  plain object and the existing guard only replaces a segment that is null, non-object, or an
  array. `'constructor.prototype.x'` is blocked today only because `typeof Object === 'function'`
  happens to fail that same test — luck, not a guard.

```js
// A dotted key is caller-supplied. These three segments reach Object.prototype rather than the
// config object, so a write through them silently no-ops the file and pollutes every object in
// the process instead. Rejected by name at the boundary rather than defended against per walk.
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

export function assertSafeKey(dotted) {
  for (const segment of String(dotted).split('.')) {
    if (UNSAFE_SEGMENTS.has(segment)) {
      throw new ConfigError(`unsafe config key segment: ${segment}`)
    }
  }
  return dotted
}
```

- [ ] **Step 2:** Call `assertSafeKey` first in `setKey`, `unsetKey` and `validateKey`, so the
  guard holds no matter which entry point a caller reaches, and the exported helpers are safe on
  their own rather than relying on every caller to check first.

- [ ] **Step 3:** Make `isEnforcementKey` test **every** segment, not just the first. Verified:
  `isEnforcementKey('__proto__.phases')` returns `false` today, which is what turns the pollution
  from a crash into a policy bypass.

```js
export function isEnforcementKey(dotted) {
  const parts = String(dotted).split('.')
  if (parts.some((part) => ENFORCEMENT_KEYS.includes(part))) return true
  // The reviewer judges `agent`-kind checks, so its tier and effort decide how good the judge
  // is. That makes them enforcement, not ergonomics, however much they look like the other two
  // roles: a teammate that could set them from the gitignored layer would be choosing the
  // reviewer that grades its own diff, leaving no fileset or ownership evidence behind.
  return /^agents\.reviewer\.(tier|effort)$/.test(dotted)
}
```

- [ ] **Step 4:** Enumerate `agents.<role>` sub-keys in `validateLocal`. Verified: a local file
  containing `{"agents":{"reviewer":{"tier":"cheap","effort":"low","checks":[],"fixRounds":0}}}`
  is accepted today and every one of those keys survives into `resolved.agents.reviewer`, which
  contradicts the design's "allowlisted keys, and nothing else". Reject `reviewer` outright in
  the local layer, and reject any sub-key that is not `tier` or `effort`:

```js
    for (const [role, entry] of Object.entries(local.agents)) {
      if (!ROLES.includes(role)) throw new ConfigError(`unknown agent role: ${role}`)
      if (role === 'reviewer') {
        throw new ConfigError(
          `agents.reviewer is an enforcement key; it may only be set in ${GATE_FILE}`,
        )
      }
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ConfigError(`agents.${role} must be an object`)
      }
      for (const field of Object.keys(entry)) {
        if (field !== 'tier' && field !== 'effort') {
          throw new ConfigError(`unknown key in ${LOCAL_FILE}: agents.${role}.${field}`)
        }
      }
      if (entry.tier !== undefined) VALIDATORS.tier(entry.tier)
      if (entry.effort !== undefined) VALIDATORS.effort(entry.effort)
    }
```

- [ ] **Step 5:** Fix `unsetKey`'s null crash. The guard `cursor?.[part] === undefined` lets
  `null` through, so `unsetKey({preview: null}, 'preview.link')` reaches `delete null['link']`
  and throws a raw TypeError. `config unset` does not call `validateKey` and reads the layer raw,
  so a manifest with `"preview": null` produces a stack trace instead of a clean exit 2:

```js
export function unsetKey(obj, dotted) {
  assertSafeKey(dotted)
  const parts = dotted.split('.')
  const last = parts.pop()
  let cursor = obj
  for (const part of parts) {
    const next = cursor?.[part]
    if (next === null || typeof next !== 'object') return obj
    cursor = next
  }
  delete cursor[last]
  return obj
}
```

- [ ] **Step 6:** Record provenance per **field** rather than per role in `loadConfig`. Today a
  single `sources['agents.' + role]` covers both fields, so a gate-file `tier` plus a local-file
  `effort` reports the local file as the source of the tier as well — and a local
  `{"agents":{"reviewer":{}}}` is truthy, attributing every field to the local layer. The values
  are already correct; only the provenance the feature exists to display is wrong:

```js
  const agents = {}
  for (const role of ROLES) {
    const gateEntry = gate.agents?.[role] ?? {}
    const localEntry = local?.agents?.[role] ?? {}
    agents[role] = { ...gateEntry, ...localEntry }
    for (const field of ['tier', 'effort']) {
      if (localEntry[field] !== undefined) sources[`agents.${role}.${field}`] = LOCAL_FILE
      else if (gateEntry[field] !== undefined) sources[`agents.${role}.${field}`] = GATE_FILE
      else sources[`agents.${role}.${field}`] = 'default'
    }
  }
```

- [ ] **Step 7:** Add tests to `tests/config.test.mjs` for every fix above:
  `setKey({}, '__proto__.polluted', 'x')` throws and `({}).polluted` stays `undefined` afterwards;
  the same for `unsetKey` and `validateKey`, and for the `constructor` and `prototype` segments;
  `isEnforcementKey('__proto__.phases')` and `isEnforcementKey('agents.reviewer.tier')` are both
  `true`; `validateLocal` rejects `agents.reviewer` by name; `validateLocal` rejects
  `agents.implementer.checks` naming that path; `unsetKey({preview: null}, 'preview.link')`
  returns without throwing; and provenance is per field — with `tier` in the gate layer and
  `effort` in the local layer, `sources['agents.implementer.tier']` is the gate file while
  `sources['agents.implementer.effort']` is the local file.
