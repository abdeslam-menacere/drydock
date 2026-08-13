import { log } from './lib/log.js';
import * as gh from './lib/gh.js';

// Ordered least to most talkative. `comments.verbosity` names one of these.
const RANK = { off: 0, milestones: 1, 'milestones-findings': 2, full: 3 };

/**
 * Should the CLI narrate lifecycle events (dock opened, gate verdict, PR
 * opened) on the issue? Lifecycle is the cheapest tier, so every level above
 * `off` wants it — but the two kill switches still win.
 */
export function wantsLifecycle(cfg) {
  const c = cfg?.comments ?? {};
  if (c.enabled === false || c.cliLifecycle === false) return false;
  return (RANK[c.verbosity] ?? RANK.full) >= RANK.milestones;
}

/**
 * Post a lifecycle comment to the issue.
 *
 * Best effort by design. The GitHub issue is the audit trail, but it is not the
 * source of truth — a network hiccup, a missing remote or an unauthenticated
 * `gh` must never fail the command that triggered the comment, least of all a
 * land. Every failure path here reports and returns.
 */
export function lifecycle(cfg, issue, body, cwd) {
  if (!wantsLifecycle(cfg)) return { posted: false, reason: 'policy' };

  try {
    const r = gh.comment(issue, body, cwd);
    if (r.skipped) return { posted: false, reason: 'gh-unavailable' };
    if (!r.ok) {
      log.dim(`Issue comment not posted: ${firstLine(r.err) || 'gh exited non-zero'}`);
      return { posted: false, reason: 'failed' };
    }
    log.dim(`Commented on #${issue}`);
    return { posted: true };
  } catch (e) {
    log.dim(`Issue comment not posted: ${e.message}`);
    return { posted: false, reason: 'threw' };
  }
}

const firstLine = (s) => String(s || '').split('\n')[0].trim();
