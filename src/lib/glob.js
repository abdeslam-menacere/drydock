/**
 * A small glob matcher for routing patterns.
 *
 * Node 22 ships `path.matchesGlob()`, but `package.json` declares `>= 20.12`
 * where it does not exist, and it is still experimental besides. Adding
 * `minimatch` would cost the zero-dependency property, which is a feature here.
 * So: the floor-compatible subset, deliberately small.
 *
 *   *        any run of characters within one path segment
 *   **       any run of characters across segments
 *   ** / *   (no space) zero or more leading segments
 *   ?        exactly one character, not a separator
 *   {a,b}    alternation
 *
 * Routing patterns are policy that a human reviews as code. A matcher nobody
 * can predict the behaviour of would undermine the point, so anything fancier
 * is intentionally absent rather than merely unimplemented.
 */

const SPECIAL = /[.*+?^${}()|[\]\\]/g;
const escapeLiteral = (c) => c.replace(SPECIAL, '\\$&');

/** Compile a glob to an anchored RegExp over `/`-separated paths. */
export function globToRegExp(glob) {
  const s = String(glob);
  let re = '';
  let depth = 0;

  for (let i = 0; i < s.length; ) {
    const c = s[i];

    if (c === '*') {
      if (s[i + 1] === '*') {
        const atSegmentStart = i === 0 || s[i - 1] === '/';
        if (atSegmentStart && s[i + 2] === '/') {
          // `**/` — zero or more whole segments, so `**/*.md` still matches a
          // file at the root. Without the zero case every such pattern would
          // quietly require at least one directory.
          re += '(?:[^/]*\\/)*';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }

    if (c === '?') { re += '[^/]'; i += 1; continue; }
    if (c === '{') { re += '(?:'; depth += 1; i += 1; continue; }
    if (c === '}' && depth > 0) { re += ')'; depth -= 1; i += 1; continue; }
    if (c === ',' && depth > 0) { re += '|'; i += 1; continue; }

    re += escapeLiteral(c);
    i += 1;
  }

  // An unbalanced `{` is a typo in policy. Closing it here would silently match
  // something the author did not write, so refuse instead.
  if (depth !== 0) throw new Error(`Unbalanced { } in pattern: ${s}`);

  return new RegExp(`^${re}$`);
}

const cache = new Map();
const compiled = (glob) => {
  let re = cache.get(glob);
  if (!re) { re = globToRegExp(glob); cache.set(glob, re); }
  return re;
};

/** Does `filePath` match `glob`? Paths are normalised to `/` first. */
export function matchesGlob(glob, filePath) {
  return compiled(glob).test(String(filePath).replace(/\\/g, '/'));
}

/** Does `filePath` match any of `globs`? An empty list matches nothing. */
export function matchesAny(globs, filePath) {
  return (globs ?? []).some((g) => matchesGlob(g, filePath));
}
