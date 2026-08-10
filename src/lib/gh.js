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
