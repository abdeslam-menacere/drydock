#!/usr/bin/env node
// Full-loop smoke test against a scratch repo. No network, no gh required.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
ok('writes config', fs.existsSync(path.join(repo, 'drydock.config.json')));
ok('creates state dir', fs.existsSync(path.join(repo, '.drydock', 'docks')));

console.log('\nstart');
const s = dd(['start', '412']);
ok('exits 0', s.status === 0, s.stderr);
const dock = JSON.parse(fs.readFileSync(path.join(repo, '.drydock/docks/412.json'), 'utf8'));
ok('creates worktree', fs.existsSync(dock.worktree));
ok('creates DOCK.md', fs.existsSync(path.join(dock.worktree, 'DOCK.md')));
ok('creates branch', git(['branch', '--list', dock.branch]).length > 0);
ok('gates start unset', Object.values(dock.gates).every((g) => g === null));

console.log('\nisolation');
dd(['start', '415']);
const d415 = JSON.parse(fs.readFileSync(path.join(repo, '.drydock/docks/415.json'), 'utf8'));
ok('two docks, distinct worktrees', d415.worktree !== dock.worktree);
ok('two docks, distinct branches', d415.branch !== dock.branch);

// agent does work
fs.writeFileSync(path.join(dock.worktree, 'refund.js'), 'export const refund = () => {};\n');
git(['add', '-A'], dock.worktree); git(['commit', '-qm', 'feat: refund'], dock.worktree);

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
