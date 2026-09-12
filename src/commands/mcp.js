import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/args.js';
import { loadConfig } from '../lib/config.js';
import { run, tryRun, has } from '../lib/sh.js';
import {
  readJson, localPath, serverMap, validateDefinition, canonicalDefinition,
  findConnection, planWrites, applyWrites, digest, jsonText, same,
} from './mcp-config.js';
import { parseObservations, diagnose, WORKFLOWS } from './mcp-readiness.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY = path.join('.drydock', 'mcp.json');
const OUTPUT = path.join('.drydock', 'mcp-plugins');
const usage = 'Usage: drydock mcp setup|doctor --client vscode|cli|app --client-version <version> [--servers github,learn,azure,playwright] [--workflow issue|pull-request|docs|browser] [--import <workspace-file>] [--existing <workspace-file>] [--observations-stdin --session <id>] [--apply] [--json]';

export function versionAtLeast(version, minimum) {
  const parse = (v) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(version), b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export function loadCatalog() {
  return readJson(path.join(packageRoot, 'integrations', 'catalog.json'));
}

export function clientSupport(version, client, observation) {
  const numeric = version.match(/^\d+\.\d+\.\d+/)?.[0];
  if (!numeric) return null;
  if (client.pluginMilestone && !versionAtLeast(numeric, client.pluginMilestone)) return false;
  if (observation?.portablePlugins === false) return false;
  return observation?.portablePlugins === true ? true : null;
}

function registryAt(root) {
  const file = localPath(root, REGISTRY);
  if (!fs.existsSync(file)) return { version: 1, servers: {} };
  const registry = readJson(file);
  if (registry.version !== 1 || !registry.servers || Array.isArray(registry.servers)
      || typeof registry.servers !== 'object' || Object.keys(registry).some((k) => !['version', 'servers'].includes(k))) throw new Error('Unsupported .drydock/mcp.json registry; see docs/MCP.md.');
  for (const [name, entry] of Object.entries(registry.servers)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || ['constructor', 'prototype'].includes(name)
      || !entry || typeof entry.enabled !== 'boolean'
      || Object.keys(entry).some((k) => !['enabled', 'definition', 'requiredTools', 'prerequisites', 'catalogDefinition', 'reuseIn', 'authentication'].includes(k))) {
      throw new Error('Invalid integration name or enabled flag in .drydock/mcp.json.');
    }
    if (entry.authentication !== undefined && !['none', 'client', 'user-identity'].includes(entry.authentication)) {
      throw new Error('Invalid authentication declaration; never store authentication material in the registry.');
    }
    validateDefinition(entry.definition);
    if (entry.requiredTools !== undefined && (!Array.isArray(entry.requiredTools)
      || !entry.requiredTools.every((tool) => typeof tool === 'string' && /^[a-zA-Z0-9_.:-]+$/.test(tool)))) {
      throw new Error('Invalid requiredTools in .drydock/mcp.json; use canonical tool identifiers only.');
    }
    if (entry.catalogDefinition !== undefined) validateDefinition(entry.catalogDefinition);
    if (entry.reuseIn !== undefined && (!Array.isArray(entry.reuseIn)
      || !entry.reuseIn.every((client) => ['vscode', 'cli', 'app'].includes(client)))) {
      throw new Error('Invalid reuseIn client selection in .drydock/mcp.json.');
    }
  }
  return registry;
}

function existingAt(root, client, supplied) {
  const candidates = supplied ? [supplied] : client === 'vscode'
    ? [path.join('.vscode', 'mcp.json')] : [];
  const servers = Object.create(null);
  for (const relative of candidates) {
    const file = localPath(root, relative);
    if (!fs.existsSync(file)) {
      if (supplied) throw new Error('The supplied existing configuration does not exist.');
      continue;
    }
    for (const [name, def] of Object.entries(serverMap(readJson(file)))) {
      if (Object.hasOwn(servers, name) && !same(servers[name], def)) throw new Error('Conflicting existing MCP definitions; reconcile them before setup.');
      servers[name] = def;
    }
  }
  return servers;
}

export function prerequisitesFor(entry, probe = { has, tryRun }) {
  const missing = [];
  const command = entry?.definition?.command;
  if (command && !probe.has(command)) {
    missing.push({ name: `${command} runtime/package runner`, action: 'Install the approved runtime yourself; setup never executes or installs this server.' });
  }
  for (const requirement of entry?.prerequisites ?? []) {
    if (!['node', 'npx', 'dotnet', 'dnx', 'az'].includes(requirement.command)) {
      throw new Error('Unsupported prerequisite probe; only documented runtime version checks are allowed.');
    }
    if (!probe.has(requirement.command)) {
      missing.push({ name: requirement.name, action: requirement.action });
      continue;
    }
    if (requirement.minimum) {
      const result = probe.tryRun(requirement.command, ['--version'], { timeout: 5000 });
      const version = result.out.trim().match(/^v?(\d+\.\d+\.\d+)$/)?.[1];
      if (!result.ok || !versionAtLeast(version ?? '', requirement.minimum)) {
        missing.push({ name: requirement.name, action: requirement.action });
      }
    }
  }
  return missing;
}

