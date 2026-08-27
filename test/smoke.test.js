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
import { parseArgs } from '../src/lib/args.js';
import { matchesGlob, globToRegExp } from '../src/lib/glob.js';
import { deriveRoute, validateRouting, parseCodeowners, ownersFor } from '../src/commands/route.js';
import { resolveActor, isAgent } from '../src/commands/gate.js';
import { wantsLifecycle, lifecycle } from '../src/commands/notify.js';
import { runInterview } from '../src/commands/config.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(sourceRoot, 'bin', 'drydock.js');
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
// Run with every actor source blanked, so a real DRYDOCK_ACTOR or USERNAME in
// the developer's own shell cannot make an attribution test pass by accident.
// Blanked rather than deleted: Windows re-injects USERNAME into a child that
// omits it, which silently defeated the "nothing identifies the actor" case.
const ddBare = (args, extra = {}, cwd = repo) => {
  const env = { ...process.env, DRYDOCK_ACTOR: '', USER: '', USERNAME: '' };
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...env, ...extra } });
};
const cfgFile = path.join(repo, 'drydock.config.json');
const readCfg = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const gitignore = () => fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

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
ok('exits 0', dd(['init']).status === 0);
ok('writes config', fs.existsSync(cfgFile));
ok('creates state dir', fs.existsSync(path.join(repo, '.drydock', 'docks')));
ok('ignores .docks/', /^\.docks\/$/m.test(gitignore()));
dd(['init', '--force']);
ok('re-running init does not duplicate the ignore entry',
  gitignore().split(/\r?\n/).filter((l) => l.trim() === '.docks/').length === 1, gitignore());

console.log('\nconfig');
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

console.log('\nrole instructions');
const rolePaths = [
  '.github/agents/drydock-dev.md',
  '.github/agents/drydock-reviewer.md',
  '.github/agents/drydock-qa.md',
  'bmad-module/agents/drydock-dev.agent.yaml',
  'bmad-module/agents/drydock-reviewer.agent.yaml',
  'bmad-module/agents/drydock-qa.agent.yaml',
];
const roles = rolePaths.map((p) => [p, fs.readFileSync(path.join(sourceRoot, p), 'utf8')]);
const rolesNamed = (name) => roles.filter(([p]) => p.includes(name)).map(([, text]) => text);
ok('all six roles treat the rendered policy as authoritative', roles.every(([, text]) =>
  text.includes('Operating policy') && text.includes('authoritative') && text.includes('drydock config show')));
ok('all six roles require MCP-first GitHub access', roles.every(([, text]) =>
  text.includes('GitHub MCP tools first')
  && text.includes('copilot --add-github-mcp-toolset issues')
  && text.includes('copilot --add-github-mcp-toolset pull_requests')));
ok('both dev roles are plan-only before code', rolesNamed('drydock-dev').every((text) =>
  text.includes('first output is plan-only') && text.includes('no code until the answers')));
ok('both reviewer roles record an attributed gate', rolesNamed('drydock-reviewer').every((text) =>
  text.includes('Drydock reviewer: review started') && text.includes('--as agent:drydock-reviewer')));
ok('both QA roles record an attributed gate with real output', rolesNamed('drydock-qa').every((text) =>
  text.includes('Drydock QA: QA started')
  && text.includes('real test output')
  && text.includes('--as agent:drydock-qa')));
ok('dev roles hand off instead of waiting for a human gate', rolesNamed('drydock-dev').every((text) =>
  text.includes('orchestrator')
  && !/A human runs|stop and wait for a human|Merge authority belongs to the human/i.test(text)));

dd(['init', '--force']);

console.log('\nstart');
const s = dd(['start', '412']);
ok('exits 0', s.status === 0, s.stderr);
const dock = JSON.parse(fs.readFileSync(path.join(repo, '.drydock/docks/412.json'), 'utf8'));
ok('creates worktree', fs.existsSync(dock.worktree));
ok('creates DOCK.md', fs.existsSync(path.join(dock.worktree, 'DOCK.md')));
const brief = fs.readFileSync(path.join(dock.worktree, 'DOCK.md'), 'utf8');
ok('DOCK.md contains the operating policy', brief.includes('## Operating policy'));
ok('operating policy matches config show',
  brief.includes('**Autonomy level:** `full`')
  && brief.includes('**Escalation bar:** `any-ambiguity`')
  && brief.includes('**Comment verbosity:** `full`')
  && brief.includes('**GitHub MCP preference:** `prefer`')
  && brief.includes('**Retry budget:** 2 gate-failure retries'));
