---
name: dock-github
description: >
  Perform GitHub operations for a docked issue — reading issues, filing follow-ups,
  labelling, inspecting pull requests and checks — using the Copilot CLI's built-in
  GitHub tools or the gh CLI. Use this skill whenever the user asks to look at an
  issue or PR, file a follow-up, check CI status, or when you need to act on the
  repository during dock work. Defines which operations are allowed at which stage
  and which are never the agent's to perform.
---

# GitHub operations inside a dock

## Which tool

Read `tools.githubMcp` from the operating policy first: `require` means no `gh`
fallback, `prefer` means MCP first with an explained fallback, and `off` means
use `gh` without enabling GitHub MCP.

Before issue-dependent work, inspect the current client's actual server status
and tool inventory. Issue workflows need `issue_read`, `issue_write`, and
`add_issue_comment`; repository/code search alone is insufficient. PR/check
reads need `pull_request_read` and the permissions for the requested method.
Do not infer authentication, authorization, or tool exposure from configuration.

Use `drydock mcp doctor --client <vscode|cli|app> --client-version <version>
--workflow issue`. Where you can observe runtime state, provide the non-secret,
fresh, scoped stdin observation described in `docs/MCP.md`, with this session's
identifier. Normalize client-prefixed tool names to their canonical MCP names
only when you have verified the actual tool. Leave unobserved fields unknown.
Do not assert write authorization based on a successful read, and never create
an issue/comment or mutate cloud resources merely to test permission.

If `require` has any missing or unknown prerequisite, stop before dependent
work and explain the affected capability and corrective action. Even a successful
doctor result does not give the standalone Drydock CLI an MCP transport: its
GitHub-dependent commands refuse under `require`. Escalate the transport boundary;
do not hand-create a PR or receipt. Under `prefer`, explain missing MCP capability
before the documented `gh` fallback. Optional integrations do not block GitHub work.

For missing configuration, preview `drydock mcp setup` with explicit client,
version and server selection, then obtain approval before adding `--apply`.
Setup never installs packages, signs in, approves client trust, or changes global
settings. See `docs/MCP.md` for switching clients, migration and troubleshooting.

The Copilot CLI ships with GitHub tools enabled by default as a restricted subset.
Widen it only when the task needs it:

```bash
copilot --add-github-mcp-toolset issues        # issue read/write
copilot --add-github-mcp-toolset pull_requests # PR read
copilot --add-github-mcp-tool <tool>           # one specific tool
```

Under `prefer`, anything not covered goes through `gh`. Under `off`, use `gh`
directly. Under `require`, do not run these fallbacks:

```bash
gh issue view 412 --json title,body,labels
gh pr checks <pr>
gh run view <run-id> --log-failed
```

Prefer read-only calls. Every write below is subject to the stage rules.

## Allowed, any time

- Read issues, PRs, checks, run logs, diffs, labels, milestones.
- Read `.drydock/docks/*.json` and `DOCK.md`.

## Allowed, with the user's explicit go-ahead

- **File a follow-up issue** from a `## Follow-ups` entry. This is the sanctioned
  destination for scope creep — an agent that notices a real problem needs an
  alternative to fixing it, or it will fix it. Link back to the originating issue.
- **Comment** on an issue or PR.
- **Add labels** that reflect state you can verify.

Say what you are about to create and wait for a yes. Filing five speculative
issues from one dock is noise, not diligence.

## Never

- **Never merge a pull request.** No agent in this system has merge authority.
  That is the invariant the whole product rests on.
- **Never open a PR by hand.** Use `drydock land <issue>`, which attaches the
  gate receipt. A hand-opened PR has no receipt and CI will reject it — and
  working around that rejection is defeating the safety mechanism, not fixing a bug.
- **Never edit a PR body to add, alter, or copy a gate receipt.** Receipts are
  generated from recorded verdicts. Hand-writing one is forgery even if CI passes it.
- **Never close the issue your dock is for.** Landing does it via `Closes #<issue>`.
- **Never change repository settings**, branch protection, required checks, or
  Actions permissions. Surface the need to the user instead.
- **Never force-push** a dock branch after landing. It invalidates the receipt
  and re-triggers CI as a failure.

## Filing a good follow-up

Carry over what the next dock cannot infer:

```bash
gh issue create \
  --title "<what is wrong, not what to do>" \
  --body "Noticed while working #412.

Problem: <observed behaviour, with file:line>
Why out of scope here: <one line>
Suggested acceptance criteria:
- [ ] ..."
```

One issue per problem. If it needs two branches, it is two issues.

## When CI is red

Read the failure before touching anything:

```bash
gh pr checks <pr>
gh run view <run-id> --log-failed
```

If **Drydock Gates** is the failing check, the fix is process, not code — re-run
the stale gate against current HEAD and land again. Do not attempt to satisfy the
check by editing the PR body.
