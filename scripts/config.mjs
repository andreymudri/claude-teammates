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

// Enforcement keys are hand-edited by design, so `config set` never validates them and the
// operator's only feedback is `config list`. Shape is checked here so that feedback exists;
// content is not, because a lens name or a check's `run` string is policy, not structure.
const ENFORCEMENT_VALIDATORS = {
  lens: (v) => {
    if (!Array.isArray(v) || v.length === 0 || v.some((l) => typeof l !== 'string' || l === '')) {
      throw new ConfigError('lens must be a non-empty array of strings')
    }
    return v
  },
  phases: (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new ConfigError('phases must be an object keyed by phase name')
    }
    for (const [name, phase] of Object.entries(v)) {
      if (phase === null || typeof phase !== 'object' || Array.isArray(phase)) {
        throw new ConfigError(`phases.${name} must be an object`)
      }
      if (phase.checks !== undefined && !Array.isArray(phase.checks)) {
        throw new ConfigError(`phases.${name}.checks must be an array`)
      }
      if (phase.fixRounds !== undefined
        && (!Number.isInteger(phase.fixRounds) || phase.fixRounds < 0)) {
        throw new ConfigError(`phases.${name}.fixRounds must be an integer >= 0`)
      }
    }
    return v
  },
  preview: (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new ConfigError('preview must be an object')
    }
    if (v.link !== undefined
      && (!Array.isArray(v.link) || v.link.some((e) => typeof e !== 'string' || e === ''))) {
      throw new ConfigError('preview.link must be an array of non-empty strings')
    }
    return v
  },
}

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
  }
  return local
}

// The gate file is tracked and reviewable, so a bad value here is an operator typo rather than an
// attack. It is validated anyway, and for the same reason validateLocal is: a key that silently
// resolves to a default is a key the operator believes is set. Enforcement keys are permitted
// here — this is the file they belong in — and their shape is checked too, because they are
// hand-edited: `config set` refuses them by name, so this is the only layer that can say no.
export function validateGate(gate) {
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) {
    throw new ConfigError(`${GATE_FILE} must contain a JSON object`)
  }
  if (gate.maxParallel !== undefined) VALIDATORS.maxParallel(gate.maxParallel)
  if (gate.caveman !== undefined) VALIDATORS.caveman(gate.caveman)
  if (gate.agents !== undefined) {
    if (gate.agents === null || typeof gate.agents !== 'object' || Array.isArray(gate.agents)) {
      throw new ConfigError('agents must be an object keyed by role')
    }
    for (const [role, entry] of Object.entries(gate.agents)) {
      if (!ROLES.includes(role)) throw new ConfigError(`unknown agent role: ${role}`)
      // Note the deliberate difference from validateLocal: `agents.reviewer` is permitted here.
      // The reviewer's tier and effort are enforcement keys, and this is the file enforcement
      // keys live in. Rejecting the role in this layer would leave no way to configure it at all.
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ConfigError(`agents.${role} must be an object`)
      }
      for (const field of Object.keys(entry)) {
        if (field !== 'tier' && field !== 'effort') {
          throw new ConfigError(`unknown key in ${GATE_FILE}: agents.${role}.${field}`)
        }
      }
      if (entry.tier !== undefined) VALIDATORS.tier(entry.tier)
      if (entry.effort !== undefined) VALIDATORS.effort(entry.effort)
    }
  }
  // Every entry in ENFORCEMENT_KEYS has a validator, so this lookup cannot come back undefined.
  // If a future key joins that list without one, this throws a TypeError rather than silently
  // waving the new key through unchecked — which is the failure direction to prefer.
  for (const key of ENFORCEMENT_KEYS) {
    if (gate[key] !== undefined) ENFORCEMENT_VALIDATORS[key](gate[key])
  }
  return gate
}

// A layer file whose whole body is `null` parses to the same value this returns for a missing
// file. Callers that must tell the two apart pass their own `missing` sentinel; the default
// stays `null` so "absent" reads naturally everywhere else.
export async function readLayer(root, file, { missing = null } = {}) {
  try {
    return JSON.parse(await readFile(path.join(root, file), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return missing
    if (err instanceof SyntaxError) throw new ConfigError(`${file} is not valid JSON: ${err.message}`)
    throw err
  }
}

const MISSING = Symbol('missing layer')

export async function loadConfig(root) {
  // Only an absent file skips validation, in either layer. A present file holding `false`, `0`,
  // `""` or `null` is a malformed layer, and guarding on truthiness would silently ignore it
  // instead of saying so. An absent gate file still resolves to defaults with no error — that is
  // the ordinary case for a project with no manifest, which `gate` reports on its own terms.
  const gateRaw = await readLayer(root, GATE_FILE, { missing: MISSING })
  const gate = gateRaw === MISSING ? {} : validateGate(gateRaw)
  const raw = await readLayer(root, LOCAL_FILE, { missing: MISSING })
  const local = raw === MISSING ? null : validateLocal(raw)

  const sources = {}
  const pick = (key, fallback) => {
    if (local && local[key] !== undefined) { sources[key] = LOCAL_FILE; return local[key] }
    if (gate[key] !== undefined) { sources[key] = GATE_FILE; return gate[key] }
    sources[key] = 'default'
    return fallback
  }

  // Provenance is per field, not per role: a gate-file tier alongside a local-file effort has two
  // different sources, and a local `{"agents":{"reviewer":{}}}` names no field at all.
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

// `config get <key>` hands this a raw user key, so it needs the same boundary as its siblings:
// without it `config get constructor` prints the Object function instead of raising.
export function getKey(obj, dotted) {
  assertSafeKey(dotted)
  return dotted.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj)
}

// Every descent below tests own-ness, never mere reachability: an inherited branch belongs to
// some other object, and writing through it mutates that object while leaving this one empty.
export function setKey(obj, dotted, value) {
  assertSafeKey(dotted)
  const parts = dotted.split('.')
  const last = parts.pop()
  let cursor = obj
  for (const part of parts) {
    const next = Object.hasOwn(cursor, part) ? cursor[part] : undefined
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {}
    }
    cursor = cursor[part]
  }
  cursor[last] = value
  return obj
}

export function unsetKey(obj, dotted) {
  assertSafeKey(dotted)
  const parts = dotted.split('.')
  const last = parts.pop()
  let cursor = obj
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) return obj
    const next = cursor[part]
    if (next === null || typeof next !== 'object') return obj
    cursor = next
  }
  if (!Object.hasOwn(cursor, last)) return obj
  delete cursor[last]
  return obj
}

export function validateKey(dotted, value) {
  assertSafeKey(dotted)
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
  const parts = String(dotted).split('.')
  if (parts.some((part) => ENFORCEMENT_KEYS.includes(part))) return true
  // The reviewer judges `agent`-kind checks, so its tier and effort decide how good the judge
  // is. That makes them enforcement, not ergonomics, however much they look like the other two
  // roles: a teammate that could set them from the gitignored layer would be choosing the
  // reviewer that grades its own diff, leaving no fileset or ownership evidence behind.
  // Anchored on the role, not the field: `agents.reviewer` with no field names the same
  // enforcement surface, and a caller that only tested the two field paths would wave it through.
  return /^agents\.reviewer(\..*)?$/.test(dotted)
}

export async function writeLayer(root, file, obj) {
  await writeFile(path.join(root, file), `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
}

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
