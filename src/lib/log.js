const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const on = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (on ? code + s + C.reset : s);

export const log = {
  info: (m) => console.log(`${c(C.cyan, '›')} ${m}`),
  ok: (m) => console.log(`${c(C.green, '✓')} ${m}`),
  warn: (m) => console.log(`${c(C.yellow, '!')} ${m}`),
  err: (m) => console.error(`${c(C.red, '✗')} ${m}`),
  dim: (m) => console.log(c(C.dim, `  ${m}`)),
  head: (m) => console.log(`\n${c(C.bold, m)}`),
  raw: (m) => console.log(m),
};

export function die(msg, hint) {
  log.err(msg);
  if (hint) log.dim(hint);
  process.exit(1);
}
