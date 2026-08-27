import { loadConfig, repoRoot, readDock } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import { parseArgs } from '../lib/args.js';
import { matchesAny } from '../lib/glob.js';
import * as git from '../lib/git.js';

/**
 * Paths that route to the maximum path and can never be exempted.
 *
 * Not configurable, on purpose. These are the files that decide what routing
 * does; if a change to them could route itself short, the mechanism would be
 * decorative. SPEC §11.2.
 */
export const PROTECTED_PATHS = [
  'drydock.config.json',
  '.github/workflows/**',
  'CODEOWNERS',
  '**/CODEOWNERS',
];

/** Diffs wider than this take the maximum path unless policy says otherwise. */
const DEFAULT_MAX_FILES = 200;

/**
 * The gates a change must pass.
 *
 * A pure projection of `(diff, policy)` — same inputs, same answer, always, and
 * never written to the manifest. Recomputing it everywhere is what lets routing
 * compose with §4.1 staleness without a single special case: revert the auth
 * file and `security` simply leaves the set, its stale verdict now irrelevant.
 *
 * `diff` is the list from `git.diffFiles`, or null when it could not be read.
 * Null is not "no files" — it is "unknown", and unknown takes the maximum path.
 */
export function deriveRoute(cfg, diff, binaryPaths = []) {
  const all = [...(cfg.gates ?? [])];
  const routing = cfg.routing;

  // Absent `routing`, behaviour is v0.1 exactly: every gate, every time.
  if (!routing) {
    return {
      routed: false,
      gates: all,
      maxPath: false,
      reason: 'routing is not configured — every gate applies',
      exemption: null,
      matched: [],
    };
  }

  const max = (reason) => ({
    routed: true, gates: all, maxPath: true, reason, exemption: null, matched: [],
  });

  // --- Fail closed. Anything we cannot read confidently takes every gate. ---
  if (diff === null) return max('the diff could not be read');
  if (binaryPaths === null) return max('binary detection failed');
  if (binaryPaths.length) return max(`the diff contains binary files (${binaryPaths[0]})`);

  const renamed = diff.find((f) => /^[RC]/i.test(f.status));
  if (renamed) return max(`the diff contains a rename or copy (${renamed.from} → ${renamed.path})`);

  const maxFiles = Number(routing.maxFiles) > 0 ? Number(routing.maxFiles) : DEFAULT_MAX_FILES;
  if (diff.length > maxFiles) return max(`${diff.length} files changed, over the ${maxFiles} limit`);

  const paths = diff.map((f) => f.path);
  const protectedHit = paths.find((p) => matchesAny(PROTECTED_PATHS, p));
  if (protectedHit) return max(`the diff changes routing policy itself (${protectedHit})`);

  const baseline = normalise(routing.baseline ?? all, all);

  // --- Exemptions. Deliberately awkward: `only: true` is mandatory and the
  // rule must cover the entire diff, so one stray file voids it. ---
  for (const entry of routing.exempt ?? []) {
    if (entry?.only !== true) continue;
    if (!diff.length) continue;
    const covered = paths.every((p) => matchesAny(entry.paths, p));
    if (!covered) continue;
    return {
      routed: true,
      gates: normalise(entry.gates ?? [], all),
      maxPath: false,
      reason: `every file matched the "${entry.name ?? 'unnamed'}" exemption`,
      exemption: { name: entry.name ?? 'unnamed', paths: entry.paths ?? [], files: paths },
      matched: [{ source: 'exempt', name: entry.name ?? 'unnamed', gates: normalise(entry.gates ?? [], all), files: paths }],
    };
  }

  return {
    routed: true,
    gates: baseline,
    maxPath: false,
    reason: 'baseline — no exemption covered the whole diff',
    exemption: null,
    matched: [{ source: 'baseline', name: 'baseline', gates: baseline, files: paths }],
  };
}

/**
 * Keep declared order and drop anything not in `gates`.
 *
 * §4.2 ordering generalises to a topological order over the subgraph induced on
 * the required nodes; with a linear gate list that is just a filter, and doing
 * it here means callers never have to think about it.
 */
function normalise(names, all) {
  const want = new Set(names ?? []);
  return all.filter((g) => want.has(g));
}

/** Derive the route for a dock at a given commit. */
export function routeForDock(cfg, dock, sha) {
  const base = `origin/${dock.base}`;
  const from = git.resolveCommit(base, dock.worktree) ? base : dock.base;
  const diff = git.diffFiles(from, sha, dock.worktree);
  const binary = git.diffBinaryPaths(from, sha, dock.worktree);
  return deriveRoute(cfg, diff, binary);
}

export default function route(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);

  const cli = parseArgs(args, { flags: ['--json'] });
  const usage = 'Usage: drydock route <issue> [--json]';
  if (cli.unknown.length) die(`Unknown option: ${cli.unknown.join(', ')}`, usage);

  const issue = cli.positionals.find((a) => /^\d+$/.test(a));
  if (!issue) die(usage);

  const dock = readDock(issue, root);
  if (!dock) die(`No dock for issue #${issue}.`, `Run \`drydock start ${issue}\` first.`);

  const head = git.headSha(dock.worktree);
  const r = routeForDock(cfg, dock, head);

  if (cli.flags.has('--json')) {
    log.raw(JSON.stringify({ issue: Number(issue), sha: head, ...r }, null, 2));
    return;
  }

  log.head(`Route for #${issue} @ ${head.slice(0, 8)}`);
  log.raw(`  Required: ${r.gates.length ? r.gates.join(' → ') : '(none)'}`);
  log.dim(`  Why: ${r.reason}`);
  if (r.maxPath) log.warn('  Maximum path — routing failed closed here.');

  for (const m of r.matched) {
    log.raw(`\n  ${m.source}: ${m.name} → ${m.gates.length ? m.gates.join(', ') : '(no gates)'}`);
    for (const f of m.files.slice(0, 10)) log.dim(`    ${f}`);
    if (m.files.length > 10) log.dim(`    …and ${m.files.length - 10} more`);
  }

  if (!r.routed) log.dim('\n  Add a `routing` block to drydock.config.json to route by diff.');
}
