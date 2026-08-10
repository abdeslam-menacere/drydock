import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, saveConfig, configPath, repoRoot, stateDir } from '../lib/config.js';
import { log } from '../lib/log.js';
import { has, runLive } from '../lib/sh.js';
import * as gh from '../lib/gh.js';

const GITIGNORE_BLOCK = `
# Drydock
.drydock/tmp/
`;

export default function init(args) {
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
  const gi = path.join(root, '.gitignore');
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!cur.includes('# Drydock')) {
    fs.appendFileSync(gi, GITIGNORE_BLOCK);
    log.ok('Updated .gitignore');
  }

  // 4. Preflight
  log.head('Preflight');
  check('git', has('git'), 'required');
  check('gh (GitHub CLI)', has('gh'), 'required for issue + PR automation — https://cli.github.com');
  if (has('gh')) check('gh authenticated', gh.authOk(), 'run: gh auth login');
  check('code (VS Code CLI)', has('code'), 'optional — set "editor": null in config for headless');

  // 5. BMAD
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

  log.head('Next');
  log.raw('  drydock start <issue-number>    # open a dock for a GitHub issue');
  log.raw('  drydock status                 # see every dock in flight');
  log.raw('');
}

function check(label, ok, hint) {
  if (ok) log.ok(label);
  else { log.err(`${label} — missing`); if (hint) log.dim(hint); }
}
