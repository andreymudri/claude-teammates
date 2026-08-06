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
    // merge-base (both plain and its --is-ancestor form) takes no pathspec and rejects a
    // trailing "--" outright — confirmed against real git ("fatal: Not a valid object name
    // --" / "fatal: --is-ancestor takes exactly two commits"). No "--" is added to either.
    async mergeBase(a, b) {
      if (!isNonEmptyString(a) || !isNonEmptyString(b)) {
        throw new GitError(`mergeBase requires non-empty refs, got a=${JSON.stringify(a)} b=${JSON.stringify(b)}`)
      }
      return (await run(['merge-base', '--end-of-options', a, b])).trim()
    },
    async isAncestor(ancestor, descendant) {
      if (!isNonEmptyString(ancestor) || !isNonEmptyString(descendant)) {
        throw new GitError(`isAncestor requires non-empty refs, got ancestor=${JSON.stringify(ancestor)} descendant=${JSON.stringify(descendant)}`)
      }
      const args = ['merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant]
      const { code, stderr } = await runRaw(args)
      if (code === 0) return true
      // Exit 1 is git's answer for "not an ancestor". Anything else (128 for a bad ref,
      // for instance) is a failure and must not read as a clean "no".
      if (code === 1) return false
      throw new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`)
    },
    async commitsBetween({ from, to }) {
      if (!isNonEmptyString(from) || !isNonEmptyString(to)) {
        throw new GitError(`commitsBetween requires non-empty refs, got from=${JSON.stringify(from)} to=${JSON.stringify(to)}`)
      }
      // rev-list accepts a trailing "--" (confirmed against real git), so a file or
      // directory named exactly like the "from..to" range cannot make this resolve as a
      // pathspec instead of a revision range.
      const out = await run(['rev-list', '--end-of-options', `${from}..${to}`, '--'])
      return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    },
    async commitParents(sha) {
      if (!isNonEmptyString(sha)) {
        throw new GitError(`commitParents requires a non-empty sha, got ${JSON.stringify(sha)}`)
      }
      const out = await run(['rev-list', '--parents', '-n', '1', '--end-of-options', sha, '--'])
      return out.trim().split(/\s+/).slice(1)
    },
    async branchSha(name) {
      if (!isNonEmptyString(name)) {
        throw new GitError(`branchSha requires a non-empty branch name, got ${JSON.stringify(name)}`)
      }
      return (await run(['rev-parse', '--verify', '--end-of-options', `refs/heads/${name}`, '--'])).trim()
    },
    async fileAtCommit(sha, filePath) {
      if (!isNonEmptyString(sha) || !isNonEmptyString(filePath)) {
        throw new GitError(`fileAtCommit requires a non-empty sha and path, got sha=${JSON.stringify(sha)} path=${JSON.stringify(filePath)}`)
      }
      return run(['show', '--end-of-options', `${sha}:${filePath}`, '--'])
    },
    // A bare name is resolved through refs/tags/ BEFORE refs/heads/, so a teammate that
    // creates a tag named like its branch makes every range command read a different
    // object while branchSha still reports the honest tip. Confirmed bypass. Callers
    // resolve names to shas through this, once, and pass only shas onward.
    async resolveRef(fullRef) {
      if (!isNonEmptyString(fullRef) || !fullRef.startsWith('refs/')) {
        throw new GitError(`resolveRef requires a fully-qualified ref, got ${JSON.stringify(fullRef)}`)
      }
      return (await run(['rev-parse', '--verify', '--end-of-options', fullRef, '--'])).trim()
    },
    async fetchRefspec({ from, src, dst }) {
      if (!isNonEmptyString(from) || !isNonEmptyString(src) || !isNonEmptyString(dst)) {
        throw new GitError(`fetchRefspec requires non-empty from/src/dst, got ${JSON.stringify({ from, src, dst })}`)
      }
      if (!src.startsWith('refs/') || !dst.startsWith('refs/')) {
        throw new GitError(`fetchRefspec requires fully-qualified refs, got src=${src} dst=${dst}`)
      }
      // --no-tags: without it a fetch drags the clone's tags into the project, reintroducing
      // the shadowing primitive the boundary exists to remove.
      await run(['fetch', '--no-tags', '--end-of-options', from, `+${src}:${dst}`])
      return (await run(['rev-parse', '--verify', '--end-of-options', dst, '--'])).trim()
    },
  }
}

export function teammateRef(runId, taskId) {
  return `refs/teammates/${runId}/${taskId}`
}
