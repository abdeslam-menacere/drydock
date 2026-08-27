import { loadConfig, repoRoot, readDock } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import { parseArgs } from '../lib/args.js';
import { matchesAny } from '../lib/glob.js';
import * as git from '../lib/git.js';
import * as gh from '../lib/gh.js';
import { readScore, applyScore } from './scorer.js';
import { assertOnBranch } from './start.js';

// --- drydock:derive-route (mirrored by .github/workflows/drydock-gates.yml) ---

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

/** Keys that would make a rule subtract. Refused outright, see `validateRouting`. */
const SUBTRACTIVE_KEYS = ['only', 'replace', 'subtract', 'remove', 'exempt'];

export class RoutingConfigError extends Error {}

/**
 * Reject a routing policy that cannot mean what it says.
 *
 * Two failures are worth catching early rather than at land time, when a dock is
 * finished and a person is waiting: a gate name that does not exist (the rule
 * silently never fires), and an attempt to use an author-controlled signal to
 * reach *below* the baseline. The second one is the important one — see §11.3.
 * Refusing loudly is the whole point; silently ignoring it would leave someone
 * believing a `trivial` label is doing something.
 */
export function validateRouting(cfg) {
  const routing = cfg.routing;
  if (!routing) return;

  const all = new Set(cfg.gates ?? []);
  const bad = (msg) => { throw new RoutingConfigError(msg); };
  const checkGates = (names, where) => {
    if (names === undefined) return;
    if (!Array.isArray(names)) bad(`routing.${where}.gates must be a list of gate names.`);
    for (const n of names) {
      if (!all.has(n)) bad(`routing.${where} names gate "${n}", which is not in gates: [${[...all].join(', ')}].`);
    }
  };

  checkGates(routing.baseline, 'baseline');

  if (routing.exempt !== undefined && !Array.isArray(routing.exempt)) {
    bad('routing.exempt must be a list.');
  }
  for (const [i, e] of (routing.exempt ?? []).entries()) {
    const where = `exempt[${i}]${e?.name ? ` (${e.name})` : ''}`;
    checkGates(e?.gates, where);
    // An exemption subtracts. Letting an author-controlled signal reach it would
    // make `trivial` a way to skip review, which is the one thing routing must
    // never permit.
    if (e && 'label' in e) bad(`routing.${where} matches on a label. Labels may only add gates, never remove them.`);
  }

  if (routing.rules !== undefined && !Array.isArray(routing.rules)) {
    bad('routing.rules must be a list.');
  }
  for (const [i, r] of (routing.rules ?? []).entries()) {
    const where = `rules[${i}]${r?.name ? ` (${r.name})` : ''}`;
    if (!r || typeof r !== 'object') bad(`routing.${where} must be an object.`);
    checkGates(r.gates, where);
    if (!Array.isArray(r.gates) || r.gates.length === 0) {
      bad(`routing.${where} adds no gates. A rule that adds nothing cannot be what was meant.`);
    }
    const subtractive = SUBTRACTIVE_KEYS.find((k) => k in r);
    if (subtractive) {
      bad(`routing.${where} uses "${subtractive}". Rules are additive; only routing.exempt may reduce the route.`);
    }
    const conditions = ['paths', 'label', 'labels', 'filesTouched', 'linesChanged', 'deletionRatio', 'codeowners'];
    if (!conditions.some((k) => r[k] !== undefined)) {
      bad(`routing.${where} has no condition, so it would match every diff. Give it one of: ${conditions.join(', ')}.`);
    }
  }
}

/** Parse a CODEOWNERS file into `{ pattern, owners }`, in file order. */
export function parseCodeowners(text) {
  if (!text) return [];
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    out.push({ pattern, owners });
  }
  return out;
}

/**
 * CODEOWNERS patterns are gitignore-shaped, not glob-shaped.
 *
 * A leading slash anchors, a trailing slash means "this directory and below",
 * and a pattern with no slash at all matches at any depth. Everything else is
 * close enough to a glob to reuse the matcher rather than write a second one.
 */
