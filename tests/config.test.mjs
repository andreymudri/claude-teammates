import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultMaxParallel } from '../scripts/gate-config.mjs'
import { TIERS } from '../scripts/routing.mjs'
import {
  GATE_FILE,
  LOCAL_FILE,
  CAVEMAN_LEVELS,
  EFFORTS,
  ROLES,
  ENFORCEMENT_KEYS,
  ConfigError,
  validateLocal,
  readLayer,
  writeLayer,
  loadConfig,
  getKey,
  setKey,
  unsetKey,
  validateKey,
  isEnforcementKey,
  ensureGitignored,
} from '../scripts/config.mjs'

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'tm-config-'))
  try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

const writeJson = (root, file, obj) =>
  writeFile(path.join(root, file), JSON.stringify(obj), 'utf8')

test('vocabulary constants name the two layers and their domains', () => {
  assert.equal(GATE_FILE, 'teammates.gate.json')
  assert.equal(LOCAL_FILE, 'teammates.local.json')
  assert.deepEqual(CAVEMAN_LEVELS, ['lite', 'full', 'ultra'])
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(ROLES, ['implementer', 'reviewer', 'integrator'])
  assert.deepEqual(ENFORCEMENT_KEYS, ['phases', 'lens', 'preview'])
})

test('loadConfig lets the local layer beat the gate manifest for maxParallel', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { maxParallel: 4 })
    await writeJson(root, LOCAL_FILE, { maxParallel: 12 })
    const { resolved, sources } = await loadConfig(root)
    assert.equal(resolved.maxParallel, 12)
    assert.equal(sources.maxParallel, LOCAL_FILE)
  })
})

test('loadConfig lets the gate manifest beat the default for maxParallel', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { maxParallel: 4 })
    const { resolved, sources } = await loadConfig(root)
    assert.equal(resolved.maxParallel, 4)
    assert.equal(sources.maxParallel, GATE_FILE)
  })
})

test('loadConfig falls back to the computed default with neither layer present', async () => {
  await withTempRoot(async (root) => {
    const { resolved, sources } = await loadConfig(root)
    assert.equal(resolved.maxParallel, defaultMaxParallel())
    assert.equal(sources.maxParallel, 'default')
    assert.equal(resolved.caveman, false)
    assert.equal(sources.caveman, 'default')
  })
})

test('loadConfig exposes the raw gate manifest alongside the resolved view', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { maxParallel: 3, phases: { default: { checks: [] } } })
    const { gate } = await loadConfig(root)
    assert.deepEqual(gate.phases, { default: { checks: [] } })
  })
})

test('loadConfig merges agent entries per role and names the winning layer', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: { reviewer: { tier: 'mid', effort: 'low' } } })
    await writeJson(root, LOCAL_FILE, { agents: { reviewer: { tier: 'capable' } } })
    const { resolved, sources } = await loadConfig(root)
    assert.deepEqual(resolved.agents.reviewer, { tier: 'capable', effort: 'low' })
    assert.equal(sources['agents.reviewer'], LOCAL_FILE)
    assert.deepEqual(resolved.agents.integrator, {})
    assert.equal(sources['agents.integrator'], 'default')
  })
})

test('loadConfig reports the gate layer as the source of an agent entry it alone sets', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, GATE_FILE, { agents: { implementer: { effort: 'high' } } })
    const { resolved, sources } = await loadConfig(root)
    assert.deepEqual(resolved.agents.implementer, { effort: 'high' })
    assert.equal(sources['agents.implementer'], GATE_FILE)
  })
})

test('loadConfig rejects an enforcement key in the local layer by name', async () => {
  await withTempRoot(async (root) => {
    await writeJson(root, LOCAL_FILE, { phases: { default: { checks: [] } } })
    await assert.rejects(
      () => loadConfig(root),
      (err) => err instanceof ConfigError && /phases/.test(err.message)
        && err.message.includes(GATE_FILE),
    )
  })
})

