import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isEntryPoint } from '../scripts/cli.mjs'

test('package.json requires a Node version with import.meta.main', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.engines?.node, '>=24.2.0')
})

test('isEntryPoint trusts import.meta.main when it is defined', () => {
  assert.equal(isEntryPoint(true, '/anything', '/else'), true)
  assert.equal(isEntryPoint(false, '/same', '/same'), false)
})

test('isEntryPoint falls back to comparing argv[1] against the module URL when import.meta.main is undefined', () => {
  assert.equal(isEntryPoint(undefined, '/repo/scripts/cli.mjs', '/repo/scripts/cli.mjs'), true)
  assert.equal(isEntryPoint(undefined, '/repo/scripts/cli.mjs', '/repo/scripts/other.mjs'), false)
})
