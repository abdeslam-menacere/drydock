import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { versionAtLeast, loadCatalog, prerequisitesFor, clientSupport } from '../src/commands/mcp.js';
import { diagnose, parseObservations, WORKFLOWS } from '../src/commands/mcp-readiness.js';
import { assertGhAllowed, githubPreflightText } from '../src/commands/mcp-policy.js';
import {
  validateDefinition, findConnection, readJson, planWrites, applyWrites, digest,
} from '../src/commands/mcp-config.js';

const scope = { client: 'cli', clientVersion: '1.0.0', workspace: process.cwd(), workflow: 'issue', session: 'test-session' };
const now = Date.now();
const working = () => ({
  source: 'builtin', configured: true, enabled: true, trusted: true, loaded: true,
  connected: true, authenticated: true, tools: [...WORKFLOWS.issue.github],
  authorization: Object.fromEntries(WORKFLOWS.issue.github.map((tool) => [tool, 'allowed'])),
});
const observation = (over = {}) => ({
  ...scope, portablePlugins: true, observedAt: new Date(now).toISOString(), servers: { github: working() }, ...over,
});
const check = (observed, over = {}) => diagnose({
  name: 'github', definition: { enabled: true }, observed, tools: WORKFLOWS.issue.github, ...over,
});

test('configuration cannot prove loaded, authenticated, exposed or authorized', () => {
  const result = check(undefined);
  assert.equal(result.declared, true);
  assert.equal(result.loaded, 'unknown');
  assert.equal(result.authenticated, 'unknown');
  assert.equal(result.ready, false);
});

test('a working current-session observation is labeled, not independently attested', () => {
  const parsed = parseObservations(JSON.stringify(observation()), scope, now);
  const result = check(parsed.servers.github);
  assert.equal(result.ready, true);
  assert.match(result.source, /not independently verified/);
});

for (const [field, value] of [
  ['session', 'other'], ['client', 'app'], ['clientVersion', '0.0.1'],
  ['workspace', path.dirname(process.cwd())], ['workflow', 'browser'],
  ['observedAt', new Date(now - 301000).toISOString()],
  ['observedAt', new Date(now + 6000).toISOString()],
]) {
  test(`observations refuse wrong/stale scope: ${field}=${value}`, () => {
    assert.throws(() => parseObservations(JSON.stringify(observation({ [field]: value })), scope, now), /Invalid MCP observations/);
  });
}

test('observations refuse unknown fields and never echo credential/error content', () => {
  const input = observation();
  input.servers.github.token = 'sensitive-example-value';
  assert.throws(() => parseObservations(JSON.stringify(input), scope, now), (e) => !e.message.includes('sensitive-example'));
  assert.throws(() => parseObservations('sensitive-example-value', scope, now), (e) => !e.message.includes('sensitive-example'));
});

test('repository-only tools fail issue/comment prerequisites', () => {
  const result = check({ ...working(), tools: ['search_code', 'get_file_contents'] });
  assert.equal(result.ready, false);
  assert.match(result.findings.find((f) => f.state === 'missing-toolsets').capability, /issue_write.*add_issue_comment/);
});

for (const [key, state] of [
  ['enabled', 'disabled'], ['trusted', 'untrusted'], ['loaded', 'not-loaded'],
  ['connected', 'connection-failure'], ['authenticated', 'authentication'],
]) {
  test(`diagnostics distinguish ${state}`, () => {
    const result = check({ ...working(), [key]: false });
    assert.equal(result.ready, false);
    assert.ok(result.findings.some((f) => f.state === state && f.action));
  });
}

for (const state of ['missing-package', 'organization-policy', 'authorization', 'authentication']) {
  test(`client-reported failure ${state} remains a failure`, () => {
    assert.ok(check({ ...working(), failure: state }).findings.some((f) => f.state === state));
  });
}

test('unknown or denied authorization is never ready', () => {
  assert.equal(check({ ...working(), authorization: undefined }).ready, false);
  assert.ok(check({ ...working(), authorization: { issue_write: 'denied' } }).findings.some((f) => f.state === 'authorization'));
});

test('missing definition/runtime/unsupported client get distinct diagnostics', () => {
  assert.ok(check(undefined, { definition: null }).findings.some((f) => f.state === 'missing-configuration'));
  assert.ok(check(working(), { supported: false }).findings.some((f) => f.state === 'unsupported-client'));
  assert.ok(check(working(), { prerequisites: [{ name: 'node', action: 'Install Node' }] }).findings.some((f) => f.state === 'missing-runtime'));
});

