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

**Which commit `sha` is.** It is the commit the reviewer *examined*, not HEAD at the moment the verdict was written. Those are the same instant only if nothing committed in between, and in an unattended loop that is not a safe assumption: a dock commits on its own schedule while a review is in flight. Capturing HEAD at write time silently binds the verdict to a commit nobody read, and `land` then sees a perfectly fresh gate — the exact inversion of this section. Staleness only ever detected commits made *after* a verdict; this window sat before it.

So the reviewer states what it read, with `--sha`, and Drydock refuses the verdict when that is not HEAD rather than recording it against something else. Refusing is the whole point: the correct response to a moved dock is to re-read it, not to re-target the verdict.

`--sha` is **mandatory for `agent:` actors and optional for humans**. The window is a property of concurrency, and the unattended path is where it is real. A human at a terminal is the same person who just read the diff, seconds earlier, and would notice — so the manual path keeps its short command. This is deliberate asymmetry, not an oversight: the stricter rule falls on the path that cannot notice.

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
| Smuggle a row into the receipt through a gate note or an actor name | The receipt is parsed one line at a time, so a line break in a caller-supplied value is a forged verdict — or a forged route claim, which needs no table at all. `gate` refuses `--note`/`--as` containing any JavaScript line terminator (including the invisible U+2028/U+2029), `DRYDOCK_ACTOR` is collapsed to one line, the renderer strips terminators and escapes `\|` in every cell, and CI takes the **last** `drydock-route` line — the one below the table, which a cell cannot reach. |
| Bind a verdict to a commit nobody reviewed | `--sha` names the reviewed commit and a mismatch with the dock's HEAD is refused (§4.1). Without it the verdict binds to HEAD at write time, which may have moved during the review. |
| Gate or land a branch-mode dock from another branch | With no worktree of its own (§11.5) nothing pins a dock to its branch, so `gate` and `land` refuse unless it is the branch checked out. |
| A CODEOWNERS that will not read | Absence, unreadability, and "a directory of that name" are distinguished (`git cat-file -t` must say `blob`, then `git show`); unreadable fails closed to the maximum path in both the CLI and CI. |
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

  Partly superseded by §11: routing is the attention budget, allocated per change
  rather than per queue, and arrives before this milestone.

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

§10.1 attribution is delivered: `gate --as <actor>` writes the actor to the manifest's `by` field, and `resolveActor()` ranks the flag above `DRYDOCK_ACTOR` deliberately, because an environment variable persists for the life of a shell and a stale one filed under the wrong name is exactly the error this is meant to prevent. Unknown options are rejected rather than ignored, so a mistyped flag fails loudly instead of recording the wrong thing and exiting 0.

## 11. Heaviness decision

Supersedes the uniform process cost implied by §3 and §6, and delivers part of §8's v0.3 milestone early. Like §10, this changes *how much* process a change earns and *when* the gates bind — not whether they bind. §4.1 SHA binding, §4.2 ordering, and §10.5's no-bypass survive intact.

### The problem

v0.1 charges every issue the same price: a worktree, a `DOCK.md`, a manifest, a policy block, two gates, a receipt, and a CI check. A typo and a payments refactor pay identically. That is two distinct costs wearing one name:

1. **Fixed ceremony** — paid per issue, regardless of blast radius.
2. **Per-commit friction** — gates bind to dock `HEAD` and go stale on every commit, so governance fires *while* the work is being built rather than when it is proposed for integration.

§11.1–11.4 address the first. §11.5 addresses the second.

### 11.1 The route

The set of gates a change must pass is **derived**, not configured globally and not asserted by the author:

```
required(sha) = baseline ∪ { r.gates : r ∈ rules, r matches diff(base…sha) }
```

Rules are **additive, with union semantics**. First-match-wins is wrong here: risks compose, and a change touching both `auth/` and `migrations/` needs both gates. The property this buys is worth stating on its own — **adding a rule can never weaken the system.**

`required` is a pure projection of `(diff at sha, policy at base)`. It is never stored. Recomputing it at every evaluation is what makes routing compose with §4.1 staleness without a single special case:

| Event | Outcome | Special-case logic |
|---|---|---|
| Dev touches an auth file after review passed | review goes stale, `security` is now required and never ran → `land` refuses | none |
| Dev reverts that auth change | `security` leaves the required set; its stale verdict is simply irrelevant | none |
| Diff grows past a size threshold | `qa` joins the required set | none |

