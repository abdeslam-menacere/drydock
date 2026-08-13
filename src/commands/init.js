import { repoRoot } from '../lib/config.js';
import { log } from '../lib/log.js';
import { interactive } from '../lib/prompt.js';
import { applyPlan } from '../lib/scaffold.js';
import {
  buildScaffoldPlan, confirmScaffold, interviewInitOptions, resolveInitOptions,
} from './setup.js';

export default async function init(args) {
  const root = repoRoot();
  let options = resolveInitOptions(args, root, { isInteractive: interactive() });
  if (!options.yes && !options.existingConfig) options = await interviewInitOptions(options, root);
  const plan = buildScaffoldPlan(root, options.config, options);

  log.head('Drydock init');
  for (const item of plan) {
    const note = item.note ? ` — ${item.note}` : '';
    log.raw(`  ${item.action.padEnd(8)} ${item.path}${note}`);
  }

  if (options.dryRun) {
    log.warn('Dry run — no files were written.');
    return;
  }

  if (!options.yes && !await confirmScaffold()) {
    log.warn('Cancelled — no files were written.');
    return;
  }

  applyPlan(plan);
  log.ok('Drydock scaffold applied.');

  const conflicts = plan.filter((item) => item.action === 'conflict');
  if (conflicts.length) {
    log.warn(`${conflicts.length} project-owned file(s) were left unchanged; merge them manually.`);
    process.exitCode = 1;
  }

  log.head('Next');
  log.raw(`  npx --yes --package ${options.config.installation.cliSpec} drydock doctor`);
  log.raw(`  npx --yes --package ${options.config.installation.cliSpec} drydock start <issue-number>`);
  if (options.config.installation.assets.bmad) {
    log.raw('');
    log.dim('Optional BMAD integration (not run automatically):');
    log.raw(`  npx --yes bmad-method@<approved-version> install --custom-source ${options.config.installation.cliSpec} --modules drydock`);
    log.dim('Replace <approved-version> with the exact BMAD CLI version approved for your repository.');
  }
}