function codeownerGlobs(pattern) {
  let g = pattern;
  if (g.endsWith('/')) return [`${g.replace(/^\//, '')}**`];
  if (g.startsWith('/')) g = g.slice(1);
  else if (!g.includes('/')) return [`**/${g}`, `**/${g}/**`];
  // A bare directory name is a directory, but so is a file of the same name.
  return [g, `${g}/**`];
}

/** Owners of `path` — last matching entry wins, as GitHub does it. */
export function ownersFor(entries, filePath) {
  let owners = [];
  for (const e of entries) {
    if (matchesAny(codeownerGlobs(e.pattern), filePath)) owners = e.owners;
  }
  return owners;
}

/**
 * The gates a change must pass.
 *
 * A pure projection of `(diff, policy, context)` — same inputs, same answer,
 * always, and never written to the manifest. Recomputing it everywhere is what
 * lets routing compose with §4.1 staleness without a single special case:
 * revert the auth file and `security` simply leaves the set, its stale verdict
 * now irrelevant.
 *
 * `diff` is the list from `git.diffFiles`, or null when it could not be read.
 * Null is not "no files" — it is "unknown", and unknown takes the maximum path.
 */
export function deriveRoute(cfg, diff, binaryPaths = [], ctx = {}) {
  validateRouting(cfg);

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

  const rules = routing.rules ?? [];
  const needsStats = rules.some((r) => r.linesChanged !== undefined || r.deletionRatio !== undefined);
  if (needsStats && (ctx.added === null || ctx.added === undefined)) {
    return max('a size rule applies but the diff statistics could not be read');
  }
  const needsOwners = rules.some((r) => r.codeowners !== undefined);
  if (needsOwners && ctx.owners === null) {
    return max('a CODEOWNERS rule applies but CODEOWNERS could not be read');
  }

  const matched = [];

  // --- Exemptions. Deliberately awkward: `only: true` is mandatory and the
  // rule must cover the entire diff, so one stray file voids it. ---
  let exemption = null;
  for (const entry of routing.exempt ?? []) {
    if (entry?.only !== true) continue;
    if (!diff.length) continue;
    if (!paths.every((p) => matchesAny(entry.paths, p))) continue;
    exemption = { name: entry.name ?? 'unnamed', paths: entry.paths ?? [], files: paths };
    matched.push({ source: 'exempt', name: exemption.name, gates: normalise(entry.gates ?? [], all), files: paths });
    break;
  }
  if (!exemption) {
    const baseline = normalise(routing.baseline ?? all, all);
    matched.push({ source: 'baseline', name: 'baseline', gates: baseline, files: paths });
  }

  // --- Rules. Union, never precedence: risks compose, so two rules that both
  // fire contribute both gate sets. That is also what makes adding a rule a
  // monotone operation — it can never shorten anybody's route. §11.3. ---
  for (const [i, rule] of rules.entries()) {
    const hit = ruleMatches(rule, { diff, paths, ...ctx });
    if (!hit) continue;
    matched.push({
      source: 'rule',
      name: rule.name ?? `rules[${i}]`,
      gates: normalise(rule.gates ?? [], all),
      files: hit.files,
      why: hit.why,
    });
  }

  const union = new Set(matched.flatMap((m) => m.gates));
  const gates = normalise([...union], all);
  const rulesFired = matched.filter((m) => m.source === 'rule');

  let reason = exemption
    ? `every file matched the "${exemption.name}" exemption`
    : 'baseline — no exemption covered the whole diff';
  if (rulesFired.length) {
    reason += `, plus ${rulesFired.length} rule${rulesFired.length > 1 ? 's' : ''}: ${rulesFired.map((m) => m.name).join(', ')}`;
  }

  return { routed: true, gates, maxPath: false, reason, exemption, matched };
}

/**
 * Does one rule fire?
 *
 * Conditions within a rule are ANDed — `{ paths: ['src/auth/**'], linesChanged: 500 }`
 * reads as "a large change to auth", which is what anybody writing it expects.
 * Composition happens *between* rules, by union, where it is monotone.
 */
