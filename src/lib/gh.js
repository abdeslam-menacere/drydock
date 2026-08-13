import { tryRun, has } from './sh.js';

export const available = () => has('gh');

export function authOk() {
  return tryRun('gh', ['auth', 'status']).ok;
}

/** Fetch an issue as { number, title, body, labels }. Returns null on failure. */
export function getIssue(number, cwd) {
  const r = tryRun('gh', [
    'issue', 'view', String(number),
    '--json', 'number,title,body,labels,url',
  ], { cwd });
  if (!r.ok) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

export function createPr({ title, body, base, head }, cwd) {
  return tryRun('gh', [
    'pr', 'create',
    '--title', title,
    '--body', body,
    '--base', base,
    '--head', head,
  ], { cwd });
}

export function repoNameWithOwner(cwd) {
  const r = tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd });
  return r.ok ? r.out : null;
}

/** Run one read-only GitHub API request and return the raw command result. */
export function api(endpoint, cwd) {
  return tryRun('gh', ['api', endpoint], { cwd });
}

/** Does the repo allow auto-merge? null when it cannot be determined. */
export function autoMergeEnabled(cwd) {
  const r = tryRun('gh', ['repo', 'view', '--json', 'autoMergeAllowed', '-q', '.autoMergeAllowed'], { cwd });
  return r.ok ? r.out === 'true' : null;
}

/** Required status check contexts on a branch. null when it cannot be determined. */
export function requiredChecks(branch, cwd) {
  const nwo = repoNameWithOwner(cwd);
  if (!nwo) return null;
  const r = tryRun('gh', [
    'api', `repos/${nwo}/branches/${branch}/protection/required_status_checks`,
    '-q', '.contexts[]?',
  ], { cwd });
  return r.ok ? r.out.split('\n').map((s) => s.trim()).filter(Boolean) : null;
}