test('GitHub require cannot be converted to a gh permission by an observation', () => {
  assert.throws(() => assertGhAllowed({ tools: { githubMcp: 'require' } }, 'issue creation'), /No gh fallback/);
  assert.doesNotThrow(() => assertGhAllowed({ tools: { githubMcp: 'off' } }, 'issue creation'));
  assert.match(githubPreflightText({ tools: { githubMcp: 'require' } }), /STOP before dependent work/);
});

test('optional integrations are absent from issue prerequisites', () => {
  assert.deepEqual(Object.keys(WORKFLOWS.issue), ['github']);
});

const remote = { type: 'streamable-http', url: 'https://example.com/mcp' };
test('reuse by alias preserves disabled state and filters', () => {
  const def = { ...remote, disabled: true, tools: ['search'] };
  assert.deepEqual(findConnection('docs', remote, { mine: def }), { name: 'mine', definition: def });
});
test('same-name conflict is explicit, not silently replaced', () => {
  assert.deepEqual(findConnection('docs', remote, { docs: { ...remote, url: 'https://other.example.com/mcp' } }), { conflict: true });
});
test('duplicate aliases are an explicit conflict rather than arbitrary reuse', () => {
  assert.deepEqual(findConnection('docs', remote, { a: remote, b: remote }), { conflict: true });
});

for (const def of [
  { ...remote, headers: { Authorization: 'secret' } },
  { ...remote, env: { TOKEN: 'secret' } },
  { ...remote, url: 'https://user:secret@example.com/mcp' },
  { ...remote, url: 'https://example.com/mcp?key=secret' },
  { ...remote, autoApprove: ['*'] },
  { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  { command: 'node', args: ['server.js', '--token', 'secret'] },
  { command: 'node', args: ['server.js', '--api-key', 'sensitive-example'] },
]) {
  test('unsafe/nonportable definitions are refused without echo', () => {
    assert.throws(() => validateDefinition(def), (e) => !e.message.includes('Authorization:') && /no values logged/.test(e.message));
  });
}

test('additional approved servers need no core integration code', () => {
  assert.equal(validateDefinition(remote), remote);
  assert.ok(validateDefinition({ command: 'npx', args: ['-y', 'example-mcp@1.2.3'] }));
});

test('JSONC migration preserves its source and does not echo malformed content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drydock-mcp-json-'));
  try {
    const file = path.join(root, 'mcp.json');
    const content = '{ // comment\n "servers": { "docs": {"url":"https://example.com/mcp"}, /* trailing */ },\n}';
    fs.writeFileSync(file, content);
    assert.equal(readJson(file).servers.docs.url, remote.url);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    fs.writeFileSync(file, '{"token":"sensitive-example",');
    assert.throws(() => readJson(file), (e) => !e.message.includes('sensitive-example'));
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('runtime minimum comparisons require exact stable versions', () => {
  assert.equal(versionAtLeast('1.2.3', '1.2.3'), true);
  assert.equal(versionAtLeast('1.2.4', '1.2.3'), true);
  assert.equal(versionAtLeast('1.2.2', '1.2.3'), false);
  assert.equal(versionAtLeast('1.3.0-beta', '1.2.3'), false);
  assert.equal(versionAtLeast('unknown', '1.2.3'), false);
});

test('unpublished client minima stay unknown; milestones are not readiness guarantees', () => {
  for (const client of Object.values(loadCatalog().clients)) {
    assert.equal(client.minimum, null);
    assert.equal(clientSupport('99.0.0', client), null);
    assert.equal(clientSupport('99.0.0', client, { portablePlugins: true }), true);
    assert.equal(clientSupport('99.0.0', client, { portablePlugins: false }), false);
    assert.equal(clientSupport('unknown', client, { portablePlugins: true }), null);
    if (client.pluginMilestone) assert.equal(clientSupport('0.0.1', client, { portablePlugins: true }), false);
  }
});

test('public Learn needs no fabricated sign-in but still needs client permission', () => {
  const observed = { ...working(), tools: ['microsoft_docs_search'], authenticated: undefined,
    authorization: { microsoft_docs_search: 'allowed' } };
  const result = diagnose({ name: 'learn', definition: {}, observed,
    tools: ['microsoft_docs_search'], authenticationRequired: false });
  assert.equal(result.ready, true);
  assert.equal(result.authenticated, 'not-required');
  assert.equal(diagnose({ name: 'learn', definition: {}, observed: { ...observed, authorization: {} },
    tools: ['microsoft_docs_search'], authenticationRequired: false }).ready, false);
});

test('prerequisite detection is read-only and refuses arbitrary execution', () => {
  const seen = [];
  const probe = { has: () => true, tryRun: (cmd, args) => {
    seen.push([cmd, args]); return { ok: true, out: 'v20.12.0' };
  } };
  const entry = { definition: { command: 'npx' }, prerequisites: [
    { name: 'Node', command: 'node', minimum: '20.12.0', action: 'Install Node' },
  ] };
  assert.deepEqual(prerequisitesFor(entry, probe), []);
  assert.deepEqual(seen, [['node', ['--version']]]);
  assert.equal(prerequisitesFor(entry, { has: () => false }).length, 2);
  assert.throws(() => prerequisitesFor({ prerequisites: [{ command: 'unapproved' }] }, probe), /Unsupported prerequisite/);
});

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(source, 'bin', 'drydock.js');
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drydock-mcp-cli-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const config = { tools: { githubMcp: 'prefer' }, setup: { completed: true }, editor: null };
  fs.writeFileSync(path.join(root, 'drydock.config.json'), JSON.stringify(config));
  const cli = (args, input) => spawnSync(process.execPath, [bin, 'mcp', ...args], {
    cwd: root, encoding: 'utf8', input, env: { ...process.env, DRYDOCK_NONINTERACTIVE: '1' },
  });
  try { fn({ root, cli, config }); }
  finally { fs.rmSync(root, { recursive: true }); }
}
function clientArgs(client = 'cli') {
  return ['--client', client, '--client-version', loadCatalog().clients[client].pluginMilestone ?? '1.0.0'];
}