function readObservation(cli, scope) {
  if (!cli.flags.has('--observations-stdin')) return null;
  if (process.stdin.isTTY) throw new Error('Pipe current-session observation JSON to stdin; never paste credentials.');
  return parseObservations(fs.readFileSync(0, 'utf8'), scope);
}

export default function mcp(args) {
  if (args.some((arg) => /^--(?:apply|json|observations-stdin)=/.test(arg))) {
    throw new Error('Boolean MCP flags do not accept values. Use --apply only for explicit configuration approval.');
  }
  const cli = parseArgs(args, {
    flags: ['--apply', '--json', '--observations-stdin'],
    options: ['--client', '--client-version', '--servers', '--workflow', '--import', '--existing', '--session'],
  });
  const [sub] = cli.positionals;
  if (cli.unknown.length || cli.missing.length || cli.positionals.length !== 1
      || !['setup', 'doctor'].includes(sub)) throw new Error(usage);
  if (sub === 'doctor' && (cli.flags.has('--apply') || cli.options['--import'])) throw new Error(usage);
  const client = cli.options['--client'], clientVersion = cli.options['--client-version'];
  const catalog = loadCatalog();
  if (!Object.hasOwn(catalog.clients, client ?? '') || !clientVersion
    || !/^(?:unknown|\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/.test(clientVersion)
    || clientVersion.length > 64) throw new Error(usage);
  // Unlike dock manifests, integration files belong to THIS checkout, not the
  // shared git-common-dir (which may be another agent's workspace).
  const root = run('git', ['rev-parse', '--show-toplevel']);
  const cfg = loadConfig(root);
  const workflow = cli.options['--workflow'] ?? 'issue';
  if (!Object.hasOwn(WORKFLOWS, workflow) && workflow !== 'custom') throw new Error(usage);
  const scope = { client, clientVersion, workspace: root, workflow, session: cli.options['--session'] };
  const observed = readObservation(cli, scope);
  const registry = registryAt(root);
  const existing = existingAt(root, client, cli.options['--existing']);
  const names = cli.options['--servers']?.split(',');
  if (names && (!names.length || new Set(names).size !== names.length
      || names.some((name) => !/^[a-z][a-z0-9-]{0,63}$/.test(name) || ['constructor', 'prototype'].includes(name)))) throw new Error('Supply distinct integration names, separated by commas.');
  const supported = clientSupport(clientVersion, catalog.clients[client], observed);
  if (sub === 'setup') {
    if (supported === false) throw new Error(`Unsupported ${client} version for portable plugins. ${catalog.clients[client].guidance}`);
    return setup({ root, cfg, cli, catalog, registry, existing, names, observed, client, supported });
  }
  const required = [...new Set([...Object.keys(WORKFLOWS[workflow] ?? {}), ...(names ?? [])])];
  if (!required.length) throw new Error('Custom diagnostics require --servers <approved names>.');
  const results = [];
  for (const name of required) {
    if (name === 'github' && cfg.tools.githubMcp === 'off') {
      results.push({ integration: name, ready: false, skipped: true, source: 'policy', findings: [{ state: 'off', capability: 'GitHub MCP', action: 'Use gh; do not enable GitHub MCP.' }] });
      continue;
    }
    const entry = registry.servers[name];
    const builtIn = observed?.servers[name];
    const desired = entry?.definition ?? catalog.servers[name]?.definition;
    const connection = desired ? findConnection(name, desired, existing) : null;
    let definition = entry ?? (connection?.definition ? {
      definition: connection.definition, enabled: connection.definition.disabled !== true,
    } : null);
    if (connection?.definition?.disabled === true && definition) definition = { ...definition, enabled: false };
    const result = diagnose({
      name, definition, observed: builtIn, supported,
      tools: WORKFLOWS[workflow]?.[name] ?? entry?.requiredTools ?? catalog.servers[name]?.requiredTools ?? [],
      prerequisites: prerequisitesFor(entry ?? catalog.servers[name]),
      authenticationRequired: (catalog.servers[name]?.authentication ?? entry?.authentication) !== 'none',
    });
    if (connection?.conflict) {
      result.ready = false;
      result.findings.push({ state: 'conflict', capability: 'server definition', action: 'Resolve the existing same-name conflict manually; setup will not overwrite it.' });
    }
    results.push(result);
  }
  const mcpReady = results.every((r) => r.ready);
  const fallback = cfg.tools.githubMcp !== 'require'
    && results.some((result) => result.integration === 'github' && !result.ready);
  const canProceed = results.every((result) => result.ready || (result.integration === 'github' && fallback));
  const report = {
    client, clientVersion, workflow, workspace: root, supported,
    mcpReady, fallback: fallback ? 'gh (not tested by MCP doctor)' : null,
    source: observed ? 'current-session agent observations' : 'configuration only',
    results,
  };
  output(report, cli.flags.has('--json'));
  if (!canProceed) process.exitCode = 1;
  return report;
}

function setup({ root, cfg, cli, catalog, registry, existing, names, observed, client, supported }) {
  const legacy = path.join('.drydock', 'mcp-plugin');
  if (['plugin.json', 'mcp.json'].some((file) => fs.existsSync(localPath(root, path.join(legacy, file))))) {
    throw new Error('Legacy shared MCP plugin detected at .drydock/mcp-plugin. Unregister/disable that plugin in every client, then move the reviewed legacy folder to a backup location before setup. Keep .drydock/mcp.json; no files were changed.');
  }
  const outputDir = path.join(OUTPUT, client);
  const receiptPath = path.join(outputDir, 'managed.json');
  const selected = names ?? Object.keys(registry.servers);
  if (!selected.length) throw new Error('No integrations approved. Preview with --servers github,learn,azure,playwright; --apply approves only the selected configuration.');
  const next = structuredClone(registry);
  const imported = cli.options['--import']
    ? serverMap(readJson(localPath(root, cli.options['--import']))) : null;
  const decisions = [];
  for (const name of selected) {
    const importedDefinition = imported && Object.hasOwn(imported, name) ? imported[name] : undefined;
    if (importedDefinition !== undefined) {
      validateDefinition(importedDefinition);
      if (importedDefinition.tools !== undefined) {
        throw new Error('Client-specific tool filters cannot be migrated automatically. Keep this existing connection or translate the filter in the target client yourself.');
      }
      if (next.servers[name] && importedDefinition.disabled !== undefined
        && next.servers[name].enabled !== !importedDefinition.disabled) {
        throw new Error('Migration disabled state conflicts with an approved definition. Reconcile the enabled flag in .drydock/mcp.json explicitly; nothing changed.');
      }
    }
    if (name === 'github' && cfg.tools.githubMcp === 'off') {
      decisions.push({ integration: name, action: 'off: not enabled or generated' });
      continue;
    }
    if (!next.servers[name]) {
      const baseline = catalog.servers[name];
      if (!baseline && importedDefinition === undefined) throw new Error('Unknown integration. Add an approved definition to .drydock/mcp.json or select it from --import.');
      const definition = importedDefinition ?? baseline.definition;
      validateDefinition(definition);
      next.servers[name] = {
        enabled: definition.disabled !== true,
        definition: canonicalDefinition(definition),
        ...(baseline ? {
          prerequisites: baseline.prerequisites ?? [], requiredTools: baseline.requiredTools ?? [],
          authentication: baseline.authentication,
        } : {}),
        ...(importedDefinition === undefined && baseline ? { catalogDefinition: baseline.definition } : {}),
      };
    } else if (importedDefinition !== undefined && !same(canonicalDefinition(importedDefinition), next.servers[name].definition)) {
      throw new Error('Migration conflicts with an approved definition. Reconcile .drydock/mcp.json explicitly; nothing changed.');
    }
  }
  const generated = {};
  for (const [name, entry] of Object.entries(next.servers)) {
    const baseline = catalog.servers[name];
    if (baseline && entry.catalogDefinition && same(entry.definition, entry.catalogDefinition)) {
      entry.definition = canonicalDefinition(baseline.definition);
      entry.catalogDefinition = baseline.definition;
      entry.prerequisites = baseline.prerequisites ?? [];
      entry.requiredTools = baseline.requiredTools ?? [];
      entry.authentication = baseline.authentication;
    }
    if (!entry.enabled || (name === 'github' && cfg.tools.githubMcp === 'off')) {
      decisions.push({ integration: name, action: 'disabled: preserved, not generated' });
      continue;
    }
    validateDefinition(entry.definition);
    const match = findConnection(name, entry.definition, existing);
    if (match?.conflict) throw new Error(`MCP definition conflict for ${name}. Existing configuration is preserved; reconcile it explicitly before setup.`);
    if (match) {
      entry.reuseIn = [...new Set([...(entry.reuseIn ?? []), client])];
      decisions.push({ integration: name, action: match.definition.disabled ? 'reuse disabled existing connection (not enabled)' : 'reuse existing connection, preserving filters and overrides' });
      continue;
    }
    const builtIn = observed?.servers[name];
    if (builtIn?.source === 'builtin' && builtIn.configured === true && builtIn.loaded === true) {
      entry.reuseIn = [...new Set([...(entry.reuseIn ?? []), client])];
      decisions.push({ integration: name, action: 'reuse agent-observed built-in connection; not a readiness claim' });
      continue;
    }
    if (entry.reuseIn?.includes(client)) {
      decisions.push({ integration: name, action: 'preserve approved reuse choice for this client; current runtime readiness is unknown' });
      continue;
    }
    if (entry.definition.tools || entry.definition.disabled !== undefined) {
      throw new Error('Move disabled into the canonical enabled flag, and configure tool filters in the client; these fields are not portable.');
    }
    generated[name] = canonicalDefinition(entry.definition);
    decisions.push({
      integration: name, action: 'generate approved definition (authentication/trust still required)',
      prerequisites: prerequisitesFor(entry),
    });
  }
  const manifest = readJson(path.join(packageRoot, 'plugin.json'));
  const outputs = {
    [path.join(outputDir, 'plugin.json')]: jsonText({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: `drydock-workspace-${client}`, version: manifest.version,
      description: manifest.description, author: manifest.author, license: manifest.license,
    }),
    [path.join(outputDir, 'mcp.json')]: jsonText({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: generated,
    }),
    [path.join(outputDir, 'docs', 'MCP.md')]: fs.readFileSync(path.join(packageRoot, 'docs', 'MCP.md'), 'utf8'),
  };
  copySkillOutputs(path.join(packageRoot, 'skills'), path.join(outputDir, 'skills'), outputs);
  const receiptFile = localPath(root, receiptPath);
  const previous = fs.existsSync(receiptFile) ? readJson(receiptFile) : { files: {} };
  const outputPlan = planWrites(root, outputs, previous.files);
  const registryFile = localPath(root, REGISTRY);
  const registryText = jsonText(next);
  const before = fs.existsSync(registryFile) ? fs.readFileSync(registryFile, 'utf8') : null;
  if (before !== registryText) outputPlan.push({ relative: REGISTRY, file: registryFile, content: registryText, before });
  const receipt = jsonText({ version: 1, client, files: Object.fromEntries(Object.entries(outputs).map(([file, content]) => [file, digest(content)])) });
  const priorReceipt = fs.existsSync(receiptFile) ? fs.readFileSync(receiptFile, 'utf8') : null;
  if (receipt !== priorReceipt) outputPlan.push({ relative: receiptPath, file: receiptFile, content: receipt, before: priorReceipt });
  if (cli.flags.has('--apply')) applyWrites(outputPlan);
  const result = {
    applied: cli.flags.has('--apply'), client, supported, changedFiles: outputPlan.map((p) => p.relative),
    decisions, install: catalog.clients[client].install,
    notice: `${supported === null ? 'Canonical client compatibility is UNKNOWN; minimum versions are not published. Confirm this client can load Agent Plugins 1.0 before using it. ' : ''}Configuration only. No packages installed, no authentication copied, no trust granted. Install/enable the plugin in this client, then run doctor with fresh observations. Do not install duplicate plugin copies.`,
  };
  output(result, cli.flags.has('--json'));
  return result;
}

function copySkillOutputs(source, relative, outputs) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Refusing symlinked packaged skills.');
    const file = path.join(source, entry.name), target = path.join(relative, entry.name);
    if (entry.isDirectory()) copySkillOutputs(file, target, outputs);
    else outputs[target] = fs.readFileSync(file, 'utf8');
  }
}

function output(report, asJson) {
  if (asJson) return console.log(JSON.stringify(report, null, 2));
  if (report.results) {
    console.log(`MCP readiness: ${report.mcpReady ? 'reported ready for this workflow' : 'NOT established'} (${report.source})`);
    for (const item of report.results) {
      console.log(`${item.integration}: ${item.skipped ? 'off' : item.ready ? 'agent-reported ready' : 'not ready'}`);
      for (const finding of item.findings) console.log(`  ${finding.state}: ${finding.capability}. ${finding.action}`);
    }
    if (report.fallback) console.log(`Policy permits ${report.fallback}; MCP readiness is not implied.`);
  } else {
    console.log(report.applied ? 'Approved MCP configuration applied.' : 'MCP setup preview; no changes. Repeat with --apply only after approval.');
    for (const decision of report.decisions) {
      console.log(`${decision.integration}: ${decision.action}`);
      for (const prerequisite of decision.prerequisites ?? []) console.log(`  missing: ${prerequisite.name}. ${prerequisite.action}`);
    }
    console.log(`Files: ${report.changedFiles.join(', ') || '(unchanged)'}`);
    console.log(report.install);
    console.log(report.notice);
  }
}
