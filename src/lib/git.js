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

export function pushBranch(branch, cwd) {
  return tryRun('git', ['push', '-u', 'origin', branch], { cwd });
}

export function fetchBase(base, cwd) {
  return tryRun('git', ['fetch', 'origin', base], { cwd });
}
