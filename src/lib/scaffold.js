import fs from 'node:fs';
import path from 'node:path';

const displayPath = (relative) => relative.split(path.sep).join('/');

// Line endings alone never make a file project-owned; git may rewrite them on checkout.
const sameContent = (a, b) => a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');

function target(root, relative) {
  const absolute = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  if (absolute !== path.resolve(root) && !absolute.startsWith(prefix)) {
    throw new Error(`Scaffold path escapes the repository: ${relative}`);
  }
  return absolute;
}

export function planDirectory(root, relative) {
  const absolute = target(root, relative);
  const blocked = blockedParent(root, absolute);
  if (blocked) return operation('conflict', relative, absolute, { note: `parent path is not a directory: ${blocked}` });
  if (!fs.existsSync(absolute)) return operation('create', relative, absolute, { kind: 'directory' });
  return fs.statSync(absolute).isDirectory()
    ? operation('present', relative, absolute, { kind: 'directory' })
    : operation('conflict', relative, absolute, { note: 'expected a directory' });
}

export function planCreateIfAbsent(root, relative, content) {
  const absolute = target(root, relative);
  const blocked = blockedParent(root, absolute);
  if (blocked) return operation('conflict', relative, absolute, { note: `parent path is not a directory: ${blocked}` });
  if (!fs.existsSync(absolute)) return operation('create', relative, absolute, { content });
  return fs.statSync(absolute).isFile()
    ? operation('present', relative, absolute)
    : operation('conflict', relative, absolute, { note: 'expected a file' });
}

export function planCreate(root, relative, content) {
  const absolute = target(root, relative);
  const blocked = blockedParent(root, absolute);
  if (blocked) return operation('conflict', relative, absolute, { note: `parent path is not a directory: ${blocked}` });
  if (!fs.existsSync(absolute)) return operation('create', relative, absolute, { content });
  if (!fs.statSync(absolute).isFile()) {
    return operation('conflict', relative, absolute, { note: 'expected a file' });
  }
  return sameContent(fs.readFileSync(absolute, 'utf8'), content)
    ? operation('present', relative, absolute)
    : operation('conflict', relative, absolute, { note: 'project-owned file differs' });
}

export function planAppend(root, relative, marker, block, { prefix = '' } = {}) {
  const absolute = target(root, relative);
  const blocked = blockedParent(root, absolute);
  if (blocked) return operation('conflict', relative, absolute, { note: `parent path is not a directory: ${blocked}` });
  if (!fs.existsSync(absolute)) {
    return operation('create', relative, absolute, { content: prefix + block });
  }
  if (!fs.statSync(absolute).isFile()) {
    return operation('conflict', relative, absolute, { note: 'expected a file' });
  }
  const current = fs.readFileSync(absolute, 'utf8');
  if (current.includes(marker)) return operation('present', relative, absolute);
  const separator = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return operation('append', relative, absolute, { content: current + separator + block });
}

export function planJsonMerge(root, relative, desired, merge) {
  const absolute = target(root, relative);
  const blocked = blockedParent(root, absolute);
  if (blocked) return operation('conflict', relative, absolute, { note: `parent path is not a directory: ${blocked}` });
  const rendered = JSON.stringify(desired, null, 2) + '\n';
  if (!fs.existsSync(absolute)) return operation('create', relative, absolute, { content: rendered });
  if (!fs.statSync(absolute).isFile()) {
    return operation('conflict', relative, absolute, { note: 'expected a JSON file' });
  }

  let current;
  try {
    current = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return operation('conflict', relative, absolute, { note: 'not strict JSON; merge manually' });
  }

  const result = merge(current, desired);
  if (result.conflict) return operation('conflict', relative, absolute, { note: result.conflict });
  if (!result.changed) return operation('present', relative, absolute);
  return operation('merge', relative, absolute, {
    content: JSON.stringify(result.value, null, 2) + '\n',
  });
}

export function applyPlan(plan) {
  for (const item of plan) {
    if (!['create', 'append', 'merge'].includes(item.action)) continue;
    if (item.kind === 'directory') {
      fs.mkdirSync(item.absolute, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(item.absolute), { recursive: true });
    fs.writeFileSync(item.absolute, item.content);
  }
}

function operation(action, relative, absolute, extra = {}) {
  return { action, path: displayPath(relative), absolute, ...extra };
}

export function planSkip(root, relative, note) {
  return operation('skip', relative, target(root, relative), { note });
}

function blockedParent(root, absolute) {
  const repository = path.resolve(root);
  for (let parent = path.dirname(absolute); parent.startsWith(repository); parent = path.dirname(parent)) {
    if (fs.existsSync(parent)) return fs.statSync(parent).isDirectory() ? null : path.relative(repository, parent);
    if (parent === repository) return null;
  }
  return null;
}