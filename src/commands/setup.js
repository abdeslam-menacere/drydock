import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, DEFAULTS, deepMerge } from '../lib/config.js';
import { DEFAULT_CLI_SPEC } from '../lib/package.js';
import { interview } from '../lib/prompt.js';
import { SCHEMA_VERSION } from '../lib/questions.js';
import {
  planAppend, planCreate, planCreateIfAbsent, planDirectory, planJsonMerge, planSkip,
} from '../lib/scaffold.js';
import { tryRun } from '../lib/sh.js';
import { collectPolicy } from './config.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEMPLATE_ROOT = path.join(PACKAGE_ROOT, 'templates');
const GITIGNORE_MARKER = '# >>> Drydock >>>';
const COPILOT_MARKER = '<!-- drydock:start -->';

export function resolveInitOptions(args, root, { isInteractive = false } = {}) {
  const parsed = parseArgs(args);
  const configFile = path.join(root, CONFIG_FILE);

  if (!parsed.yes && !isInteractive) {
    throw new Error('This shell cannot prompt. Re-run with `drydock init --yes` (add `--dry-run` to preview).');
  }

  if (fs.existsSync(configFile)) {
    const config = readExistingConfig(configFile, root);
    rejectConfigOverrides(parsed.explicit, config);
    return { ...parsed, config, existingConfig: true };
  }

  const config = deepMerge(DEFAULTS, {
    baseBranch: parsed.values.baseBranch ?? detectBaseBranch(root),
    docksDir: parsed.values.docksDir,
    branchPattern: parsed.values.branchPattern,
    gates: parsed.values.gates,
    editor: parsed.values.editor,
    agent: parsed.values.agent,
    installation: {
      cliSpec: parsed.values.cliSpec ?? DEFAULT_CLI_SPEC,
      assets: {
        github: parsed.values.github,
        vscode: parsed.values.vscode,
        bmad: parsed.values.bmad,
      },
    },
    bmad: { enabled: parsed.values.bmad },
    setup: parsed.yes
      ? { completed: true, at: null, schemaVersion: SCHEMA_VERSION }
      : DEFAULTS.setup,
  });
  validateConfig(config, root);
  return { ...parsed, config, existingConfig: false };
}

export function buildScaffoldPlan(root, config, { existingConfig = false } = {}) {
  const plan = [];
  const configFile = path.join(root, CONFIG_FILE);
  plan.push(existingConfig
    ? planCreate(root, CONFIG_FILE, fs.readFileSync(configFile, 'utf8'))
    : planCreate(root, CONFIG_FILE, JSON.stringify(config, null, 2) + '\n'));
  plan.push(planDirectory(root, path.join('.drydock', 'docks')));
  plan.push(planCreateIfAbsent(root, path.join('.drydock', 'README.md'), template('core/drydock-readme.md')));
  plan.push(planAppend(root, '.gitignore', GITIGNORE_MARKER, gitignoreBlock(config.docksDir)));

  const githubFiles = [
    path.join('.github', 'copilot-instructions.md'),
    ...['dev', 'reviewer', 'qa'].map((role) => path.join('.github', 'agents', `drydock-${role}.md`)),
    path.join('.github', 'workflows', 'drydock-gates.yml'),
    path.join('.github', 'ISSUE_TEMPLATE', 'drydock-feature.yml'),
  ];
  if (config.installation.assets.github) {
    plan.push(planAppend(
      root,
      path.join('.github', 'copilot-instructions.md'),
      COPILOT_MARKER,
      template('github/copilot-instructions.md'),
      { prefix: '# Copilot instructions\n\n' },
    ));
    for (const role of ['dev', 'reviewer', 'qa']) {
      plan.push(planCreate(
        root,
        path.join('.github', 'agents', `drydock-${role}.md`),
        template(`github/agents/drydock-${role}.md`),
      ));
    }
    plan.push(planCreate(
      root,
      path.join('.github', 'workflows', 'drydock-gates.yml'),
      template('github/workflows/drydock-gates.yml', { GATES_JSON: JSON.stringify(config.gates) }),
    ));
    plan.push(planCreate(
      root,
      path.join('.github', 'ISSUE_TEMPLATE', 'drydock-feature.yml'),
      template('github/ISSUE_TEMPLATE/drydock-feature.yml'),
    ));
  } else {
    for (const file of githubFiles) plan.push(planSkip(root, file, 'GitHub assets not selected'));
  }

  if (config.installation.assets.vscode) {
    plan.push(planJsonMerge(root, path.join('.vscode', 'tasks.json'), vscodeTasks(config), mergeTasks));
    plan.push(planJsonMerge(
      root,
      path.join('.vscode', 'extensions.json'),
      vscodeExtensions(),
      mergeExtensions,
    ));
  } else {
    plan.push(planSkip(root, path.join('.vscode', 'tasks.json'), 'VS Code assets not selected'));
    plan.push(planSkip(root, path.join('.vscode', 'extensions.json'), 'VS Code assets not selected'));
  }

  plan.push(planSkip(root, 'bmad-module', config.installation.assets.bmad
    ? 'run the printed pinned BMAD installer command manually'
    : 'BMAD integration not selected'));

  return plan;
}

