import { run, tryRun } from './sh.js';

export const headSha = (cwd) => run('git', ['rev-parse', 'HEAD'], { cwd });
export const currentBranch = (cwd) => run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });

/** The shared .git directory — the same path from a linked worktree or the main tree. */
export const commonDir = (cwd) =>
  run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });

export function branchExists(name, cwd) {
  return tryRun('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd }).ok;
}

export function addWorktree(dir, branch, base, cwd) {
  const args = branchExists(branch, cwd)
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, base];
  const r = tryRun('git', args, { cwd });
  if (!r.ok) throw new Error(r.err || 'git worktree add failed');
  return dir;
}

export function removeWorktree(dir, cwd, force = false) {
  const args = ['worktree', 'remove', dir];
  if (force) args.push('--force');
  return tryRun('git', args, { cwd });
}

export function deleteBranch(name, cwd, force = false) {
  return tryRun('git', ['branch', force ? '-D' : '-d', name], { cwd });
}

/** The patch itself, or null when it cannot be read. */
export function diffText(base, head, cwd, { unified = 3 } = {}) {
  const r = tryRun('git', ['diff', `--unified=${unified}`, `${base}...${head}`], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return r.ok ? r.out : null;
}

/**
 * Changed line ranges in the *new* file, keyed by path.
 *
 * `--unified=0` so a hunk header describes only lines that actually changed.
 * This is what makes "evidence must point at the diff" checkable: a claim about
 * line 900 of a file whose diff stops at line 40 is not evidence.
 */
export function diffRanges(base, head, cwd) {
  const r = tryRun('git', ['diff', '--unified=0', `${base}...${head}`], { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (!r.ok) return null;

  const out = {};
  let file = null;
  for (const line of r.out.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && !out[file]) out[file] = [];
      continue;
    }
    if (!file || !line.startsWith('@@')) continue;
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // A pure deletion has count 0 and points *between* lines; record the
    // insertion point so evidence about a removal still has somewhere to land.
    out[file].push(count === 0 ? [start, start] : [start, start + count - 1]);
  }
  return out;
}

export function isDirty(cwd) {
  // Drydock's own manifests live in the working tree. In a dock with its own
  // worktree they land in the main checkout and never show up here; in a
  // branch-mode dock they land right next to the developer's files. Either
  // way they are the tool's bookkeeping, not work anyone can lose, so they
  // must not be what makes a checkout look dirty.
  const args = ['status', '--porcelain', '--', ':(top)', ':(exclude,top).drydock/'];
  return tryRun('git', args, { cwd }).out.length > 0;
}

/** Full SHA for a ref, or null if it does not name a commit here. */
export function resolveCommit(ref, cwd) {
  const r = tryRun('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  return r.ok && r.out ? r.out.trim() : null;
}

/**
 * Files changed between `base` and `head`, as `{ status, path, from }`.
 *
 * `-z` because a path may contain spaces, quotes or newlines and the NUL
 * framing is the only output git guarantees is unambiguous. Returns null when
 * the diff cannot be read or cannot be parsed — callers must treat that as
 * "unknown", never as "nothing changed".
 */
export function diffFiles(base, head, cwd) {
  const r = tryRun('git', ['diff', '--name-status', '-z', '--find-renames', `${base}...${head}`], { cwd });
  if (!r.ok) return null;

  const parts = r.out.split('\0').filter((s) => s !== '');
  const files = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    // R and C carry two paths; everything else carries one.
    if (/^[RC]/i.test(status)) {
      const from = parts[i++];
      const to = parts[i++];
      if (from === undefined || to === undefined) return null;
      files.push({ status, path: to, from });
    } else {
      const p = parts[i++];
      if (p === undefined) return null;
      files.push({ status, path: p, from: null });
    }
  }
  return files;
}

/** Paths git reports as binary in this diff, or null if it cannot be read. */
export function diffBinaryPaths(base, head, cwd) {
  const r = tryRun('git', ['diff', '--numstat', '--find-renames', `${base}...${head}`], { cwd });
  if (!r.ok) return null;
  return r.out
    .split('\n')
    .filter((l) => l.startsWith('-\t-\t'))
    .map((l) => l.slice(4).trim())
    .filter(Boolean);
}

/**
 * Total lines added and deleted between `base` and `head`, or null if unreadable.
 *
 * Binary files report `-` for both counts and are skipped; a diff containing one
 * has already taken the maximum path by the time anybody asks for totals.
 */
export function diffStats(base, head, cwd) {
  const r = tryRun('git', ['diff', '--numstat', '--find-renames', `${base}...${head}`], { cwd });
  if (!r.ok) return null;

  let added = 0;
  let deleted = 0;
  for (const line of r.out.split('\n')) {
    if (!line.trim() || line.startsWith('-\t-\t')) continue;
    const [a, d] = line.split('\t');
    const na = Number(a);
    const nd = Number(d);
    if (!Number.isFinite(na) || !Number.isFinite(nd)) return null;
    added += na;
    deleted += nd;
  }
  return { added, deleted };
}

/** Contents of `path` at `ref`, or null when it cannot be read. */
export function showFile(ref, filePath, cwd) {
  const r = tryRun('git', ['show', `${ref}:${filePath}`], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return r.ok ? r.out : null;
}

/**
 * Does `path` exist at `ref`?
 *
 * `showFile` returning null is ambiguous — absent, or present and unreadable —
 * and routing has to tell those apart: "no CODEOWNERS" means nobody owns
 * anything, while "CODEOWNERS exists but we could not read it" must fail closed.
 * Collapsing the two makes the fail-closed branch unreachable and quietly
 * *shrinks* routes.
 */
export function pathExists(ref, filePath, cwd) {
  return tryRun('git', ['cat-file', '-e', `${ref}:${filePath}`], { cwd }).ok;
}

export function pushBranch(branch, cwd) {
  return tryRun('git', ['push', '-u', 'origin', branch], { cwd });
}

/** Check out `branch` here, creating it from `base` if it does not exist yet. */
export function switchToBranch(branch, base, cwd) {
  if (branchExists(branch, cwd)) return tryRun('git', ['switch', branch], { cwd });
  return tryRun('git', ['switch', '-c', branch, base], { cwd });
}

export function fetchBase(base, cwd) {
  return tryRun('git', ['fetch', 'origin', base], { cwd });
}