test('a boolean-looking flag value never becomes installation approval', () => fixture(({ root, cli }) => {
  const result = cli(['setup', ...clientArgs(), '--servers', 'learn', '--apply=false']);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(root, '.drydock')), false);
}));

test('all clients generate from one catalog; approval and repeated setup are idempotent', () => {
  for (const client of ['cli', 'vscode', 'app']) fixture(({ root, cli }) => {
    const args = ['setup', ...clientArgs(client), '--servers', 'github,learn,azure,playwright', '--json'];
    const preview = cli(args);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).supported, null);
    assert.match(JSON.parse(preview.stdout).notice, /compatibility is UNKNOWN/);
    assert.equal(fs.existsSync(path.join(root, '.drydock')), false);
    const applied = cli([...args, '--apply']);
    assert.equal(applied.status, 0, applied.stderr);
    const plugin = path.join(root, '.drydock', 'mcp-plugin');
    const definitions = readJson(path.join(plugin, 'mcp.json')).mcpServers;
    assert.deepEqual(Object.keys(readJson(path.join(plugin, 'plugin.json'))).sort(),
      ['$schema', 'author', 'description', 'license', 'name', 'version']);
    assert.equal(readJson(path.join(plugin, 'plugin.json')).$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    assert.equal(readJson(path.join(plugin, 'mcp.json')).$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    for (const definition of Object.values(definitions)) {
      assert.ok(['stdio', 'streamable-http', 'sse'].includes(definition.type));
      assert.ok(!Object.keys(definition).some((key) => ['enabled', 'disabled', 'tools', 'timeout'].includes(key)));
    }
    assert.deepEqual(Object.keys(definitions).sort(), ['azure', 'github', 'learn', 'playwright']);
    assert.ok(fs.existsSync(path.join(plugin, 'skills', 'dock-github', 'SKILL.md')));
    const again = cli([...args, '--apply']);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout).changedFiles, []);
  });
});

test('setup respects off, preserves custom definitions and intentional output overrides', () => fixture(({ root, cli, config }) => {
  config.tools.githubMcp = 'off';
  fs.writeFileSync(path.join(root, 'drydock.config.json'), JSON.stringify(config));
  const args = ['setup', ...clientArgs(), '--servers', 'github,learn', '--apply', '--json'];
  assert.equal(cli(args).status, 0);
  const file = path.join(root, '.drydock', 'mcp-plugin', 'mcp.json');
  assert.equal(readJson(file).mcpServers.github, undefined);
  const registry = path.join(root, '.drydock', 'mcp.json');
  const approved = readJson(registry);
  approved.servers.custom = { enabled: true, definition: remote };
  approved.servers.learn.enabled = false;
  fs.writeFileSync(registry, JSON.stringify(approved));
  assert.equal(cli(args).status, 0);
  assert.deepEqual(readJson(file).mcpServers, { custom: remote });
  fs.writeFileSync(file, '{"mcpServers":{"manual":{"url":"https://manual.example/mcp"}}}');
  assert.notEqual(cli(args).status, 0);
  assert.ok(readJson(file).mcpServers.manual);
}));

