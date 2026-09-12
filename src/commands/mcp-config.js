import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const same = (a, b) => JSON.stringify(sort(a)) === JSON.stringify(sort(b));
function sort(v) {
  return Array.isArray(v) ? v.map(sort) : object(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
}
export const digest = (text) => createHash('sha256').update(text).digest('hex');
export const jsonText = (value) => JSON.stringify(value, null, 2) + '\n';

/** Read JSONC without rewriting the source or printing parse errors containing secrets. */
export function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let out = '', quoted = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (quoted) {
      out += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; out += c; }
    else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i >= text.length) throw new Error('Invalid MCP JSONC: unterminated comment; no values logged.');
      i++;
      out += ' ';
    } else out += c;
  }
  let clean = '';
  quoted = false; escape = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (!quoted && c === ',' && /^\s*[}\]]/.test(out.slice(i + 1))) continue;
    clean += c;
    if (quoted && escape) escape = false;
    else if (quoted && c === '\\') escape = true;
    else if (c === '"') quoted = !quoted;
  }
  try { return JSON.parse(clean); }
  catch { throw new Error('Invalid MCP JSON/JSONC. Fix the source configuration; no values logged.'); }
}

/** Every managed write stays inside this checkout, including through symlinks. */
export function localPath(root, relative) {
  const base = fs.realpathSync(root);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) {
    throw new Error('MCP paths must stay inside the current checkout.');
  }
  let cursor = root;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error('MCP setup refuses symlinked configuration paths.');
      const resolved = fs.realpathSync(cursor);
      const inside = path.relative(base, resolved);
      if (inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside)) {
        throw new Error('MCP setup refuses symlinked configuration paths.');
      }
    }
  }
  return target;
}

export function serverMap(document) {
  if (!object(document)) throw new Error('Expected a JSON object containing servers or mcpServers.');
  const map = document.servers ?? document.mcpServers;
  if (!object(map)) throw new Error('Expected servers (VS Code) or mcpServers (portable/CLI). No configuration changed.');
  return map;
}

