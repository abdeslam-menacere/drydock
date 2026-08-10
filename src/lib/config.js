import fs from 'node:fs';
import path from 'node:path';
import { run, tryRun } from './sh.js';
import { die } from './log.js';

export const CONFIG_FILE = 'drydock.config.json';
export const STATE_DIR = '.drydock';

export const DEFAULTS = {
  $schema: 'https://drydock.dev/schema/v1.json',
  version: 1,
  // Where isolated worktrees are created, relative to the repo root's parent.
  docksDir: '../.docks',
  // Branch naming. {issue} and {slug} are substituted.
  branchPattern: 'feat/{issue}-{slug}',
  baseBranch: 'main',
  // Gates that must pass, in order, before `drydock land` will open a PR.
  gates: ['review', 'qa'],
  // Open an editor window per dock. Set to null for headless/CI use.
  editor: 'code',
  // Which agent CLI to hand the dock to. Informational in v1.
  agent: 'copilot',
  bmad: {
    enabled: true,
    module: 'drydock',
  },
};

/**
 * Absolute path to the MAIN repo root, or exit.
 *
 * Deliberately not `--show-toplevel`: inside a dock worktree that returns the
 * worktree, which has no config and no manifests. `--git-common-dir` points at
 * the shared .git in both cases, so its parent is always the main working tree.
 * This is what lets you run drydock from inside the dock you're working in.
 */
export function repoRoot() {
  const common = tryRun('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.ok && common.out) return path.dirname(common.out);
  const top = tryRun('git', ['rev-parse', '--show-toplevel']);
  if (!top.ok) die('Not inside a git repository.', 'Run this from your project root.');
  return top.out;
}

export function configPath(root = repoRoot()) {
  return path.join(root, CONFIG_FILE);
}

export function loadConfig(root = repoRoot()) {
  const p = configPath(root);
  if (!fs.existsSync(p)) {
    die(`No ${CONFIG_FILE} found.`, 'Run `drydock init` first.');
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { ...DEFAULTS, ...raw, bmad: { ...DEFAULTS.bmad, ...(raw.bmad || {}) } };
}

export function saveConfig(cfg, root = repoRoot()) {
  fs.writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + '\n');
}

export function stateDir(root = repoRoot()) {
  const d = path.join(root, STATE_DIR, 'docks');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function dockPath(issue, root = repoRoot()) {
  return path.join(stateDir(root), `${issue}.json`);
}

export function readDock(issue, root = repoRoot()) {
  const p = dockPath(issue, root);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeDock(dock, root = repoRoot()) {
  fs.writeFileSync(dockPath(dock.issue, root), JSON.stringify(dock, null, 2) + '\n');
  return dock;
}

export function listDocks(root = repoRoot()) {
  const d = stateDir(root);
  return fs.readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')))
    .sort((a, b) => Number(a.issue) - Number(b.issue));
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'work';
}