test('existing disabled aliases are reused without rewriting JSONC or exposing secrets', () => fixture(({ root, cli }) => {
  fs.mkdirSync(path.join(root, '.vscode'));
  const file = path.join(root, '.vscode', 'mcp.json');
  const content = JSON.stringify({ servers: {
    original: { ...loadCatalog().servers.github.definition, disabled: true },
    unrelated: { url: 'https://example.com/mcp', headers: { Authorization: 'sensitive-example' } },
  } });
  fs.writeFileSync(file, content);
  const result = cli(['setup', ...clientArgs('vscode'), '--servers', 'github', '--apply', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.equal(readJson(path.join(root, '.drydock', 'mcp-plugin', 'mcp.json')).mcpServers.github, undefined);
  assert.ok(!result.stdout.includes('sensitive-example'));
}));

test('migration requires explicit selection and refuses credentials without touching either file', () => fixture(({ root, cli }) => {
  const file = path.join(root, 'source.json');
  const content = JSON.stringify({ servers: { custom: remote, secret: { ...remote, headers: { Authorization: 'sensitive-example' } } } });
  fs.writeFileSync(file, content);
  const result = cli(['setup', ...clientArgs(), '--import', 'source.json', '--servers', 'custom', '--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.deepEqual(readJson(path.join(root, '.drydock', 'mcp-plugin', 'mcp.json')).mcpServers.custom, remote);
  const rejected = cli(['setup', ...clientArgs(), '--import', 'source.json', '--servers', 'secret', '--apply']);
  assert.notEqual(rejected.status, 0);
  assert.ok(!rejected.stderr.includes('sensitive-example'));
}));

test('built-in reuse needs scoped evidence and does not claim readiness from reuse', () => fixture(({ root, cli }) => {
  const current = {
    ...observation(), workspace: root, clientVersion: loadCatalog().clients.cli.pluginMilestone,
    observedAt: new Date().toISOString(),
  };
  const result = cli(['setup', ...clientArgs(), '--servers', 'github', '--apply',
    '--session', scope.session, '--observations-stdin', '--json'], JSON.stringify(current));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not a readiness claim/);
  assert.deepEqual(readJson(path.join(root, '.drydock', 'mcp-plugin', 'mcp.json')).mcpServers, {});
  const again = cli(['setup', ...clientArgs(), '--apply', '--json']);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).changedFiles, []);
  assert.match(again.stdout, /runtime readiness is unknown/);
}));

test('upgrades advance unmodified catalog entries but preserve pins deliberately overridden', () => fixture(({ root, cli }) => {
  const args = ['setup', ...clientArgs(), '--servers', 'playwright', '--apply', '--json'];
  assert.equal(cli(args).status, 0);
  const registryFile = path.join(root, '.drydock', 'mcp.json');
  const registry = readJson(registryFile);
  const old = { command: 'npx', args: ['-y', '@playwright/mcp@0.0.1'] };
  registry.servers.playwright.definition = old;
  registry.servers.playwright.catalogDefinition = old;
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  assert.equal(cli(args).status, 0);
  assert.deepEqual(readJson(registryFile).servers.playwright.definition, loadCatalog().servers.playwright.definition);
  const overridden = readJson(registryFile);
  overridden.servers.playwright.definition = old;
  fs.writeFileSync(registryFile, JSON.stringify(overridden));
  assert.equal(cli(args).status, 0);
  assert.deepEqual(readJson(registryFile).servers.playwright.definition, old);
}));

test('linked-worktree setup writes only into the current checkout', () => fixture(({ root }) => {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['config', 'user.name', 'test']); git(['config', 'user.email', 'test@example.com']);
  git(['add', 'drydock.config.json']); git(['commit', '-qm', 'fixture']);
  const child = path.join(root, 'linked');
  git(['worktree', 'add', '-qb', 'test-linked', child]);
  const result = spawnSync(process.execPath, [bin, 'mcp', 'setup', ...clientArgs(),
    '--servers', 'learn', '--apply'], { cwd: child, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(child, '.drydock', 'mcp.json')));
  assert.equal(fs.existsSync(path.join(root, '.drydock')), false);
}));

