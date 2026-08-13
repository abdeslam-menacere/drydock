#!/usr/bin/env node
// Full-loop smoke test against a scratch repo. No network, no gh required.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { pendingQuestions } from '../src/lib/config.js';
import { QUESTIONS, SCHEMA_VERSION } from '../src/lib/questions.js';
import { runInterview } from '../src/commands/config.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/drydock.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drydock-test-'));
const repo = path.join(tmp, 'repo');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? '\n      ' + extra : ''}`); }
};
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const dd = (args, cwd = repo) => spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
const ddEnv = (args, env, cwd = repo) =>
  spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const cfgFile = path.join(repo, 'drydock.config.json');
const readCfg = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const gitignore = () => fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

/** Drive the real interview over scripted streams, capturing what it asked. */
async function answer(lines, opts = {}) {
  const queue = [...lines];
  let asked = '';
  const input = new Readable({ read() {} });
  // One answer per prompt: feed the next line only once a question has been
  // written, otherwise readline swallows the whole script on the first read.
  const output = new Writable({
    write(chunk, _enc, cb) {
      const text = String(chunk);
      asked += text;
      if (text.endsWith(': ')) input.push(queue.length ? queue.shift() + '\n' : null);
      cb();
    },
  });

  const real = console.log;
  console.log = () => {};
  try {
    const cfg = await runInterview(repo, { ...opts, io: { input, output } });
    return { cfg, asked };
  } finally {
    console.log = real;
  }
}

console.log('\nDrydock smoke test');

// --- setup ---
fs.mkdirSync(repo, { recursive: true });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'test@example.com']);
git(['config', 'user.name', 'test']);
fs.writeFileSync(path.join(repo, 'README.md'), '# scratch\n');
git(['add', '-A']); git(['commit', '-qm', 'init']);

console.log('\ninit');
ok('exits 0', dd(['init', '--yes']).status === 0);
ok('writes config', fs.existsSync(cfgFile));
ok('creates state dir', fs.existsSync(path.join(repo, '.drydock', 'docks')));
ok('ignores .docks/', /^\.docks\/$/m.test(gitignore()));
dd(['init', '--yes', '--force']);
ok('re-running init does not duplicate the ignore entry',
  gitignore().split(/\r?\n/).filter((l) => l.trim() === '.docks/').length === 1, gitignore());

console.log('\nconfig');
dd(['config', 'reset', '--all']);
// The wizard must never block: every command here runs with a piped stdin, the
// same as CI and any agent shelling out. A prompt would hang this suite forever.
const wizard = dd(['config']);
ok('wizard exits 0 when stdin is not a tty', wizard.status === 0, wizard.stderr);
ok('wizard says how to configure instead', (wizard.stdout + wizard.stderr).includes('drydock config set'));
ok('wizard does not claim setup completed', readCfg().setup.completed !== true);
const forced = ddEnv(['config'], { DRYDOCK_NONINTERACTIVE: '1' });
ok('DRYDOCK_NONINTERACTIVE=1 skips it too',
  forced.status === 0 && (forced.stdout + forced.stderr).includes('cannot prompt'), forced.stderr);

const policy = json(dd(['config', 'show', '--json']));
ok('show --json emits parseable JSON and nothing else', policy !== null, dd(['config', 'show', '--json']).stdout);
ok('reports setup.completed false before setup', policy?.setup.completed === false);
ok('docksDir defaults to .docks', policy?.docksDir === '.docks');
ok('nested policy defaults present',
  policy?.comments.verbosity === 'full' && policy?.autonomy.merge.method === 'squash');

ok('set exits 0', dd(['config', 'set', 'comments.verbosity', 'off']).status === 0);
const afterSet = json(dd(['config', 'show', '--json']));
ok('set round-trips', afterSet?.comments.verbosity === 'off');
ok('set leaves siblings alone',
  afterSet?.comments.enabled === true && afterSet?.autonomy.merge.method === 'squash');
dd(['config', 'set', 'autonomy.merge.enabled', 'false']);
ok('set coerces to the schema type', json(dd(['config', 'show', '--json']))?.autonomy.merge.enabled === false);
ok('set rejects an unknown key', dd(['config', 'set', 'nope.nope', '1']).status !== 0);
ok('set rejects a value outside the schema', dd(['config', 'set', 'comments.verbosity', 'loud']).status !== 0);
ok('set rejects a whole section', dd(['config', 'set', 'comments', 'off']).status !== 0);

// A config file that names one nested key must keep every sibling default.
fs.writeFileSync(cfgFile, JSON.stringify({ comments: { verbosity: 'milestones' } }, null, 2));
const merged = json(dd(['config', 'show', '--json']));
ok('partial config keeps its own value', merged?.comments.verbosity === 'milestones');
ok('partial config keeps nested defaults',
  merged?.comments.enabled === true && merged?.comments.cliLifecycle === true);
ok('partial config keeps top-level defaults', merged?.baseBranch === 'main' && merged?.docksDir === '.docks');

ok('reset exits 0', dd(['config', 'reset']).status === 0);
ok('reset restores policy defaults', json(dd(['config', 'show', '--json']))?.comments.verbosity === 'full');

// Asked once, then only ever asked what is new.
const bumped = [{ id: 'a', schemaVersion: 1 }, { id: 'b', schemaVersion: 2 }];
ok('an unconfigured repo is asked everything',
  pendingQuestions({ setup: { completed: false, schemaVersion: 0 } }, bumped).length === 2);
ok('a configured repo is asked nothing',
  pendingQuestions({ setup: { completed: true, schemaVersion: SCHEMA_VERSION } }).length === 0);
ok('a schema bump asks only the new question',
  pendingQuestions({ setup: { completed: true, schemaVersion: 1 } }, bumped).map((q) => q.id).join() === 'b');
ok('every shipped question is versioned',
  QUESTIONS.every((q) => Number.isInteger(q.schemaVersion) && q.schemaVersion >= 1));

console.log('\ninterview');
// Preset 2 = trust-but-verify, then decline to customise.
const first = await answer(['2', 'n']);
ok('asks the preset question', first.asked.includes('How much should Drydock do on its own?'));
ok('a declined customise skips the detail', !first.asked.includes('Autonomy level'));
const answered = readCfg();
ok('marks setup completed', answered.setup.completed === true);
ok('stamps the schema version it asked', answered.setup.schemaVersion === SCHEMA_VERSION);
ok('records when', typeof answered.setup.at === 'string' && answered.setup.at.length > 0);
ok('applies the chosen preset', answered.autonomy.level === 'gated-merge'
  && answered.autonomy.merge.enabled === false
  && answered.comments.verbosity === 'milestones-findings');
ok('show --json reflects the answers', json(dd(['config', 'show', '--json']))?.autonomy.level === 'gated-merge');

const again = await answer(['1', 'n']);
ok('never asks a second time', again.asked === '');
ok('and leaves the answers alone', readCfg().autonomy.level === 'gated-merge');

const reopened = await answer(['1', 'y', ...Array(QUESTIONS.length).fill('')], { all: true });
ok('--all reopens the interview', reopened.asked.includes('How much should Drydock do on its own?'));
ok('customise reaches the detail questions', reopened.asked.includes('Autonomy level'));
ok('blank answers keep the preset value', readCfg().autonomy.level === 'full');
ok('start is not blocked once configured', readCfg().setup.completed === true);

dd(['init', '--yes', '--force']);

console.log('\nstart');
const s = dd(['start', '412']);
ok('exits 0', s.status === 0, s.stderr);
const dock = JSON.parse(fs.readFileSync(path.join(repo, '.drydock/docks/412.json'), 'utf8'));
ok('creates worktree', fs.existsSync(dock.worktree));
ok('creates DOCK.md', fs.existsSync(path.join(dock.worktree, 'DOCK.md')));
ok('creates branch', git(['branch', '--list', dock.branch]).length > 0);
ok('gates start unset', Object.values(dock.gates).every((g) => g === null));
ok('dock lives inside the repo', dock.worktree.startsWith(repo + path.sep));
ok('dock lives under .docks', path.relative(repo, dock.worktree).split(path.sep)[0] === '.docks');
ok('git ignores the docks directory', !git(['status', '--porcelain']).includes('.docks'));
ok('start does not warn once setup is complete', !(s.stdout + s.stderr).includes('drydock config'));

// The brief is scaffolding. If git sees it, every dock is born dirty and `land`
// refuses forever — the exact bug that blocked the first live autonomous run.
const excludeFile = path.join(repo, '.git', 'info', 'exclude');
const excludeLines = () => fs.readFileSync(excludeFile, 'utf8').split(/\r?\n/).map((l) => l.trim());
ok('start leaves the worktree clean', git(['status', '--porcelain'], dock.worktree) === '',
  git(['status', '--porcelain'], dock.worktree));
ok('start excludes DOCK.md', excludeLines().includes('/DOCK.md'));
ok('git does not see DOCK.md at all', !git(['status', '--porcelain', '-uall'], dock.worktree).includes('DOCK.md'));

console.log('\nisolation');
dd(['start', '415']);
const d415 = JSON.parse(fs.readFileSync(path.join(repo, '.drydock/docks/415.json'), 'utf8'));
ok('two docks, distinct worktrees', d415.worktree !== dock.worktree);
ok('two docks, distinct branches', d415.branch !== dock.branch);
ok('a second dock is clean too', git(['status', '--porcelain'], d415.worktree) === '');
ok('the exclude entry is written once, not per dock',
  excludeLines().filter((l) => l === '/DOCK.md').length === 1);

// agent does work — with the sweeping `git add -A` a real agent reaches for
fs.writeFileSync(path.join(dock.worktree, 'refund.js'), 'export const refund = () => {};\n');
git(['add', '-A'], dock.worktree); git(['commit', '-qm', 'feat: refund'], dock.worktree);
ok('add -A does not sweep DOCK.md into the commit', git(['ls-files', 'DOCK.md'], dock.worktree) === '');

console.log('\nrunning from inside a dock');
// The dock worktree has no drydock.config.json — commands must still resolve
// the main repo. `drydock start` tells you to cd here, so it has to work.
const inDock = dd(['status'], dock.worktree);
ok('status works from inside the worktree', inDock.status === 0, inDock.stderr);
ok('and sees the dock', inDock.stdout.includes('#412'));

console.log('\ngate ordering');
ok('qa blocked before review', dd(['gate', '412', 'qa', '--pass']).status !== 0);
ok('review passes', dd(['gate', '412', 'review', '--pass', '--note', 'ok']).status === 0);
ok('qa now passes', dd(['gate', '412', 'qa', '--pass']).status === 0);

console.log('\nland');
const dry = dd(['land', '412', '--dry-run']);
ok('dry-run succeeds with fresh gates', dry.status === 0, dry.stdout + dry.stderr);
ok('DOCK.md is not in the diff that would be pushed',
  !git(['diff', '--name-only', 'main...HEAD'], dock.worktree).includes('DOCK.md'));
ok('receipt marker present', dry.stdout.includes('**drydock-receipt:v1**'));
ok('marker is not an HTML comment', !dry.stdout.includes('<!-- drydock-receipt'));
const head = git(['rev-parse', 'HEAD'], dock.worktree);
const rows = [...dry.stdout.matchAll(/^\|\s*([a-z0-9-]+)\s*\|\s*✅\s*pass\s*\|\s*`([0-9a-f]{7,40})`/gim)];
ok('CI regex parses both gates', rows.length === 2, `parsed ${rows.length}`);
ok('receipt SHAs match HEAD', rows.every((r) => head.startsWith(r[2])));

console.log('\nCI contract');
// The workflow and the CLI each used to carry a private copy of the receipt
// contract, with nothing checking they agreed — that is how the HTML-comment
// bug shipped. Read the real patterns out of the workflow file and apply them
// to the CLI's real output, so the two cannot silently drift apart again.
const wfPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.github/workflows/drydock-gates.yml');
const wf = fs.readFileSync(wfPath, 'utf8');
const literalOf = (name) => {
  const m = wf.match(new RegExp(`^\\s*const ${name} = (/.*/[a-z]*);\\s*$`, 'm'));
  return m && m[1];
};
const toRegExp = (lit) => {
  const i = lit.lastIndexOf('/');
  return new RegExp(lit.slice(1, i), lit.slice(i + 1));
};
const markerLit = literalOf('RECEIPT_MARKER');
const rowLit = literalOf('ROW_RE');
ok('workflow declares RECEIPT_MARKER', !!markerLit, 'expected `const RECEIPT_MARKER = /.../;` in the workflow');
ok('workflow declares ROW_RE', !!rowLit, 'expected `const ROW_RE = /.../;` in the workflow');

const MARKER = toRegExp(markerLit);
const ROW = () => toRegExp(rowLit); // fresh each use — the /g flag is stateful

ok("workflow's marker matches the CLI receipt", MARKER.test(dry.stdout));
ok("workflow's row regex parses the CLI receipt", [...dry.stdout.matchAll(ROW())].length === 2);
// The GitHub MCP server deletes HTML comments from PR bodies.
ok('marker survives HTML-comment stripping', MARKER.test(dry.stdout.replace(/<!--[\s\S]*?-->/g, '')));
ok('legacy HTML-comment marker still accepted', MARKER.test('Closes #1\n\n<!-- drydock-receipt:v1 -->\n### Drydock gate receipt\n'));

// The workflow's verdict, evaluated here against the patterns it actually uses.
const evaluate = (body, headSha, required = ['review', 'qa']) => {
  if (!MARKER.test(body)) return ['no receipt'];
  const seen = new Map([...body.matchAll(ROW())].map((r) => [r[1], r[2]]));
  return required.flatMap((gate) => {
    const sha = seen.get(gate);
    if (!sha) return [`gate "${gate}" is missing or did not pass`];
    return headSha.startsWith(sha) ? [] : [`gate "${gate}" is STALE`];
  });
};
ok('CI accepts a fresh receipt', evaluate(dry.stdout, head).length === 0, evaluate(dry.stdout, head).join('; '));
ok('CI fails a stale receipt', evaluate(dry.stdout, 'f'.repeat(40)).some((p) => p.includes('STALE')));
ok('CI fails a gate that did not pass', evaluate(dry.stdout.replace('✅ pass', '❌ fail'), head).length > 0);
ok('CI fails a missing receipt', evaluate('Closes #1\n\nNo receipt here.\n', head).length > 0);

console.log('\ndirty worktree');
// Excluding the brief must not blunt the real check: uncommitted work of any
// kind still blocks the land, tracked or not.
fs.appendFileSync(path.join(dock.worktree, 'refund.js'), '// uncommitted\n');
const tracked = dd(['land', '412', '--dry-run']);
ok('land refuses uncommitted tracked changes', tracked.status !== 0, tracked.stdout);
ok('and says why', (tracked.stdout + tracked.stderr).includes('uncommitted'));
git(['checkout', '--', 'refund.js'], dock.worktree);

fs.writeFileSync(path.join(dock.worktree, 'scratch.js'), '// forgotten new file\n');
ok('land refuses an untracked source file', dd(['land', '412', '--dry-run']).status !== 0);
fs.rmSync(path.join(dock.worktree, 'scratch.js'));
ok('land succeeds again once the worktree is clean', dd(['land', '412', '--dry-run']).status === 0);

console.log('\nstale detection');
fs.appendFileSync(path.join(dock.worktree, 'refund.js'), '// extra\n');
git(['commit', '-qam', 'chore: extra'], dock.worktree);
const stale = dd(['land', '412']);
ok('land refuses stale gates', stale.status !== 0);
ok('names the stale gate', (stale.stdout + stale.stderr).includes('STALE'));
ok('status shows stale', dd(['status']).stdout.includes('stale'));

console.log('\nclean');
ok('clean exits 0', dd(['clean', '412', '--force']).status === 0);
ok('worktree removed', !fs.existsSync(dock.worktree));
ok('manifest removed', !fs.existsSync(path.join(repo, '.drydock/docks/412.json')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