ok('creates branch', git(['branch', '--list', dock.branch]).length > 0);
ok('gates start unset', Object.values(dock.gates).every((g) => g === null));
ok('dock lives inside the repo', dock.worktree.startsWith(repo + path.sep));
ok('dock lives under .docks', path.relative(repo, dock.worktree).split(path.sep)[0] === '.docks');
ok('git ignores the docks directory', !git(['status', '--porcelain']).includes('.docks'));
ok('start warns that setup is pending', (s.stdout + s.stderr).includes('drydock config'));

// The brief is scaffolding. If git sees it, every dock is born dirty and `land`
// refuses forever — the exact bug that blocked the first live autonomous run.
const excludeFile = path.join(repo, '.git', 'info', 'exclude');
const excludeLines = () => fs.readFileSync(excludeFile, 'utf8').split(/\r?\n/).map((l) => l.trim());
ok('start leaves the worktree clean', git(['status', '--porcelain'], dock.worktree) === '',
  git(['status', '--porcelain'], dock.worktree));
ok('start excludes DOCK.md', excludeLines().includes('/DOCK.md'));
ok('git does not see DOCK.md at all', !git(['status', '--porcelain', '-uall'], dock.worktree).includes('DOCK.md'));

console.log('\nisolation');
dd(['config', 'set', 'comments.verbosity', 'milestones']);
dd(['start', '415']);
const d415 = JSON.parse(fs.readFileSync(path.join(repo, '.drydock/docks/415.json'), 'utf8'));
const brief415 = fs.readFileSync(path.join(d415.worktree, 'DOCK.md'), 'utf8');
ok('the next dock receives changed comment verbosity',
  brief415.includes('**Comment verbosity:** `milestones`'));
dd(['config', 'set', 'comments.verbosity', 'full']);
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

console.log('\nflag discipline');
// Args used to be matched with `includes`, so anything unrecognised was thrown
// away and the command carried on. `--as` was swallowed whole: the verdict went
// in under the human's username and the CLI exited 0 saying it had worked.
const gates415 = () => JSON.parse(fs.readFileSync(path.join(repo, '.drydock/docks/415.json'), 'utf8')).gates;
ok('parser collects an undeclared flag', parseArgs(['--pas'], { flags: ['--pass'] }).unknown[0] === '--pas');
ok('parser reads an option value', parseArgs(['--as', 'x'], { options: ['--as'] }).options['--as'] === 'x');
ok('parser accepts --opt=value', parseArgs(['--as=x'], { options: ['--as'] }).options['--as'] === 'x');
ok('parser reports an option with no value', parseArgs(['--as'], { options: ['--as'] }).missing[0] === '--as');
ok('parser refuses to eat the next flag as a value',
  parseArgs(['--as', '--pass'], { flags: ['--pass'], options: ['--as'] }).missing[0] === '--as');

const typo = dd(['gate', '415', 'review', '--pass', '--pas']);
ok('gate rejects an unknown flag', typo.status !== 0, typo.stdout + typo.stderr);
ok('and names it', (typo.stdout + typo.stderr).includes('--pas'));
ok('a rejected gate records nothing', gates415().review === null);
ok('gate rejects --as with no value', dd(['gate', '415', 'review', '--pass', '--as']).status !== 0);
ok('gate rejects a blank --as', dd(['gate', '415', 'review', '--pass', '--as', '  ']).status !== 0);
ok('gate rejects --as swallowing the next flag', dd(['gate', '415', 'review', '--as', '--pass']).status !== 0);
ok('gate rejects --note with no value', dd(['gate', '415', 'review', '--pass', '--note']).status !== 0);

// A swallowed --dry-run turns a preview into a real push, a real PR, and a
// PR with auto-merge armed on it. Assert on the rejection message, not just a
// non-zero exit: without the guard this push fails anyway for want of a remote,
// so the exit code alone would pass whether the flag is checked or not.
const landTypo = dd(['land', '412', '--dryrun']);
const landTypoOut = landTypo.stdout + landTypo.stderr;
ok('land rejects a mistyped --dry-run', landTypo.status !== 0, landTypoOut);
ok('and names the flag instead of pushing',
  landTypoOut.includes('--dryrun') && !landTypoOut.includes('Pushed'), landTypoOut);

console.log('\ngate attribution');
ok('--as beats every environment source',
  resolveActor('agent:x', { DRYDOCK_ACTOR: 'a', USER: 'b', USERNAME: 'c' }) === 'agent:x');
ok('DRYDOCK_ACTOR beats USER', resolveActor(undefined, { DRYDOCK_ACTOR: 'a', USER: 'b' }) === 'a');
ok('USER beats USERNAME', resolveActor(undefined, { USER: 'b', USERNAME: 'c' }) === 'b');
ok('nothing set resolves to unknown', resolveActor(undefined, {}) === 'unknown');
ok('a blank source is skipped, not recorded',
  resolveActor(undefined, { DRYDOCK_ACTOR: '   ', USER: 'b' }) === 'b');
ok('an agent: prefix marks an agent verdict', isAgent('agent:drydock-reviewer'));
ok('a bare username is not an agent', !isAgent('ci-bot'));

const headOf415 = () => git(['rev-parse', 'HEAD'], d415.worktree);
const asFlag = dd(['gate', '415', 'review', '--pass', '--as', 'agent:drydock-reviewer', '--sha', headOf415(), '--note', 'diff only']);
ok('gate with --as exits 0', asFlag.status === 0, asFlag.stdout + asFlag.stderr);
ok('--as records that exact actor', gates415().review.by === 'agent:drydock-reviewer');
ok('and keeps the note', gates415().review.note === 'diff only');

// The failure this flag exists for: DRYDOCK_ACTOR persists across commands in a
// shared shell, and once nearly filed an agent's verdict under a human's name.
ddEnv(['gate', '415', 'review', '--pass', '--as', 'agent:drydock-reviewer', '--sha', headOf415()], { DRYDOCK_ACTOR: 'human-alice' });
ok('--as beats a leaked DRYDOCK_ACTOR', gates415().review.by === 'agent:drydock-reviewer');
ddEnv(['gate', '415', 'review', '--pass'], { DRYDOCK_ACTOR: 'human-alice' });
ok('DRYDOCK_ACTOR still works with no --as', gates415().review.by === 'human-alice');
ddBare(['gate', '415', 'review', '--pass'], { USERNAME: 'ci-bot' });
ok('falls back to the shell user', gates415().review.by === 'ci-bot');
ddBare(['gate', '415', 'review', '--pass']);
ok('falls back to unknown when nothing identifies the actor', gates415().review.by === 'unknown');

console.log('\nverdict binds to the commit that was reviewed');
// The window this closes: a reviewer reads commit A, the dock commits B while
// the review is still in flight, and the verdict is written afterwards. Bound
// to HEAD-at-write-time it records B — a commit nobody read — and `land` then
// sees a perfectly fresh gate. Staleness only ever caught commits made *after*
// the verdict, so this direction was invisible.
const reviewedA = headOf415();
fs.writeFileSync(path.join(d415.worktree, 'moved.js'), '// committed while the review ran\n');
git(['add', '-A'], d415.worktree);
git(['commit', '-qm', 'chore: commit while the review is in flight'], d415.worktree);
const movedB = headOf415();
ok('the dock moved under the reviewer', reviewedA !== movedB);

const onA = dd(['gate', '415', 'review', '--pass', '--as', 'agent:drydock-reviewer', '--sha', reviewedA]);
ok('a verdict naming the reviewed commit is refused once the dock moved', onA.status !== 0,
  onA.stdout + onA.stderr);
ok('and says the dock moved', (onA.stdout + onA.stderr).includes('moved'), onA.stdout + onA.stderr);
ok('and records nothing', gates415().review.by !== 'agent:drydock-reviewer');

const noSha = dd(['gate', '415', 'review', '--pass', '--as', 'agent:drydock-reviewer']);
ok('an agent cannot record a verdict without naming a commit', noSha.status !== 0,
  noSha.stdout + noSha.stderr);
ok('and is told which flag it needs', (noSha.stdout + noSha.stderr).includes('--sha'));

ok('gate rejects --sha with no value', dd(['gate', '415', 'review', '--pass', '--sha']).status !== 0);
ok('gate rejects a --sha that names no commit here',
  dd(['gate', '415', 'review', '--pass', '--sha', 'deadbeef']).status !== 0);
// The manual path keeps its short command: a human is the same person who just
// read the diff, so there is no window between reading and recording.
ok('a human verdict still needs no --sha', dd(['gate', '415', 'review', '--pass']).status === 0);

const onB = dd(['gate', '415', 'review', '--pass', '--as', 'agent:drydock-reviewer', '--sha', movedB]);
ok('re-reading the new commit records it', onB.status === 0, onB.stdout + onB.stderr);
ok('bound to exactly the commit the reviewer named', gates415().review.sha === movedB);

console.log('\nreceipt attribution');
dd(['gate', '415', 'review', '--pass', '--as', 'agent:drydock-reviewer', '--sha', headOf415(), '--note', 'diff only']);
ddBare(['gate', '415', 'qa', '--pass', '--note', 'suite green'], { USERNAME: 'ci-bot' });
const mixed = dd(['land', '415', '--dry-run']);
ok('a mixed receipt renders', mixed.status === 0, mixed.stdout + mixed.stderr);
ok('marks the agent verdict', /\|\s*🤖 agent:drydock-reviewer\s*\|/.test(mixed.stdout), mixed.stdout);
ok('marks the human verdict', /\|\s*👤 ci-bot\s*\|/.test(mixed.stdout), mixed.stdout);
ok('says what the marks mean', mixed.stdout.includes('recorded by an agent'));
// Attribution must not cost us the CI contract: the workflow parses gate,
// verdict and SHA, and the By column has to stay out of its way.
ok("workflow's row regex still parses a mixed receipt", [...mixed.stdout.matchAll(ROW())].length === 2);
const head415 = git(['rev-parse', 'HEAD'], d415.worktree);
ok('CI accepts a mixed receipt', evaluate(mixed.stdout, head415).length === 0,
  evaluate(mixed.stdout, head415).join('; '));
ok('an all-human receipt says so', dry.stdout.includes('every verdict recorded by a human'));

console.log('\ncomment policy');
ok('full narrates lifecycle', wantsLifecycle({ comments: { enabled: true, verbosity: 'full', cliLifecycle: true } }));
ok('milestones-findings narrates lifecycle', wantsLifecycle({ comments: { verbosity: 'milestones-findings' } }));
ok('milestones narrates lifecycle', wantsLifecycle({ comments: { verbosity: 'milestones' } }));
ok('off says nothing', !wantsLifecycle({ comments: { verbosity: 'off' } }));
ok('comments.enabled false overrides verbosity', !wantsLifecycle({ comments: { enabled: false, verbosity: 'full' } }));
ok('cliLifecycle false silences the CLI', !wantsLifecycle({ comments: { cliLifecycle: false, verbosity: 'full' } }));
ok('an unreadable verbosity fails open, not silent', wantsLifecycle({ comments: { verbosity: '??' } }));
ok('a missing comments block fails open', wantsLifecycle({}));

// The scratch repo has no GitHub remote, so every comment here genuinely fails.
// That is the point: the issue is the audit trail, not the source of truth, and
// a comment that cannot be posted must never fail the command that made it.
const unpostable = lifecycle({ comments: { verbosity: 'full' } }, 999999, 'body', repo);
ok('a comment that cannot be posted returns instead of throwing', unpostable.posted === false);
ok('and says why', ['gh-unavailable', 'failed', 'threw'].includes(unpostable.reason), unpostable.reason);
let propagated = false, blew;
try { blew = lifecycle({ comments: { verbosity: 'full' } }, { toString() { throw new Error('boom'); } }, 'b', repo); }
catch { propagated = true; }
ok('a comment that blows up never propagates', !propagated && blew.posted === false);
ok('off skips the call entirely', lifecycle({ comments: { verbosity: 'off' } }, 999999, 'b', repo).reason === 'policy');

dd(['config', 'set', 'comments.verbosity', 'off']);
const quiet = dd(['gate', '415', 'qa', '--pass']);
ok('a gate exits 0 with comments off', quiet.status === 0, quiet.stdout + quiet.stderr);
ok('and still records the verdict', gates415().qa.verdict === 'pass');
ok('and posts nothing', !quiet.stdout.includes('Commented on'));
dd(['config', 'set', 'comments.verbosity', 'full']);
const loud = dd(['gate', '415', 'qa', '--pass']);
ok('a gate exits 0 when the comment fails', loud.status === 0, loud.stdout + loud.stderr);
ok('and still records the verdict', gates415().qa.verdict === 'pass');

console.log('\nrun');
const rr = dd(['run', '415']);
ok('run exits 0', rr.status === 0, rr.stdout + rr.stderr);
ok('prints the gate commands', rr.stdout.includes(`drydock gate 415 review`));
ok('renders this repo\'s gate order', rr.stdout.includes('Gates, in order: review → qa'));
ok('tells the agent to attribute itself', rr.stdout.includes('--as agent:drydock-reviewer'));
ok('tells the agent to bind the verdict to what it read', rr.stdout.includes('--sha <reviewed-sha>'));
ok('offers no bypass', !/--skip-gates|--force/.test(rr.stdout));
ok('run rejects an unknown flag', dd(['run', '415', '--yolo']).status !== 0);
ok('run needs an issue number', dd(['run']).status !== 0);
dd(['config', 'set', 'triggers.cliRun', 'false']);
ok('a disabled trigger refuses', dd(['run', '415']).status !== 0);
dd(['config', 'set', 'triggers.cliRun', 'true']);

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

console.log('\nrouting: glob matching');
ok('* stays inside one segment', matchesGlob('*.md', 'a.md') && !matchesGlob('*.md', 'docs/a.md'));
ok('**/ matches zero segments', matchesGlob('**/*.md', 'a.md'));
ok('**/ matches nested segments', matchesGlob('**/*.md', 'docs/deep/a.md'));
ok('a trailing ** matches everything below', matchesGlob('docs/**', 'docs/a/b.md'));
ok('and does not escape its prefix', !matchesGlob('docs/**', 'src/a.js'));
ok('{a,b} alternates', matchesGlob('*.{md,txt}', 'a.txt') && !matchesGlob('*.{md,txt}', 'a.js'));
ok('a dot is a literal dot', !matchesGlob('a.md', 'axmd'));
ok('? matches one non-separator', matchesGlob('a?.md', 'ab.md') && !matchesGlob('a?.md', 'a/.md'));
ok('backslashes are normalised', matchesGlob('docs/**', 'docs\\a\\b.md'));
ok('an unbalanced brace is refused, not guessed',
  (() => { try { globToRegExp('a{b'); return false; } catch { return true; } })());

console.log('\nrouting: the route');
const G = { gates: ['review', 'qa'] };
const f = (...p) => p.map((x) => ({ status: 'M', path: x, from: null }));
const R = {
  gates: ['review', 'qa'],
  routing: {
    baseline: ['review'],
    exempt: [{ name: 'docs-only', only: true, paths: ['**/*.md'], gates: [] }],
  },
};

ok('absent routing keeps every gate', deriveRoute(G, f('src/a.js')).gates.join() === 'review,qa');
ok('and reports itself unrouted', deriveRoute(G, f('src/a.js')).routed === false);
ok('baseline applies when no exemption covers the diff',
  deriveRoute(R, f('src/a.js')).gates.join() === 'review');
ok('a docs-only diff takes the exemption', deriveRoute(R, f('README.md', 'docs/a.md')).gates.length === 0);
ok('and names it', deriveRoute(R, f('README.md')).exemption.name === 'docs-only');
// The awkwardness is the point: an exemption must cover the whole diff.
ok('one stray file voids the exemption',
  deriveRoute(R, f('README.md', 'src/a.js')).gates.join() === 'review');
ok('an exemption without only:true never applies',
  deriveRoute({ gates: ['review', 'qa'], routing: { baseline: ['review'], exempt: [{ name: 'x', paths: ['**/*.md'], gates: [] }] } },
    f('README.md')).gates.join() === 'review');
ok('an empty diff cannot be exempted', deriveRoute(R, []).gates.join() === 'review');

// Fail closed. Anything unreadable, unusual, or self-referential takes everything.
ok('an unreadable diff takes the maximum path', deriveRoute(R, null).maxPath);
ok('failed binary detection takes the maximum path', deriveRoute(R, f('a.md'), null).maxPath);
ok('a binary file takes the maximum path', deriveRoute(R, f('a.md'), ['logo.png']).maxPath);
ok('a rename takes the maximum path',
  deriveRoute(R, [{ status: 'R100', path: 'b.md', from: 'a.md' }]).maxPath);
ok('an oversized diff takes the maximum path',
  deriveRoute({ ...R, routing: { ...R.routing, maxFiles: 2 } }, f('a.md', 'b.md', 'c.md')).maxPath);

// Routing protects the rules that decide routing. Not configurable.
ok('touching drydock.config.json takes the maximum path', deriveRoute(R, f('drydock.config.json')).maxPath);
ok('touching a workflow takes the maximum path', deriveRoute(R, f('.github/workflows/ci.yml')).maxPath);
ok('touching CODEOWNERS takes the maximum path', deriveRoute(R, f('.github/CODEOWNERS')).maxPath);
ok('a root CODEOWNERS counts too', deriveRoute(R, f('CODEOWNERS')).maxPath);
ok('an exemption cannot cover a protected file',
  deriveRoute(R, f('README.md', 'drydock.config.json')).gates.join() === 'review,qa');

ok('gates keep their declared order, not the order written in policy',
  deriveRoute({ gates: ['review', 'qa'], routing: { baseline: ['qa', 'review'] } }, f('a.js')).gates.join() === 'review,qa');
ok('a gate name that is not declared is refused, not dropped',
  throws(() => deriveRoute({ gates: ['review', 'qa'], routing: { baseline: ['nope'] } }, f('a.js'))));

console.log('\nrouting: additive rules');
const RR = (rules, extra = {}) => ({
  gates: ['review', 'qa', 'security'],
  routing: { baseline: ['review'], rules, ...extra },
});
const auth = { name: 'auth', paths: ['src/auth/**'], gates: ['security'] };
const migr = { name: 'migrations', paths: ['migrations/**'], gates: ['qa'] };

ok('a rule that matches nothing changes nothing',
  deriveRoute(RR([auth]), f('src/ui.js')).gates.join() === 'review');
ok('a matching rule adds to the baseline',
  deriveRoute(RR([auth]), f('src/auth/token.js')).gates.join() === 'review,security');
// Union, not first-match-wins: risks compose.
ok('two rules both fire and both contribute',
  deriveRoute(RR([auth, migr]), f('src/auth/token.js', 'migrations/003.sql')).gates.join() === 'review,qa,security');
ok('overlapping rules do not duplicate a gate',
  deriveRoute(RR([auth, { name: 'also', paths: ['src/**'], gates: ['security'] }]),
    f('src/auth/token.js')).gates.join() === 'review,security');
ok('every contributing rule is attributed',
  deriveRoute(RR([auth, migr]), f('src/auth/token.js', 'migrations/003.sql'))
    .matched.filter((m) => m.source === 'rule').map((m) => m.name).join() === 'auth,migrations');
ok('and so are the files that made it fire',
  deriveRoute(RR([auth]), f('src/auth/token.js', 'README.md'))
    .matched.find((m) => m.source === 'rule').files.join() === 'src/auth/token.js');

// A rule ANDs its own conditions; composition happens between rules, by union.
const bigAuth = { name: 'big-auth', paths: ['src/auth/**'], linesChanged: 100, gates: ['security'] };
ok('a rule needs every one of its conditions',
  deriveRoute(RR([bigAuth]), f('src/auth/a.js'), [], { added: 10, deleted: 0 }).gates.join() === 'review');
ok('and fires when they all hold',
  deriveRoute(RR([bigAuth]), f('src/auth/a.js'), [], { added: 90, deleted: 20 }).gates.join() === 'review,security');
ok('filesTouched counts the whole diff',
  deriveRoute(RR([{ name: 'wide', filesTouched: 3, gates: ['qa'] }]), f('a.js', 'b.js', 'c.js')).gates.join() === 'review,qa');
ok('deletionRatio catches a removal',
  deriveRoute(RR([{ name: 'rip', deletionRatio: 0.8, gates: ['qa'] }]), f('a.js'), [], { added: 1, deleted: 99 }).gates.join() === 'review,qa');
ok('and leaves an addition alone',
  deriveRoute(RR([{ name: 'rip', deletionRatio: 0.8, gates: ['qa'] }]), f('a.js'), [], { added: 99, deleted: 1 }).gates.join() === 'review');
// Fail closed: a size rule with no size data cannot be evaluated.
ok('a size rule with unreadable statistics takes the maximum path',
  deriveRoute(RR([bigAuth]), f('src/auth/a.js'), [], {}).maxPath);

// An exemption still subtracts, but a rule can still add on top of it.
ok('a rule fires even inside an exemption',
  deriveRoute(RR([{ name: 'release-notes', paths: ['docs/RELEASE.md'], gates: ['qa'] }],
    { exempt: [{ name: 'docs-only', only: true, paths: ['docs/**'], gates: [] }] }),
    f('docs/RELEASE.md')).gates.join() === 'qa');

console.log('\nrouting: author-controlled signals only add');
const withLabel = RR([{ name: 'sec-review', label: 'needs-security-review', gates: ['security'] }]);
ok('a label that is absent adds nothing',
  deriveRoute(withLabel, f('a.js'), [], { labels: [] }).gates.join() === 'review');
ok('a label that is present adds its gates',
  deriveRoute(withLabel, f('a.js'), [], { labels: ['needs-security-review'] }).gates.join() === 'review,security');
ok('a label may never reach an exemption',
  throws(() => validateRouting({ gates: ['review'], routing: { exempt: [{ name: 'x', only: true, label: 'trivial', paths: ['**'], gates: [] }] } })));
ok('and the refusal says why', (() => {
  try { validateRouting({ gates: ['review'], routing: { exempt: [{ label: 'trivial' }] } }); return false; }
  catch (e) { return /may only add gates/.test(e.message); }
})());
ok('a rule may not carry a subtractive key',
  throws(() => validateRouting({ gates: ['review'], routing: { rules: [{ paths: ['**'], only: true, gates: ['review'] }] } })));
ok('a rule that adds no gates is refused',
  throws(() => validateRouting({ gates: ['review'], routing: { rules: [{ paths: ['**'], gates: [] }] } })));
ok('a rule with no condition is refused',
  throws(() => validateRouting({ gates: ['review'], routing: { rules: [{ gates: ['review'] }] } })));
ok('an unknown gate in a rule is refused at load, not at land',
  throws(() => validateRouting({ gates: ['review'], routing: { rules: [{ paths: ['**'], gates: ['nope'] }] } })));
ok('a valid policy validates quietly',
  !throws(() => validateRouting(RR([auth, migr]))));

console.log('\nrouting: CODEOWNERS as a signal');
const owners = parseCodeowners([
  '# comment',
  '*        @org/everyone',
  '/src/billing/**  @org/payments',
  'docs/  @org/writers',
].join('\n'));
ok('comments and blanks are skipped', owners.length === 3);
ok('a later entry wins', ownersFor(owners, 'src/billing/charge.js').join() === '@org/payments');
ok('a catch-all still owns everything else', ownersFor(owners, 'src/ui.js').join() === '@org/everyone');
ok('a trailing slash means the directory and below', ownersFor(owners, 'docs/a/b.md').join() === '@org/writers');

const ownedRule = RR([{ name: 'payments', codeowners: ['@org/payments'], gates: ['security'] }]);
ok('a diff in an owned path picks up that owner\'s gate',
  deriveRoute(ownedRule, f('src/billing/charge.js'), [], { owners }).gates.join() === 'review,security');
ok('a diff elsewhere does not',
  deriveRoute(ownedRule, f('src/ui.js'), [], { owners }).gates.join() === 'review');
ok('codeowners: true means any owned path',
  deriveRoute(RR([{ name: 'any', codeowners: true, gates: ['qa'] }]), f('src/ui.js'), [], { owners }).gates.join() === 'review,qa');
ok('an unreadable CODEOWNERS takes the maximum path',
  deriveRoute(ownedRule, f('src/billing/charge.js'), [], { owners: null }).maxPath);

console.log('\nrouting: CI derives the same route');
// The server layer is the one that counts and it cannot import this code, so it
// carries a copy. Extract that copy and prove it still agrees — the same
// anti-drift trick the receipt contract uses above.
const blockMatch = wf.match(/--- drydock:derive-route[^\n]*\n([\s\S]*?)\/\/ --- end drydock:derive-route/);
ok('workflow carries the derive-route block', !!blockMatch,
  'expected a `// --- drydock:derive-route ... // --- end drydock:derive-route` block');
const mirrored = new Function('cfg', 'diff', 'binaryPaths', 'ctx',
  `${blockMatch[1]}\nreturn deriveRoute(cfg, diff, binaryPaths, ctx);`);
const routeCases = [
  [G, f('src/a.js'), [], {}],
  [R, f('src/a.js'), [], {}],
  [R, f('README.md', 'docs/a.md'), [], {}],
  [R, f('README.md', 'src/a.js'), [], {}],
  [R, f('drydock.config.json'), [], {}],
  [R, f('.github/workflows/ci.yml'), [], {}],
  [R, f('CODEOWNERS'), [], {}],
  [R, [], [], {}],
  [R, null, [], {}],
  [R, f('a.md'), ['logo.png'], {}],
  [R, f('a.md'), null, {}],
  [R, [{ status: 'R100', path: 'b.md', from: 'a.md' }], [], {}],
  [{ ...R, routing: { ...R.routing, maxFiles: 2 } }, f('a.md', 'b.md', 'c.md'), [], {}],
  [{ gates: ['review', 'qa'], routing: { baseline: ['qa', 'review'] } }, f('a.js'), [], {}],
  // Rules, in every shape CI has to reproduce.
  [RR([auth]), f('src/ui.js'), [], {}],
  [RR([auth, migr]), f('src/auth/t.js', 'migrations/003.sql'), [], {}],
  [RR([bigAuth]), f('src/auth/a.js'), [], { added: 90, deleted: 20 }],
  [RR([bigAuth]), f('src/auth/a.js'), [], { added: 1, deleted: 1 }],
  [RR([bigAuth]), f('src/auth/a.js'), [], {}],
  [RR([{ name: 'wide', filesTouched: 3, gates: ['qa'] }]), f('a.js', 'b.js', 'c.js'), [], {}],
  [RR([{ name: 'rip', deletionRatio: 0.8, gates: ['qa'] }]), f('a.js'), [], { added: 1, deleted: 99 }],
  [withLabel, f('a.js'), [], { labels: ['needs-security-review'] }],
  [withLabel, f('a.js'), [], { labels: [] }],
  [ownedRule, f('src/billing/charge.js'), [], { owners }],
  [ownedRule, f('src/ui.js'), [], { owners }],
  [ownedRule, f('src/billing/charge.js'), [], { owners: null }],
  [RR([{ name: 'release-notes', paths: ['docs/RELEASE.md'], gates: ['qa'] }],
    { exempt: [{ name: 'docs-only', only: true, paths: ['docs/**'], gates: [] }] }), f('docs/RELEASE.md'), [], {}],
];
const disagreement = routeCases.find(([c, d, b, x]) =>
  JSON.stringify(mirrored(c, d, b, x)) !== JSON.stringify(deriveRoute(c, d, b, x)));
ok('the workflow derives exactly what the CLI derives', !disagreement,
  disagreement ? `diverged on ${JSON.stringify(disagreement[1])}` : '');
ok('the workflow refuses the same broken policies the CLI does',
  throws(() => mirrored({ gates: ['review'], routing: { rules: [{ paths: ['**'], gates: ['nope'] }] } }, f('a.js'), [], {})));

console.log('\nrouting: a real dock');
dd(['start', '416']);
const d416 = JSON.parse(fs.readFileSync(path.join(repo, '.drydock/docks/416.json'), 'utf8'));
const savedCfg = fs.readFileSync(cfgFile, 'utf8');
const routedCfg = JSON.parse(savedCfg);
routedCfg.routing = {
  baseline: ['review'],
  exempt: [{ name: 'docs-only', only: true, paths: ['**/*.md'], gates: [] }],
};
fs.writeFileSync(cfgFile, JSON.stringify(routedCfg, null, 2) + '\n');

fs.writeFileSync(path.join(d416.worktree, 'NOTES.md'), '# notes\n');
git(['add', '-A'], d416.worktree);
git(['commit', '-qm', 'docs: notes'], d416.worktree);

const r416 = dd(['route', '416', '--json']);
const rj = json(r416);
ok('route exits 0', r416.status === 0, r416.stdout + r416.stderr);
ok('a docs-only dock earns no gates', rj && rj.gates.length === 0, r416.stdout);
ok('and names the exemption that decided it', rj && rj.exemption.name === 'docs-only');

const landDocs = dd(['land', '416', '--dry-run']);
ok('a fully exempt dock lands with no verdicts at all', landDocs.status === 0, landDocs.stdout + landDocs.stderr);
ok('the receipt claims an empty route', /\*\*drydock-route:v1\*\*\s*``/.test(landDocs.stdout), landDocs.stdout);
ok('and records which exemption was used', landDocs.stdout.includes('Exemption used: `docs-only`'), landDocs.stdout);

// Add one code file and the same dock falls back to baseline. Nothing is stored,
// so this is just the projection being recomputed.
fs.writeFileSync(path.join(d416.worktree, 'app.js'), '// code\n');
git(['add', '-A'], d416.worktree);
git(['commit', '-qm', 'feat: app'], d416.worktree);
ok('one code file drops the exemption', json(dd(['route', '416', '--json'])).gates.join() === 'review');
ok('and land now demands review', dd(['land', '416', '--dry-run']).status !== 0);
ok('review alone satisfies the baseline route', dd(['gate', '416', 'review', '--pass']).status === 0);
const landBaseline = dd(['land', '416', '--dry-run']);
ok('qa is never required on this route', landBaseline.status === 0, landBaseline.stdout + landBaseline.stderr);
ok('and the receipt claims exactly that route',
  /\*\*drydock-route:v1\*\*\s*`review`/.test(landBaseline.stdout), landBaseline.stdout);

// A pull request must not be able to shorten the route that judges it.
fs.writeFileSync(path.join(d416.worktree, 'drydock.config.json'),
  JSON.stringify({ ...routedCfg, routing: { baseline: [], exempt: [] } }, null, 2) + '\n');
git(['add', '-A'], d416.worktree);
git(['commit', '-qm', 'chore: rewrite my own routing'], d416.worktree);
const selfEdit = json(dd(['route', '416', '--json']));
ok('a diff that edits routing policy takes the maximum path', selfEdit.maxPath === true, JSON.stringify(selfEdit));
ok('and earns every gate regardless of what it wrote', selfEdit.gates.join() === 'review,qa');
ok('so land refuses until qa runs too', dd(['land', '416', '--dry-run']).status !== 0);

fs.writeFileSync(cfgFile, savedCfg);
ok('removing the routing block restores v0.1 behaviour',
  json(dd(['route', '416', '--json'])).routed === false);

console.log('\nclean');
ok('clean exits 0', dd(['clean', '412', '--force']).status === 0);
ok('worktree removed', !fs.existsSync(dock.worktree));
ok('manifest removed', !fs.existsSync(path.join(repo, '.drydock/docks/412.json')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
