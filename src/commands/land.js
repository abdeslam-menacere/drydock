import { loadConfig, repoRoot, readDock, writeDock } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import { parseArgs } from '../lib/args.js';
import * as git from '../lib/git.js';
import * as gh from '../lib/gh.js';
import * as notify from './notify.js';
import { routeOrDie } from './route.js';
import { ensureScore } from './scorer.js';
import { assertOnBranch } from './start.js';
import { renderReceipt } from './receipt.js';

export default function land(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);
  const flow = cfg.profile === 'flow';

  // A mistyped `--dry-run` used to be discarded, turning a preview into a real
  // push, a real PR and — now — armed auto-merge.
  const cli = parseArgs(args, { flags: ['--dry-run'] });
  if (cli.unknown.length) die(`Unknown option: ${cli.unknown.join(', ')}`, 'Usage: drydock land <issue> [--dry-run]');

  const issue = cli.positionals.find((a) => /^\d+$/.test(a));
  if (!issue) die('Usage: drydock land <issue-number> [--dry-run]');

  const dock = readDock(issue, root);
  if (!dock) die(`No dock for issue #${issue}.`);

  assertOnBranch(dock, 'landing');

  if (git.isDirty(dock.worktree)) {
    die('Worktree has uncommitted changes.', 'Commit them inside the dock first.');
  }

  const head = git.headSha(dock.worktree);

  // The ceiling, before the floor is read. A proposal binds to a SHA like a
  // verdict does, so a stale one is worth nothing and gets recomputed here —
  // the last point at which adding a gate can still change the outcome. If the
  // scorer is off, broken or slow, this is a no-op and the deterministic route
  // stands: it can only ever have added.
  ensureScore(cfg, dock, head, root);

  // What this change earns, derived from its own diff. A pure projection —
  // never stored, recomputed here so a revert relaxes the route for free.
  const route = routeOrDie(cfg, dock, head, root);

  // --- Gate verification. This is the whole point of Drydock. ---
  //
  // Flow mode moves *where* this happens, not *whether*. The route still has to
  // be satisfied at the PR head, in order, against the commit each reviewer
  // examined — but the check that enforces it is `drydock-gates` on the server,
  // so `land` opens the PR with a receipt whose rows are pending. A pending row
  // is a row CI refuses; there is no path here that merges anything unreviewed.
  const problems = [];
  const pending = [];
  for (const name of route.gates) {
    const g = dock.gates[name];
    if (!g) (flow ? pending : problems).push(`"${name}" has not run`);
    else if (g.verdict !== 'pass') problems.push(`"${name}" did not pass`);
    else if (g.sha !== head) problems.push(`"${name}" is STALE (passed @ ${g.sha.slice(0, 8)}, HEAD is ${head.slice(0, 8)})`);
  }
  if (problems.length) {
    log.err(`Dock #${issue} cannot land:`);
    problems.forEach((p) => log.dim('• ' + p));
    log.dim(`Route: ${route.gates.join(' → ') || '(none)'} — ${route.reason}`);
    log.dim('Re-run the failing gate against the current HEAD.');
    process.exit(1);
  }

  if (pending.length) {
    log.warn(`Opening the PR with ${pending.length} gate${pending.length > 1 ? 's' : ''} still to run:`);
    pending.forEach((p) => log.dim('• ' + p));
    log.dim('Flow mode: the gates bind to the pull request. It cannot merge until');
    log.dim(`each one is recorded against the PR head — run: drydock gate ${issue} <gate> --pass --sha <head>`);
    warnIfUnenforced(cfg, dock);
  } else {
    log.ok(`All gates green @ ${head.slice(0, 8)}`);
  }
  if (route.routed) log.dim(`Route: ${route.gates.join(' → ') || '(none)'} — ${route.reason}`);

  const receipt = renderReceipt(dock, route, head, { profile: cfg.profile });
  const body = `Closes #${issue}\n\n${receipt}`;

  if (cli.flags.has('--dry-run')) {
    log.warn('Dry run — nothing pushed. PR body would be:');
    log.raw('\n' + body + '\n');
    return;
  }

  const push = git.pushBranch(dock.branch, dock.worktree);
  if (!push.ok) die('Push failed.', push.err);
  log.ok(`Pushed ${dock.branch}`);

  if (gh.available()) {
    const pr = gh.createPr(
      { title: `${dock.title} (#${issue})`, body, base: dock.base, head: dock.branch },
      dock.worktree
    );
    if (pr.ok) {
      dock.pr = pr.out;
      log.ok(`PR opened: ${pr.out}`);
      notify.lifecycle(cfg, issue, prOpenedComment(dock, pr.out, head), root);
      armAutoMerge(dock, cfg, pr.out);
    } else log.warn(`PR not created automatically: ${pr.err}`);
  } else {
    log.warn('gh not installed — open the PR manually with this body:');
    log.raw('\n' + body + '\n');
  }

  dock.status = 'landed';
  dock.landedAt = new Date().toISOString();
  writeDock(dock, root);
  log.dim(`Clean up when merged: drydock clean ${issue}`);
}

