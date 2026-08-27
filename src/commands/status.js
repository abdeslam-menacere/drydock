import { loadConfig, repoRoot, listDocks } from '../lib/config.js';
import { log } from '../lib/log.js';
import * as git from '../lib/git.js';

export default function status() {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const docks = listDocks(root);

  if (!docks.length) {
    log.info('No docks open. Start one: drydock start <issue>');
    return;
  }

  log.head(`${docks.length} dock${docks.length > 1 ? 's' : ''} in flight`);
  for (const d of docks) {
    let head = null;
    try { head = git.headSha(d.worktree); } catch { /* worktree gone */ }

    const marks = cfg.gates.map((n) => {
      const g = d.gates[n];
      if (!g) return `${n}:·`;
      if (g.verdict !== 'pass') return `${n}:✗`;
      if (head && g.sha !== head) return `${n}:⚠stale`;
      return `${n}:✓`;
    }).join('  ');

    const state = head ? d.status : 'worktree-missing';
    log.raw(`  #${String(d.issue).padEnd(5)} ${marks.padEnd(26)} ${state.padEnd(18)} ${d.title}`);

    // Which mode this dock is in and what workspace it got, with the reason —
    // `auto` is a decision made once at `start`, and a decision nobody can see
    // afterwards is indistinguishable from arbitrary behaviour.
    const profile = d.profile ?? 'dock';
    const workspace = d.workspace ?? 'worktree';
    log.dim(`${d.branch}  ·  ${profile} / ${workspace}${d.workspaceReason ? ` (${d.workspaceReason})` : ''}`);
    if (d.preview?.url) log.dim(`preview: ${d.preview.url}`);
  }
  log.raw('');
  log.dim('✓ passed   ✗ failed   · not run   ⚠stale = new commits since the gate passed');
  log.dim('dock = gates bind to every commit   flow = gates bind to the pull request');
}