export function validateConfig(config, root, { checkBase = true } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('drydock.config.json must contain an object.');
  }
  if (!safeBranch(config.baseBranch)) throw new Error(`Invalid base branch: ${config.baseBranch}`);
  if (checkBase && !baseAvailable(config.baseBranch, root)) {
    throw new Error(`Base ref is not available locally: ${config.baseBranch}`);
  }
  if (!safeRelative(config.docksDir, root)) throw new Error(`Invalid docks directory: ${config.docksDir}`);
  validateBranchPattern(config.branchPattern);
  validateGates(config.gates);
  if (config.editor !== null && !safeTool(config.editor)) throw new Error(`Invalid editor command: ${config.editor}`);
  if (config.agent !== null && !safeTool(config.agent)) throw new Error(`Invalid agent command: ${config.agent}`);
  if (!config.installation || typeof config.installation !== 'object') {
    throw new Error('Missing installation configuration.');
  }
  if (!safePackageSpec(config.installation.cliSpec)) {
    throw new Error(`Invalid CLI package spec: ${config.installation.cliSpec}`);
  }
  const assets = config.installation.assets;
  if (!assets || ['github', 'vscode', 'bmad'].some((key) => typeof assets[key] !== 'boolean')) {
    throw new Error('installation.assets must define boolean github, vscode, and bmad values.');
  }
  return config;
}

export function baseAvailable(branch, root) {
  return tryRun('git', ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], { cwd: root }).ok
    || tryRun('git', ['rev-parse', '--verify', '--quiet', `origin/${branch}^{commit}`], { cwd: root }).ok;
}

export function expectedWorkflowGates(root) {
  const file = path.join(root, '.github', 'workflows', 'drydock-gates.yml');
  if (!fs.existsSync(file)) return null;
  const match = fs.readFileSync(file, 'utf8').match(/^\s*const REQUIRED_GATES = (\[[^;]+\]);\s*$/m);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function parseArgs(args) {
  const values = { github: true, vscode: false, bmad: false };
  const explicit = new Map();
  let yes = false;
  let dryRun = false;
  let force = false;
  const valueFlags = new Map([
    ['--base', 'baseBranch'], ['--base-branch', 'baseBranch'],
    ['--docks-dir', 'docksDir'], ['--branch-pattern', 'branchPattern'],
    ['--gates', 'gates'], ['--editor', 'editor'], ['--agent', 'agent'],
    ['--cli-spec', 'cliSpec'], ['--github-assets', 'github'],
    ['--vscode-assets', 'vscode'], ['--bmad-integration', 'bmad'],
  ]);

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--yes') { yes = true; continue; }
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--force') { force = true; continue; }
    if (arg === '--github' || arg === '--no-github') {
      setExplicit(values, explicit, 'github', arg === '--github'); continue;
    }
    if (arg === '--vscode' || arg === '--no-vscode') {
      setExplicit(values, explicit, 'vscode', arg === '--vscode'); continue;
    }
    if (arg === '--bmad' || arg === '--no-bmad') {
      setExplicit(values, explicit, 'bmad', arg === '--bmad'); continue;
    }
    const key = valueFlags.get(arg);
    if (!key) throw new Error(`Unknown init option: ${arg}`);
    const raw = args[++index];
    if (raw === undefined || raw.startsWith('--')) throw new Error(`${arg} requires a value.`);
    let value = raw;
    if (key === 'gates') value = raw.split(',').map((gate) => gate.trim()).filter(Boolean);
    if (['github', 'vscode', 'bmad'].includes(key)) value = parseBoolean(arg, raw);
    if (['editor', 'agent'].includes(key) && /^(none|null|off)$/i.test(raw)) value = null;
    setExplicit(values, explicit, key, value);
  }
  return { yes, dryRun, force, values, explicit };
}

