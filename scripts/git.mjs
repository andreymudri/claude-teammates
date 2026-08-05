import { spawn } from 'node:child_process'

export class GitError extends Error {}

// argv array, shell: false. Branch names reach git as a single argv entry, so a name
// containing shell metacharacters is data, never a command.
export function defaultGitExec(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

export function createGit({ cwd = process.cwd(), exec = defaultGitExec } = {}) {
  const runRaw = (args) => exec(args, cwd)

  const run = async (args) => {
    const { code, stdout, stderr } = await runRaw(args)
    if (code !== 0) throw new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`)
    return stdout
  }

  return {
    async changedFiles({ base, branch }) {
      // Three dots: diff against the merge base, so commits that landed on the run
      // branch while the teammate worked are not attributed to the teammate.
      // core.quotePath=false plus -z: paths come back NUL-delimited and unquoted, so a
      // non-ASCII path round-trips intact and a leading/trailing space in a filename is
      // never mistaken for line-trimming whitespace.
      const out = await run(['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', `${base}...${branch}`])
      return out.split('\0').filter(Boolean)
    },
    async headSha() {
      return (await run(['rev-parse', 'HEAD'])).trim()
    },
    async currentBranch() {
      return (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    },
    async isDirty() {
      return (await run(['status', '--porcelain'])).trim() !== ''
    },
    async branchExists(name) {
      const args = ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]
      const { code, stderr } = await runRaw(args)
      if (code === 0) return true
      // Exit 1 is git's answer for "no such ref" — a real absence, not a failure.
      // Any other non-zero (e.g. 128 outside a repository) is a failure carrying stderr.
      if (code === 1) return false
      throw new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`)
    },
  }
}
