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
    // A downstream caller's `if (!(err instanceof GitError)) throw err` (Task 3's check
    // wrappers) must not see a plain Error here — spawn failure (git missing from PATH,
    // cwd absent) has to read as a gate FAIL with a message, not an uncaught crash.
    child.on('error', (err) => reject(new GitError(err.message)))
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

  const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

  return {
    async changedFiles({ base, branch }) {
      // base/branch build the rev range by string interpolation below, so an empty or
      // non-string value silently becomes "HEAD" (git's default side of "..."): base: ''
      // yields "...branch" = "HEAD...branch", branch: '' yields "base..." = "base...HEAD".
      // Both produce an exit-0 answer against the wrong ref instead of failing — never the
      // caller's job to have checked first.
      if (!isNonEmptyString(base) || !isNonEmptyString(branch)) {
        throw new GitError(`changedFiles requires non-empty base and branch strings, got base=${JSON.stringify(base)} branch=${JSON.stringify(branch)}`)
      }
      // Three dots: diff against the merge base, so commits that landed on the run
      // branch while the teammate worked are not attributed to the teammate.
      // core.quotePath=false plus -z: paths come back NUL-delimited and unquoted, so a
      // non-ASCII path round-trips intact and a leading/trailing space in a filename is
      // never mistaken for line-trimming whitespace.
      // --no-renames: without it git reports only the post-image of a rename, hiding the
      // deletion of a pre-image path that may belong to a different task's declared set.
      // --end-of-options stops a base/branch beginning with "-" from reaching option
      // position; the trailing -- stops git from reinterpreting the rev range as a
      // pathspec when no such rev exists but a same-named file does. Without both, an
      // untracked file named exactly like the rev string makes the diff resolve to a
      // pathspec and report a silent, empty "no changes" instead of failing.
      const out = await run([
        '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z',
        '--end-of-options', `${base}...${branch}`, '--',
      ])
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