function readExistingConfig(file, root) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Malformed drydock.config.json: ${error.message}`); }
  const config = deepMerge(DEFAULTS, raw);
  if (!raw.installation && raw.bmad?.enabled === true) config.installation.assets.bmad = true;
  return validateConfig(config, root);
}

function rejectConfigOverrides(explicit, config) {
  for (const [key, value] of explicit) {
    const actual = key === 'cliSpec' ? config.installation.cliSpec
      : ['github', 'vscode', 'bmad'].includes(key) ? config.installation.assets[key]
        : config[key];
    if (JSON.stringify(actual) !== JSON.stringify(value)) {
      throw new Error(`Existing drydock.config.json sets ${key} to ${JSON.stringify(actual)}; init never overwrites it.`);
    }
  }
}

function detectBaseBranch(root) {
  const remote = tryRun('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  if (remote.ok) return remote.out.replace(/^origin\//, '');
  const current = tryRun('git', ['branch', '--show-current'], { cwd: root });
  if (current.ok && current.out) return current.out;
  throw new Error('Could not detect a base branch. Pass `--base-branch <name>`.');
}

function validateBranchPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.includes('{issue}') || !pattern.includes('{slug}')) {
    throw new Error('branchPattern must include both {issue} and {slug}.');
  }
  const unknown = [...pattern.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])
    .filter((name) => !['issue', 'slug'].includes(name));
  if (unknown.length || !/^[A-Za-z0-9._/{\}-]+$/.test(pattern) || pattern.includes('..')) {
    throw new Error(`Invalid branch pattern: ${pattern}`);
  }
}

function validateGates(gates) {
  if (!Array.isArray(gates) || gates.length === 0) throw new Error('At least one gate is required.');
  if (gates.some((gate) => typeof gate !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(gate))) {
    throw new Error('Gate names must use lowercase letters, digits, and hyphens.');
  }
  if (new Set(gates).size !== gates.length) throw new Error('Gate names must be unique and ordered.');
}

function safeBranch(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('..')
    && /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith('-') && !value.endsWith('/');
}

function safeRelative(value, root) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\0')) return false;
  // Compared as resolved paths so every spelling of the root ('.', './', './/') is caught.
  const relative = path.relative(root, path.resolve(root, value));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
  // Windows folds case and strips trailing dots, so '.GIT' and '.git.' both reach .git.
  return relative.split(path.sep)[0].replace(/\.+$/, '').toLowerCase() !== '.git';
}

function safeTool(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value);
}

function safePackageSpec(value) {
  if (typeof value !== 'string' || /[\s;&|`$<>"']/.test(value)) return false;
  const npm = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  const github = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[A-Za-z0-9][A-Za-z0-9._/-]*$/;
  return npm.test(value) || github.test(value);
}

function parseBoolean(flag, raw) {
  if (/^(true|yes|1|on)$/i.test(raw)) return true;
  if (/^(false|no|0|off)$/i.test(raw)) return false;
  throw new Error(`${flag} expects true or false.`);
}

function setExplicit(values, explicit, key, value) {
  values[key] = value;
  explicit.set(key, value);
}

function template(relative, replacements = {}) {
  // Normalised because a Windows checkout may rewrite the packaged templates to CRLF.
  let content = fs.readFileSync(path.join(TEMPLATE_ROOT, relative), 'utf8').replaceAll('\r\n', '\n');
  for (const [key, value] of Object.entries(replacements)) content = content.replaceAll(`{{${key}}}`, value);
  return content;
}

function gitignoreBlock(docksDir) {
  const dockEntry = docksDir.replaceAll('\\', '/').replace(/\/$/, '') + '/';
  return `${GITIGNORE_MARKER}\n.drydock/tmp/\n${dockEntry}\n# <<< Drydock <<<\n`;
}

function vscodeTasks(config) {
  const prefix = ['--yes', '--package', config.installation.cliSpec, 'drydock'];
  const task = (label, args) => ({
    label, type: 'shell', command: 'npx', args: [...prefix, ...args], problemMatcher: [],
  });
  const tasks = [
    task('Drydock: status', ['status']),
    task('Drydock: start a dock', ['start', '${input:issue}']),
  ];
  for (const gate of config.gates) {
    tasks.push(task(`Drydock: gate ${gate} --pass`, ['gate', '${input:issue}', gate, '--pass', '--note', '${input:note}']));
    tasks.push(task(`Drydock: gate ${gate} --fail`, ['gate', '${input:issue}', gate, '--fail', '--note', '${input:note}']));
  }
  tasks.push(task('Drydock: land (dry run)', ['land', '${input:issue}', '--dry-run']));
  tasks.push(task('Drydock: land', ['land', '${input:issue}']));
  tasks.push(task('Drydock: clean merged docks', ['clean', '--merged']));
  return {
    version: '2.0.0', tasks,
    inputs: [
      { id: 'issue', type: 'promptString', description: 'GitHub issue number' },
      { id: 'note', type: 'promptString', description: 'Gate note recorded in the audit trail' },
    ],
  };
}

function vscodeExtensions() {
  return { recommendations: ['github.copilot', 'github.copilot-chat', 'github.vscode-pull-request-github'] };
}

