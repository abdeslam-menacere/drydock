import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, repoRoot, readDock, STATE_DIR } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import { tryRun } from '../lib/sh.js';
import * as git from '../lib/git.js';
import * as notify from './notify.js';
import { assertOnBranch } from './start.js';

// Runtime, not state. `.drydock/tmp/` is gitignored by `init`, and this file
// must stay there: a pid and a port are true for one machine for a few hours,
// and committing them would be committing a lie to everybody else.
const previewsFile = (root) => path.join(root, STATE_DIR, 'tmp', 'previews.json');

export function readPreviews(root) {
  try { return JSON.parse(fs.readFileSync(previewsFile(root), 'utf8')); } catch { return []; }
}

function writePreviews(root, list) {
  const f = previewsFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(list, null, 2) + '\n');
}

/** Is this pid still ours to talk to? Signal 0 asks without sending anything. */
export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * The preview for an issue, or null.
 *
 * A recorded pid is a claim, not a fact â€” the machine rebooted, the server
 * crashed, someone killed it. Every read verifies before reporting, so nothing
 * downstream can bind a product owner's approval to a server that is not there.
 */
export function previewFor(root, issue) {
  const p = readPreviews(root).find((x) => String(x.issue) === String(issue));
  if (!p) return null;
  return alive(p.pid) ? p : { ...p, dead: true };
}

/**
 * Deterministic from the issue number, so the URL can be bookmarked and the
 * same issue comes back on the same port tomorrow. Collisions fall forward.
 */
export function portFor(cfg, issue) {
  const base = Number(cfg?.preview?.basePort) || 4200;
  return base + (Number(issue) % 1000);
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function freePortFrom(start) {
  for (let p = start; p < start + 50 && p < 65536; p++) {
    if (await portFree(p)) return p;
  }
  return null;
}

/**
 * What to run. Configured wins; otherwise the two script names that mean "run
 * this project" in practice. Guessing beyond that would be guessing.
 */
export function resolveCommand(cfg, worktree) {
  if (cfg?.preview?.command) return { command: cfg.preview.command, from: 'config' };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf8'));
    if (pkg.scripts?.dev) return { command: 'npm run dev', from: 'package.json scripts.dev' };
    if (pkg.scripts?.start) return { command: 'npm start', from: 'package.json scripts.start' };
  } catch { /* no package.json, or unreadable */ }
  return { command: null, from: null };
}

/**
 * Stop a preview and everything it started.
 *
 * A dev server is usually a shell that started a runtime that started a
 * bundler. Killing only the pid we recorded leaves the port held, which is the
 * one failure mode that makes the next `drydock preview` confusing.
 */
export function stopPreview(root, issue) {
  const list = readPreviews(root);
  const entry = list.find((x) => String(x.issue) === String(issue));
  if (!entry) return { stopped: false, reason: 'none' };

  const wasAlive = alive(entry.pid);
  if (wasAlive) {
    if (process.platform === 'win32') tryRun('taskkill', ['/pid', String(entry.pid), '/T', '/F']);
    else {
      try { process.kill(-entry.pid, 'SIGTERM'); } catch { try { process.kill(entry.pid, 'SIGTERM'); } catch { /* gone */ } }
    }
  }
  writePreviews(root, list.filter((x) => String(x.issue) !== String(issue)));
  return { stopped: wasAlive, reason: wasAlive ? 'stopped' : 'stale', entry };
}

export default async function preview(args = []) {
  const root = repoRoot();
  const cfg = loadConfig(root);

  const usage = 'Usage: drydock preview [<issue>]  |  drydock preview stop <issue>';
  const unknown = args.filter((a) => a.startsWith('-'));
  if (unknown.length) die(`Unknown option: ${unknown[0]}`, usage);

  const issue = args.find((a) => /^\d+$/.test(a));
  if (args[0] === 'stop') {
    if (!issue) die('Which issue?', usage);
    return stop(root, issue);
  }
  if (args.length && !issue) die(`Unknown argument: ${args[0]}`, usage);
  if (!issue) return list(root, cfg);
  return start(root, cfg, issue);
}

