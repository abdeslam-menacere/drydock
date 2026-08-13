import readline from 'node:readline/promises';

const MAX_ATTEMPTS = 3;

/**
 * Can we actually ask a human something right now?
 *
 * Everything in Drydock that prompts is gated on this. `test/smoke.test.js`,
 * CI, and any agent shelling out to the CLI run with a piped stdin — a prompt
 * there would block forever with nobody to answer it.
 */
export function interactive() {
  if (process.env.DRYDOCK_NONINTERACTIVE === '1') return false;
  return Boolean(process.stdin.isTTY);
}

/**
 * Run an interview. `fn` receives an `ask(question)` function and may branch on
 * the answers it gets back.
 *
 * When stdin is not a TTY no readline interface is created at all: `ask`
 * resolves to each question's default immediately, nothing reads stdin, and no
 * handle is left open to keep the process alive. Pass `io` to drive the real
 * interactive path over a different pair of streams.
 */
export async function interview(fn, io = null) {
  if (!io && !interactive()) return fn(async (q) => q.default);

  const rl = readline.createInterface({
    input: io?.input ?? process.stdin,
    output: io?.output ?? process.stdout,
  });
  // If the input ends mid-interview (Ctrl-D, a closed pipe) every outstanding
  // and subsequent question aborts and takes its default. Nothing can wedge.
  const ac = new AbortController();
  rl.once('close', () => ac.abort());

  try {
    return await fn((q) => ask(rl, q, ac.signal));
  } finally {
    rl.close();
  }
}

async function ask(rl, q, signal) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let raw;
    try {
      raw = await rl.question(render(q), { signal });
    } catch {
      return q.default; // input ended under us — take the default
    }
    const answer = parse(q, String(raw).trim());
    if (answer !== undefined) return answer;
    console.log('  not one of the choices — try again');
  }
  return q.default;
}

function render(q) {
  if (q.type === 'boolean') {
    return `\n${q.prompt}\n  [${q.default ? 'Y/n' : 'y/N'}]: `;
  }
  if (q.options) {
    const menu = q.options
      .map((o, i) => `  ${o.value === q.default ? '*' : ' '} ${i + 1}) ${o.label}`)
      .join('\n');
    const def = q.options.findIndex((o) => o.value === q.default) + 1;
    return `\n${q.prompt}\n${menu}\n  choice [${def}]: `;
  }
  return `\n${q.prompt}\n  [${q.default}]: `;
}

/** Returns the answer, or undefined if the input was not understood. */
function parse(q, raw) {
  if (raw === '') return q.default;

  if (q.type === 'boolean') {
    if (/^(y|yes|true)$/i.test(raw)) return true;
    if (/^(n|no|false)$/i.test(raw)) return false;
    return undefined;
  }

  if (q.type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  if (q.options) {
    const idx = Number(raw);
    if (Number.isInteger(idx) && idx >= 1 && idx <= q.options.length) return q.options[idx - 1].value;
    const hit = q.options.find((o) => o.value.toLowerCase() === raw.toLowerCase());
    return hit ? hit.value : undefined;
  }

  return raw;
}
