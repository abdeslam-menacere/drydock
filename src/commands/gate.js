import { loadConfig, repoRoot, readDock, writeDock } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import { parseArgs } from '../lib/args.js';
import * as git from '../lib/git.js';
import * as notify from '../notify.js';

/**
 * Who is recording this verdict.
 *
 * `--as` wins because `DRYDOCK_ACTOR` persists for the life of a shell: one
 * left set by an earlier command in a shared session nearly filed a reviewer
 * agent's verdict under a human's name. An explicit flag is scoped to the
 * single invocation that carries it.
 */
export function resolveActor(explicit, env = process.env) {
  for (const v of [explicit, env.DRYDOCK_ACTOR, env.USER, env.USERNAME]) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return 'unknown';
}

/** Verdicts recorded by an agent are attributed `agent:<role>`. */
export const isAgent = (by) => /^agent:/i.test(String(by ?? '').trim());

/**
 * A gate binds a verdict to a specific commit SHA.
 * If new commits land after the gate, the gate is stale and land() will refuse.
 * This is the mechanism that makes "nothing merges unreviewed" enforceable.
 */
export default function gate(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);

  const usage = `Usage: drydock gate <issue> <${cfg.gates.join('|')}> --pass|--fail [--note "..."] [--as <actor>]`;
  const cli = parseArgs(args, { flags: ['--pass', '--fail'], options: ['--note', '--as'] });

  // A swallowed flag records the wrong thing and exits 0. Refuse instead.
  if (cli.unknown.length) die(`Unknown option: ${cli.unknown.join(', ')}`, usage);
  if (cli.missing.length) die(`${cli.missing.join(', ')} needs a value.`, usage);

  const issue = cli.positionals.find((a) => /^\d+$/.test(a));
  const name = cli.positionals.find((a) => cfg.gates.includes(a));
  const pass = cli.flags.has('--pass');
  const fail = cli.flags.has('--fail');
  const note = cli.options['--note'] ?? '';
  const asFlag = cli.options['--as'];

  if (!issue || !name) die(usage);
  if (pass === fail) die('Specify exactly one of --pass or --fail.');
  if (asFlag !== undefined && !asFlag.trim()) die('--as needs an actor name.', usage);

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
  const by = resolveActor(asFlag);
  dock.gates[name] = {
    verdict: pass ? 'pass' : 'fail',
    sha,
    note,
    by,
    at: new Date().toISOString(),
  };
  dock.status = fail ? 'changes-requested' : dock.status;
  writeDock(dock, root);

  notify.lifecycle(cfg, issue, verdictComment(name, pass, sha, by, note), root);

  if (pass) {
    log.ok(`Gate "${name}" passed @ ${sha.slice(0, 8)} by ${by}`);
    const remaining = cfg.gates.filter((g) => dock.gates[g]?.verdict !== 'pass');
    if (remaining.length) log.dim(`Remaining: ${remaining.join(', ')}`);
    else log.dim(`All gates green — run: drydock land ${issue}`);
  } else {
    log.err(`Gate "${name}" failed @ ${sha.slice(0, 8)} by ${by}`);
    if (note) log.dim(note);
  }
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
