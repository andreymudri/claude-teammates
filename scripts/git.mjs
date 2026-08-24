import { spawn } from 'node:child_process'

export class GitError extends Error {}

// Every ref-consuming command in this module passes --end-of-options, added to git in 2.24
// (November 2019). On an older git the option itself is unrecognised — but git's rejection
// text for an unrecognised long option is not one shape, and it depends on which command's
// argument parser rejects it. Confirmed against real git (the git installed here is >= 2.24
// and accepts --end-of-options itself, so it cannot be made to reject it directly) by
// substituting a different unrecognised long option for --end-of-options at each call site's
// exact argument position:
//
//   COVERED — `error: unknown option \`<name>'` on stderr, exit 129: merge-base (mergeBase,
//   isAncestor), fetch (fetchRefspec), worktree add/remove (addWorktreeDetached,
//   removeWorktree), merge (mergeInto), ls-tree (fileModeAtCommit).
//
//   COVERED — `fatal: unrecognized argument: <name>` on stderr, exit 128: log
//   (commitSubject), show (fileAtCommit).
//
//   NOT COVERED — diff (changedFiles) and rev-list (mergedBranchTips, commitsBetween,
//   commitParents) print only their usage wall on an unrecognised flag, with no line naming
//   the flag or saying "unknown" anything — confirmed nothing in that text to match on. A
//   phase gate running one of these on git < 2.24 gets a bare, unexplained usage dump; this
//   module cannot turn that into an explained failure without risking a match broad enough to
//   fire on an unrelated usage error, which is worse than no match at all.
//
//   NOT AT RISK — rev-parse --verify (qualifyBranch, branchSha, resolveRef) silently ignores
//   an unrecognised long option and still resolves the ref correctly: confirmed real git
//   `rev-parse --verify --quiet --bogus-flag refs/heads/master --` prints the sha, exit 0, as
//   if the flag were never there. --end-of-options is therefore a harmless no-op for these
//   calls on git < 2.24, not a failure this module needs to explain.
function isOldGitRejectingEndOfOptions(stderr) {
  return /unknown option `end-of-options'/.test(stderr) ||
    /unrecognized argument: --end-of-options/.test(stderr)
}

// Builds the message a failed git invocation raises as. Not a version probe — this only
// inspects the stderr of a call that already failed, so it costs nothing on the success path
// that dominates this module's use (once-per-call-that-errors, not once-per-call).
function describeGitFailure(args, code, stderr) {
  const trimmed = stderr.trim()
  if (isOldGitRejectingEndOfOptions(stderr)) {
    return `git ${args.join(' ')} failed: the installed git is too old to run this plugin — ` +
      `--end-of-options requires git >= 2.24, got: ${trimmed || `exit ${code}`}`
  }
  return `git ${args.join(' ')} failed: ${trimmed || `exit ${code}`}`
}

// Where the Claude Code harness creates agent worktrees, relative to the repo root.
const HARNESS_WORKTREES = /^\.claude\//

// Record separator for commitFileSets' `git log --name-only -z` stream. It has to be a token no
// tracked path can ever equal, because the paths and the separator arrive in the same NUL-framed
// stream with nothing else to tell them apart. A bare word cannot do it: with "commit" as the
// marker, a repository tracking a file literally named "commit" reported that one commit as two,
// dropped the path, and truncated the path that followed it (git prefixes the first path of each
// commit with "\n", so the next token got its first character eaten). A trailing slash makes the
// marker unforgeable by construction rather than by luck: a git tree entry name cannot contain
// "/" at all, so no path git ever reports ends with one. Exported so the tests assert against
// this exact token instead of restating it.
export const COMMIT_MARKER = 'commit/'

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
    if (code !== 0) throw new GitError(describeGitFailure(args, code, stderr))
    return stdout
  }

  const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

  // --end-of-options blocks flag injection but not NAMESPACE PRECEDENCE: git resolves a bare
  // name through refs/tags/ BEFORE refs/heads/, warns on stderr only, and exits 0. One
  // ordinary `git tag teammates/r1/T1 <fork-point>` inside a teammate's own worktree is
  // therefore enough to make `worktree add` check out, and `merge` merge, a commit that
  // carries none of the teammate's work — the gate then runs the suite against a tree missing
  // the code it is meant to be testing and records a pass. It also fires by accident wherever
  // a release tag and a branch share a name. Every name that reaches a ref-consuming git
  // command goes through here first: if a branch of that name exists, its sha wins outright.
  // Anything that is not a branch (a sha, HEAD, an already-qualified refs/… ref) is passed on
  // unchanged, so the qualification never narrows what a caller can ask for.
  const qualifyBranch = async (name, prefix = []) => {
    if (!isNonEmptyString(name)) {
      throw new GitError(`a branch name must be a non-empty string, got ${JSON.stringify(name)}`)
    }
    if (name.startsWith('refs/')) return name
    const { code, stdout } = await exec(
      [...prefix, 'rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${name}`, '--'],
      cwd,
    )
    // Exit 1 with no output is git's "no such branch"; only a resolved sha displaces the name.
    if (code === 0 && stdout.trim() !== '') return stdout.trim()
    return name
  }

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
    // `--porcelain` reports untracked paths, and the harness stores each teammate's worktree
    // under `.claude/` inside the repo. Those directories exist for the whole run, so counting
    // them would fail the ownership check at every phase of every fleet — in a repo that has
    // not happened to ignore that path. The plugin, not the project, chose that location, so
    // the exemption belongs here rather than in each adopting project's .gitignore.
    //
    // Only that one path is exempt. Every other untracked file still counts: a stray file in
    // the main worktree is exactly what this check exists to catch.
    async isDirty() {
      const lines = (await run(['-c', 'core.quotePath=false', 'status', '--porcelain']))
        .split('\n')
        .filter((line) => line.trim() !== '')
      return lines.some((line) => !HARNESS_WORKTREES.test(line.slice(3)))
    },
    // `--porcelain` here is the worktree listing's own stable format (one `key value` line per
    // attribute, entries separated by a blank line), unrelated to `status --porcelain`. Parsed
    // rather than regexed so a path containing a space — the normal case on Windows — stays one
    // field: only the FIRST space separates the key from its value.
    async worktrees() {
      const out = await run(['worktree', 'list', '--porcelain'])
      const entries = []
      let current = null
      for (const line of out.split(/\r?\n/)) {
        if (line.trim() === '') { if (current) { entries.push(current); current = null } continue }
        const sp = line.indexOf(' ')
        const key = sp === -1 ? line : line.slice(0, sp)
        const value = sp === -1 ? '' : line.slice(sp + 1)
        if (key === 'worktree') current = { path: value, head: null, branch: null, detached: false }
        else if (!current) continue
        else if (key === 'HEAD') current.head = value
        else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
        else if (key === 'detached') current.detached = true
      }
      // git omits the trailing blank line after the last entry when the output does not end in
      // one; without this the final worktree — often the only one — is dropped silently.
      if (current) entries.push(current)
      return entries
    },
    // The paths behind isDirty's boolean. Same `.claude/` exemption, for the same reason stated
    // there: the plugin chose that location, so an adopting project is not asked to ignore it.
    async dirtyPaths() {
      return (await run(['-c', 'core.quotePath=false', 'status', '--porcelain']))
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }))
        .filter((entry) => !HARNESS_WORKTREES.test(entry.path))
    },
    // Whether the index carries anything under a path. `--error-unmatch` turns "nothing
    // matched" into exit 1 rather than an empty success, so the two answers are distinguishable
    // without parsing stdout; `--` keeps a pathspec that looks like an option in pathspec
    // position.
    async tracks(pathspec) {
      if (!isNonEmptyString(pathspec)) {
        throw new GitError(`tracks requires a non-empty pathspec, got ${JSON.stringify(pathspec)}`)
      }
      const args = ['ls-files', '--error-unmatch', '-z', '--', pathspec]
      const { code, stderr } = await runRaw(args)
      if (code === 0) return true
      if (code === 1) return false
      throw new GitError(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`)
    },
    // Every tracked path, for the inventory half of the map. `-z` with core.quotePath=false so a
    // path containing a space, a quote or a non-ASCII character comes back as written rather than
    // as git's escaped display form.
    async listFiles() {
      const out = await run(['-c', 'core.quotePath=false', 'ls-files', '-z'])
      return out.split('\0').filter(Boolean)
    },
    // One entry per commit, each the list of paths that commit touched, newest first. The record
    // separator is an explicit marker rather than a blank line: a commit that touched no file at
    // all (an empty commit, a pure merge) would otherwise be indistinguishable from the gap
    // between two commits, and dropping it silently changes every support count derived from it.
    //
    // --no-renames for the same reason changedFiles uses it: with rename detection on, git reports
    // only the post-image, so the pre-image path looks untouched in the commit that removed it.
    //
    // Confirmed against real `git log -z --name-only --format=%x00commit%x00` output (see
    // scripts/git.mjs test fixtures): with -z, git NUL-delimits paths rather than joining them
    // with newlines. Splitting on '\0' therefore already yields one token per path, verbatim and
    // unquoted (core.quotePath=false), with two exceptions that are artifacts of git's own framing,
    // not part of any path: (1) every token between one commit's NUL-delimited path list and the
    // next '\0commit\0' marker is an empty string — a real path is never empty, so empty tokens are
    // always framing and are dropped; (2) git prepends a single literal '\n' before the FIRST path
    // of a commit's name-list only (a stand-in for the blank line that separates the commit header
    // from its file list when -z is not used) — subsequent paths in the same commit carry no such
    // prefix. Stripping exactly that one leading character from exactly the first path token — never
    // trimming, never splitting on interior newlines — is what lets a path with a leading or
    // trailing space, or an embedded newline, round-trip byte for byte, matching listFiles().
    async commitFileSets({ limit = 500 } = {}) {
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new GitError(`commitFileSets requires a positive integer limit, got ${JSON.stringify(limit)}`)
      }
      const out = await run([
        '-c', 'core.quotePath=false', 'log', `--max-count=${limit}`,
        '--no-renames', '--name-only', `--format=%x00${COMMIT_MARKER}%x00`, '-z', 'HEAD', '--',
      ])
      const sets = []
      let current = null
      let atFirstPath = false
      for (const token of out.split('\0')) {
        if (token === COMMIT_MARKER) { if (current) sets.push(current); current = []; atFirstPath = true; continue }
        if (current === null) continue
        if (token === '') continue
        // Only the first path of a commit carries git's synthetic leading "\n", and only when it
        // is really there: a path may itself begin with "\n", and stripping unconditionally would
        // corrupt it. Every later path in the commit is passed through untouched.
        current.push(atFirstPath && token.startsWith('\n') ? token.slice(1) : token)
        atFirstPath = false
      }
      if (current) sets.push(current)
      return sets
    },
    async commitSubject(ref) {
      if (!isNonEmptyString(ref)) {
        throw new GitError(`commitSubject requires a non-empty ref, got ${JSON.stringify(ref)}`)
      }
      return (await run(['log', '-n', '1', '--format=%h %s', '--end-of-options', ref, '--'])).trim()
    },
    // The paths a worktree's own ignore rules exclude, as git decides them rather than as a
    // hardcoded list guesses them. A wholly ignored directory comes back once with a trailing
    // slash instead of as its contents, which is what makes the result usable as a set of
    // prefixes to prune a filesystem walk at.
    //
    // `.git` is NOT in the result and cannot be: git does not report it as ignored, because it is
    // not ignored — it is simply not part of the working tree. A caller pruning a walk still has
    // to skip it by name.
    //
    // No `--end-of-options` and no trailing `--`, against this module's habit everywhere else,
    // and that is measured rather than assumed: `git status --porcelain --ignored -z
    // --end-of-options --` prints NOTHING and exits 0 on real git (2.53, checked directly). Adding
    // them for consistency would turn "every ignored path" into "no ignored path" silently, which
    // is the exact class of failure the flags exist to prevent elsewhere. There is also no
    // pathspec position to defend here: `dir` reaches git as the argument of `-C`, never as a
    // pathspec. `tests/git.test.mjs` pins the absence so a later sweep cannot re-add them quietly.
    async ignoredPaths(dir) {
      if (!isNonEmptyString(dir)) {
        throw new GitError(`ignoredPaths requires a non-empty dir, got ${JSON.stringify(dir)}`)
      }
      const out = await run(['-C', dir, '-c', 'core.quotePath=false', 'status', '--porcelain', '--ignored', '-z'])
      return out.split('\0').filter((entry) => entry.startsWith('!! ')).map((entry) => entry.slice(3))
    },
    // Committer date, in milliseconds, of a sha the caller already resolved. %ct rather than %at:
    // the author date survives a rebase and would report a teammate's work as older than the
    // commit that carries it.
    async commitTime(sha) {
      if (!isNonEmptyString(sha)) {
        throw new GitError(`commitTime requires a non-empty sha, got ${JSON.stringify(sha)}`)
      }
      const out = (await run(['log', '-n', '1', '--format=%ct', '--end-of-options', sha, '--'])).trim()
      const seconds = Number(out)
      // The empty string is checked separately because `Number('')` is `0`, which IS finite — so
      // a `%ct` that came back empty passed this guard and returned epoch 0, and `livenessRows`
      // then reported the tip as roughly fifty-six years old: a `stalled` row and a non-zero exit
      // for a teammate that is working normally. An absent date must fail loudly, not date the
      // commit to 1970.
      if (out === '' || !Number.isFinite(seconds)) {
        throw new GitError(`commitTime read a non-numeric committer date for ${sha}: ${JSON.stringify(out)}`)
      }
      return seconds * 1000
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
      throw new GitError(describeGitFailure(args, code, stderr))
    },
    // The set of shas the run branch merged IN as secondary parents, past the anchor — that is,
    // the tips of the branches this run's integrator actually carried onto the run branch.
    //
    // Ancestry cannot answer that question. "Is this sha reachable from the run branch" is true
    // of every commit the run branch has ever passed through, including the one a teammate's ref
    // was parked at when it was created. Being NAMED as a merge parent is a fact about the merge
    // that carried the branch, so a branch that was never merged cannot satisfy it by standing
    // still.
    //
    // --parents prints "<commit> <parent1> <parent2>..."; everything past the first parent is a
    // branch that merge carried in. The anchor..run range bounds the walk to this run rather
    // than the repository's whole history — the range form rather than "--not <anchor>", because
    // git rejects "--not" after a non-option argument ("fatal: option '--not' must come before
    // non-option arguments"), and the options have to precede --end-of-options. Trailing "--"
    // for the same reason commitsBetween carries one: a file named exactly like the range must
    // not be resolvable as a pathspec.
    //
    // The range bounds which MERGE COMMITS are walked. It does NOT filter the parents they
    // print, and that distinction is the whole reason this method filters them itself. This
    // plugin's plan-amendment procedure merges the BASE branch into the run branch, so the base
    // tip is printed as a secondary parent of a merge inside the range — and for a run whose
    // amendments have all landed, merge-base(base, run) IS that base tip. Left in, the anchor
    // would be a member of this set, and a task branch parked at the anchor (a teammate that
    // committed on another ref and left the conventional ref where `git checkout -B <task>
    // <base>` put it) would read as merged, suppressing the very emptiness complaint that shape
    // exists to trigger. The same route admits older base tips, via a task branch that merged
    // the base into itself.
    //
    // So a parent counts only if it is itself inside the range. Every parent of a commit on the
    // run branch is reachable from the run branch by construction, so "inside anchor..run" is
    // exactly "not reachable from the anchor" — the filter expressed as a bound rather than as
    // an isAncestor call per parent. Dropping --min-parents=2 is what makes it one walk instead
    // of two: the unfiltered walk prints every commit in the range, so the same output carries
    // both the range membership and the merge parents. Non-merge lines contribute no parents,
    // since everything past the first is empty for them.
    async mergedBranchTips({ runSha, anchorSha }) {
      if (!isNonEmptyString(runSha) || !isNonEmptyString(anchorSha)) {
        throw new GitError(`mergedBranchTips requires non-empty refs, got runSha=${JSON.stringify(runSha)} anchorSha=${JSON.stringify(anchorSha)}`)
      }
      const out = await run(['rev-list', '--parents', '--end-of-options', `${anchorSha}..${runSha}`, '--'])
      const inRange = new Set()
      const parents = []
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/).filter(Boolean)
        if (parts.length === 0) continue
        inRange.add(parts[0])
        for (const parent of parts.slice(2)) parents.push(parent)
      }
      return new Set(parents.filter((parent) => inRange.has(parent)))
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
    // The mode fileAtCommit deliberately drops. A chmod is a real change that carries no bytes,
    // so any caller comparing two commits by content alone concludes nothing touched the file —
    // which reads as "this file has no legitimate source" in the ownership check. Returns the
    // six-digit tree mode, or null when the path is absent at that commit (`ls-tree` exits 0
    // with empty output for a path it does not find, so absence is not a GitError here).
    async fileModeAtCommit(sha, filePath) {
      if (!isNonEmptyString(sha) || !isNonEmptyString(filePath)) {
        throw new GitError(`fileModeAtCommit requires a non-empty sha and path, got sha=${JSON.stringify(sha)} path=${JSON.stringify(filePath)}`)
      }
      const out = await run(['ls-tree', '--end-of-options', sha, '--', filePath])
      const match = /^(\d{6}) /.exec(out)
      return match ? match[1] : null
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
    async addWorktreeDetached(dir, ref) {
      if (!isNonEmptyString(dir) || !isNonEmptyString(ref)) {
        throw new GitError(`addWorktreeDetached requires non-empty dir and ref, got dir=${JSON.stringify(dir)} ref=${JSON.stringify(ref)}`)
      }
      await run(['worktree', 'add', '--detach', '--end-of-options', dir, await qualifyBranch(ref)])
      return dir
    },
    async removeWorktree(dir) {
      if (!isNonEmptyString(dir)) {
        throw new GitError(`removeWorktree requires a non-empty dir, got ${JSON.stringify(dir)}`)
      }
      await run(['worktree', 'remove', '--force', '--end-of-options', dir])
      return true
    },
    // Returns null when every branch merged, or the conflicted paths when one did not.
    // Throws a GitError when the merge FAILED rather than conflicted — the two are different
    // answers and the caller cannot act on them the same way.
    //
    // One merge per branch, in order. Handing git three or more heads at once selects the
    // octopus strategy, which RESETS the working tree and index before exiting (verified on
    // git 2.53.0: exit 2, "Merge with strategy octopus failed", and nothing left carrying U
    // status). Read after that reset, --diff-filter=U comes back empty — and an empty array is
    // truthy, so the caller took the conflict branch and reported a conflict naming no
    // branches and no paths. A phase with three or more task branches is the normal case, not
    // an edge one. Merging one at a time keeps every merge on the recursive/ort strategy,
    // which leaves the unmerged index entries in place, and matches the order tm-integrator
    // merges in — so the preview's shape stays the one the integrator will actually produce.
    //
    // `--no-ff` keeps each merge a real merge commit, as tm-integrator produces.
    async mergeInto(dir, branches) {
      if (!isNonEmptyString(dir)) {
        throw new GitError(`mergeInto requires a non-empty dir, got ${JSON.stringify(dir)}`)
      }
      if (!Array.isArray(branches) || branches.length === 0 || !branches.every(isNonEmptyString)) {
        throw new GitError(`mergeInto requires a non-empty array of branch names, got ${JSON.stringify(branches)}`)
      }
      for (const branch of branches) {
        const ref = await qualifyBranch(branch, ['-C', dir])
        const mergeArgs = ['-C', dir, 'merge', '--no-ff', '-m', 'gate merge preview', '--end-of-options', ref]
        const { code, stderr } = await exec(mergeArgs, cwd)
        if (code === 0) continue
        const out = await exec(['-C', dir, 'diff', '--name-only', '--diff-filter=U'], cwd)
        const conflicted = out.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        // A conflict is a merge that failed AND left unmerged paths. Everything else — an
        // unset user.email in CI, a branch deleted out from under the run, unrelated
        // histories, a stale index.lock, or (on git < 2.24) --end-of-options itself being
        // unrecognised — is a failure whose reason lives only in git's stderr. Returning []
        // for those would discard the reason and dress the failure up as a conflict that
        // names nothing. Routed through describeGitFailure rather than building the message
        // inline, so an old-git failure here reports the same 2.24 floor every other command
        // in this module does, instead of sending the operator hunting a merge problem that
        // is actually a version problem.
        if (conflicted.length > 0) return conflicted
        throw new GitError(describeGitFailure(mergeArgs, code, stderr))
      }
      return null
    },
  }
}

export function teammateRef(runId, taskId) {
  return `refs/teammates/${runId}/${taskId}`
}
