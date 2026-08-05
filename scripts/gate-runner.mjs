import { spawn } from 'node:child_process'

const TAIL_LINES = 40

export function defaultExec(cmd, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, shell: true })
    let output = ''
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

function tail(text, n) {
  const lines = text.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

export async function runCommandCheck(check, { cwd = process.cwd(), exec = defaultExec } = {}) {
  const { code, output } = await exec(check.run, cwd)
  const passed = code === 0
  return {
    name: check.name,
    kind: 'command',
    status: passed ? 'pass' : 'fail',
    exitCode: code,
    output: passed ? '' : tail(output, TAIL_LINES),
    optional: check.optional === true,
  }
}

export function describePendingCheck(check) {
  return {
    name: check.name,
    kind: check.kind,
    status: 'pending',
    optional: check.optional === true,
    check,
  }
}

export async function runChecks(checks, ctx = {}) {
  const results = []
  for (const check of checks) {
    results.push(check.kind === 'command'
      ? await runCommandCheck(check, ctx)
      : describePendingCheck(check))
  }
  return results
}

export function aggregateVerdict(results) {
  const failed = results.filter((r) => r.status === 'fail').map((r) => r.name)
  const skipped = results.filter((r) => r.status === 'skip').map((r) => r.name)
  const pending = results.filter((r) => r.status === 'pending' && !r.optional).map((r) => r.name)
  const passed = results.length > 0 && failed.length === 0 && pending.length === 0
  return { verdict: passed ? 'PASS' : 'FAIL', failed, skipped, pending }
}
