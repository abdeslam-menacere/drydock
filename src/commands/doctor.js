import fs from 'node:fs';
import path from 'node:path';
import { constants } from 'node:fs';
import { CONFIG_FILE, DEFAULTS, deepMerge, repoRoot } from '../lib/config.js';
import * as gh from '../lib/gh.js';
import { has, tryRun } from '../lib/sh.js';
import {
  baseAvailable, buildScaffoldPlan, expectedWorkflowGates, validateConfig,
} from './setup.js';

const REQUIRED_CHECK = 'Drydock Gates / Verify gate receipt';

export default function doctor() {
  const results = [];
  const root = findRepositoryRoot();
  if (!root) {
    console.log('missing repository — not inside a Git repository');
    process.exitCode = 1;
    return;
  }
  add(results, 'pass', 'repository', root);

  const config = readConfig(root, results);
  if (config) {
    add(results, baseAvailable(config.baseBranch, root) ? 'pass' : 'missing',
      'base branch', config.baseBranch);
    checkDocksParent(root, config, results);
    checkAssets(root, config, results);
    checkGateAgreement(root, config, results);
  }

  add(results, has('git') ? 'pass' : 'missing', 'git', has('git') ? 'available' : 'not found on PATH');
  const ghReady = checkGh(results);
  if (config) {
    checkTool(config.editor, 'editor', results);
    checkTool(config.agent, 'agent', results);
    checkGitHubPolicy(root, config, ghReady, results);
    if (config.installation.assets.bmad) {
      add(results, 'unknown', 'BMAD integration', 'external installer state is not modified or inferred by Drydock');
    }
  }

  for (const result of results) {
    console.log(`${result.status.padEnd(7)} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  if (results.some((result) => result.status === 'missing')) process.exitCode = 1;
}

function findRepositoryRoot() {
  const common = tryRun('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.ok && common.out) return path.dirname(common.out);
  const top = tryRun('git', ['rev-parse', '--show-toplevel']);
  return top.ok && top.out ? top.out : null;
}

function readConfig(root, results) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    add(results, 'missing', 'config', `${CONFIG_FILE} not found; run drydock init`);
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const config = deepMerge(DEFAULTS, raw);
    validateConfig(config, root, { checkBase: false });
    add(results, 'pass', 'config', `${CONFIG_FILE} is valid`);
    return config;
  } catch (error) {
    add(results, 'missing', 'config', error.message);
    return null;
  }
}

function checkDocksParent(root, config, results) {
  const target = path.resolve(root, config.docksDir);
  let parent = path.dirname(target);
  while (!fs.existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
  try {
    fs.accessSync(parent, constants.W_OK);
    add(results, 'pass', 'docks parent', `${parent} is writable`);
  } catch {
    add(results, 'missing', 'docks parent', `${parent} is not writable`);
  }
}

function checkAssets(root, config, results) {
  const plan = buildScaffoldPlan(root, config, { existingConfig: true });
  for (const item of plan) {
    if (item.action === 'skip') continue;
    const status = item.action === 'present' ? 'pass' : 'missing';
    const detail = item.action === 'present' ? item.path : `${item.action}: ${item.note || 'setup incomplete'}`;
    add(results, status, `asset ${item.path}`, detail);
  }
}

function checkGateAgreement(root, config, results) {
  if (!config.installation.assets.github) return;
  const workflowGates = expectedWorkflowGates(root);
  if (!workflowGates) {
    add(results, 'missing', 'workflow gate policy', 'generated workflow is missing or does not declare literal gates');
    return;
  }
  const agrees = JSON.stringify(workflowGates) === JSON.stringify(config.gates);
  add(results, agrees ? 'pass' : 'missing', 'workflow gate policy', agrees
    ? config.gates.join(' -> ')
    : `config=${config.gates.join(',')} workflow=${workflowGates.join(',')}`);
}

function checkGh(results) {
  if (!gh.available()) {
    add(results, 'missing', 'gh', 'not found on PATH');
    add(results, 'unknown', 'gh authentication', 'install gh, then run `gh auth login`');
    return false;
  }
  add(results, 'pass', 'gh', 'available');
  const authenticated = gh.authOk();
  add(results, authenticated ? 'pass' : 'missing', 'gh authentication', authenticated ? 'authenticated' : 'run `gh auth login`');
  return authenticated;
}

function checkTool(command, label, results) {
  if (command === null) {
    add(results, 'pass', label, 'disabled in config');
    return;
  }
  add(results, has(command) ? 'pass' : 'missing', label, has(command) ? command : `${command} not found on PATH`);
}

function checkGitHubPolicy(root, config, ghReady, results) {
  const guidance = `GitHub Settings -> Rules -> Rulesets (or Branches -> Branch protection rules) for ${config.baseBranch}; require status check "${REQUIRED_CHECK}".`;
  if (!config.installation.assets.github) {
    add(results, 'unknown', 'GitHub required check', `GitHub assets are disabled. ${guidance}`);
    return;
  }
  if (!ghReady) {
    add(results, 'unknown', 'GitHub required check', guidance);
    return;
  }
  const repository = gh.repoNameWithOwner(root);
  if (!repository) {
    add(results, 'unknown', 'GitHub required check', `repository or permissions could not be read. ${guidance}`);
    return;
  }

  const protection = inspectProtection(repository, config.baseBranch, root);
  const rulesets = inspectRulesets(repository, config.baseBranch, root);
  if (protection.required || rulesets.required) {
    add(results, 'pass', 'GitHub required check', REQUIRED_CHECK);
  } else if (protection.known && rulesets.known) {
    add(results, 'missing', 'GitHub required check', guidance);
  } else {
    add(results, 'unknown', 'GitHub required check', `insufficient permissions to inspect all branch rules. ${guidance}`);
  }
}

function inspectProtection(repository, branch, root) {
  const encoded = encodeURIComponent(branch);
  const response = gh.api(`repos/${repository}/branches/${encoded}/protection/required_status_checks`, root);
  if (!response.ok) {
    return { known: /HTTP 404|status code 404/i.test(response.err), required: false };
  }
  try {
    const data = JSON.parse(response.out);
    const contexts = [
      ...(Array.isArray(data.contexts) ? data.contexts : []),
      ...(Array.isArray(data.checks) ? data.checks.map((check) => check.context) : []),
    ];
    return { known: true, required: contexts.includes(REQUIRED_CHECK) };
  } catch {
    return { known: false, required: false };
  }
}

function inspectRulesets(repository, branch, root) {
  const response = gh.api(`repos/${repository}/rulesets?includes_parents=true`, root);
  if (!response.ok) return { known: false, required: false };
  let summaries;
  try { summaries = JSON.parse(response.out); }
  catch { return { known: false, required: false }; }
  if (!Array.isArray(summaries)) return { known: false, required: false };

  let known = true;
  for (const summary of summaries) {
    if (summary.enforcement === 'disabled') continue;
    const detail = gh.api(`repos/${repository}/rulesets/${summary.id}`, root);
    if (!detail.ok) { known = false; continue; }
    let ruleset;
    try { ruleset = JSON.parse(detail.out); }
    catch { known = false; continue; }
    if (!appliesToBranch(ruleset, branch)) continue;
    const statusRule = (ruleset.rules || []).find((rule) => rule.type === 'required_status_checks');
    const checks = statusRule?.parameters?.required_status_checks || [];
    if (checks.some((check) => check.context === REQUIRED_CHECK)) return { known: true, required: true };
  }
  return { known, required: false };
}

function appliesToBranch(ruleset, branch) {
  if (ruleset.target && ruleset.target !== 'branch') return false;
  const names = ruleset.conditions?.ref_name;
  if (!names) return true;
  const ref = `refs/heads/${branch}`;
  const included = (names.include || []).some((pattern) => pattern === '~DEFAULT_BRANCH' || globMatch(pattern, ref));
  const excluded = (names.exclude || []).some((pattern) => globMatch(pattern, ref));
  return included && !excluded;
}

function globMatch(pattern, value) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function add(results, status, name, detail = '') {
  results.push({ status, name, detail });
}