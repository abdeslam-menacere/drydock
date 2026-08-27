import { loadConfig, repoRoot, readDock, writeDock } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import { parseArgs } from '../lib/args.js';
import * as git from '../lib/git.js';
import * as gh from '../lib/gh.js';
import * as notify from './notify.js';
import { routeOrDie } from './route.js';
import { renderReceipt } from './receipt.js';
import { previewFor } from './preview.js';
import { resolveActor, isAgent } from '../lib/actor.js';

// Re-exported so callers that already know `gate` as the home of attribution
// keep working; the implementations moved to lib/actor.js to break an import
// cycle with the receipt renderer.
export { resolveActor, isAgent };

/**
 * A gate binds a verdict to a specific commit SHA.
 * If new commits land after the gate, the gate is stale and land() will refuse.
 * This is the mechanism that makes "nothing merges unreviewed" enforceable.
 */
export default function gate(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);

  const usage = `Usage: drydock gate <issue> <${cfg.gates.join('|')}> --pass|--fail [--sha <reviewed>] [--note "..."] [--as <actor>]`;
  const cli = parseArgs(args, { flags: ['--pass', '--fail'], options: ['--note', '--as', '--sha'] });

  // A swallowed flag records the wrong thing and exits 0. Refuse instead.
  if (cli.unknown.length) die(`Unknown option: ${cli.unknown.join(', ')}`, usage);
  if (cli.missing.length) die(`${cli.missing.join(', ')} needs a value.`, usage);

  const issue = cli.positionals.find((a) => /^\d+$/.test(a));
  const name = cli.positionals.find((a) => cfg.gates.includes(a));
  const pass = cli.flags.has('--pass');
  const fail = cli.flags.has('--fail');
  const note = cli.options['--note'] ?? '';
  const asFlag = cli.options['--as'];
  const shaFlag = cli.options['--sha'];

  if (!issue || !name) die(usage);
  if (pass === fail) die('Specify exactly one of --pass or --fail.');
  if (asFlag !== undefined && !asFlag.trim()) die('--as needs an actor name.', usage);
  if (shaFlag !== undefined && !shaFlag.trim()) die('--sha needs a commit.', usage);

  const dock = readDock(issue, root);
  if (!dock) die(`No dock for issue #${issue}.`, 'Run `drydock start ' + issue + '` first.');

  // Gates are ordered, and only the gates this change earns are enforced.
  // A gate outside the route may still be recorded — additions are always
  // safe — but it cannot block one that is inside it.
  const required = routeOrDie(cfg, dock, git.headSha(dock.worktree), root).gates;
  const order = required.includes(name) ? required : cfg.gates;
  const idx = order.indexOf(name);
  for (let i = 0; i < idx; i++) {
    const prior = order[i];
    if (dock.gates[prior]?.verdict !== 'pass') {
      die(`Gate "${prior}" has not passed.`, `Gates run in order: ${order.join(' → ')}`);
    }
  }

  const head = git.headSha(dock.worktree);
  const by = resolveActor(asFlag);
  const node = cfg.gateNodes?.[name] ?? {};

  // The first gate an agent cannot record. §10.1's "an agent may record a
  // verdict" is a general permission; a gate node declaring `actor: "human"`
  // is the exception that makes product acceptance mean something, and it is
  // checked against the *resolved* actor for the same reason `--as` beats
  // DRYDOCK_ACTOR — attribution is whatever the command actually resolved.
  if (node.actor === 'human' && isAgent(by)) {
    die(
      `Gate "${name}" only accepts a human verdict, and this one is from ${by}.`,
      'This gate exists to bring in evidence from outside the agent graph. An agent recording it would defeat the entire point of having it.',
    );
  }

  const shown = node.actor === 'human' ? servingSha({ cfg, root, dock, issue, name, head }) : null;
  const sha = reviewedSha({ shaFlag, head, by, worktree: dock.worktree, issue, name, pass });

  dock.gates[name] = {
    verdict: pass ? 'pass' : 'fail',
    sha,
    note,
    by,
    at: new Date().toISOString(),
    ...(shown ? { via: 'preview', port: shown.port } : {}),
  };
  dock.status = fail ? 'changes-requested' : dock.status;
  writeDock(dock, root);

  notify.lifecycle(cfg, issue, verdictComment(name, pass, sha, by, note), root);

  // In flow mode the pull request is where the gates bind, so a verdict is not
  // recorded anywhere that counts until the receipt in the PR body says so.
  // Harmless in dock mode, where the PR already carries a complete receipt.
  refreshReceipt(cfg, dock, root, head);

  if (pass) {
    log.ok(`Gate "${name}" passed @ ${sha.slice(0, 8)} by ${by}`);
    const remaining = required.filter((g) => dock.gates[g]?.verdict !== 'pass');
    if (remaining.length) log.dim(`Remaining: ${remaining.join(', ')}`);
    else if (dock.pr) log.dim('Every gate on this route is green — CI will re-verify against the PR head.');
    else log.dim(`All gates green — run: drydock land ${issue}`);
  } else {
    log.err(`Gate "${name}" failed @ ${sha.slice(0, 8)} by ${by}`);
    if (note) log.dim(note);
  }
}

