/**
 * Parse argv against a declared spec.
 *
 * Commands used to match arguments with `includes`/`indexOf`, so anything not
 * recognised was silently discarded and the command carried on as if it had
 * never been typed. That fails in the worst possible direction: `--as` was
 * swallowed and the verdict was filed under the human's username, and a
 * mistyped `--dry-run` would push and open a real pull request. Undeclared
 * arguments come back in `unknown` so the caller can refuse them.
 */
export function parseArgs(argv, { flags = [], options = [] } = {}) {
  const out = { positionals: [], flags: new Set(), options: {}, unknown: [], missing: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) { out.positionals.push(arg); continue; }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);

    if (options.includes(name)) {
      // A following token that looks like a flag is a forgotten value, not the
      // value itself — `--as --pass` must not record an actor called "--pass".
      const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
      if (value === undefined || (eq === -1 && value.startsWith('-'))) { out.missing.push(name); continue; }
      if (eq === -1) i++;
      out.options[name] = value;
    } else if (flags.includes(name)) {
      out.flags.add(name);
    } else {
      out.unknown.push(arg);
    }
  }

  return out;
}