function prOpenedComment(dock, url, head) {
  return [
    '### Drydock: pull request opened',
    '',
    `- **PR:** ${url}`,
    `- **Branch:** \`${dock.branch}\` → \`${dock.base}\``,
    `- **Head:** \`${head}\``,
    '',
    '<sub>Every gate passed against this commit. The receipt is in the PR body.</sub>',
  ].join('\n');
}

/**
 * Say so, loudly, when flow mode has nothing enforcing it.
 *
 * Flow mode makes §4.3's claim literally true — the server layer is the only
 * layer left, because `land` no longer holds the PR back. A repo running it
 * without `drydock-gates` as a required check therefore has *no* enforcement,
 * which is strictly worse than dock mode rather than merely lighter.
 */
function warnIfUnenforced(cfg, dock) {
  const checks = gh.requiredChecks(dock.base, dock.worktree);
  if (checks === null) {
    log.warn(`Could not read branch protection on ${dock.base} — cannot confirm the gates are enforced.`);
    return;
  }
  if (!checks.some((c) => /drydock/i.test(c))) {
    log.err(`NOTHING IS ENFORCING THESE GATES: ${dock.base} has no \`drydock-gates\` required check.`);
    log.dim(`Required checks found: ${checks.join(', ') || '(none)'}`);
    log.dim('In flow mode `land` opens the PR before the gates run, so that check IS the gate.');
    log.dim('Add it in branch protection, or switch back to profile "dock".');
  }
}

/**
 * Queue the merge for when the repository says it is safe.
 *
 * Drydock never issues an immediate merge: `--auto` hands the decision to
 * GitHub's branch protection. That only means anything if there is a required
 * check to wait for — `--auto` on an unprotected branch merges the instant the
 * PR opens, which would make the gates decorative. So `waitForChecks` is
 * treated as a precondition and not just a flag: with it on and no required
 * check configured, arming is refused and the PR is left for a human.
 */
function armAutoMerge(dock, cfg, ref) {
  const merge = cfg.autonomy?.merge ?? {};
  if (!merge.enabled) { log.dim('Auto-merge disabled by policy — a human merges this.'); return; }

  if (merge.waitForChecks !== false) {
    const checks = gh.requiredChecks(dock.base, dock.worktree);
    if (!checks?.length) {
      log.warn(`Auto-merge NOT armed: no required status checks on ${dock.base}.`);
      log.dim('`--auto` with nothing to wait for merges immediately and unverified.');
      log.dim('Make `drydock-gates` a required check, or set autonomy.merge.waitForChecks false.');
      return;
    }
    log.dim(`Required checks on ${dock.base}: ${checks.join(', ')}`);
  }

  const r = gh.mergePr(ref, { method: merge.method, auto: true, deleteBranch: true }, dock.worktree);
  if (r.ok) log.ok(`Auto-merge armed (${merge.method}) — GitHub merges when checks pass`);
  else log.warn(`Auto-merge not armed: ${String(r.err || '').split('\n')[0] || 'gh exited non-zero'}`);
}
