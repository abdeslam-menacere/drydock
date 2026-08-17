import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, listDocks, CONFIG_FILE, STATE_DIR } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import { parseArgs } from '../lib/args.js';
import { interactive, interview } from '../lib/prompt.js';
import * as git from '../lib/git.js';

/**
 * Take Drydock's source tree back out of a project.
 *
 * The template distribution puts the whole CLI — `src/`, `test/`, its README,
 * its SPEC — at the root of the consuming repo, where it squats on every path a
 * real project wants first. A project that adopts Drydock should carry its
 * *policy*, not its implementation.
 *
 * Two modes, because "get this out of my repo" means two different things:
 *
 *   default   detach — remove the vendored tooling, keep the working footprint.
 *             The repo still uses Drydock, via a CLI installed once, globally.
 *   --purge   uninstall — remove the footprint too. No Drydock left.
 *
 * Everything here is a fixed whitelist. Nothing is globbed and nothing is
 * inferred, because the cost of a wrong guess is someone's source file.
 */

/** How the template's VS Code tasks invoke the CLI they ship alongside. */
const VENDORED_CLI = /node \$\{workspaceFolder\}\/bin\/drydock\.js/;

/**
 * The template's test task runs Drydock's *own* suite. Repointing it is not
 * enough — the file it names is one of the things being deleted, so the task
 * has to go entirely or it becomes a default test action that always fails.
 */
const VENDORED_TESTS = /node \$\{workspaceFolder\}\/test\/smoke\.test\.js/;

/** Drydock's own implementation. Never a consuming project's. */
const TOOLING = [
  'bin',
  'src',
  'skills',
  'bmad-module',
  '.claude-plugin',
  'plugin.json',
  'drydock.code-workspace',
];

/** Drydock's own tests. `test/` itself may be the project's — only this file. */
const TOOLING_FILES = [
  'test/smoke.test.js',
];

/**
 * Drydock's documentation, named one by one.
 *
 * Never `docs/` wholesale: ModelTree had `docs/product/` and `docs/adr/` of its
 * own sitting alongside these, and removing the directory would have taken a
 * product brief and an architecture decision record with it.
 */
const TOOLING_DOCS = [
  'docs/GETTING-STARTED.md',
  'docs/WORKFLOW.md',
  'docs/ROLES.md',
  'docs/ADOPTION.md',
  'docs/DEMO-SCRIPT.md',
];

/**
 * Files a project needs for itself but which arrive holding Drydock's identity.
 * Removed only while they still *are* Drydock's — once someone has written their
 * own README over the top, it is theirs and we do not touch it.
 */