function list(root, cfg) {
  const all = readPreviews(root);
  if (!all.length) { log.info('No previews running. Start one: drydock preview <issue>'); return; }

  const live = all.filter((p) => alive(p.pid));
  const dead = all.filter((p) => !alive(p.pid));

  log.head(`${live.length} preview${live.length === 1 ? '' : 's'} running`);
  for (const p of live) {
    log.raw(`  #${String(p.issue).padEnd(5)} ${p.url}`);
    log.dim(`pid ${p.pid}  Â·  serving ${p.sha.slice(0, 8)}  Â·  since ${p.startedAt}`);
  }
  for (const p of dead) {
    log.warn(`#${p.issue}: pid ${p.pid} is gone â€” the preview is not running.`);
    log.dim(`Recorded ${p.url}. Restart it: drydock preview ${p.issue}`);
  }
  // Reporting a stale entry is the point; keeping it afterwards is not.
  if (dead.length) writePreviews(root, live);
  return { live, dead };
}

function stop(root, issue) {
  const r = stopPreview(root, issue);
  if (r.reason === 'none') { log.info(`No preview recorded for #${issue}.`); return r; }
  if (r.stopped) log.ok(`Preview for #${issue} stopped (pid ${r.entry.pid}, port ${r.entry.port})`);
  else log.warn(`Preview for #${issue} was already gone â€” the stale record has been dropped.`);
  return r;
}

async function start(root, cfg, issue) {
  const dock = readDock(issue, root);
  if (!dock) die(`No dock for issue #${issue}.`, `Run \`drydock start ${issue}\` first.`);

  assertOnBranch(dock, 'serving a preview');

  const running = previewFor(root, issue);
  if (running && !running.dead) {
    log.info(`Preview for #${issue} is already running: ${running.url}`);
    log.dim(`Serving ${running.sha.slice(0, 8)}. Restart it: drydock preview stop ${issue} && drydock preview ${issue}`);
    return running;
  }
  if (running?.dead) stopPreview(root, issue);

  const { command, from } = resolveCommand(cfg, dock.worktree);
  if (!command) {
    die(
      'No preview command. Nothing in package.json names one.',
      'Set it: drydock config set preview.command "npm run dev"',
    );
  }

  const wanted = portFor(cfg, issue);
  const port = await freePortFrom(wanted);
  if (!port) die(`No free port near ${wanted}.`, 'Stop something, or move preview.basePort.');
  if (port !== wanted) log.warn(`Port ${wanted} is taken â€” using ${port} instead.`);

  const sha = git.headSha(dock.worktree);

  const logFile = path.join(root, STATE_DIR, 'tmp', `preview-${issue}.log`);  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');

  // Detached and unref'd: Drydock starts the process and forgets it. A
  // supervisor that outlives the command would be the daemon SPEC Â§5 refuses.
  const child = spawn(command, {
    cwd: dock.worktree,
    shell: true,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: String(port) },
  });
  child.unref();

  const url = `http://localhost:${port}`;
  const entry = {
    issue: Number(issue),
    port,
    pid: child.pid,
    sha,
    url,
    command,
    startedAt: new Date().toISOString(),
    log: logFile,
  };
  writePreviews(root, [...readPreviews(root).filter((x) => String(x.issue) !== String(issue)), entry]);

  log.ok(`Preview for #${issue}: ${url}`);
  log.dim(`${command} (${from})  Â·  pid ${child.pid}  Â·  serving ${sha.slice(0, 8)}`);
  log.dim(`Logs: ${logFile}`);
  log.dim(`Stop it: drydock preview stop ${issue}`);

  notify.lifecycle(cfg, issue, previewComment(entry, dock), root);
  return entry;
}

function previewComment(entry, dock) {
  return [
    '### Drydock preview',
    '',
    `**${entry.url}** â€” \`${dock.branch}\` at \`${entry.sha.slice(0, 8)}\``,
    '',
    'This is what the change looks like running. If you approve it, the verdict',
    'binds to the commit above, not to whatever the branch says later:',
    '',
    '```bash',
    `drydock gate ${entry.issue} po --pass --note "..."`,
    '```',
    '',
    '<sub>A local preview on the machine that started it. If you cannot reach it, ask whoever ran it.</sub>',
  ].join('\n');
}

