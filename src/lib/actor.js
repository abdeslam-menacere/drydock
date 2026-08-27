/**
 * Who recorded a verdict.
 *
 * Two string helpers, deliberately dumb, kept out of `commands/` so that the
 * receipt renderer and the gate command can both use them without importing
 * each other.
 */

/**
 * `--as` wins because `DRYDOCK_ACTOR` persists for the life of a shell: one
 * left set by an earlier command in a shared session nearly filed a reviewer
 * agent's verdict under a human's name. An explicit flag is scoped to the
 * single invocation that carries it.
 *
 * An actor name is a name, so line breaks and pipes are collapsed rather than
 * carried: a receipt is parsed one row per line, and a name that spans two of
 * them is a second row CI would read as a verdict.
 */
export function resolveActor(explicit, env = process.env) {
  for (const v of [explicit, env.DRYDOCK_ACTOR, env.USER, env.USERNAME]) {
    if (typeof v === 'string' && v.trim()) return v.replace(/[\s|]+/g, ' ').trim();
  }
  return 'unknown';
}

/** Verdicts recorded by an agent are attributed `agent:<role>`. */
export const isAgent = (by) => /^agent:/i.test(String(by ?? '').trim());