test('loadConfig surfaces a corrupt local layer as a ConfigError, not a SyntaxError', async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, LOCAL_FILE), '{ not json', 'utf8')
    await assert.rejects(
      () => loadConfig(root),
      (err) => err instanceof ConfigError && err.message.includes(LOCAL_FILE),
    )
  })
})

test('validateLocal rejects every enforcement key by name', () => {
  for (const key of ENFORCEMENT_KEYS) {
    assert.throws(
      () => validateLocal({ [key]: {} }),
      (err) => err instanceof ConfigError && err.message.includes(key),
    )
  }
})

test('validateLocal rejects an unknown key by name rather than dropping it', () => {
  assert.throws(
    () => validateLocal({ fixRounds: 99 }),
    (err) => err instanceof ConfigError && err.message.includes('fixRounds'),
  )
})

test('validateLocal rejects a non-object local layer', () => {
  for (const bad of [null, [], 'text', 3]) {
    assert.throws(() => validateLocal(bad), ConfigError)
  }
})

test('validateLocal accepts a well-formed local layer unchanged', () => {
  const local = { maxParallel: 6, caveman: 'full', agents: { reviewer: { tier: 'mid' } } }
  assert.equal(validateLocal(local), local)
})

test('validateLocal rejects an unknown agent role and a bad agent field', () => {
  assert.throws(
    () => validateLocal({ agents: { nobody: { tier: 'mid' } } }),
    (err) => err instanceof ConfigError && err.message.includes('nobody'),
  )
  assert.throws(() => validateLocal({ agents: { reviewer: { tier: 'nonsense' } } }), ConfigError)
  assert.throws(() => validateLocal({ agents: { reviewer: { effort: 'nonsense' } } }), ConfigError)
  assert.throws(() => validateLocal({ agents: [] }), ConfigError)
})

test('maxParallel accepts an integer >= 1 and rejects everything else', () => {
  assert.equal(validateKey('maxParallel', 1), 1)
  assert.equal(validateKey('maxParallel', 12), 12)
  for (const bad of [0, -1, 1.5, '4', null, true]) {
    assert.throws(
      () => validateKey('maxParallel', bad),
      (err) => err instanceof ConfigError && err.message.includes('maxParallel'),
    )
  }
})

test('caveman accepts false and each level, and rejects anything else', () => {
  assert.equal(validateKey('caveman', false), false)
  for (const level of CAVEMAN_LEVELS) assert.equal(validateKey('caveman', level), level)
  for (const bad of [true, 'loud', '', null, 1]) {
    assert.throws(
      () => validateKey('caveman', bad),
      (err) => err instanceof ConfigError && err.message.includes('caveman'),
    )
  }
})

test('tier accepts each known tier and rejects an unknown one', () => {
  for (const tier of TIERS) assert.equal(validateKey('agents.reviewer.tier', tier), tier)
  assert.throws(
    () => validateKey('agents.reviewer.tier', 'nonsense'),
    (err) => err instanceof ConfigError && TIERS.every((t) => err.message.includes(t)),
  )
})

test('effort accepts each known effort and rejects an unknown one', () => {
  for (const effort of EFFORTS) assert.equal(validateKey('agents.implementer.effort', effort), effort)
  assert.throws(
    () => validateKey('agents.implementer.effort', 'turbo'),
    (err) => err instanceof ConfigError && EFFORTS.every((e) => err.message.includes(e)),
  )
})

test('validateKey rejects an unknown role and an unknown key', () => {
  assert.throws(
    () => validateKey('agents.nobody.tier', 'mid'),
    (err) => err instanceof ConfigError && err.message.includes('nobody'),
  )
  assert.throws(
    () => validateKey('nonsense', 1),
    (err) => err instanceof ConfigError && err.message.includes('nonsense'),
  )
})

test('isEnforcementKey matches an enforcement root, dotted or bare', () => {
  assert.equal(isEnforcementKey('phases'), true)
  assert.equal(isEnforcementKey('phases.default.fixRounds'), true)
  assert.equal(isEnforcementKey('lens'), true)
  assert.equal(isEnforcementKey('preview.branch'), true)
  assert.equal(isEnforcementKey('maxParallel'), false)
  assert.equal(isEnforcementKey('agents.reviewer.tier'), false)
})

