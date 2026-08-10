import { loadConfig, repoRoot, readDock, writeDock } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import * as git from '../lib/git.js';

/**
 * A gate binds a verdict to a specific commit SHA.
 * If new commits land after the gate, the gate is stale and land() will refuse.
 * This is the mechanism that makes "nothing merges unreviewed" enforceable.
 */
export default function gate(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);

  const issue = args.find((a) => /^\d+$/.test(a));
  const name = args.find((a) => cfg.gates.includes(a));
  const pass = args.includes('--pass');
  const fail = args.includes('--fail');
  const noteIdx = args.indexOf('--note');
  const note = noteIdx > -1 ? args[noteIdx + 1] : '';

  if (!issue || !name) {
    die(`Usage: drydock gate <issue> <${cfg.gates.join('|')}> --pass|--fail [--note "..."]`);
  }
  if (pass === fail) die('Specify exactly one of --pass or --fail.');

  const dock = readDock(issue, root);
  if (!dock) die(`No dock for issue #${issue}.`, 'Run `drydock start ' + issue + '` first.');

  // Gates are ordered. You cannot pass QA before review.
  const idx = cfg.gates.indexOf(name);
  for (let i = 0; i < idx; i++) {
    const prior = cfg.gates[i];
    if (dock.gates[prior]?.verdict !== 'pass') {
      die(`Gate "${prior}" has not passed.`, `Gates run in order: ${cfg.gates.join(' → ')}`);
    }
  }

  const sha = git.headSha(dock.worktree);
  dock.gates[name] = {
    verdict: pass ? 'pass' : 'fail',
    sha,
    note,
    by: process.env.DRYDOCK_ACTOR || process.env.USER || process.env.USERNAME || 'unknown',
    at: new Date().toISOString(),
  };
  dock.status = fail ? 'changes-requested' : dock.status;
  writeDock(dock, root);

  if (pass) {
    log.ok(`Gate "${name}" passed @ ${sha.slice(0, 8)}`);
    const remaining = cfg.gates.filter((g) => dock.gates[g]?.verdict !== 'pass');
    if (remaining.length) log.dim(`Remaining: ${remaining.join(', ')}`);
    else log.dim(`All gates green — run: drydock land ${issue}`);
  } else {
    log.err(`Gate "${name}" failed @ ${sha.slice(0, 8)}`);
    if (note) log.dim(note);
  }
}
