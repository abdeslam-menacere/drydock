import { loadConfig, repoRoot, readDock, dockPath, listDocks } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import * as git from '../lib/git.js';
import { stopPreview, previewFor } from './preview.js';
import { removeScore } from './scorer.js';
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
    // Removing the branch out from under a running server leaves a process
    // holding a port and serving code that no longer exists anywhere.
    if (previewFor(root, d.issue)) {
      const r = stopPreview(root, d.issue);
      log.dim(`#${d.issue}: preview ${r.stopped ? 'stopped' : 'record dropped'}`);
    }

    // A branch-mode dock has no worktree to remove, and its branch may still be
    // the one checked out here — deleting that would put the repo on a detached
    // HEAD, so it is left for the developer who is standing in it.
    const inWorktree = (d.workspace ?? 'worktree') === 'worktree';
    if (inWorktree) {
      git.removeWorktree(d.worktree, root, force);
      git.deleteBranch(d.branch, root, force);
    } else if (git.currentBranch(root) !== d.branch) {
      git.deleteBranch(d.branch, root, force);
    } else {
      log.dim(`#${d.issue}: still on ${d.branch} — branch left alone.`);
    }
    fs.rmSync(dockPath(d.issue, root), { force: true });
    removeScore(d.issue, root);
    log.ok(`#${d.issue} cleaned — ${inWorktree ? 'worktree, branch, and manifest' : 'manifest'} removed`);
  }
}
