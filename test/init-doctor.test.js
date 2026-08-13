#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/drydock.js');
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'drydock-init-test-'));
const repo = path.join(scratch, 'repo');
let assertions = 0;

function check(fn) {
  fn();
  assertions++;
}

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function makeRepo(name) {
  const target = path.join(scratch, name);
  fs.mkdirSync(target, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: target });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: target });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: target });
  fs.writeFileSync(path.join(target, 'README.md'), '# existing project\n');
  execFileSync('git', ['add', '-A'], { cwd: target });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: target });
  return target;
}

function drydock(args) {
  return spawnSync('node', [CLI, ...args], { cwd: repo, encoding: 'utf8' });
}

function runIn(target, args) {
  return spawnSync('node', [CLI, ...args], { cwd: target, encoding: 'utf8' });
}

function snapshot(target = repo) {
  return fs.readdirSync(target, { recursive: true })
    .filter((entry) => entry !== '.git' && !String(entry).startsWith(`.git${path.sep}`))
    .sort()
    .map((entry) => {
      const absolute = path.join(target, entry);
      return fs.statSync(absolute).isDirectory()
        ? `dir:${entry}`
        : `file:${entry}:${fs.readFileSync(absolute, 'base64')}`;
    });
}

try {
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# existing project\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);

  const before = snapshot();
  const blocked = drydock(['init']);
  check(() => assert.notEqual(blocked.status, 0, 'non-TTY init without --yes must refuse to install'));
  check(() => assert.match(blocked.stdout + blocked.stderr, /--yes/));
  check(() => assert.deepEqual(snapshot(), before, 'refused init must not write any files'));

  const preview = drydock(['init', '--yes', '--dry-run']);
  check(() => assert.equal(preview.status, 0, preview.stdout + preview.stderr));
  check(() => assert.match(preview.stdout, /create\s+drydock\.config\.json/i));
  check(() => assert.deepEqual(snapshot(), before, 'dry-run must not write any files'));

  const installed = drydock([
    'init', '--yes', '--vscode', '--gates', 'review,security,qa',
    '--cli-spec', 'github:abmenace_microsoft/drydock#v0.1.0',
  ]);
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/drydock-gates.yml'), 'utf8');
  check(() => assert.equal(installed.status, 0, installed.stdout + installed.stderr));
  check(() => assert.match(workflow, /const REQUIRED_GATES = \["review","security","qa"\];/));
  const tasks = JSON.parse(fs.readFileSync(path.join(repo, '.vscode/tasks.json'), 'utf8'));
  check(() => assert.equal(tasks.tasks.some((task) => task.label === 'Drydock: run tests'), false));
  check(() => assert.deepEqual(tasks.tasks[0].args.slice(0, 4), [
    '--yes', '--package', 'github:abmenace_microsoft/drydock#v0.1.0', 'drydock',
  ]));

  const afterInstall = snapshot();
  const rerun = drydock(['init', '--yes']);
  check(() => assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr));
  check(() => assert.deepEqual(snapshot(), afterInstall, 'second identical init must be byte-for-byte idempotent'));

  const doctorBefore = snapshot();
  const examined = drydock(['doctor']);
  check(() => assert.match(examined.stdout, /pass\s+config/));
  check(() => assert.match(examined.stdout, /pass\s+workflow gate policy/));
  check(() => assert.match(examined.stdout, /unknown\s+GitHub required check|pass\s+GitHub required check/));
  check(() => assert.deepEqual(snapshot(), doctorBefore, 'doctor must not modify the repository'));

  fs.writeFileSync(
    path.join(repo, '.github/workflows/drydock-gates.yml'),
    workflow.replace('["review","security","qa"]', '["review","qa"]'),
  );
  const driftBefore = snapshot();
  const drift = drydock(['doctor']);
  check(() => assert.notEqual(drift.status, 0));
  check(() => assert.match(drift.stdout, /missing\s+workflow gate policy/));
  check(() => assert.deepEqual(snapshot(), driftBefore, 'doctor drift detection must remain read-only'));

  const invalidRepo = makeRepo('invalid');
  const invalidBefore = snapshot(invalidRepo);
  const invalid = runIn(invalidRepo, ['init', '--yes', '--gates', 'review,Review']);
  check(() => assert.notEqual(invalid.status, 0));
  check(() => assert.deepEqual(snapshot(invalidRepo), invalidBefore, 'invalid options must fail before the first write'));

  // A docks directory must never resolve to the repository root or into .git,
  // whichever way it is spelled.
  for (const args of [
    ['--branch-pattern', 'feat/{issue}'],
    ['--base-branch', 'missing'],
    ['--cli-spec', 'drydock@latest'],
    ['--docks-dir', '../outside'],
    ['--docks-dir', '.'],
    ['--docks-dir', './'],
    ['--docks-dir', './/'],
    ['--docks-dir', 'work/..'],
    ['--docks-dir', '.git'],
    ['--docks-dir', '.git/'],
    ['--docks-dir', '.git/worktrees'],
    ['--docks-dir', '.GIT'],
    ['--docks-dir', '.git.'],
  ]) {
    const cleanRepo = makeRepo(`invalid-${assertions}`);
    const cleanBefore = snapshot(cleanRepo);
    const result = runIn(cleanRepo, ['init', '--yes', ...args]);
    check(() => assert.notEqual(result.status, 0, `${args[1]} should be rejected`));
    check(() => assert.deepEqual(snapshot(cleanRepo), cleanBefore, `${args[1]} must fail before writing`));
  }

  for (const docksDir of ['.docks', 'work/docks', '.dd']) {
    const validRepo = makeRepo(`valid-${assertions}`);
    const accepted = runIn(validRepo, ['init', '--yes', '--docks-dir', docksDir]);
    check(() => assert.equal(accepted.status, 0, `${docksDir} should be accepted: ${accepted.stdout}${accepted.stderr}`));
  }

  fs.writeFileSync(path.join(invalidRepo, 'drydock.config.json'), '{ invalid json');
  const malformedBefore = snapshot(invalidRepo);
  const malformed = runIn(invalidRepo, ['init', '--yes', '--force']);
  check(() => assert.notEqual(malformed.status, 0));
  check(() => assert.deepEqual(snapshot(invalidRepo), malformedBefore, 'malformed config must remain unchanged even with --force'));

  const conflictRepo = makeRepo('conflict');
  const workflowPath = path.join(conflictRepo, '.github/workflows/drydock-gates.yml');
  const tasksPath = path.join(conflictRepo, '.vscode/tasks.json');
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(workflowPath, '# project workflow\n');
  fs.writeFileSync(tasksPath, '{\n  // project JSONC\n  "version": "2.0.0",\n  "tasks": []\n}\n');
  const workflowBefore = fs.readFileSync(workflowPath);
  const tasksBefore = fs.readFileSync(tasksPath);
  const conflicted = runIn(conflictRepo, ['init', '--yes', '--vscode']);
  check(() => assert.notEqual(conflicted.status, 0, 'reported collisions must make init nonzero'));
  check(() => assert.match(conflicted.stdout + conflicted.stderr, /conflict\s+\.github\/workflows\/drydock-gates\.yml/));
  check(() => assert.match(conflicted.stdout + conflicted.stderr, /conflict\s+\.vscode\/tasks\.json/));
  check(() => assert.deepEqual(fs.readFileSync(workflowPath), workflowBefore, 'dedicated workflow collision must be unchanged'));
  check(() => assert.deepEqual(fs.readFileSync(tasksPath), tasksBefore, 'JSONC task file must be unchanged'));
  check(() => assert.equal(fs.existsSync(path.join(conflictRepo, 'drydock.config.json')), true, 'non-conflicting operations still apply'));

  const mergeRepo = makeRepo('merge');
  fs.mkdirSync(path.join(mergeRepo, '.github'), { recursive: true });
  fs.mkdirSync(path.join(mergeRepo, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(mergeRepo, '.github/copilot-instructions.md'), '# Project rules\n');
  fs.writeFileSync(path.join(mergeRepo, '.vscode/tasks.json'), JSON.stringify({
    version: '2.0.0',
    tasks: [{ label: 'Project: build', type: 'shell', command: 'npm run build' }],
  }, null, 2) + '\n');
  const mergedInstall = runIn(mergeRepo, ['init', '--yes', '--vscode']);
  check(() => assert.equal(mergedInstall.status, 0, mergedInstall.stdout + mergedInstall.stderr));
  const mergedTasks = JSON.parse(fs.readFileSync(path.join(mergeRepo, '.vscode/tasks.json'), 'utf8'));
  check(() => assert.equal(mergedTasks.tasks[0].label, 'Project: build'));
  check(() => assert.equal(mergedTasks.tasks.some((task) => task.label === 'Drydock: status'), true));
  const instructions = fs.readFileSync(path.join(mergeRepo, '.github/copilot-instructions.md'), 'utf8');
  check(() => assert.match(instructions, /^# Project rules/m));
  check(() => assert.equal(instructions.match(/<!-- drydock:start -->/g)?.length, 1));

  const templateRepo = makeRepo('template');
  for (const relative of [
    '.github/copilot-instructions.md',
    '.github/agents/drydock-dev.md',
    '.github/agents/drydock-reviewer.md',
    '.github/agents/drydock-qa.md',
    '.github/workflows/drydock-gates.yml',
    '.github/ISSUE_TEMPLATE/drydock-feature.yml',
  ]) {
    const destination = path.join(templateRepo, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(SOURCE_ROOT, relative), destination);
  }
  const templateInstall = runIn(templateRepo, ['init', '--yes']);
  check(() => assert.equal(templateInstall.status, 0, templateInstall.stdout + templateInstall.stderr));
  check(() => assert.doesNotMatch(templateInstall.stdout + templateInstall.stderr, /conflict\s+/));

  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(outside);
  const outsideDoctor = runIn(outside, ['doctor']);
  check(() => assert.notEqual(outsideDoctor.status, 0));
  check(() => assert.match(outsideDoctor.stdout + outsideDoctor.stderr, /missing repository/));

  // An installer that publishes without its templates is broken on npm but green in tests.
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: SOURCE_ROOT, encoding: 'utf8', shell: process.platform === 'win32',
  });
  check(() => assert.equal(packed.status, 0, packed.stderr));
  const shipped = JSON.parse(packed.stdout)[0].files.map((entry) => entry.path);
  const localTemplates = fs.readdirSync(path.join(SOURCE_ROOT, 'templates'), { recursive: true })
    .map((entry) => `templates/${String(entry).split(path.sep).join('/')}`)
    .filter((entry) => fs.statSync(path.join(SOURCE_ROOT, entry)).isFile());
  for (const required of ['bin/drydock.js', 'src/cli.js', 'src/commands/setup.js', 'package.json', ...localTemplates]) {
    check(() => assert.ok(shipped.includes(required), `published package is missing ${required}`));
  }

  console.log(`init/doctor: ${assertions} passed, 0 failed`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}