import {
  DEFAULTS, loadConfig, saveConfig, repoRoot,
  deepMerge, getPath, setPath, pendingQuestions,
} from '../lib/config.js';
import { interview, interactive } from '../lib/prompt.js';
import { QUESTIONS, PRESETS, SCHEMA_VERSION, questionById } from '../lib/questions.js';
import { log, die } from '../lib/log.js';

// Everything the interview owns. `reset` restores these and leaves the
// structural settings (docksDir, branchPattern, gates, …) alone.
const POLICY_KEYS = ['setup', 'autonomy', 'escalation', 'comments', 'tools', 'triggers'];

export default async function config(args) {
  const root = repoRoot();
  const [sub, ...rest] = args.filter((a) => !a.startsWith('--'));
  const flags = args.filter((a) => a.startsWith('--'));

  switch (sub) {
    case undefined: return runInterview(root, { all: flags.includes('--all') });
    case 'show':    return show(root, flags);
    case 'set':     return set(root, rest);
    case 'reset':   return reset(root, flags);
    default:
      die(`Unknown: drydock config ${sub}`,
        'Usage: drydock config [--all] | config show [--json] | config set <key> <value> | config reset');
  }
}

/**
 * Ask the human how they want Drydock to behave, and persist it.
 *
 * Only ever asks questions this repo has not seen — a first run gets the whole
 * set, a later schema bump gets just the new ones. Returns the config either
 * way; a non-interactive shell falls straight through on defaults rather than
 * blocking on a prompt nobody can answer.
 */
export async function runInterview(root = repoRoot(), { all = false, io = null } = {}) {
  const cfg = loadConfig(root);
  const pending = all ? QUESTIONS : pendingQuestions(cfg);

  if (!pending.length) {
    log.ok('Drydock is already configured for this repo.');
    log.dim('drydock config show       # the current policy');
    log.dim('drydock config --all      # answer everything again');
    log.dim('drydock config reset      # back to defaults');
    return cfg;
  }

  if (!io && !interactive()) {
    log.warn('Drydock is not configured yet, and this shell cannot prompt — using defaults.');
    log.dim('Run `drydock config` from a terminal to answer the setup questions,');
    log.dim('or write them directly: `drydock config set <key> <value>`.');
    return cfg;
  }

  log.head('Drydock setup');
  log.dim('Answered once. `drydock config` reopens this whenever you want.');

  const answers = {};
  await interview(async (ask) => {
    const presetQ = pending.find((q) => q.id === 'preset');
    let customise = false;

    if (presetQ) {
      Object.assign(answers, PRESETS[await ask(presetQ)] || {});
      customise = await ask(questionById('customise'));
    }

    // First run: the preset already answered these unless they opted in.
    // Schema bump: the pending questions are new, so always ask them.
    const detail = pending.filter((q) => !q.control);
    for (const q of (presetQ && !customise ? [] : detail)) {
      const current = answers[q.id] ?? getPath(cfg, q.id);
      answers[q.id] = await ask({ ...q, default: current === undefined ? q.default : current });
    }
  }, io);

  const next = deepMerge(cfg, {});
  for (const [key, value] of Object.entries(answers)) setPath(next, key, value);
  next.setup = { completed: true, at: new Date().toISOString(), schemaVersion: SCHEMA_VERSION };
  saveConfig(next, root);

  log.ok('Saved to drydock.config.json');
  summarise(next);
  return next;
}

function show(root, flags) {
  const cfg = loadConfig(root);
  // --json is how an orchestrator reads policy: stdout must be JSON and nothing else.
  if (flags.includes('--json')) return console.log(JSON.stringify(cfg, null, 2));
  summarise(cfg);
}

function set(root, args) {
  const [key, ...value] = args;
  if (!key || !value.length) {
    die('Usage: drydock config set <key> <value>', 'e.g. drydock config set comments.verbosity off');
  }

  const target = getPath(DEFAULTS, key);
  if (target === undefined) {
    die(`Unknown config key: ${key}`, 'Run `drydock config show --json` to see the shape.');
  }
  if (target !== null && typeof target === 'object') {
    die(`${key} is a section, not a setting.`, 'Set one of the keys inside it.');
  }

  const parsed = coerce(key, value.join(' '));
  const q = questionById(key);
  if (q?.options && !q.options.some((o) => o.value === parsed)) {
    die(`Invalid value for ${key}: ${parsed}`, `Allowed: ${q.options.map((o) => o.value).join(', ')}`);
  }

  const cfg = loadConfig(root);
  setPath(cfg, key, parsed);
  saveConfig(cfg, root);
  log.ok(`${key} = ${JSON.stringify(parsed)}`);
}

function reset(root, flags) {
  const fresh = deepMerge(DEFAULTS, {});
  const next = flags.includes('--all')
    ? fresh
    : { ...loadConfig(root), ...Object.fromEntries(POLICY_KEYS.map((k) => [k, fresh[k]])) };
  saveConfig(next, root);
  log.ok(flags.includes('--all') ? 'Config reset to defaults.' : 'Policy reset to defaults.');
  log.dim('Run `drydock config` to answer the setup questions again.');
}

/** Coerce a CLI string to the type the schema expects for that key. */
function coerce(key, raw) {
  const kind = questionById(key)?.type || typeof getPath(DEFAULTS, key);

  if (kind === 'boolean') {
    if (/^(true|yes|y|on|1)$/i.test(raw)) return true;
    if (/^(false|no|n|off|0)$/i.test(raw)) return false;
    die(`${key} expects true or false, got: ${raw}`);
  }
  if (kind === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) die(`${key} expects a number, got: ${raw}`);
    return n;
  }
  return raw === 'null' ? null : raw;
}

function summarise(cfg) {
  log.head('Drydock policy');
  const rows = [
    ['setup', cfg.setup.completed ? `completed ${cfg.setup.at} (schema v${cfg.setup.schemaVersion})` : 'not completed'],
    ['autonomy', cfg.autonomy.level],
    ['merge', cfg.autonomy.merge.enabled
      ? `${cfg.autonomy.merge.method}${cfg.autonomy.merge.waitForChecks ? ', waits for checks' : ', DOES NOT wait for checks'}`
      : 'disabled — a human merges'],
    ['retries on gate fail', String(cfg.autonomy.retriesOnGateFail)],
    ['escalation', cfg.escalation.bar + (cfg.escalation.batchAtPlanTime ? ', batched at plan time' : '')],
    ['comments', cfg.comments.enabled ? cfg.comments.verbosity : 'off'],
    ['github mcp', cfg.tools.githubMcp],
    ['docks', cfg.docksDir],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) log.raw(`  ${k.padEnd(w)}  ${v}`);
  log.raw('');
}
