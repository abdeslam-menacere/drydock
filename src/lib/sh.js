import { execFileSync, spawnSync } from 'node:child_process';

/** Run a command, return trimmed stdout. Throws on non-zero exit. */
export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

/** Run a command, never throw. Returns { ok, out, err, code }. */
export function tryRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    ok: r.status === 0,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
    code: r.status,
  };
}

/** Run a command with output streamed to the terminal. */
export function runLive(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  return r.status === 0;
}

/** Is a binary on PATH? */
export function has(bin) {
  return tryRun(process.platform === 'win32' ? 'where' : 'which', [bin]).ok;
}