function ruleMatches(rule, s) {
  const why = [];
  let files = s.paths;

  if (rule.paths !== undefined) {
    const hit = s.paths.filter((p) => matchesAny(rule.paths, p));
    if (!hit.length) return null;
    files = hit;
    why.push(`paths: ${hit.length} file${hit.length > 1 ? 's' : ''}`);
  }

  if (rule.filesTouched !== undefined) {
    if (s.diff.length < Number(rule.filesTouched)) return null;
    why.push(`${s.diff.length} files ≥ ${rule.filesTouched}`);
  }

  if (rule.linesChanged !== undefined) {
    const total = (s.added ?? 0) + (s.deleted ?? 0);
    if (total < Number(rule.linesChanged)) return null;
    why.push(`${total} lines ≥ ${rule.linesChanged}`);
  }

  if (rule.deletionRatio !== undefined) {
    const total = (s.added ?? 0) + (s.deleted ?? 0);
    const ratio = total === 0 ? 0 : (s.deleted ?? 0) / total;
    if (ratio < Number(rule.deletionRatio)) return null;
    why.push(`${Math.round(ratio * 100)}% deletions ≥ ${Math.round(Number(rule.deletionRatio) * 100)}%`);
  }

  const wantLabels = rule.labels ?? (rule.label === undefined ? undefined : [rule.label]);
  if (wantLabels !== undefined) {
    const have = new Set(s.labels ?? []);
    const hit = wantLabels.filter((l) => have.has(l));
    if (!hit.length) return null;
    why.push(`label: ${hit.join(', ')}`);
  }

  if (rule.codeowners !== undefined) {
    const want = Array.isArray(rule.codeowners) ? new Set(rule.codeowners) : null;
    const owned = files.filter((p) => {
      const owners = ownersFor(s.owners ?? [], p);
      return want ? owners.some((o) => want.has(o)) : owners.length > 0;
    });
    if (!owned.length) return null;
    files = owned;
    why.push(want ? `owned by ${[...want].join(', ')}` : 'covered by CODEOWNERS');
  }

  return { files, why: why.join('; ') };
}

/**
 * Keep declared order and drop anything not in `gates`.
 *
 * §4.2 ordering generalises to a topological order over the subgraph induced on
 * the required nodes; with a linear gate list that is just a filter, and doing
 * it here means callers never have to think about it. Names that are not
 * declared were already refused by `validateRouting`.
 */
function normalise(names, all) {
  const want = new Set(names ?? []);
  return all.filter((g) => want.has(g));
}

// --- end drydock:derive-route ---

/** Everything the rules need that is not in the diff itself. */
function routeContext(cfg, dock, sha, root) {
  const rules = cfg.routing?.rules ?? [];
  const base = `origin/${dock.base}`;
  const from = git.resolveCommit(base, dock.worktree) ? base : dock.base;

  const ctx = { labels: dock.labels ?? [], owners: null, added: null, deleted: null };

  const stats = git.diffStats(from, sha, dock.worktree);
  if (stats) Object.assign(ctx, stats);

  if (rules.some((r) => r.codeowners !== undefined)) {
    // Policy comes from the base branch, never the head. Reading CODEOWNERS out
    // of the dock's own tree would let a pull request disown its own files.
    //
    // Absent and unreadable are different answers and must stay different. No
    // CODEOWNERS at the base means nobody owns anything, which is a real (and
    // routing-relevant) fact. A CODEOWNERS that exists but will not read is a
    // failure, and `deriveRoute` fails closed on `owners === null`.
    ctx.owners = [];
    for (const p of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
      if (!git.pathExists(from, p, dock.worktree)) continue;
      const text = git.showFile(from, p, dock.worktree);
      ctx.owners = text === null ? null : parseCodeowners(text);
      break;
    }
  }

  // Labels move after `drydock start`, and a label that appears later is exactly
  // the case worth honouring. Only pay for the lookup when a rule reads one.
  if (rules.some((r) => r.label !== undefined || r.labels !== undefined) && gh.available()) {
    const issue = gh.getIssue(dock.issue, root);
    if (issue?.labels) ctx.labels = issue.labels.map((l) => l.name ?? l);
  }

  return ctx;
}