test('getKey reads a dotted path and returns undefined for a missing branch', () => {
  const obj = { agents: { reviewer: { tier: 'capable' } } }
  assert.equal(getKey(obj, 'agents.reviewer.tier'), 'capable')
  assert.equal(getKey(obj, 'agents.integrator.tier'), undefined)
  assert.equal(getKey(obj, 'nothing.here.at.all'), undefined)
})

test('setKey creates the intermediate objects a dotted path needs', () => {
  const obj = {}
  setKey(obj, 'agents.reviewer.tier', 'capable')
  assert.deepEqual(obj, { agents: { reviewer: { tier: 'capable' } } })
  setKey(obj, 'agents.reviewer.effort', 'high')
  assert.deepEqual(obj.agents.reviewer, { tier: 'capable', effort: 'high' })
})

test('setKey replaces a non-object node standing where a branch must go', () => {
  const obj = { agents: 'oops' }
  setKey(obj, 'agents.reviewer.tier', 'mid')
  assert.deepEqual(obj, { agents: { reviewer: { tier: 'mid' } } })
})

test('unsetKey removes a leaf and leaves a missing path alone', () => {
  const obj = { agents: { reviewer: { tier: 'capable', effort: 'high' } } }
  unsetKey(obj, 'agents.reviewer.tier')
  assert.deepEqual(obj.agents.reviewer, { effort: 'high' })
  unsetKey(obj, 'agents.integrator.tier')
  assert.deepEqual(obj, { agents: { reviewer: { effort: 'high' } } })
})

test('readLayer returns null for a missing file and parses one that exists', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await readLayer(root, LOCAL_FILE), null)
    await writeJson(root, LOCAL_FILE, { maxParallel: 5 })
    assert.deepEqual(await readLayer(root, LOCAL_FILE), { maxParallel: 5 })
  })
})

test('readLayer turns invalid JSON into a ConfigError naming the file', async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, GATE_FILE), '{ oops', 'utf8')
    await assert.rejects(
      () => readLayer(root, GATE_FILE),
      (err) => err instanceof ConfigError && err.message.includes(GATE_FILE),
    )
  })
})

test('writeLayer writes pretty JSON with a trailing newline and round-trips', async () => {
  await withTempRoot(async (root) => {
    await writeLayer(root, LOCAL_FILE, { maxParallel: 12 })
    const text = await readFile(path.join(root, LOCAL_FILE), 'utf8')
    assert.equal(text, '{\n  "maxParallel": 12\n}\n')
    assert.deepEqual(await readLayer(root, LOCAL_FILE), { maxParallel: 12 })
  })
})

test('ensureGitignored creates a missing .gitignore and appends the entry once', async () => {
  await withTempRoot(async (root) => {
    assert.equal(await ensureGitignored(root, LOCAL_FILE), true)
    assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), `${LOCAL_FILE}\n`)
    assert.equal(await ensureGitignored(root, LOCAL_FILE), false)
    assert.equal(await readFile(path.join(root, '.gitignore'), 'utf8'), `${LOCAL_FILE}\n`)
  })
})

test('ensureGitignored appends after a file with no trailing newline', async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, '.gitignore'), 'node_modules', 'utf8')
    assert.equal(await ensureGitignored(root, LOCAL_FILE), true)
    assert.equal(
      await readFile(path.join(root, '.gitignore'), 'utf8'),
      `node_modules\n${LOCAL_FILE}\n`,
    )
  })
})

test('ensureGitignored recognises an existing entry with surrounding whitespace', async () => {
  await withTempRoot(async (root) => {
    await writeFile(path.join(root, '.gitignore'), `node_modules\r\n  ${LOCAL_FILE}  \r\n`, 'utf8')
    assert.equal(await ensureGitignored(root, LOCAL_FILE), false)
  })
})
