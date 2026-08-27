import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, loadConfig, saveConfig, configPath, repoRoot, stateDir } from '../lib/config.js';
import { log } from '../lib/log.js';
import { has, runLive } from '../lib/sh.js';
import * as gh from '../lib/gh.js';
import { runInterview } from './config.js';

// Docks live in-repo so workspace-scoped agents can read them; they are build
// artefacts, not source, so they stay out of git.
const GITIGNORE_LINES = ['.drydock/tmp/', '.docks/'];

export default async function init(args) {
  const root = repoRoot();
  const force = args.includes('--force');
  const withBmad = !args.includes('--no-bmad');

  log.head('Drydock init');

  // 1. Config
  const cp = configPath(root);
  if (fs.existsSync(cp) && !force) {
    log.warn('drydock.config.json already exists (use --force to overwrite)');
  } else {
    saveConfig({ ...DEFAULTS }, root);
    log.ok('Wrote drydock.config.json');
  }

  // 2. State dir
  stateDir(root);
  fs.writeFileSync(path.join(root, '.drydock', 'README.md'),
    '# .drydock\n\nDock manifests. One file per issue. Commit these — they are the audit trail.\n');
  log.ok('Created .drydock/docks/');

  // 3. gitignore
  const added = ensureGitignore(root);
  if (added.length) log.ok(`Updated .gitignore (${added.join(', ')})`);
  else log.ok('.gitignore already covers Drydock');

  // 4. Preflight
  log.head('Preflight');
  check('git', has('git'), 'required');
  check('gh (GitHub CLI)', has('gh'), 'required for issue + PR automation — https://cli.github.com');
  if (has('gh')) check('gh authenticated', gh.authOk(), 'run: gh auth login');
  check('code (VS Code CLI)', has('code'), 'optional — set "editor": null in config for headless');

  // 5. The backstop that makes autonomy safe
  mergeGate(root, loadConfig(root));

  // 6. BMAD
  if (withBmad) {
    log.head('BMAD module');
    log.info('Drydock installs as a BMAD custom module (agents + workflows).');
    log.dim('Run this to wire it in:');
    log.raw('');
    log.raw('  npx bmad-method install \\');
    log.raw('    --custom-source https://github.com/<your-org>/drydock \\');
    log.raw('    --modules bmm');
    log.raw('');
    log.dim('Drydock never forks BMAD. Upgrades stay clean.');
  }

  // 7. Ask how much Drydock should do on its own. Skipped when non-interactive.
  await runInterview(root);

  log.head('Next');
  log.raw('  drydock start <issue-number>    # open a dock for a GitHub issue');
  log.raw('  drydock status                 # see every dock in flight');
  log.raw('');
}

/** Append only the ignore lines that are missing. Safe to run repeatedly. */
function ensureGitignore(root) {
  const gi = path.join(root, '.gitignore');
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (!missing.length) return [];

  let out = '';
  if (cur && !cur.endsWith('\n')) out += '\n';
  if (!have.has('# Drydock')) out += `${cur ? '\n' : ''}# Drydock\n`;
  out += missing.join('\n') + '\n';
  fs.appendFileSync(gi, out);
  return missing;
}

/**
 * Auto-merge with no required status check merges the moment the PR opens —
 * which would make the gates decorative. Say so loudly if it is not set up.
 */
function mergeGate(root, cfg) {
  log.head('Merge gate');
  const flow = cfg.profile === 'flow';

  if (!gh.available()) {
    log.warn('gh not found — cannot verify branch protection.');
    log.dim(`Check by hand: auto-merge enabled, and \`drydock-gates\` REQUIRED on ${cfg.baseBranch}.`);
    log.dim('Auto-merge without a required check merges immediately and unverified.');
    if (flow) flowUnenforced(cfg);
    return;
  }

  const auto = gh.autoMergeEnabled(root);
  if (auto === null) log.warn('Could not read repository settings (auth, or no GitHub remote).');
  else if (auto) log.ok('Auto-merge is enabled on the repository');
  else { log.err('Auto-merge is NOT enabled'); log.dim('Settings → General → Allow auto-merge'); }

  const checks = gh.requiredChecks(cfg.baseBranch, root);
  if (checks === null) {
    log.err(`No readable branch protection on ${cfg.baseBranch}`);
    log.dim('Make `drydock-gates` a required status check before enabling auto-merge.');
    if (flow) flowUnenforced(cfg);
  } else if (checks.includes('drydock-gates')) {
    log.ok('`drydock-gates` is a required status check');
    if (flow) log.ok('Flow mode is enforced: the PR cannot merge until the receipt is complete.');
  } else {
    log.err(`\`drydock-gates\` is NOT required on ${cfg.baseBranch}`);
    log.dim('Without it, auto-merge lands unverified work the instant a PR opens.');
    if (flow) flowUnenforced(cfg);
  }
}

/**
 * In dock mode an unenforced repo still has `land` refusing to open a PR until
 * the gates pass locally. Flow mode removes that layer on purpose, so without
 * the required check there is nothing left at all — strictly worse than dock
 * mode rather than merely lighter. It is worth an unmissable warning.
 */
function flowUnenforced(cfg) {
  log.err('FLOW MODE IS UNENFORCED IN THIS REPOSITORY.');
  log.dim(`profile is "flow", so \`drydock land\` opens the PR before the gates run.`);
  log.dim(`\`drydock-gates\` on ${cfg.baseBranch} is the only thing that would stop an unreviewed merge.`);
  log.dim('Add it as a required status check, or set profile back to "dock".');
}

function check(label, ok, hint) {
  if (ok) log.ok(label);
  else { log.err(`${label} — missing`); if (hint) log.dim(hint); }
}