Ordering (§4.2) generalises from a total order over an array to a topological order over the subgraph induced on the required nodes. `qa` still cannot precede `review`.

### 11.2 Why this is not a bypass

A mechanism that gives some changes fewer gates is a bypass unless every one of these is inverted:

| A bypass | Routing |
|---|---|
| The author asserts the change is safe | The router **observes** the diff; the author asserts nothing |
| Decided per change, at commit time | Decided once, in committed policy, reviewed as code |
| A judgement call | A **deterministic function** — same diff, same route, always |
| Leaves no record of what was skipped | Route and matched rules are named in the receipt |

You do not approve the change. You approve the rule that classified it.

Policy is read from the **base branch**, never from the PR head — otherwise a pull request rewrites the rules that judge it. A diff touching `drydock.config.json`, `.github/workflows/**`, or `CODEOWNERS` routes to the maximum path. The routing rules protect themselves.

**Routing allocates judgement, never verification.** Tests, lint, and typecheck are not routable and no exemption reaches them. Routing decides how much review and QA attention to spend *on top of* a floor that always runs. That distinction is the whole defence, and it is why this is an attention budget rather than a skip flag.

Falling below `baseline` requires `exempt`, which is deliberately awkward: `only: true` is mandatory — the rule must match the *entire* diff, so one stray file voids it — and exemptions never apply to policy files, workflows, or CODEOWNERS-owned paths. Each use is named in the receipt.

### 11.3 Author-assertable signals are monotone-increasing

A label, a branch name, or anything else under the author's control may **add** a gate. It may never remove one. `needs-security-review` works; `trivial` does nothing.

Fail closed everywhere else. An unmatched path takes `baseline`. A binary file, a rename, a parse failure, or an oversized diff takes the maximum path.

### 11.4 The risk scorer

An agent may contribute to the route under exactly one constraint: **it may only add.**

1. Monotonicity is enforced by the **output schema**, not by the prompt. The parser accepts `{ add, evidence, why }`, validates each name against `gates`, and drops everything else. Removal is not a field that exists.
2. **Evidence is mandatory** — a file and line range drawn from the diff. An addition without it is dropped. The failure mode being defended against here is not security but noise: a scorer that adds `security` to every pull request gets the whole tool removed within a month.
3. The scorer's output is **bound to a SHA** and goes stale on a new commit, exactly like a verdict. `required` stays a free pure projection; the scorer runs at discrete points and is recomputed before `land`, so `status` never spawns a model call.
4. §10.3 applies unchanged: issue and diff only, never the developer's summary — and preferably not the developer's model, since agents on one model agree with each other at scale.

Two properties follow from monotonicity, and together they are why an agent is admissible in this position at all:

- **Prompt injection degrades to the floor.** The diff is attacker-controlled text and the scorer reads it. The worst an injection achieves is suppressing an addition.
- **Fail-open is legal.** Unavailable, rate-limited, or timed out → proceed on the deterministic route. That is never acceptable for a gate; it is fine for a contributor that can only add.

Both depend on one discipline, which is the load-bearing sentence of this section:

> **The deterministic router is the security boundary. The scorer is never the sole detector of a known risk class.**

Move a rule out of `rules` and rely on the scorer for it, and fail-open becomes a hole. The scorer exists to catch what no rule anticipated. A finding it repeats belongs in `rules` as deterministic code — its success metric is that it goes quiet, and its long-term output is pull requests against its own configuration.

**Consequence for §4.3.** Server-side verification can no longer compare routes for equality; a probabilistic contributor will not reproduce itself. It becomes containment:

```
claimed ⊇ derived_deterministic
∀ g ∈ claimed : g has a passing verdict whose sha === PR head
```

CI verifies the floor and ignores the ceiling. The scorer's nondeterminism is structurally harmless, and additions are binding once claimed. **The containment check ships in the first routing issue, before anything can add to a route** — it is forward-compatible and expensive to retrofit.

Residual risk, in the register of §4.4: an author may drop a scorer-added gate from the receipt, and containment will still pass. This degrades to the deterministic floor, which is precisely why the discipline above is not optional. The scorer's output is committed to `.drydock/` alongside the manifest, so the omission is visible in history. As with §4.4, Drydock raises the cost and creates an audit trail; it does not replace CODEOWNERS.

