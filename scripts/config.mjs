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

export async function readLayer(root, file) {
  try {
    return JSON.parse(await readFile(path.join(root, file), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err instanceof SyntaxError) throw new ConfigError(`${file} is not valid JSON: ${err.message}`)
    throw err
  }
}

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

export function getKey(obj, dotted) {
  return dotted.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj)
}

export function setKey(obj, dotted, value) {
  assertSafeKey(dotted)
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
  return /^agents\.reviewer\.(tier|effort)$/.test(dotted)
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
