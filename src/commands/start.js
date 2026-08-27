import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, repoRoot, readDock, writeDock, slugify, isConfigured, listDocks } from '../lib/config.js';
import { log, die } from '../lib/log.js';
import { parseArgs } from '../lib/args.js';
import { tryRun, has } from '../lib/sh.js';
import * as git from '../lib/git.js';
import * as gh from '../lib/gh.js';
import * as notify from './notify.js';
import { runInterview } from './config.js';

export default async function start(args) {
  const cli = parseArgs(args, { flags: ['--force', '--preview'] });
  const issue = cli.positionals.find((a) => /^\d+$/.test(a));
  if (!issue) die('Usage: drydock start <issue-number> [--preview] [--force]');

  const root = repoRoot();
  let cfg = loadConfig(root);

  // First use: settle how much Drydock should do on its own before it does any
  // of it. Non-interactive shells get a notice and the defaults, never a block.
  if (!isConfigured(cfg)) cfg = await runInterview(root);

  if (readDock(issue, root) && !cli.flags.has('--force')) {
    die(`Dock for issue #${issue} already exists.`, 'Use --force to recreate, or `drydock status`.');
  }

  // --- Fetch the issue. GitHub Issues are the source of truth. ---
  let meta = { number: Number(issue), title: `issue-${issue}`, body: '', url: '' };
  if (gh.available()) {
    const fetched = gh.getIssue(issue, root);
    if (fetched) { meta = fetched; log.ok(`Issue #${issue}: ${meta.title}`); }
    else log.warn(`Could not fetch issue #${issue} — continuing with a placeholder title.`);
  } else {
    log.warn('gh not found — using placeholder issue metadata.');
  }

  const slug = slugify(meta.title);
  const branch = cfg.branchPattern.replace('{issue}', issue).replace('{slug}', slug);
  const dockDir = path.resolve(root, cfg.docksDir, `${issue}-${slug}`);
  const flow = cfg.profile === 'flow';

  // --- One issue, one branch, one workspace. The invariant. ---
  git.fetchBase(cfg.baseBranch, root);
  const plan = planWorkspace(cfg, root, issue, cli.flags.has('--preview'));
  log.dim(`Workspace: ${plan.kind} — ${plan.reason}`);

  let workspace;
  if (plan.kind === 'worktree') {
    fs.mkdirSync(path.dirname(dockDir), { recursive: true });
    try {
      git.addWorktree(dockDir, branch, `origin/${cfg.baseBranch}`, root);
    } catch {
      // Fall back to local base if origin/<base> isn't available.
      git.addWorktree(dockDir, branch, cfg.baseBranch, root);
    }
    workspace = dockDir;
    log.ok(`Worktree: ${path.relative(root, dockDir)}`);
  } else {
    // A plain branch in the checkout the developer is already standing in.
    // Refused rather than forced if that would discard work: `start` is not
    // allowed to be the command that loses somebody's uncommitted changes.
    if (git.isDirty(root)) {
      die('The checkout has uncommitted changes.', 'Commit or stash them, or set worktree to "always".');
    }
    const from = git.resolveCommit(`origin/${cfg.baseBranch}`, root) ? `origin/${cfg.baseBranch}` : cfg.baseBranch;
    const sw = git.switchToBranch(branch, from, root);
    if (!sw.ok) die(`Could not check out ${branch}.`, sw.err);
    workspace = root;
    log.ok(`Checked out ${branch} here (no worktree)`);
  }
  log.ok(`Branch:   ${branch}`);

  // --- Brief the agent. This file is the dock's only context. ---
  // Dock mode only: in flow mode the issue is the brief, there is no local
  // policy block, and writing DOCK.md into the developer's own checkout would
  // be litter rather than context.
  if (!flow && plan.kind === 'worktree') {
    // The brief is scaffolding, not source. Git reports untracked files as
    // dirty, so without an exclude entry every dock is permanently dirty and
    // `land` refuses to run — and a stray `git add -A` drags DOCK.md into the
    // PR diff.
    excludeDockBrief(workspace);
    fs.writeFileSync(path.join(workspace, 'DOCK.md'), renderBrief(meta, cfg, branch));
    log.ok('Wrote DOCK.md (the agent brief for this dock)');
  } else {
    log.dim(`Brief: the issue itself${meta.url ? ` — ${meta.url}` : ''}`);
  }

  const dock = {
    issue: Number(issue),
    title: meta.title,
    url: meta.url,
    branch,
    // Kept as `worktree` whatever the workspace kind is: every other command
    // treats it as "the directory this dock's commits live in", and in branch
    // mode that is the checkout itself.
    worktree: workspace,
    workspace: plan.kind,
    workspaceReason: plan.reason,
    profile: cfg.profile,
    base: cfg.baseBranch,
    agent: cfg.agent,
    // Labels are a routing signal (§11.3). Recorded here as a floor; `route`
    // re-reads them from the issue when a rule asks, because a label added
    // after the dock opened is exactly the case worth honouring.
    labels: (meta.labels ?? []).map((l) => l?.name ?? l).filter(Boolean),
    createdAt: new Date().toISOString(),
    gates: Object.fromEntries(cfg.gates.map((g) => [g, null])),
    status: 'open',
  };
  writeDock(dock, root);

  notify.lifecycle(cfg, issue, dockOpenedComment(dock, root), root);

  // --- Optional editor window. Headless if editor is null. ---
  if (cfg.editor && has(cfg.editor) && plan.kind === 'worktree') {
    tryRun(cfg.editor, [workspace]);
    log.ok(`Opened ${cfg.editor} on the dock`);
  }

  log.head(`Dock #${issue} is open`);
  if (plan.kind === 'worktree') log.dim(`cd ${workspace}`);
  log.dim(`then: drydock gate ${issue} review --pass   (after principal review)`);
}

