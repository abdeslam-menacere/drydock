# ⚓ Drydock

**Every feature gets its own dock. Nothing ships unreviewed.**

A GitHub **repository template** that bootstraps a project where every issue gets
its own branch, its own git worktree, and its own AI agent session — and where a
pull request cannot open until review and QA have both passed **against the
current commit**.

Built for [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
and VS Code. Works with any agent that reads instruction files.

> **How to read this document.** Drydock is `v0.1.0`. Anything marked
> **Not shipped yet — #N** is a decided behaviour that has not landed; `#N` is
> the issue that delivers it. Everything unmarked works today. The full list is
> in [Honest status](#honest-status).

Use the template, clone it, open VS Code, and say:

```
/drydock 412
```

**Not shipped yet — #5.** No `.github/prompts/drydock.prompt.md` exists, so
`/drydock` does not resolve and there is no orchestrator contract behind it.

Issue #412 gets a branch, a worktree, and an agent brief. A developer agent plans
it, asks you everything it needs in one batch, and implements it. A reviewer
agent that has never seen the developer's reasoning gates it. QA gates it after
that. A pull request opens with a receipt binding both verdicts to the exact
commit. GitHub merges it when CI is green.

Drive it yourself — this is the path that works today, same gates, same receipt:

```bash
drydock start 412                 # issue #412 → branch, worktree, agent brief
drydock gate 412 review --pass    # principal review
drydock gate 412 qa --pass        # QA validation
drydock land 412                  # gates verified → PR opened with a receipt
drydock clean 412                 # worktree and branch removed
```

How much runs unattended is a question you answer once, on first run. Full
autopilot, trust-but-verify, or fully manual are the same code path with
different config — see [`SPEC.md` §10](SPEC.md). `drydock config` reopens that
question at any time.

**[→ Getting started](docs/GETTING-STARTED.md)** — empty repo to gated PR in fifteen minutes.

---

## Start here

Click **Use this template → Create a new repository**, then:

```bash
gh repo clone <you>/<your-new-repo>
cd <your-new-repo>
node bin/drydock.js init
code .
```

Then `drydock start <issue>` and work the loop by hand — see
[Getting started](docs/GETTING-STARTED.md).

**Not shipped yet — #5.** `/drydock <issue>` in Copilot Chat.

You get, wired together and ready:

| | |
|---|---|
| `bin/`, `src/` | The CLI. Zero runtime dependencies — Node's standard library and `git`. |
| `skills/` | Copilot CLI skills: the loop, dock switching, the audit trail, GitHub operation policy |
| `.github/copilot-instructions.md` | Repo-wide agent rules, picked up automatically |
| `.github/agents/` | The role contracts — developer, reviewer, QA. The orchestrator contract is **not shipped yet — #5** |
| `.github/workflows/drydock-gates.yml` | Server-side gate enforcement |
| `.github/ISSUE_TEMPLATE/` | An issue form built around *explicitly out of scope* |
| `.vscode/` | Tasks for every dock command, plus extension recommendations |

### Before you turn on auto-merge

Auto-merge has one prerequisite, and it is not optional. On GitHub → **Settings
→ Branches → Add rule** for `main`:

- ☑ Require a pull request before merging
- ☑ Require status checks to pass → select **Drydock Gates / Verify gate receipt**
- ☑ Do not allow bypassing the above settings

With `drydock-gates` set as a **required** status check, an unverified PR cannot
merge. Without it, auto-merge merges immediately and unverified — which is
strictly worse than doing nothing. `drydock init` checks both and tells you
which one is missing, but it cannot set them for you: they are repository
settings, and that is deliberate.

Install the skills into Copilot CLI globally:

```bash
copilot plugin marketplace add <you>/<your-new-repo>
copilot plugin install drydock@drydock
```

If your repo is **private**, export a token first — the installer clones over
git and will otherwise fail with a confusing `Access is denied` error:

```bash
export GH_TOKEN="$(gh auth token)"
```

## The problem

Run three coding agents on one repo and you get three agents editing the same
files, leaking each other's requirements, and quietly overwriting each other's
work. Worktrees fix the collisions. They don't fix the other half.

The other half is this: **your agents got faster, your review capacity didn't.**
A dozen agents producing a dozen pull requests is not throughput. It's a firehose
pointed at one human's attention.

Drydock is not another way to spawn agents. It's the part after that.

## What Drydock actually does

**One issue, one branch, one worktree, one agent.** An invariant you can hold in
your head, and one a script can verify.

**Gates bind to a commit SHA.** This is the load-bearing idea. When review passes,
the verdict is stamped with the exact commit it saw. If the agent pushes another
commit, that gate goes **stale** and the work cannot land until it's re-reviewed.
A review that doesn't know what it approved isn't a review.

```
#412   review:⚠stale  qa:⚠stale   open    add refund endpoint
```

**Gates run in order.** QA cannot pass before review has. Enforced, not documented.

**Enforcement is server-side too.** `drydock land` writes a gate receipt into the
pull request body. A GitHub Action re-verifies every gate against the PR head SHA
on open, edit, push, and reopen. Make it a required check and hand-opened PRs
simply cannot merge.

**One session per dock.** `copilot --name "dock-412" --add-dir .` keeps each
issue's context — and each issue's requirements — from bleeding into the next.
Resume it later by name. Orchestrated, the same isolation comes from spawning
each agent with fresh context instead — **not shipped yet — #5.**

**A reviewer that never read the author's summary.** An agent may record a gate
verdict, attributed `agent:<role>`. Pass `--as` and `drydock gate` stamps it into
the receipt's `By` column:

```bash
drydock gate 412 review --pass --as agent:drydock-reviewer --sha "$REVIEWED" --note "scope clean"
```

`--sha` is the commit the reviewer read, captured before it started reading. If
the dock committed in the meantime, Drydock refuses the verdict rather than
binding it to a commit nobody examined. Humans may omit it; agents may not.

`DRYDOCK_ACTOR` works as a fallback, but the flag wins over it on purpose — an
environment variable outlives the command that set it, and a stale one files an
agent's verdict under a human's name.

That is only worth something because the reviewer and QA agents are given the
issue text and the diff and nothing else — not the developer's account of its
own work. A reviewer reading the author's explanation is a rubber stamp with
extra steps.

**Heaviness is earned, not chosen.** Add a `routing` block and each dock's gates
are derived from its own diff against the base branch — a docs-only change can
skip everything, a change to `src/billing/` can require more. Absent that block,
every dock takes every gate exactly as before.

```bash
drydock route 412          # Required: review → qa   (baseline)
drydock route 413          # Required: (none)        (exempt: docs-only)
```

Three properties make it something other than a way to skip review:

- **The route is a projection, never stored.** It is recomputed from the diff
  every time, by the CLI and independently by CI. Nothing to tamper with.
- **Policy is read from the base branch.** A pull request cannot shorten the
  route that judges it. Touch `drydock.config.json`, a workflow, or `CODEOWNERS`
  and the diff takes the maximum path automatically.
- **It fails closed.** An unreadable diff, a binary file, a rename, or more than
  `maxFiles` paths all fall back to every gate. Routing allocates judgement; it
  never weakens verification.

An exemption must cover the *whole* diff — one stray file and it doesn't apply.
That awkwardness is deliberate: it is what stops a real change from riding along
inside a documentation PR.

Rules go the other way and only ever add:

```jsonc
"rules": [
  { "name": "auth",       "paths": ["src/auth/**"],   "gates": ["qa", "security"] },
  { "name": "migrations", "paths": ["migrations/**"], "gates": ["qa"] },
  { "name": "large",      "linesChanged": 400,        "gates": ["qa"] },
  { "name": "requested",  "label": "needs-security-review", "gates": ["security"] }
]
```

The required set is the **union** of the baseline and every rule that fires, not
the first match. Risks compose, and union is what guarantees that adding a rule
can never shorten somebody else's route. Author-controlled signals like `label`
are allowed to add and nothing else; a config that tries to use one to reach
below the baseline is refused with an error naming the rule.

**A rule cannot anticipate everything.** So one agent is allowed to contribute to
the route — under exactly one constraint: **it may only add.**

```jsonc
"scorer": {
  "enabled": true,
  "command": "copilot -p --model {model}",
  "model": "a-model-that-is-not-the-developer's",
  "timeoutMs": 120000
}
```

It reads the issue and the diff — never the developer's summary — and answers in
one shape:

```json
{ "add": [ { "gate": "qa", "evidence": { "file": "src/auth/login.js", "lines": [12, 14] },
             "why": "new token path with no test" } ] }
```

There is no field for removing a gate. That is the whole design. Monotonicity is
a property of the schema rather than of the prompt, so the interesting failure
modes collapse into harmless ones:

- **A diff that argues it needs no review** is attacker-controlled text the
  scorer reads. The most an injection achieves is suppressing an addition — the
  route falls back to the deterministic floor.
- **A scorer that is down, slow, or babbling** fails open, and the receipt says
  so. Fail-open is never acceptable for a gate; it is fine for a contributor
  that can only add.
- **Evidence is mandatory** and must point at lines that actually changed. Not
  for security — for noise. A scorer that adds `security` to every pull request
  gets the whole tool deleted within a month.

An addition is bound to a SHA and goes stale on a new commit, exactly like a
verdict, and once it is claimed on the receipt it is as binding as any other
gate. `drydock route` shows what it added and why; `drydock score --show` shows
the raw proposal. Nothing else ever spawns a model — `status` and `route` read
the proposal off disk.

The load-bearing discipline, stated once: **the deterministic router is the
security boundary, and the scorer is never the sole detector of a known risk
class.** A finding it repeats belongs in `rules` as code. Its success metric is
that it goes quiet.

**Ceremony is earned too.** Routing decides *how many* gates a change owes. The
`profile` decides *when* they bind, and whether the dock gets a worktree at all.

```jsonc
{ "profile": "flow", "worktree": "auto" }
```

| | `dock` (default) | `flow` |
|---|---|---|
| Governance travels with | the commit | the pull request |
| Enforced by | `land` locally, then CI | CI |
| Worktree | always | when it earns one |
| Local artifacts | `DOCK.md`, manifest, policy block | the issue is the brief |

In flow mode `land` opens the pull request with the gates still outstanding, and
the receipt says so:

```
| review | ⏳ pending |   |   |
| qa     | ⏳ pending |   |   |
```

Recording a verdict afterwards rewrites the receipt in place, and CI re-derives
the route and re-checks every row against the PR head. So gates still bind to a
SHA, still run in order, still go stale on a new commit, and still cannot be
skipped — they simply fire once, against the thing that is about to merge,
instead of at every commit along the way.

A failed or stale gate blocks `land` in **both** profiles. There is no `--force`
and no `--skip-gates`; flow mode moves the binding point, not the binding.

The trade is stated plainly: flow mode has no local enforcement layer left, so
if `drydock-gates` is not a **required** status check, flow mode is unenforced.
`drydock init` says so out loud when you select it.

**Worktrees are allocated, not assumed.** A worktree solves exactly two problems
— two checkouts at once, and a long-running process pinned to a branch.
`"worktree": "auto"` creates one when another dock is already open or a preview
is requested, and otherwise just switches your checkout to the branch. Where
neither problem exists, the isolation ceremony is pure cost. `always` and
`never` are also available, and `drydock status` always names which one a dock
got and why.

**What should I start next?** `drydock backlog` answers it. Issues are nodes,
`blocked-by` relationships are edges, and the interesting query is the ready
set — open, nothing blocking it, no dock holding it.

```
15 open · 3 ready

ready
  #21    Routing v1: baseline, exempt, and the containment check
in dock
  #23    review:✓  qa:·        Flow mode
         feat/23-flow-mode  ·  flow / branch
blocked
  #26    Risk scorer
         blocked by #21, #22
```

Edges come from GitHub's native sub-issue relationships where the repo uses
them — a parent is blocked by its open sub-issues — and from `blocked-by: #N`
in the issue body where it doesn't. Both, if both are present. A cycle is
reported and every issue in it is held blocked, because nothing in a cycle can
ever become ready. `--ready` narrows to what you can pick up; `--json` emits
the graph for an orchestrator. It writes nothing.

**A gate an agent cannot record.** Everything above is agents checking agents,
which converges on confident agreement. Some evidence has to come from outside
that graph. `drydock preview 412` runs the dock on a deterministic port and
posts the URL to the issue, so a product owner's entire interface is a link:

```bash
drydock preview 412        # http://localhost:4612 — serving 84896226
drydock gate 412 po --pass --note "matches what I asked for"
```

```jsonc
"gates": ["review", "qa", "po"],
"gateNodes": { "po": { "actor": "human" } }
```

`actor: "human"` means `drydock gate` **refuses** an `agent:` verdict on that
gate — the one place agent autonomy does not reach. And the verdict binds to
the SHA the preview was *serving*, not to `HEAD`: if the dock committed while
the PO was clicking around, the running server is stale and the gate refuses
rather than approving commits nobody looked at. The receipt marks the row
`(preview)`, because "someone watched this run" and "someone read this diff"
are different evidence.

It is a local process on a local port. Nothing is deployed, tunnelled, or
exposed, and the pid file is gitignored — a pid is not state.

## Works with your agent

The behavioural contracts live in `.github/`, which is simultaneously:

- GitHub Copilot's instructions and custom-agents path
- readable by Claude Code, Cursor, and Codex as plain instruction files
- the source that Drydock's BMAD agent definitions point at

One set of files, every agent. When you switch models next year, you keep your process.

## The roles

Four, not seven. A role only exists here if it owns a **gate with a pass/fail verdict**.

| Role | Gate | Question it answers |
|---|---|---|
| **Orchestrator** | ordering + isolation | Did the right agent see the right context, and when do we stop? **Not shipped yet — #5** |
| **Dock Developer** | — | Implements exactly one issue, inside one worktree |
| **Principal Reviewer** | `review` | Is the scope disciplined and the design sound? |
| **QA Validator** | `qa` | Are the acceptance criteria actually met, adversarially? |

There is no Product Owner agent. **You** are the product owner — the issue is
your artifact. Ceremony without authority is theatre, and it's why most
agent-role frameworks feel like cosplay.

See [`docs/ROLES.md`](docs/ROLES.md) for the full reasoning.

## Works with BMAD

Drydock also installs as a [BMAD](https://github.com/bmad-code-org/BMAD-METHOD)
**custom module**, not a fork. **BMAD owns planning** — analyst, PM, architect,
PRDs, stories. **Drydock owns execution isolation and merge governance** —
worktrees, gates, receipts. Because it only uses BMAD's documented module
interface, BMAD upgrades never require a merge on your side.

Use it without BMAD too; that's the default.

## Documentation

| | |
|---|---|
| [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) | Empty repo → gated PR, step by step |
| [`SPEC.md`](SPEC.md) | Design spec, invariants, state model, threat model |
| [`docs/WORKFLOW.md`](docs/WORKFLOW.md) | The loop, condensed |
| [`docs/ROLES.md`](docs/ROLES.md) | Why four roles and not seven |
| [`docs/ADOPTION.md`](docs/ADOPTION.md) | Rolling it out on GitHub Enterprise |
| [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md) | 90-second demo, shot by shot |

## What Drydock is not

- Not an agent runtime. Bring your own.
- Not a model wrapper.
- Not a replacement for BMAD, Spec Kit, or Agent HQ — it's the merge governance
  layer under whichever you use.

## Honest status

`v0.1.0`, early.

**Verified end to end against real GitHub:** issue fetch, dock creation, gate
ordering, SHA binding, staleness detection, `land` opening a real PR with a
receipt, and the CI receipt check rejecting stale receipts, missing receipts,
copied receipts, and partial gates.

**The whole CLI surface that exists today** is `init`, `config`, `start`, `run`,
`route`, `score`, `backlog`, `status`, `preview`, `gate`, `land`, and `clean`.
Any other command in this repo's documentation is marked **Not shipped yet — #N**.

### Documented but not shipped yet

This documentation describes the autonomy decision recorded in
[`SPEC.md` §10](SPEC.md), which is being delivered across five issues. The
decision is final; the code is not all written. Nothing below works today:

| Marked | What it is | Ships in |
|---|---|---|
| `/drydock <issue>`, `.github/prompts/drydock.prompt.md`, `.github/agents/drydock-orchestrator.md` | The orchestrator and its trigger | **#5** |

One consequence worth stating outright:

- **The unattended loop does not run yet.** Every documented autonomous run is
  the manual loop with agents doing the typing.

**Known limits, stated plainly:**

- A receipt whose SHA matches the PR head passes CI *without any gate having
  run*. Someone with write access can fabricate one. Drydock raises the cost and
  creates an audit trail; it is not a substitute for CODEOWNERS. Closing this is
  the v0.4 milestone — see [`SPEC.md` §4.4](SPEC.md).
- Running unattended, that gap and branch protection are the *only* backstops
  left. Turn auto-merge on without `drydock-gates` as a required check and
  everything merges instantly, unverified.
- Automatic conflict arbitration between concurrent docks is the next milestone
  and is not built yet.
- Not published to npm. The CLI ships in the template; use `npm link` or
  `node bin/drydock.js`.

## License

MIT
