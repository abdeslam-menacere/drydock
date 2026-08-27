import { loadConfig, repoRoot, listDocks } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import * as gh from '../lib/gh.js';
import * as git from '../lib/git.js';
import { gateMarks } from './status.js';
import { routeForDock } from './route.js';

// The order is the order of the answer to "what should I start next?" — the
// things you can pick up, then the things already moving, then the things you
// cannot pick up and why.
const ORDER = ['ready', 'gated', 'in dock', 'blocked', 'landed'];

const HEADING = {
  ready: 'ready',
  gated: 'gated — every gate passed, waiting to land',
  'in dock': 'in dock',
  blocked: 'blocked',
  landed: 'landed',
};

/**
 * Dependency edges declared in an issue body.
 *
 * The fallback for repos not using native sub-issues. Fenced code is stripped
 * first so a `blocked-by:` inside an example does not become a real edge.
 */
export function parseBlockedBy(body) {
  if (!body) return [];
  const prose = String(body).replace(/```[\s\S]*?```/g, '');
  const out = [];
  const line = /^[ \t>*\-]*blocked[ -]?by[ \t]*:?[ \t]*(.+)$/gim;
  for (const m of prose.matchAll(line)) {
    for (const ref of m[1].matchAll(/#(\d+)/g)) out.push(Number(ref[1]));
  }
  return [...new Set(out)];
}

/**
 * Issues and docks in, graph out. Pure — every input is passed, nothing is read
 * from disk or the network here, which is what makes the states testable.
 *
 * A parent issue is blocked by its open sub-issues: decomposition is the one
 * relationship GitHub models natively, and "the parent is not done until its
 * children are" is what it means. Body `blocked-by:` edges are added on top,
 * never instead — a repo may use both.
 */
export function buildGraph({ issues, docks = [], gates = [], routes = {}, heads = {} }) {
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const dockFor = new Map(docks.map((d) => [d.issue, d]));

  const blockedBy = new Map(issues.map((i) => [i.number, new Set()]));
  const add = (issue, blocker) => {
    if (issue === blocker) return; // a self-edge is noise, not a cycle
    blockedBy.get(issue)?.add(blocker);
  };

  for (const i of issues) {
    if (i.parent != null && byNumber.has(i.parent)) add(i.parent, i.number);
    for (const n of parseBlockedBy(i.body)) if (byNumber.has(n)) add(i.number, n);
  }

  const cycles = findCycles(issues.map((i) => i.number), blockedBy);
  const inCycle = new Set(cycles.flat());

  const nodes = issues.map((i) => {
    const dock = dockFor.get(i.number) ?? null;
    const deps = [...blockedBy.get(i.number)].sort((a, b) => a - b);
    // A dependency stops blocking once its own dock has landed. An open issue
    // with no dock is still an unmet dependency, which is the whole point.
    const unmet = deps.filter((n) => dockFor.get(n)?.status !== 'landed');

    return {
      number: i.number,
      title: i.title,
      url: i.url ?? null,
      labels: i.labels ?? [],
      blockedBy: deps,
      unmetBlockers: unmet,
      inCycle: inCycle.has(i.number),
      state: stateOf({ dock, unmet, cycle: inCycle.has(i.number), gates, routes, heads }),
      dock: dock && {
        branch: dock.branch,
        status: dock.status,
        profile: dock.profile ?? 'dock',
        workspace: dock.workspace ?? 'worktree',
        gates: dock.gates ?? {},
        preview: dock.preview?.url ?? null,
      },
    };
  });

  return { nodes, cycles };
}

function stateOf({ dock, unmet, cycle, gates, routes, heads }) {
  if (dock?.status === 'landed') return 'landed';
  if (dock) return allGatesPassed(dock, gates, routes, heads) ? 'gated' : 'in dock';
  // A cycle has no ready set. Calling any member of one ready would be a
  // recommendation to start work whose dependencies can never be satisfied.
  if (cycle || unmet.length) return 'blocked';
  return 'ready';
}

function allGatesPassed(dock, gates, routes, heads) {
  const required = routes[dock.issue] ?? gates;
  if (!required.length) return true;
  const head = heads[dock.issue] ?? null;
  return required.every((n) => {
    const g = dock.gates?.[n];
    return g?.verdict === 'pass' && (!head || g.sha === head);
  });
}

/**
 * Every dependency cycle, each reported once.
 *
 * Iterative on purpose: a cycle is exactly the input that makes a recursive
 * walk of this graph hang, and hanging is the failure mode this is here to
 * prevent.
 */
export function findCycles(numbers, blockedBy) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map(numbers.map((n) => [n, WHITE]));
  const seen = new Set();
  const cycles = [];

  for (const root of numbers) {
    if (colour.get(root) !== WHITE) continue;
    const stack = [{ node: root, kids: [...(blockedBy.get(root) ?? [])] }];
    colour.set(root, GREY);
    const path = [root];

    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (!frame.kids.length) {
        colour.set(frame.node, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      const next = frame.kids.shift();
      if (!colour.has(next)) continue;
      if (colour.get(next) === GREY) {
        const cycle = path.slice(path.indexOf(next));
        const key = [...cycle].sort((a, b) => a - b).join(',');
        if (!seen.has(key)) { seen.add(key); cycles.push(cycle); }
        continue;
      }
      if (colour.get(next) === BLACK) continue;
      colour.set(next, GREY);
      path.push(next);
      stack.push({ node: next, kids: [...(blockedBy.get(next) ?? [])] });
    }
  }
  return cycles;
}

export default function backlog(args = []) {
  const unknown = args.filter((a) => a.startsWith('-') && !['--ready', '--json'].includes(a));
  if (unknown.length) die(`Unknown option: ${unknown[0]}`, 'Usage: drydock backlog [--ready] [--json]');

  const readyOnly = args.includes('--ready');
  const asJson = args.includes('--json');

  const root = repoRoot();
  const cfg = loadConfig(root);
  const docks = listDocks(root);

  const { issues, source, notice, truncated } = collect(root, docks);

  const heads = {};
  const routes = {};
  for (const d of docks) {
    try { heads[d.issue] = git.headSha(d.worktree); } catch { /* workspace gone */ }
    try { routes[d.issue] = routeForDock(cfg, d, heads[d.issue], root).gates; } catch { /* fall back to cfg.gates */ }
  }

  const graph = buildGraph({ issues, docks, gates: cfg.gates, routes, heads });
  const shown = readyOnly ? graph.nodes.filter((n) => n.state === 'ready') : graph.nodes;

  if (asJson) {
    // stdout is JSON and nothing else — an orchestrator reads this.
    return console.log(JSON.stringify({ source, truncated, cycles: graph.cycles, nodes: shown }, null, 2));
  }

  if (notice) log.warn(notice);
  if (truncated) log.warn('More than 100 open issues — the graph is capped at the oldest 100.');

  if (graph.cycles.length) {
    log.err(`${graph.cycles.length} dependency cycle${graph.cycles.length > 1 ? 's' : ''}:`);
    for (const c of graph.cycles) log.dim(`${c.map((n) => `#${n}`).join(' → ')} → #${c[0]}`);
    log.dim('Nothing in a cycle can ever be ready. Break one edge.');
  }

  if (!shown.length) {
    log.info(readyOnly ? 'Nothing is ready. Everything open is blocked or already in a dock.' : 'Backlog is empty.');
    return graph;
  }

  const readyCount = graph.nodes.filter((n) => n.state === 'ready').length;
  log.head(`${graph.nodes.length} open · ${readyCount} ready`);

  for (const state of ORDER) {
    const group = shown.filter((n) => n.state === state);
    if (!group.length) continue;
    log.raw('');
    log.raw(HEADING[state]);
    for (const n of group) render(n, cfg, heads);
  }

  log.raw('');
  log.dim('ready = nothing open is blocking it and no dock is holding it');
  log.dim('Start one: drydock start <issue>');
  return graph;
}

function render(n, cfg, heads) {
  const marks = n.dock ? gateMarks(n.dock, cfg.gates, heads[n.number] ?? null) : '';
  log.raw(`  #${String(n.number).padEnd(5)} ${marks.padEnd(marks ? 26 : 0)}${n.title}`);
  if (n.unmetBlockers.length) log.dim(`blocked by ${n.unmetBlockers.map((b) => `#${b}`).join(', ')}`);
  if (n.dock) log.dim(`${n.dock.branch}  ·  ${n.dock.profile} / ${n.dock.workspace}`);
  if (n.dock?.preview) log.dim(`preview: ${n.dock.preview}`);
}

/**
 * Issues, from the best source available.
 *
 * Degrading is fine; degrading quietly is not. Every step down says what was
 * lost, because a backlog with no edges in it looks exactly like a backlog
 * with no dependencies.
 */
function collect(root, docks) {
  const graph = gh.issueGraph(root);
  if (graph) return { issues: graph.issues, source: 'github', truncated: graph.truncated, notice: null };

  const listed = gh.listIssues(root);
  if (listed) {
    return {
      issues: listed,
      source: 'github',
      truncated: false,
      notice: 'Sub-issue relationships unavailable — edges come from `blocked-by: #N` in issue bodies only.',
    };
  }

  return {
    issues: docks.map((d) => ({ number: d.issue, title: d.title, url: null, body: '', labels: d.labels ?? [], parent: null })),
    source: 'docks',
    truncated: false,
    notice: 'gh unavailable — showing open docks only. Issues without a dock, and every dependency edge, are invisible.',
  };
}