/**
 * A branch-mode dock has to be the branch that is checked out.
 *
 * In dock mode this is structurally guaranteed: the worktree holds the branch,
 * so HEAD there is always the dock's HEAD. With `worktree: "auto"` or `"never"`
 * `dock.worktree` is the developer's own checkout, and if they have switched
 * away, HEAD belongs to something else — so a verdict would bind to a commit
 * that is not on this dock, a preview would serve another branch's code, and
 * `land` would push the dock branch's real tip under a receipt describing what
 * happened to be checked out instead.
 *
 * Refusing is the honest fix. Reading `refs/heads/<branch>` instead would judge
 * one commit while the dirty-tree check inspected an unrelated working copy.
 * `clean` already guards this way; every command that binds to a commit now
 * does too. Commands that only *report* across every dock — `status`,
 * `backlog` — deliberately do not, since dying there would make them useless.
 */
export function assertOnBranch(dock, verb) {
  if ((dock.workspace ?? 'worktree') === 'worktree') return;
  const here = git.currentBranch(dock.worktree);
  if (here === dock.branch) return;
  die(
    `Dock #${dock.issue} is on \`${dock.branch}\`, but \`${here || 'a detached HEAD'}\` is checked out.`,
    `This dock has no worktree of its own, so ${verb} here would use the wrong commit. Run: git switch ${dock.branch}`,
  );
}

/**
 * Worktree, or just a branch?
 *
 * A worktree solves exactly two problems: two checkouts of the same repo needed
 * at once, and a long-running process pinned to one branch. Where neither is
 * present it costs a directory, a copy of the working set, and the mental
 * overhead of remembering where you are. `auto` therefore asks whether either
 * problem is actually here rather than assuming it always is.
 */
export function planWorkspace(cfg, root, issue, previewWanted = false, docks = null) {
  const mode = cfg.worktree ?? 'always';
  if (mode === 'always') return { kind: 'worktree', reason: 'policy: worktree always' };
  if (mode === 'never') return { kind: 'branch', reason: 'policy: worktree never' };
  if (mode !== 'auto') return { kind: 'worktree', reason: `unrecognised worktree policy "${mode}" — failing safe` };

  if (previewWanted) return { kind: 'worktree', reason: 'a preview was requested, which pins a process to this branch' };

  const active = (docks ?? listDocks(root)).filter(
    (d) => String(d.issue) !== String(issue) && d.status !== 'landed' && d.status !== 'closed',
  );
  if (active.length) {
    return {
      kind: 'worktree',
      reason: `${active.length} other dock${active.length > 1 ? 's are' : ' is'} in flight (#${active.map((d) => d.issue).join(', #')})`,
    };
  }
  return { kind: 'branch', reason: 'nothing else is in flight and no preview was asked for' };
}

function dockOpenedComment(dock, root) {
  return [
    '### Drydock: dock opened',
    '',
    `- **Branch:** \`${dock.branch}\` (from \`${dock.base}\`)`,
    dock.workspace === 'worktree'
      ? `- **Worktree:** \`${path.relative(root, dock.worktree)}\``
      : `- **Workspace:** branch in the main checkout — ${dock.workspaceReason}`,
    `- **Agent:** \`${dock.agent}\``,
    `- **Profile:** \`${dock.profile}\``,
    '',
    dock.profile === 'flow'
      ? '<sub>One issue, one branch. Gates bind to the pull request: it cannot merge until every gate on its route has passed against the PR head.</sub>'
      : '<sub>One issue, one branch, one worktree. Nothing opens a PR until every gate passes against the commit it reviewed.</sub>',
  ].join('\n');
}

