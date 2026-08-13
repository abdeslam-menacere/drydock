# Drydock — Design Specification

Version 0.1.0 · Status: draft

## 1. Problem statement

Coding agents are now capable enough that a single developer can run several at once. Git worktrees solved the mechanical collision problem — each agent gets its own checked-out branch, so they stop overwriting each other. Every major orchestrator converged on this in 2026.

What none of them solved is the layer above: **task alignment, gate enforcement, and merge decisions.** Parallel agents multiply pull request production. They do not multiply the human review capacity that pull requests consume. The result is a queue of plausible-looking diffs that nobody has the attention budget to actually review, which is worse than no automation at all — it converts a bottleneck into a false sense of throughput.

Drydock addresses the second problem and treats the first as solved.

## 2. Non-goals

Explicitly out of scope, permanently:

- Being an agent runtime or model wrapper
- Being an MCP server. Drydock does not serve MCP — but its agents should prefer
  GitHub MCP tools over shelling out to `gh` where both can do the job.
- Replacing BMAD, Spec Kit, or GitHub Agent HQ
- Planning, requirements elaboration, or architecture (BMAD's `bmm` module does this)
- A GUI, dashboard, or web service in v1

## 3. Core invariant

> **One issue → one branch → one worktree → one agent → policy-gated merge.**

Every property below derives from it:

- Any change traces to exactly one GitHub issue.
- Any two concurrent units of work are filesystem-isolated.
- Merge authority belongs to the gates, not to whoever runs them. See §10.
- Blast radius of a bad agent run is one branch.

The invariant is machine-checkable, which is what separates it from a methodology.

## 4. The gate model

### 4.1 SHA binding

A gate verdict is meaningless without knowing what it approved. Drydock stores:

```json
{ "verdict": "pass", "sha": "264fd89a...", "by": "adeslam", "at": "...", "note": "..." }
```

A gate is **valid** only while `gate.sha === HEAD` of its worktree. Any new commit invalidates every gate on that dock. This is the single most important design decision in the project.

Failure mode it prevents: agent gets review approval, then "just fixes one more thing," and unreviewed code merges under a green check. This is not hypothetical — it is the default behaviour of every review workflow that stores approval as a boolean.

### 4.2 Ordering

Gates are an ordered list (`["review", "qa"]`). Gate *n* cannot be recorded until gates `0..n-1` have passed. Configurable per repo; teams may add `security` or `perf`.

### 4.3 Dual enforcement

| Layer | Mechanism | Defeats |
|---|---|---|
| Local | `drydock land` refuses to push | Honest mistakes |
| Server | GitHub Action parses the receipt in the PR body and re-verifies each gate against the PR head SHA | Bypass — hand-opened PRs, edited receipts, force-pushes after landing |

The server layer is the real one. Set it as a required status check in branch protection. The CLI is a convenience.

### 4.4 Threat model

| Attack | Mitigation |
|---|---|
| Open PR by hand, skip gates | CI finds no receipt → fail |
| Paste a fake receipt | SHAs must match PR head; forging requires knowing the head, and the receipt is still auditable in `.drydock/` history |
| Push after landing | `synchronize` event re-runs CI; SHA no longer matches → fail |
| Edit the PR body to add gates | `edited` event re-runs CI; still SHA-checked. **Residual risk:** an author with write access can fabricate a matching receipt. Drydock raises the cost and creates an audit trail; it does not replace CODEOWNERS. |
| Agent edits its own gate manifest | **Known gap in v0.1.** Manifests are plain files in the worktree's parent repo. v0.2 should move gate recording behind a signed commit or a GitHub check-run written by a separate identity. |

## 5. State model

State lives in two places, both in git. There is no database.

```
repo/
├── drydock.config.json      # committed — team policy
├── .drydock/docks/412.json  # committed — the audit trail
└── ../.docks/412-slug/      # NOT committed — the isolated worktree
    └── DOCK.md              # the agent's entire brief
```

Dock manifest schema:

```json
{
  "issue": 412,
  "title": "Add refund endpoint",
  "branch": "feat/412-add-refund-endpoint",
  "worktree": "/abs/path/../.docks/412-add-refund-endpoint",
  "base": "main",
  "gates": { "review": {...}, "qa": {...} },
  "status": "open | changes-requested | landed",
  "pr": "https://github.com/..."
}
```

Committing manifests is deliberate: gate history becomes reviewable, blameable, and auditable with the same tools as code.

## 6. Command surface

| Command | Effect |
|---|---|
| `init` | Write config, state dir, gitignore; run preflight; print BMAD wiring |
| `start <issue>` | Fetch issue via `gh`, create branch + worktree, write `DOCK.md`, open editor |
| `status` | Table of docks with per-gate state, including stale detection |
| `gate <issue> <name> --pass\|--fail [--note]` | Record a SHA-bound verdict; enforce ordering |
| `land <issue> [--dry-run]` | Verify all gates fresh → push → open PR with receipt |
| `clean <issue> \| --merged` | Remove worktree, branch, manifest |

## 7. `DOCK.md` — the context boundary

Each worktree gets a generated `DOCK.md`: the issue body, the rules of the dock, a definition of done, and two empty sections the agent must fill — **Assumptions** and **Follow-ups**.

`Assumptions` exists because the dominant failure mode of coding agents is not producing wrong code; it is producing confident code from an unstated guess. Forcing the guess into a file makes it reviewable.

`Follow-ups` exists to give scope creep somewhere legitimate to go. An agent that notices a real problem needs an alternative to fixing it, or it will fix it.

## 8. Roadmap

**v0.2 — Convergence.** The actual moat. Nothing on the market does this:
- Detect file-overlap between open docks *before* work starts and warn on collision-prone issue pairs
- Rebase queue: order landing by dependency, not by whoever finished first
- Conflict arbitration: when two docks touch the same hunk, produce a structured report rather than a merge conflict

**v0.3 — Attention budget.** Review capacity is the real constraint:
- Risk-score each dock (diff size, blast radius, gate notes) and rank the human review queue
- Auto-hold docks that exceed a configured concurrent-review budget

**v0.4 — Hardening.** Gate recording via GitHub check-runs under a separate identity, closing the §4.4 residual risk.

## 9. Open questions

1. ~~Should `gate` be runnable *by an agent*, or only by a human invoking an agent?~~ **Answered in §10:** yes, attributed, and context-isolated from the developer. Self-certification remains the hole; v0.4 makes the distinction cryptographic.
2. Does `--merged` cleanup belong in the CLI or a GitHub Action on merge?
3. Is per-dock editor launching worth keeping at all, given it caps parallelism at human window count? Current stance: keep it optional, default headless in CI.

## 10. Autonomy decision

Supersedes the human-gated posture in §3 and §9.1. `AGENTS.md` requires that any change weakening the invariant be recorded here rather than in a commit message. This is that record.

The invariant becomes **policy-gated merge**. "Gated" said *who*. "Policy-gated" says *what*: the gates still exist, still bind to a SHA, still run in order, and still block the merge. What changed is that a human is no longer required to be the one who records the verdict.

**1. Agents may record gate verdicts.** An agent verdict is attributed `agent:<role>` in the manifest's `by` field and in the PR receipt, so a reader can always tell an agent verdict from a human one.

**2. Autonomy level is configuration, not code.** A first-run setup wizard asks once, persists the answer, and never asks again. Full autopilot, trust-but-verify, and fully manual are the same code path with different data. Nobody has to fork Drydock to keep a human on the gates.

**3. Reviewer and QA agents must be context-independent from the developer agent.** They get the issue text and the diff. They do not get the developer's summary, its reasoning, or its session. A reviewer that reads the author's account of the change is a rubber stamp with extra steps — and an automated rubber stamp is worse than none, because it manufactures a green check nobody actually produced.

**4. Accountability moves to the issue comment trail plus the receipt in the PR body.** With no human in the loop, the record *is* the oversight. Agents post their plan, their assumptions, their findings, real test output, and their verdicts to the issue; the receipt ties each verdict to a SHA. Together they answer "who approved what, against which commit" after the fact, which is the job the human in the loop was doing.

**5. No bypass.** Autonomy is not exemption. There is still no `--skip-gates` and no `--force`. Gates still go stale on any new commit. An agent that cannot pass its own gates does not merge.

### What this rests on

With the human optional, the backstop is entirely server-side: the `drydock-gates` check, branch protection, and CODEOWNERS. Auto-merge with `drydock-gates` *not* set as a required status check merges immediately and unverified — strictly worse than the manual loop. Setup must verify it.

§4.3 already said the server layer is the real one and the CLI is a convenience. This decision is what makes that literally true, and it promotes §4.4's residual risk from theoretical to load-bearing.

### Delivery

This section is a decision, not a description of the shipped CLI. As of `v0.1.0` the command surface is still §6 exactly: `init`, `start`, `status`, `gate`, `land`, `clean`. The decision lands across five issues:

| Decision | Delivered by | Issue |
|---|---|---|
| The record itself, and the governance docs | this section, `AGENTS.md`, `.github/copilot-instructions.md`, `docs/` | **#1** |
| §10.2 — autonomy as configuration | `drydock config`, the first-run interview, `init` verifying branch protection | **#2** |
| §10.1 — agent verdicts, and unattended merge | `gate --as <actor>`, `land` arming auto-merge | **#3** |
| Policy reaching the agent | the `## Operating policy` block rendered into `DOCK.md` by `start` | **#4** |
| §10.3 — the context boundary, enforced | `.github/agents/drydock-orchestrator.md`, `.github/prompts/drydock.prompt.md` | **#5** |

Until #3, §10.1 attribution works through the `DRYDOCK_ACTOR` environment variable, which `gate` writes to the manifest's `by` field. `gate` ignores unrecognised flags rather than rejecting them, so `--as` passed today is silently dropped and the verdict is attributed to the invoking user — an agent verdict recorded as a human one. Rejecting unknown flags belongs with #3.