test('require doctor exits nonzero for repo-only tools, unknown auth, and unsupported versions', () => fixture(({ root, cli, config }) => {
  config.tools.githubMcp = 'require';
  fs.writeFileSync(path.join(root, 'drydock.config.json'), JSON.stringify(config));
  const args = ['doctor', ...clientArgs(), '--workflow', 'issue', '--json'];
  assert.notEqual(cli(args).status, 0);
  const current = {
    ...observation(), workspace: root, clientVersion: loadCatalog().clients.cli.pluginMilestone,
    observedAt: new Date().toISOString(),
  };
  const observedArgs = [...args, '--session', scope.session, '--observations-stdin'];
  assert.equal(cli(observedArgs, JSON.stringify(current)).status, 0);
  delete current.portablePlugins;
  const unknownCompatibility = cli(observedArgs, JSON.stringify(current));
  assert.notEqual(unknownCompatibility.status, 0);
  assert.match(unknownCompatibility.stdout, /canonical Agent Plugins/);
  current.portablePlugins = true;
  current.servers.github.authorization = {};
  assert.notEqual(cli(observedArgs, JSON.stringify(current)).status, 0);
  current.servers.github = { ...working(), tools: ['search_code'] };
  assert.notEqual(cli(observedArgs, JSON.stringify(current)).status, 0);
  const bad = cli(['doctor', '--client', 'cli', '--client-version', '0.0.0', '--json']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /unsupported-client/);
}));

test('require stops start before any dock files, branch changes or GitHub fallback', () => fixture(({ root, config }) => {
  config.tools.githubMcp = 'require';
  fs.writeFileSync(path.join(root, 'drydock.config.json'), JSON.stringify(config));
  const result = spawnSync(process.execPath, [bin, 'start', '40'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No gh fallback was attempted/);
  assert.equal(fs.existsSync(path.join(root, '.drydock', 'docks', '40.json')), false);
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(), 'main');
}));

test('workspace setup never follows a directory link outside the checkout', (t) => fixture(({ root, cli }) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drydock-mcp-outside-'));
  try {
    try { fs.symlinkSync(outside, path.join(root, '.drydock'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error.code === 'EPERM') return t.skip('Host does not permit directory links');
      throw error;
    }
    const result = cli(['setup', ...clientArgs(), '--servers', 'learn', '--apply']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlinked configuration/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    if (fs.existsSync(path.join(root, '.drydock'))) fs.unlinkSync(path.join(root, '.drydock'));
    fs.rmSync(outside, { recursive: true });
  }
}));

test('shipped catalog is inert, pinned and included with docs/skills in npm package', () => {
  const catalog = loadCatalog();
  assert.deepEqual(Object.keys(catalog.servers).sort(), ['azure', 'github', 'learn', 'playwright']);
  for (const entry of Object.values(catalog.servers)) validateDefinition(entry.definition);
  const plugin = readJson(path.join(source, 'plugin.json'));
  assert.equal(plugin.mcpServers, undefined);
  assert.equal(fs.existsSync(path.join(source, 'mcp.json')), false);
  const options = { cwd: source, encoding: 'utf8' };
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm pack --dry-run --json --ignore-scripts'], options)
    : spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], options);
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map((f) => f.path);
  for (const file of ['integrations/catalog.json', 'docs/MCP.md', 'plugin.json',
    'src/commands/mcp.js', 'skills/dock-github/SKILL.md']) assert.ok(files.includes(file), file);
  assert.deepEqual(readJson(path.join(source, 'package.json')).dependencies, {});
});

test('setup writes are dry-run, idempotent, upgradeable and preserve intentional changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drydock-mcp-write-'));
  try {
    const relative = path.join('.drydock', 'plugin', 'mcp.json');
    const first = planWrites(root, { [relative]: 'first' });
    assert.equal(fs.existsSync(path.join(root, relative)), false);
    applyWrites(first);
    assert.deepEqual(planWrites(root, { [relative]: 'first' }), []);
    applyWrites(planWrites(root, { [relative]: 'second' }, { [relative]: digest('first') }));
    assert.throws(() => planWrites(root, { [relative]: 'third' }, { [relative]: digest('first') }), /changed outside setup/);
    assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), 'second');
    assert.throws(() => planWrites(root, { [path.join('..', 'escape')]: 'no' }), /inside the current checkout/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
