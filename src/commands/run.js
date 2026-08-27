import { loadConfig, repoRoot, readDock } from '../lib/config.js';
import { die, log } from '../lib/log.js';
import { parseArgs } from '../lib/args.js';

/**
 * Print the orchestration prompt for an issue.
 *
 * The loop is not owned by any one agent surface. `drydock run <issue>` emits
 * the brief on stdout and nothing else, so it can be piped or pasted into VS
 * Code chat, a terminal agent, or an issue comment without editing.
 */
export default function run(args) {
  const root = repoRoot();
  const cfg = loadConfig(root);

  const cli = parseArgs(args, { flags: [], options: [] });
  if (cli.unknown.length) die(`Unknown option: ${cli.unknown.join(', ')}`, 'Usage: drydock run <issue-number>');

  const issue = cli.positionals.find((a) => /^\d+$/.test(a));
  if (!issue) die('Usage: drydock run <issue-number>');

  if (cfg.triggers?.cliRun === false) {
    die('The `drydock run` trigger is disabled for this repo.',
      'Enable it: drydock config set triggers.cliRun true');
  }

  log.raw(renderPrompt(issue, cfg, readDock(issue, root)));
}

function renderPrompt(issue, cfg, dock) {
  const merge = cfg.autonomy?.merge ?? {};
  const gates = cfg.gates.join(' → ');

  return `Run the Drydock loop for issue #${issue} in this repository.

The invariant: one issue → one branch → one worktree → one agent → policy-gated
merge. Gate verdicts bind to a commit SHA and go stale on any new commit. There
is no bypass, and you must not invent one.

## Policy for this repo

- Autonomy level: ${cfg.autonomy?.level}
- Gates, in order: ${gates}
- Escalation bar: ${cfg.escalation?.bar}${cfg.escalation?.batchAtPlanTime ? ', batched into one round at plan time' : ''}
- Issue comments: ${cfg.comments?.enabled === false ? 'off' : cfg.comments?.verbosity}
- Merge: ${merge.enabled ? `${merge.method}, ${merge.waitForChecks === false ? 'does NOT wait for checks' : 'waits for required checks'}` : 'disabled — a human merges'}
- Retries after a failed gate: ${cfg.autonomy?.retriesOnGateFail}
- GitHub tooling: ${cfg.tools?.githubMcp}

## Steps

1. Read issue #${issue}. Do not start work you cannot trace back to its text.
2. ${dock ? `The dock already exists at \`${dock.worktree}\` on \`${dock.branch}\`.` : `\`drydock start ${issue}\` — this creates the branch, the worktree and DOCK.md.`}
3. Work only inside that worktree. Anything out of scope goes under
   \`## Follow-ups\` in DOCK.md as a proposed issue; do not fix it here.
4. Record every ambiguity under \`## Assumptions\` in DOCK.md rather than
   guessing silently. Escalate per the bar above.
5. Commit in small atomic commits. Run the tests and report the real output.
6. Review, with context independent of whoever implemented — the issue text and
   \`git diff\` only, never the developer's own summary. Bind the verdict to the
   commit you actually read, not to whatever HEAD has become since:
   \`drydock gate ${issue} review --pass|--fail --as agent:drydock-reviewer --sha <reviewed-sha> --note "..."\`
7. QA, likewise independent and likewise bound to the commit it examined:
   \`drydock gate ${issue} qa --pass|--fail --as agent:drydock-qa --sha <reviewed-sha> --note "..."\`
8. \`drydock land ${issue}\` — gates are verified against HEAD, then the PR opens
   with the receipt${merge.enabled ? ' and auto-merge is armed' : ''}.
9. Post the summary to the issue: what changed, files touched and why, real test
   output, assumptions, and what you deliberately did not do.

Never review your own work. Never edit \`.drydock/docks/*.json\` by hand. Never
hand-write a gate receipt. If a gate goes stale, re-run it — that is the system
working, not a problem to route around.

\`--sha\` is the commit you read, captured before you start reading. A dock that
commits while you review moves HEAD, and a verdict recorded against the new HEAD
would pass code nobody examined. If Drydock tells you the dock moved, re-read the
new commit; do not re-run with the SHA it reports.
`;
}