export function validateDefinition(definition) {
  const refuse = () => { throw new Error('Unsafe or unsupported MCP definition. Use command/args or HTTPS url, no credentials, env, input references, automatic approval, or arbitrary headers. See docs/MCP.md; no values logged.'); };
  if (!object(definition)) refuse();
  const allowed = ['type', 'url', 'command', 'args', 'headers', 'tools', 'disabled'];
  if (Object.keys(definition).some((k) => !allowed.includes(k))) refuse();
  if (definition.disabled !== undefined && typeof definition.disabled !== 'boolean') refuse();
  if (definition.tools !== undefined && (!Array.isArray(definition.tools)
      || !definition.tools.every((s) => typeof s === 'string' && /^[a-zA-Z0-9_.:-]+$/.test(s)))) refuse();
  if (definition.url !== undefined) {
    let url;
    try { url = new URL(definition.url); } catch { refuse(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || definition.command !== undefined || definition.args !== undefined
        || (definition.type !== undefined && !['http', 'streamable-http', 'sse'].includes(definition.type))) refuse();
  } else {
    if (typeof definition.command !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(definition.command)
      || (definition.type !== undefined && !['stdio', 'local'].includes(definition.type))
      || definition.headers !== undefined
      || (definition.args !== undefined && (!Array.isArray(definition.args) || !definition.args.every((s) => typeof s === 'string')))) refuse();
    const args = definition.args ?? [];
    if (args.some((s) => /token|secret|password|credential|authorization|bearer|(?:api|access|client)[_-]?key|(?:^|[ _-])key(?:[=:]|$)|:\/\/[^/]*@|\$\{|[\r\n]/i.test(s))) refuse();
    validateRunner(definition.command, args);
  }
  if (definition.headers !== undefined && (!object(definition.headers)
    || Object.entries(definition.headers).some(([k, v]) =>
      !['X-MCP-Tools', 'X-MCP-Toolsets', 'X-MCP-Readonly'].includes(k)
      || typeof v !== 'string' || !/^[a-zA-Z0-9_, -]+$/.test(v)))) refuse();
  return definition;
}

function validateRunner(command, args) {
  const runner = command.toLowerCase().replace(/\.(?:cmd|exe|bat|ps1)$/, '');
  const refuse = () => {
    throw new Error('Unsupported package-runner invocation. Use one exact stable package with npx [--no|-y|--yes|--offline] <package>@<version> [server args], or dnx <package>@<version> [-- server args]. Package-selection flags and other package-manager wrappers are not supported; no values logged.');
  };
  // Wrapper spellings must obey the same pin rules as their unsuffixed command.
  if (/^(?:npx|dnx)\./.test(runner)
    || ['npm', 'pnpm', 'yarn', 'bun', 'corepack', 'uv', 'uvx', 'pipx'].includes(runner)
    || (runner === 'dotnet' && ['dnx', 'tool', 'run'].includes(args[0]?.toLowerCase()))) refuse();
  if (runner !== 'npx' && runner !== 'dnx') return;

  const version = '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)';
  if (runner === 'npx') {
    // Deliberately accept only the single-positional-package form. Merely finding
    // a pinned-looking token cannot validate --package/-p/--call dispatch.
    if (args.some((arg) => /^(?:--package|--call)(?:=|$)|^-[pc]/.test(arg))) refuse();
    let index = 0;
    while (['--no', '-y', '--yes', '--offline'].includes(args[index])) index++;
    const packageSpec = new RegExp(`^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@${version}$`);
    if (!packageSpec.test(args[index] ?? '')) refuse();
  } else {
    const packageSpec = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]*@${version}$`);
    if (!packageSpec.test(args[0] ?? '') || (args.length > 1 && args[1] !== '--')) refuse();
  }
}

export function canonicalDefinition(definition) {
  const d = { ...definition };
  delete d.disabled;
  // Tool filtering/disable switches belong to the source client, not portability.
  delete d.tools;
  if (d.command) { d.type = 'stdio'; d.args ??= []; }
  if (d.url && (d.type === undefined || d.type === 'http')) d.type = 'streamable-http';
  return d;
}

export function connectionMatch(existing, desired) {
  const a = canonicalDefinition(existing), b = canonicalDefinition(desired);
  if (a.url || b.url) return a.url === b.url && a.type === b.type;
  return a.command === b.command && same(a.args, b.args);
}

/**
 * Reuse connections regardless of alias. Same-name conflicts must be resolved
 * by a person; disabled entries and filters are never "repaired" by setup.
 */
export function findConnection(name, desired, existing) {
  const matches = Object.entries(existing).filter(([, def]) => object(def) && connectionMatch(def, desired));
  if (matches.length > 1) return { conflict: true };
  if (Object.hasOwn(existing, name)) {
    return connectionMatch(existing[name], desired)
      ? { name, definition: existing[name] }
      : { conflict: true };
  }
  const found = matches[0];
  return found ? { name: found[0], definition: found[1] } : null;
}

/** Refuse all conflicting outputs before writing any of them. */
export function planWrites(root, outputs, previous = {}) {
  const plan = [];
  for (const [relative, content] of Object.entries(outputs)) {
    const file = localPath(root, relative);
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (old === content) continue;
    if (old !== null && digest(old) !== previous[relative]) {
      throw new Error(`Managed MCP output was changed outside setup: ${relative}. Preserve the override or reconcile it explicitly; nothing changed.`);
    }
    plan.push({ relative, file, content, before: old });
  }
  return plan;
}

export function applyWrites(plan) {
  for (const item of plan) {
    const now = fs.existsSync(item.file) ? fs.readFileSync(item.file, 'utf8') : null;
    if (now !== item.before) throw new Error('MCP configuration changed during setup. Rerun the preview; nothing was written.');
  }
  for (const item of plan) {
    fs.mkdirSync(path.dirname(item.file), { recursive: true });
    fs.writeFileSync(item.file, item.content);
  }
}
