---
name: dock-audit
description: >
  Reconstruct what happened on a piece of work — who approved what, against which
  commit, and what the agent assumed. Use this skill when the user asks who
  reviewed something, whether a change was actually gated, what an agent assumed
  or deferred, why a PR was rejected by CI, or wants an audit trail for a release
  or an incident. Covers where Drydock's trace lives and how to read it.
---

# Reading the trail

Drydock keeps no database. Every trace is a file in git, readable with the same
tools as code — `git log`, `git blame`, `gh`.

## Where the trace lives

| Artifact | Location | Answers |
|---|---|---|
| Dock manifest | `.drydock/docks/<issue>.json` (committed) | Which branch, which worktree, every gate verdict with its SHA, who recorded it, when |
| Agent brief | `DOCK.md` in the dock branch | The issue as briefed, the agent's assumptions, its deferred follow-ups |
| Gate receipt | The pull request body | What CI verified at merge time |
| CI verdict | Drydock Gates check on the PR | Whether the receipt matched the head SHA |

## Answering the common questions

**"Was this actually reviewed?"**

```bash
git log --follow -p .drydock/docks/412.json
```

Each commit shows a verdict appearing, with `sha`, `by`, `at`, and `note`. The
`sha` is the whole point: it says *what* was approved, not merely that approval
happened.

**"Did anything land unreviewed?"**

Compare the receipt's SHA to the merge commit's first parent. If a commit landed
after the gates were stamped, the Drydock Gates check would have failed — so
look for a PR that merged with that check red or absent.

**"What did the agent assume?"**

```bash
git show <branch>:DOCK.md
```

Read `## Assumptions` and `## Follow-ups`. An unrecorded assumption that changed
behaviour is itself a review failure — the absence of content here is a finding.

**"Why did CI reject this PR?"**

The Drydock Gates check fails for exactly four reasons:

- no `<!-- drydock-receipt:v1 -->` marker → PR was hand-opened, skipping gates
- a gate is missing from the receipt → gates did not all run
- a gate's SHA does not prefix the PR head → someone pushed after gates passed
- a gate is present but not `pass`

## What the trail does not prove

Be precise about this when reporting, and do not overstate it:

The receipt binds a verdict to a **commit**, which stops a stale or copied
receipt from being reused. It does **not** prove a human actually reviewed
anything — someone with write access can fabricate a receipt whose SHA matches,
and CI will pass it. Drydock raises the cost and creates an audit trail; it is
not a substitute for CODEOWNERS and branch protection.

Similarly, a manifest edited by hand before being committed looks identical to
an honest one. The git history of `.drydock/` is what makes tampering visible —
so review changes to that directory as carefully as you review code.

## Reporting

When asked for an audit, give the SHA, the verdict, the recorder, and the note —
in that order. Never report "review passed" without the commit it passed against.
A verdict without a SHA is exactly the thing this system exists to eliminate.
