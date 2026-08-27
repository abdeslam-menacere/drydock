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

/** Rewrite a pull request body. Used to keep the gate receipt current. */
export function updatePrBody(ref, body, cwd) {
  if (!available()) return unavailable();
  return tryRun('gh', ['pr', 'edit', String(ref), '--body', body], { cwd });
}

export function repoNameWithOwner(cwd) {
  const r = tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd });
  return r.ok ? r.out : null;
}

const ISSUE_GRAPH_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, states: OPEN, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage }
      nodes {
        number
        title
        url
        body
        labels(first: 20) { nodes { name } }
        parent { number }
      }
    }
  }
}`;

/**
 * Open issues plus their native sub-issue edges, in one round trip.
 *
 * `parent` is the sub-issue relationship. Asking for it is also the probe: on a
 * host that predates sub-issues the whole query errors, and the caller falls
 * back to the body convention rather than silently reporting a graph with no
 * edges in it — an empty graph and an unreadable one must not look the same.
 *
 * Returns { issues, truncated } or null.
 */
export function issueGraph(cwd) {
  if (!available()) return null;
  const nwo = repoNameWithOwner(cwd);
  if (!nwo) return null;
  const [owner, name] = nwo.split('/');

  const r = tryRun('gh', [
    'api', 'graphql',
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-f', `query=${ISSUE_GRAPH_QUERY}`,
  ], { cwd });
  if (!r.ok) return null;

  try {
    const page = JSON.parse(r.out)?.data?.repository?.issues;
    if (!page) return null;
    return {
      truncated: !!page.pageInfo?.hasNextPage,
      issues: (page.nodes ?? []).filter(Boolean).map((n) => ({
        number: n.number,
        title: n.title,
        url: n.url,
        body: n.body ?? '',
        labels: (n.labels?.nodes ?? []).map((l) => l.name),
        parent: n.parent?.number ?? null,
      })),
    };
  } catch { return null; }
}

/** Open issues without their edges — the fallback when sub-issues are unavailable. */
export function listIssues(cwd) {
  if (!available()) return null;
  const r = tryRun('gh', [
    'issue', 'list', '--state', 'open', '--limit', '100',
    '--json', 'number,title,url,body,labels',
  ], { cwd });
  if (!r.ok) return null;
  try {
    const rows = JSON.parse(r.out);
    if (!Array.isArray(rows)) return null;
    return rows.map((n) => ({
      number: n.number,
      title: n.title,
      url: n.url,
      body: n.body ?? '',
      labels: (n.labels ?? []).map((l) => l.name),
      parent: null,
    }));
  } catch { return null; }
}

const unavailable = () => ({ ok: false, out: '', err: 'gh not available', code: null, skipped: true });

/** Post a comment on an issue. Degrades silently when gh is absent. */
export function comment(number, body, cwd) {
  if (!available()) return unavailable();
  return tryRun('gh', ['issue', 'comment', String(number), '--body', body], { cwd });
}

const MERGE_FLAG = { squash: '--squash', merge: '--merge', rebase: '--rebase' };

/**
 * Merge a pull request, identified by branch, number or URL. `auto` queues the
 * merge for when the repository's required checks pass instead of merging now.
 */
export function mergePr(ref, { method = 'squash', auto = true, deleteBranch = true } = {}, cwd) {
  if (!available()) return unavailable();
  const flag = MERGE_FLAG[method];
  if (!flag) return { ok: false, out: '', err: `unknown merge method: ${method}`, code: null };

  const args = ['pr', 'merge', String(ref), flag];
  if (auto) args.push('--auto');
  if (deleteBranch) args.push('--delete-branch');
  return tryRun('gh', args, { cwd });
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
