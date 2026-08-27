import init from './commands/init.js';
import config from './commands/config.js';
import start from './commands/start.js';
import run from './commands/run.js';
import route from './commands/route.js';
import backlog from './commands/backlog.js';
import preview from './commands/preview.js';
import score from './commands/scorer.js';
import gate from './commands/gate.js';
import land from './commands/land.js';
import status from './commands/status.js';
import clean from './commands/clean.js';
import { log } from './lib/log.js';

const VERSION = '0.1.0';

const COMMANDS = {
  init:   [init,   'Scaffold Drydock in the current repo'],
  config: [config, 'Set how much Drydock does on its own (show | set | reset)'],
  start:  [start,  'Open a dock for a GitHub issue (branch + worktree + agent brief)'],
  run:    [run,    'Print the orchestration prompt for an issue, for any agent surface'],
  route:  [route,  'Show which gates this change earns, and why'],
  score:  [score,  'Ask the risk scorer whether this change earns more (add-only)'],
  backlog:[backlog,'Show what is ready to start, what is blocked, and by what'],
  status: [status, 'Show every dock in flight and its gate state'],
  preview:[preview,'Serve a dock on a deterministic port so a human can look at it'],
  gate:   [gate,   'Record a gate verdict, bound to the current commit'],
  land:   [land,   'Verify gates, push, and open the pull request'],
  clean:  [clean,  'Remove a dock: worktree, branch, manifest'],
};

export function main(argv) {
  const [cmd, ...args] = argv;

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return help();
  if (cmd === '-v' || cmd === '--version') return console.log(VERSION);

  const entry = COMMANDS[cmd];
  if (!entry) { log.err(`Unknown command: ${cmd}`); return help(1); }

  try {
    const result = entry[0](args);
    if (result && typeof result.then === 'function') result.catch(fail);
  } catch (e) {
    fail(e);
  }
}

function fail(e) {
  log.err(e.message);
  if (process.env.DRYDOCK_DEBUG) console.error(e);
  process.exit(1);
}

function help(code = 0) {
  console.log(`
Drydock ${VERSION} — every feature gets its own dock. Nothing ships unreviewed.

Usage: drydock <command> [options]

Commands:`);
  for (const [name, [, desc]] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(8)} ${desc}`);
  }
  console.log(`
The loop:
  drydock backlog                    # what is ready to start, and what is blocked
  drydock start 412                  # issue #412 gets a branch, a worktree, an agent
  drydock route 412                  # which gates this diff earns, and why
  drydock preview 412                # serve it on a port so a person can look
  drydock gate 412 review --pass --sha <head>
  drydock gate 412 qa --pass --sha <head>
  drydock land 412                   # gates verified → PR opened
  drydock clean 412                  # worktree and branch removed

Gates bind to the commit that was reviewed. New commits invalidate them. Stale
gates cannot land. Routing and the scorer decide how much review a change earns;
neither can decide it earns none.
`);
  process.exit(code);
}