/**
 * Derive the route for a dock at a given commit.
 *
 * Two layers, and the order matters. `deriveRoute` is the floor — deterministic,
 * re-derivable by CI from the base branch, and the thing containment is checked
 * against. A fresh scorer proposal is then folded in *above* it. The scorer can
 * only push this function's answer upward; if it is absent, stale, disabled or
 * broken, what comes out is exactly the deterministic route.
 *
 * Nothing here invokes a model. Reading a proposal off disk is all that happens,
 * so `route`, `status` and `backlog` stay as cheap as they were.
 */
export function routeForDock(cfg, dock, sha, root) {
  const base = `origin/${dock.base}`;
  const from = git.resolveCommit(base, dock.worktree) ? base : dock.base;
  const diff = git.diffFiles(from, sha, dock.worktree);
  const binary = git.diffBinaryPaths(from, sha, dock.worktree);
  const derived = deriveRoute(cfg, diff, binary, routeContext(cfg, dock, sha, root));
  return applyScore(derived, readScore(dock.issue, root), sha, cfg);
}

/**
 * `routeForDock`, but a broken policy stops the command instead of the process.
 *
 * Every caller wants this. A routing block that cannot mean what it says should
 * refuse the first time any command reads it — not silently route short, and not
 * surface as a stack trace at land time with a finished dock waiting.
 */
export function routeOrDie(cfg, dock, sha, root) {
  try {
    return routeForDock(cfg, dock, sha, root);
  } catch (e) {
    if (e instanceof RoutingConfigError) {
      die(`Invalid routing policy: ${e.message}`, 'Fix drydock.config.json and try again.');
    }
    throw e;
  }
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

  assertOnBranch(dock, 'reading a route');

  const head = git.headSha(dock.worktree);
  const r = routeOrDie(cfg, dock, head, root);


  if (cli.flags.has('--json')) {
    log.raw(JSON.stringify({ issue: Number(issue), sha: head, ...r }, null, 2));
    return;
  }

  log.head(`Route for #${issue} @ ${head.slice(0, 8)}`);
  log.raw(`  Required: ${r.gates.length ? r.gates.join(' → ') : '(none)'}`);
  log.dim(`  Why: ${r.reason}`);
  if (r.maxPath) log.warn('  Maximum path — routing failed closed here.');

  for (const m of r.matched) {
    const label = m.why ? `${m.name} (${m.why})` : m.name;
    log.raw(`\n  ${m.source}: ${label} → ${m.gates.length ? m.gates.join(', ') : '(no gates)'}`);
    for (const f of m.files.slice(0, 10)) log.dim(`    ${f}`);
    if (m.files.length > 10) log.dim(`    …and ${m.files.length - 10} more`);
  }

  if (!r.routed) log.dim('\n  Add a `routing` block to drydock.config.json to route by diff.');

  // The scorer's contribution is reported separately from the rules on purpose.
  // These two things have different standing: a rule is policy somebody agreed
  // to, an addition is one agent's opinion with a citation. Merging them into
  // one list would hide which is which at exactly the moment it matters.
  const sc = r.scored ?? { state: 'absent', add: [] };
  if (sc.state === 'fresh' && sc.add.length) {
    log.raw(`\n  scorer${sc.model ? ` (${sc.model})` : ''}: ${sc.add.map((a) => a.gate).join(', ')}`);
    for (const a of sc.add) log.dim(`    ${a.gate} ← ${a.evidence.file}:${a.evidence.lines.join('-')} — ${a.why}`);
  } else if (sc.state === 'stale') {
    log.dim(`\n  scorer: proposal is STALE — it scored a different commit. \`drydock land ${issue}\` re-runs it.`);
  } else if (cfg.scorer?.enabled && sc.state === 'absent') {
    log.dim('\n  scorer: has not run for this commit yet.');
  }
  if (sc.unavailable) log.dim(`  scorer was unavailable: ${sc.unavailable}`);
  if (sc.dropped?.length) log.dim(`  scorer additions dropped: ${sc.dropped.join('; ')}`);
}