### 11.5 Flow mode

The second cost is *when* the gates bind. Flow mode moves the binding point, not the binding.

| | Dock mode (§3, today) | Flow mode |
|---|---|---|
| Governance travels with | the commit | the pull request |
| Enforced | `land` locally, then CI | CI only |
| Worktree | always | when it earns one |
| Local artifacts | `DOCK.md`, manifest, policy block | none — the issue is the brief |

Gates still bind to a SHA, still run in order, still go stale, and still cannot be skipped. They fire once, against the integration candidate.

This makes §4.3's "the server layer is the real one and the CLI is a convenience" literally true for flow mode, because there is no local layer left. The warning in §10's *What this rests on* therefore applies with full force: without `drydock-gates` as a **required** status check, flow mode is unenforced.

**Worktrees are allocated, not assumed.** A worktree solves two problems — concurrent checkouts, and long-running processes bound to a branch. `worktree: "auto"` creates one when another dock is active or a preview is requested, and uses a plain branch otherwise. Where neither problem exists there is nothing to solve, and the isolation ceremony is pure cost.

### 11.6 Product acceptance, and evidence from outside the graph

A graph of agents reviewing agents converges on confident agreement. Some evidence has to originate outside it. Tests are one such source. A human looking at the running software is the other, and Drydock currently has no way to express it — §3's roles table deliberately has no product owner, on the grounds that ceremony without authority is theatre. A gate *is* authority, which resolves that objection.

`preview` runs a dock's branch on a deterministic port and posts the URL to the issue, so the product owner's entire interface is a link. A `po` gate records their verdict, under two rules:

1. **`actor: "human"`.** A gate node may declare that an `agent:` verdict is refused. This is the first gate an agent cannot record; §10.1 does not extend to it.
2. **The verdict binds to the SHA the preview was serving**, not to `HEAD`. A product owner approves what they *saw*. If the dock advanced while they were looking, the approval is stale — §4.1, applied to product acceptance.

The scorer may add `po`, since §11.3 permits additions of human gates. Under `autonomy.level: full` that stalls the dock by design, so it must notify loudly rather than wait in silence. An agent escalating to a human gate is the system correctly reporting that it is out of its depth.

### What this rests on

Routing moves a decision that was previously implicit and uniform into committed, reviewable policy. It is therefore only as good as that policy. A `routing` block that exempts too much is a self-inflicted wound, and no mechanism described here prevents it — in the same way §4.4 cannot prevent an author with write access from fabricating a receipt. What both do is make the choice explicit, attributable, and reviewable after the fact.

Three costs, stated plainly:

- **`routing` absent means v0.1 behaviour exactly.** Routing is opt-in. Shipped any other way, it makes the complaint it exists to answer worse.
- **Zero-dependency glob matching is a hand-rolled matcher.** `path.matchesGlob()` is Node 22+ and experimental, against a stated floor of Node 20.12. Bump the floor or write the thirty lines — deliberately, not by accident.
- **`preview` spawns a detached process and tracks it in a pid file.** §5 says state lives in git and there is no daemon. A preview is neither: it is ephemeral runtime, gitignored like the worktree it serves. The exception is recorded here rather than discovered in a diff.

### Delivery

As with §10, this section is a decision, not a description of the shipped CLI. Nothing in §11 exists in `v0.1.0`.

| Decision | Delivered by | Issue |
|---|---|---|
| The record itself, and the governance docs | this section, `AGENTS.md`, `.github/copilot-instructions.md` | **#20** |
| §11.1, §11.2 — routing, `exempt`, and the containment check | `routing.baseline`, `routing.exempt`, `drydock route`, the CI receipt check | **#21** |
| §11.1, §11.3 — additive rules and their signals | `routing.rules`, path/size/CODEOWNERS matching | **#22** |
| §11.5 — flow mode and allocated worktrees | `profile`, `worktree: "auto"`, PR-bound gates | **#23** |
| §11.6 — product acceptance | `drydock preview`, the `po` gate, `actor: "human"` | **#24** |
| The dock DAG, as the backlog | `drydock backlog`, `blocked-by` edges, the ready set | **#25** |
| §11.4 — the risk scorer | monotone additions, SHA-bound, evidence-required | **#26** |

#21 is the minimum that delivers the felt relief and must ship first; #26 is meaningless without the containment check it introduces.

