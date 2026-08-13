import init from './commands/init.js';
import config from './commands/config.js';
import start from './commands/start.js';
import run from './commands/run.js';
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
  status: [status, 'Show every dock in flight and its gate state'],
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
  drydock start 412                  # issue #412 gets a branch, a worktree, an agent
  drydock gate 412 review --pass     # principal review
  drydock gate 412 qa --pass         # QA validation
  drydock land 412                   # gates verified → PR opened
  drydock clean 412                  # worktree and branch removed

Gates bind to a commit SHA. New commits invalidate them. Stale gates cannot land.
`);
  process.exit(code);
}