function mergeTasks(current, desired) {
  if (!current || current.version !== '2.0.0' || !Array.isArray(current.tasks)
      || (current.inputs !== undefined && !Array.isArray(current.inputs))) {
    return { conflict: 'tasks.json does not match the expected VS Code task schema; merge manually' };
  }
  if (current.tasks.some((task) => !task || typeof task !== 'object' || typeof task.label !== 'string')) {
    return { conflict: 'tasks.json contains a task without a string label; merge manually' };
  }
  if ((current.inputs || []).some((input) => !input || typeof input !== 'object' || typeof input.id !== 'string')) {
    return { conflict: 'tasks.json contains an input without a string id; merge manually' };
  }
  const byLabel = new Map(current.tasks.map((task) => [task?.label, task]));
  if (byLabel.size !== current.tasks.length) return { conflict: 'tasks.json contains duplicate task labels' };
  for (const task of desired.tasks) {
    const existing = byLabel.get(task.label);
    if (existing && JSON.stringify(existing) !== JSON.stringify(task)) {
      return { conflict: `task identifier already exists with different content: ${task.label}` };
    }
  }
  const existingInputs = new Map((current.inputs || []).map((input) => [input?.id, input]));
  if (existingInputs.size !== (current.inputs || []).length) return { conflict: 'tasks.json contains duplicate input ids' };
  for (const input of desired.inputs) {
    const existing = existingInputs.get(input.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(input)) {
      return { conflict: `input identifier already exists with different content: ${input.id}` };
    }
  }
  const missingTasks = desired.tasks.filter((task) => !byLabel.has(task.label));
  const missingInputs = desired.inputs.filter((input) => !existingInputs.has(input.id));
  return {
    changed: missingTasks.length > 0 || missingInputs.length > 0,
    value: { ...current, tasks: [...current.tasks, ...missingTasks], inputs: [...(current.inputs || []), ...missingInputs] },
  };
}

function mergeExtensions(current, desired) {
  if (!current || !Array.isArray(current.recommendations)
      || current.recommendations.some((id) => typeof id !== 'string')) {
    return { conflict: 'extensions.json must contain a recommendations array; merge manually' };
  }
  const missing = desired.recommendations.filter((id) => !current.recommendations.includes(id));
  return {
    changed: missing.length > 0,
    value: { ...current, recommendations: [...current.recommendations, ...missing] },
  };
}

export async function interviewInitOptions(options, root, { io = null } = {}) {
  const config = deepMerge(options.config, {});
  await interview(async (ask) => {
    if (!options.explicit.has('baseBranch')) config.baseBranch = await ask(textQuestion('Base branch', config.baseBranch));
    if (!options.explicit.has('docksDir')) config.docksDir = await ask(textQuestion('Docks directory', config.docksDir));
    if (!options.explicit.has('branchPattern')) {
      config.branchPattern = await ask(textQuestion('Branch pattern', config.branchPattern));
    }
    if (!options.explicit.has('gates')) {
      const gates = await ask(textQuestion('Ordered gates (comma-separated)', config.gates.join(',')));
      config.gates = String(gates).split(',').map((gate) => gate.trim()).filter(Boolean);
    }
    if (!options.explicit.has('editor')) config.editor = nullable(await ask(textQuestion('Editor command (none to disable)', config.editor ?? 'none')));
    if (!options.explicit.has('agent')) config.agent = nullable(await ask(textQuestion('Agent command (none to disable)', config.agent ?? 'none')));
    if (!options.explicit.has('github')) {
      config.installation.assets.github = await ask(booleanQuestion('Install GitHub enforcement assets?', true));
    }
    if (!options.explicit.has('vscode')) {
      config.installation.assets.vscode = await ask(booleanQuestion('Install VS Code tasks and recommendations?', false));
    }
    if (!options.explicit.has('bmad')) {
      config.installation.assets.bmad = await ask(booleanQuestion('Show the BMAD integration command?', false));
    }
    if (!options.explicit.has('cliSpec')) {
      config.installation.cliSpec = await ask(textQuestion('Pinned Drydock CLI package spec', config.installation.cliSpec));
    }
  }, io);
  config.bmad.enabled = config.installation.assets.bmad;
  const withPolicy = await collectPolicy(config, { all: true, io });
  validateConfig(withPolicy, root);
  return { ...options, config: withPolicy };
}

export async function confirmScaffold({ io = null } = {}) {
  let confirmed = false;
  await interview(async (ask) => {
    confirmed = await ask(booleanQuestion('Apply this Drydock scaffold?', false));
  }, io);
  return confirmed;
}

function textQuestion(prompt, value) {
  return { prompt, default: value };
}

function booleanQuestion(prompt, value) {
  return { prompt, default: value, type: 'boolean' };
}

function nullable(value) {
  return /^(none|null|off)$/i.test(String(value)) ? null : value;
}