/** Rewrite the PR receipt so the server sees what the manifest now says. */
function refreshReceipt(cfg, dock, root, head) {
  if (!dock.pr || !gh.available()) return;
  const route = routeOrDie(cfg, dock, head, root);
  const body = `Closes #${dock.issue}\n\n${renderReceipt(dock, route, head, { profile: cfg.profile })}`;
  const r = gh.updatePrBody(dock.pr, body, dock.worktree);
  if (r.ok) log.ok('Receipt updated on the pull request');
  else log.warn(`Could not update the PR receipt: ${String(r.err || '').split('\n')[0]}`);
}

/**
 * The commit a human-only gate is allowed to judge.
 *
 * A product owner approves what they *saw*, and what they saw is whatever the
 * preview was serving. If the dock committed while they were clicking around,
 * the running server is stale and so is any approval of it — §4.1, applied to
 * product acceptance. Refusing here is the difference between a gate and a
 * decoration.
 *
 * With no preview recorded there is nothing to bind to. That is allowed, since
 * a PO may have looked at the change some other way, but it is said out loud:
 * an unbound approval is an assertion, not evidence.
 */
function servingSha({ cfg, root, dock, issue, name, head }) {
  const p = previewFor(root, issue);
  if (!p) {
    log.warn(`No preview is running for #${issue}, so this verdict is not bound to anything anyone demonstrably saw.`);
    log.dim(`Start one first and the verdict binds to what it serves: drydock preview ${issue}`);
    return null;
  }
  if (p.dead) {
    die(
      `The preview for #${issue} is not running (pid ${p.pid} is gone).`,
      `It was serving ${p.sha.slice(0, 8)}. Restart it and look again: drydock preview ${issue}`,
    );
  }
  if (p.sha !== head) {
    die(
      `The dock advanced past the preview: it is serving ${p.sha.slice(0, 8)}, HEAD is ${head.slice(0, 8)}.`,
      `Approving "${name}" now would approve commits nobody looked at. Restart the preview and look again: drydock preview stop ${issue} && drydock preview ${issue}`,
    );
  }
  return p;
}

/**
 * The commit this verdict is about.
 *
 * Without `--sha` this is HEAD at the moment the verdict is written, which is
 * not necessarily the commit that was examined. A dock that commits while a
 * review is in flight moves HEAD, so the verdict binds to code nobody read and
 * `land` sees a fresh gate. Naming the reviewed commit closes that window: a
 * mismatch is refused rather than recorded.
 *
 * It is mandatory for agents because that is where the window is real — an
 * unattended dock commits on its own schedule. A human at a terminal is the
 * same person who just read the diff, so the flag stays optional there and the
 * manual path keeps its short command.
 */
function reviewedSha({ shaFlag, head, by, worktree, issue, name, pass }) {
  if (shaFlag === undefined) {
    if (isAgent(by)) {
      die(
        '--sha is required when an agent records a verdict.',
        `State the commit you examined: drydock gate ${issue} ${name} ${pass ? '--pass' : '--fail'} --as ${by} --sha ${head.slice(0, 8)}`,
      );
    }
    return head;
  }

  const ref = shaFlag.trim();
  const reviewed = git.resolveCommit(ref, worktree);
  if (!reviewed) die(`--sha ${ref} does not name a commit in this dock.`);
  if (reviewed !== head) {
    die(
      `The dock moved: you reviewed ${reviewed.slice(0, 8)}, HEAD is now ${head.slice(0, 8)}.`,
      'Re-examine the current commit and record the verdict against that. A verdict on a commit that is no longer HEAD would land unreviewed code.',
    );
  }
  return reviewed;
}

function verdictComment(name, pass, sha, by, note) {
  return [
    `### Drydock gate \`${name}\`: ${pass ? '✅ pass' : '❌ fail'}`,
    '',
    `- **Recorded by:** ${isAgent(by) ? '🤖' : '👤'} \`${by}\``,
    `- **Commit:** \`${sha}\``,
    `- **Note:** ${note || '—'}`,
    '',
    '<sub>This verdict is bound to the commit above. Any new commit makes it stale.</sub>',
  ].join('\n');
}
