import { loadConfig, repoRoot, readDock, dockPath, listDocks } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import * as git from '../lib/git.js';
import fs from 'node:fs';

export default function clean(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const force = args.includes('--force');
  const all = args.includes('--merged');
  const issue = args.find((a) => /^\d+$/.test(a));

  if (!issue && !all) die('Usage: drydock clean <issue> [--force]  |  drydock clean --merged');

  const targets = all
    ? listDocks(root).filter((d) => d.status === 'landed')
    : [readDock(issue, root)].filter(Boolean);

  if (!targets.length) { log.info('Nothing to clean.'); return; }

  for (const d of targets) {
    if (git.isDirty(d.worktree) && !force) {
      log.warn(`#${d.issue}: uncommitted changes — skipped (use --force)`);
      continue;
    }
    git.removeWorktree(d.worktree, root, force);
    git.deleteBranch(d.branch, root, force);
    fs.rmSync(dockPath(d.issue, root), { force: true });
    log.ok(`#${d.issue} cleaned — worktree, branch, and manifest removed`);
  }
}
