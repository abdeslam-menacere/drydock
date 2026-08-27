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

export function isDirty(cwd) {
  return tryRun('git', ['status', '--porcelain'], { cwd }).out.length > 0;
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

export function pushBranch(branch, cwd) {
  return tryRun('git', ['push', '-u', 'origin', branch], { cwd });
}

export function fetchBase(base, cwd) {
  return tryRun('git', ['fetch', 'origin', base], { cwd });
}