const IDENTITY = [
  { file: 'README.md', is: (s) => /^#\s*⚓?\s*Drydock\b/m.test(s) || s.includes('Every feature gets its own dock') },
  { file: 'SPEC.md', is: (s) => s.includes('Drydock — Design Specification') },
  { file: 'AGENTS.md', is: (s) => s.includes('Agent instructions') && s.includes('Drydock') },
];

/** The per-project footprint. Kept on detach, removed on purge. */
const FOOTPRINT = [
  CONFIG_FILE,
  STATE_DIR,
  '.github/workflows/drydock-gates.yml',
  '.github/agents/drydock-dev.md',
  '.github/agents/drydock-reviewer.md',
  '.github/agents/drydock-qa.md',
  '.github/ISSUE_TEMPLATE/feature.yml',
];

/**
 * Never deleted, only reported. Both are files a repository must have, and
 * guessing at a replacement is worse than leaving a wrong one in place with a
 * note saying so.
 */
const MANUAL = [
  { file: 'package.json', why: 'declares the drydock CLI — replace with your project’s own', is: (s) => tryJson(s)?.name === 'drydock' },
  { file: 'LICENSE', why: 'Drydock’s MIT licence — replace with your project’s', is: () => true },
];

export default async function eject(args) {
  const { flags, unknown } = parseArgs(args, { flags: ['--purge', '--yes', '--dry-run'] });
  if (unknown.length) die(`Unknown argument: ${unknown[0]}`, 'Usage: drydock eject [--purge] [--yes] [--dry-run]');

  const purge = flags.has('--purge');
  const dryRun = flags.has('--dry-run');
  const root = repoRoot();

  // Docks in flight depend on the config and manifests purge would delete.
  if (purge) {
    const open = listDocks(root).filter((d) => d.status !== 'landed');
    if (open.length) {
      die(
        `${open.length} dock${open.length > 1 ? 's' : ''} still in flight: ${open.map((d) => '#' + d.issue).join(', ')}`,
        'Land or `drydock clean` them first — purge removes the manifests they run on.',
      );
    }
  }

  const plan = buildPlan(root, purge);

  if (!plan.remove.length && !plan.rewrite.length) {
    log.info('Nothing to eject — no Drydock tooling found in this repo.');
    return;
  }

  report(plan, purge, root);

  if (dryRun) {
    log.head('Dry run');
    log.dim('Nothing was changed. Drop --dry-run to apply.');
    return;
  }

  // A dirty tree makes this irreversible. Clean, it is one `git checkout` away.
  if (git.isDirty(root)) {
    die(
      'Working tree has uncommitted changes.',
      'Commit or stash first — a clean tree is what makes this revertible.',
    );
  }

  if (!flags.has('--yes') && !(await confirm(plan))) {
    log.info('Nothing was changed.');
    return;
  }

  apply(plan, root);
  farewell(purge);
}

function buildPlan(root, purge) {
  const remove = [];
  const rewrite = [];
  const manual = [];
  const kept = [];

  const exists = (rel) => fs.existsSync(path.join(root, rel));

  for (const rel of [...TOOLING, ...TOOLING_FILES, ...TOOLING_DOCS]) {
    if (exists(rel)) remove.push(rel);
  }

  for (const { file, is } of IDENTITY) {
    if (!exists(file)) continue;
    if (is(fs.readFileSync(path.join(root, file), 'utf8'))) remove.push(file);
    else kept.push({ file, why: 'you have rewritten it — it is yours now' });
  }

  for (const { file, why, is } of MANUAL) {
    if (!exists(file)) continue;
    if (is(fs.readFileSync(path.join(root, file), 'utf8'))) manual.push({ file, why });
  }

  if (purge) {
    for (const rel of FOOTPRINT) if (exists(rel)) remove.push(rel);
    if (exists('.vscode/tasks.json')) rewrite.push({ file: '.vscode/tasks.json', how: 'drop' });
    if (exists('.gitignore')) rewrite.push({ file: '.gitignore', how: 'unignore' });
    if (exists('.github/copilot-instructions.md')) manual.push({
      file: '.github/copilot-instructions.md',
      why: 'may hold your own agent rules alongside Drydock’s — review before deleting',
    });
  } else {
    for (const rel of FOOTPRINT) if (exists(rel)) kept.push({ file: rel, why: 'your policy and audit trail' });
    // The tasks call `node ${workspaceFolder}/bin/drydock.js`, which this very
    // command is about to delete. Repoint them at the installed CLI — but only
    // while they still point at ./bin, so a second run has nothing left to do.
    if (exists('.vscode/tasks.json')) {
      const src = fs.readFileSync(path.join(root, '.vscode/tasks.json'), 'utf8');
      if (VENDORED_CLI.test(src) || VENDORED_TESTS.test(src)) {
        rewrite.push({ file: '.vscode/tasks.json', how: 'repoint' });
      }
    }
  }

  return { remove, rewrite, manual, kept };
}

function report(plan, purge, root) {
  log.head(purge ? 'Purge — removing Drydock entirely' : 'Eject — removing Drydock’s tooling');

  log.head(`Remove (${plan.remove.length})`);
  let bytes = 0, files = 0;
  for (const rel of plan.remove) {
    const m = measure(path.join(root, rel));
    bytes += m.bytes; files += m.files;
    log.raw(`  − ${rel}${m.files > 1 ? `  (${m.files} files)` : ''}`);
  }
  log.dim(`${files} files, ${(bytes / 1024).toFixed(0)} KB`);

  if (plan.rewrite.length) {
    log.head('Rewrite');
    for (const r of plan.rewrite) {
      log.raw(`  ~ ${r.file}`);
      log.dim(r.how === 'repoint' ? 'point tasks at the installed `drydock` instead of ./bin'
        : r.how === 'drop' ? 'remove the Drydock tasks'
        : 'remove the Drydock ignore lines');
    }
  }

  if (plan.kept.length) {
    log.head('Keep');
    for (const k of plan.kept) { log.raw(`  = ${k.file}`); log.dim(k.why); }
  }

  if (plan.manual.length) {
    log.head('Yours to deal with — not touched');
    for (const m of plan.manual) { log.raw(`  ! ${m.file}`); log.dim(m.why); }
  }
}

async function confirm(plan) {
  if (!interactive()) {
    die('Refusing to eject without confirmation.', 'Re-run with --yes, or --dry-run to preview.');
  }
  return interview(async (ask) => ask({
    type: 'boolean',
    prompt: `Remove ${plan.remove.length} path${plan.remove.length > 1 ? 's' : ''}? The tree is clean, so this is revertible with git.`,
    default: false,
  }));
}

function apply(plan, root) {
  for (const rel of plan.remove) {
    fs.rmSync(path.join(root, rel), { recursive: true, force: true });
    log.ok(`removed ${rel}`);
  }

  // `test/` only ever held smoke.test.js in a template-made repo; if the project
  // put its own tests there it stays.
  const testDir = path.join(root, 'test');
  if (fs.existsSync(testDir) && fs.readdirSync(testDir).length === 0) {
    fs.rmdirSync(testDir);
    log.ok('removed test/ (empty)');
  }

  for (const r of plan.rewrite) {
    if (r.how === 'repoint') repointTasks(root);
    if (r.how === 'drop') dropTasks(root);
    if (r.how === 'unignore') unignore(root);
    log.ok(`rewrote ${r.file}`);
  }
}

/**
 * `node ${workspaceFolder}/bin/drydock.js x` → `drydock x`, and drop the task
 * that ran Drydock's own test suite.
 *
 * The repoint is a string replace so comments and formatting survive; the drop
 * needs the document parsed, so it is only paid for when such a task exists.
 */
function repointTasks(root) {
  const p = path.join(root, '.vscode/tasks.json');
  const src = fs.readFileSync(p, 'utf8');
  const repointed = src.replace(new RegExp(VENDORED_CLI.source, 'g'), 'drydock');

  if (!VENDORED_TESTS.test(repointed)) { fs.writeFileSync(p, repointed); return; }

  const doc = tryJson(stripComments(repointed));
  if (!doc?.tasks) { fs.writeFileSync(p, repointed); return; }
  doc.tasks = doc.tasks.filter((t) => !VENDORED_TESTS.test(t.command || ''));
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
}

function dropTasks(root) {
  const p = path.join(root, '.vscode/tasks.json');
  const doc = tryJson(stripComments(fs.readFileSync(p, 'utf8')));
  if (!doc?.tasks) return;

  doc.tasks = doc.tasks.filter((t) => !/^Drydock:/.test(t.label || ''));
  if (!doc.tasks.length) { fs.rmSync(p, { force: true }); return; }
  if (doc.inputs) doc.inputs = doc.inputs.filter((i) => !['issue', 'note'].includes(i.id));
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
}

function unignore(root) {
  const p = path.join(root, '.gitignore');
  const kept = fs.readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !['# Drydock', '.drydock/tmp/', '.docks/'].includes(l.trim()));
  fs.writeFileSync(p, kept.join('\n').replace(/\n{3,}/g, '\n\n'));
}

function farewell(purge) {
  if (purge) {
    log.head('Drydock removed');
    log.dim('Gate history is still in your git log, and in any pull request receipts.');
    return;
  }
  log.head('Tooling removed — Drydock still runs here');
  log.raw('  Install the CLI once, globally, then carry on as before:');
  log.raw('');
  log.raw('    npm i -g drydock          # or: npm link, from a drydock clone');
  log.raw('');
  log.dim('Your config, audit trail, gates workflow, and agent contracts all stayed.');
  log.dim('Reclaim README.md and package.json for your project — they were Drydock’s.');
}

function measure(abs) {
  const st = fs.statSync(abs);
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0, bytes = 0;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const m = measure(path.join(abs, e.name));
    files += m.files; bytes += m.bytes;
  }
  return { files, bytes };
}

const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, '');
function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }
