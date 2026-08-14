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

const asFlag = dd(['gate', '415', 'review', '--pass', '--as', 'agent:drydock-reviewer', '--note', 'diff only']);
ok('gate with --as exits 0', asFlag.status === 0, asFlag.stdout + asFlag.stderr);
ok('--as records that exact actor', gates415().review.by === 'agent:drydock-reviewer');
ok('and keeps the note', gates415().review.note === 'diff only');

// The failure this flag exists for: DRYDOCK_ACTOR persists across commands in a
// shared shell, and once nearly filed an agent's verdict under a human's name.
ddEnv(['gate', '415', 'review', '--pass', '--as', 'agent:drydock-reviewer'], { DRYDOCK_ACTOR: 'human-alice' });
ok('--as beats a leaked DRYDOCK_ACTOR', gates415().review.by === 'agent:drydock-reviewer');
ddEnv(['gate', '415', 'review', '--pass'], { DRYDOCK_ACTOR: 'human-alice' });
ok('DRYDOCK_ACTOR still works with no --as', gates415().review.by === 'human-alice');
ddBare(['gate', '415', 'review', '--pass'], { USERNAME: 'ci-bot' });
ok('falls back to the shell user', gates415().review.by === 'ci-bot');
ddBare(['gate', '415', 'review', '--pass']);
ok('falls back to unknown when nothing identifies the actor', gates415().review.by === 'unknown');

console.log('\nreceipt attribution');
dd(['gate', '415', 'review', '--pass', '--as', 'agent:drydock-reviewer', '--note', 'diff only']);
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

console.log('\nclean');
ok('clean exits 0', dd(['clean', '412', '--force']).status === 0);
ok('worktree removed', !fs.existsSync(dock.worktree));
ok('manifest removed', !fs.existsSync(path.join(repo, '.drydock/docks/412.json')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