/**
 * Keep DOCK.md out of git without asking the user to do anything.
 *
 * Linked worktrees share `info/exclude` through the common git dir — a
 * per-worktree `.git/worktrees/<name>/info/exclude` is written but never read,
 * verified experimentally — so one anchored entry covers every dock and
 * rewriting it on each `start` is a no-op. The repo's tracked `.gitignore`
 * cannot do this job: the dock branch is cut from `origin/<base>`, which would
 * not carry an uncommitted ignore rule.
 */
function excludeDockBrief(dockDir) {
  const file = path.join(git.commonDir(dockDir), 'info', 'exclude');
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  if (have.has('/DOCK.md') || have.has('DOCK.md')) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}# Drydock dock brief — scaffolding, never committed\n/DOCK.md\n`);
}

function renderBrief(meta, cfg, branch) {
  return `# Dock #${meta.number} — ${meta.title}

> You are the **sole developer** assigned to this dock.
> Your entire scope is this one issue. Do not touch work outside it.

${renderPolicy(cfg)}

## Rules of this dock

1. This worktree is yours alone. Another agent is working in a sibling worktree — never reach outside this directory.
2. Branch: \`${branch}\`. Base: \`${cfg.baseBranch}\`. Do not switch branches.
3. Follow the escalation bar in the operating policy. Record every proposed interpretation under **Assumptions**; do not silently guess.
4. Scope creep is a failure. Anything you notice that is out of scope goes under **Follow-ups** as a proposed new issue — you do not fix it here.
5. You cannot merge. Your work goes to review and QA gates. Optimise for reviewability: small commits, clear messages.

## Issue

${meta.body || '_(no description provided)_'}

${meta.url ? `Source: ${meta.url}` : ''}

## Definition of done

- [ ] Change implemented, scoped strictly to this issue
- [ ] Tests added or updated and passing locally
- [ ] No unrelated files modified
- [ ] Assumptions recorded below

## Assumptions

_(agent fills this in)_

## Follow-ups

_(agent proposes out-of-scope work here — do not implement)_
`;
}

function renderPolicy(cfg) {
  const comments = cfg.comments.enabled ? cfg.comments.verbosity : 'off';
  const autonomy = {
    full: 'Independent agents may drive implementation, review, QA, landing, and the configured merge flow without waiting for a human gate.',
    'gated-merge': 'Independent agents may drive implementation, review, QA, and landing; a human performs the merge.',
    'human-gates': 'After implementation, hand off and wait for a human to record each gate.',
  }[cfg.autonomy.level] || 'Follow the configured autonomy level and escalate before exceeding it.';
  const escalation = {
    'any-ambiguity': 'Ask about anything the issue does not explicitly answer.',
    'irreversible-only': 'Ask only when a wrong assumption would be difficult to reverse; record other assumptions and proceed.',
    never: 'Do not stop for clarification; record assumptions and proceed.',
  }[cfg.escalation.bar] || 'Apply the configured escalation bar.';
  const batching = cfg.escalation.batchAtPlanTime
    ? ' Batch every clarification into the initial plan before writing code.'
    : ' Ask when clarification becomes necessary.';
  const narration = {
    full: 'Post every role template separately.',
    'milestones-findings': 'Combine related progress updates, but preserve findings and final evidence.',
    milestones: 'Post opening and final milestones only, preserving required final evidence.',
    off: 'Post no narrative GitHub comments; return required evidence to the orchestrator.',
  }[comments] || 'Scale narration to the configured value.';
  const github = {
    prefer: 'Use GitHub MCP first and fall back to `gh` only when MCP does not cover the operation.',
    require: 'Use GitHub MCP only; escalate if it does not cover a required operation.',
    off: 'Use `gh` instead of GitHub MCP.',
  }[cfg.tools.githubMcp] || 'Follow the configured GitHub tooling preference.';

  return `## Operating policy

This block is authoritative for every agent working in this dock.

- **Autonomy level:** \`${cfg.autonomy.level}\`. ${autonomy}
- **Escalation bar:** \`${cfg.escalation.bar}\`. ${escalation}${batching}
- **Comment verbosity:** \`${comments}\`. ${narration}
- **GitHub MCP preference:** \`${cfg.tools.githubMcp}\`. ${github}
- **Retry budget:** ${cfg.autonomy.retriesOnGateFail} gate-failure retries. After the budget is exhausted, escalate instead of spawning another attempt.
`;
}
