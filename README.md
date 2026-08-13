# ⚓ Drydock

**Every feature gets its own dock. Nothing ships unreviewed.**

A dependency-free CLI and GitHub **repository template** for adding isolated
worktrees and SHA-bound review gates to new or existing repositories.

Built for [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
and VS Code. Works with any agent that reads instruction files.

> **How to read this document.** Drydock is `v0.1.0`. Anything marked
> **Not shipped yet — #N** is a decided behaviour that has not landed; `#N` is
> the issue that delivers it. Everything unmarked works today. The full list is
> in [Honest status](#honest-status).

Install into an existing repository from npm:

```bash
npx --yes drydock@latest init
npx --yes drydock@latest doctor
```

Before npm publication, or when pinning a tagged GitHub release:

```bash
npx --yes --package github:abmenace_microsoft/drydock#<tag> drydock init \
  --cli-spec github:abmenace_microsoft/drydock#<tag>
```

`init` never adds a dependency or lockfile. It stores the exact safe package
spec and generated VS Code tasks invoke that pinned spec through `npx`.

Then say:

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
different config — see [`SPEC.md` §10](SPEC.md).

**[→ Getting started](docs/GETTING-STARTED.md)** — empty repo to gated PR in fifteen minutes.

---

## Start here

For a greenfield repository, click **Use this template → Create a new
repository**, clone it, and run:

```bash
gh repo clone <you>/<your-new-repo>
cd <your-new-repo>
node bin/drydock.js init --yes
code .
```

For an existing repository, preview every operation before writing:

```bash
npx --yes drydock@latest init --yes --dry-run
npx --yes drydock@latest init --yes
```

The unattended profile installs core state plus GitHub enforcement. VS Code and
BMAD are opt-in with `--vscode` and `--bmad`. In a human terminal, omit `--yes`
to answer the existing policy interview, preview the full plan, and confirm once.
Piped/non-TTY setup without `--yes` refuses before writing.

Then `drydock start <issue>` and work the loop by hand — see
[Getting started](docs/GETTING-STARTED.md).

**Not shipped yet — #5.** `/drydock <issue>` in Copilot Chat arrives with the
orchestrator contract in #5.

### Safe reruns and conflicts

Every operation is previewed as `create`, `append`, `merge`, `present`, `skip`,
or `conflict`. Preview and execution consume the same plan. Rerunning the same
command is byte-for-byte idempotent.

- Existing `drydock.config.json` is parsed, validated, and reused. Even
  `--force` never overwrites it.
- Generic marker blocks may be appended to `.gitignore` and existing Copilot
  instructions. Dedicated Drydock assets are create-only.
- VS Code files are merged only when they are strict JSON with the expected
  schema and no Drydock label/input collision. JSONC and malformed files are
  left unchanged with manual guidance.
- Pull-request templates and `.vscode/settings.json` are never touched.

Run `drydock doctor` after setup. It reports `pass`, `missing`, or `unknown` for
local assets, workflow/config gate agreement, tools, authentication, and the
required GitHub status check. Lack of GitHub permission is `unknown`, with the
manual Settings path, not a false failure.

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
strictly worse than doing nothing. Set it yourself and check it yourself.

`doctor` inspects branch protection and repository rulesets when authenticated
permissions allow it. It never changes repository settings. `drydock land`
does not arm auto-merge yet (#3), so nothing in Drydock can merge a pull request
for you today.

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
verdict, attributed `agent:<role>`. Today that attribution comes from the
`DRYDOCK_ACTOR` environment variable, which `drydock gate` stamps into the
receipt's `By` column:

```bash
DRYDOCK_ACTOR=agent:drydock-reviewer drydock gate 412 review --pass --note "scope clean"
```

That is only worth something because the reviewer and QA agents are given the
issue text and the diff and nothing else — not the developer's account of its
own work. A reviewer reading the author's explanation is a rubber stamp with
extra steps.

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

**The CLI surface that exists today** is `init`, `config`, `doctor`, `start`,
`status`, `gate`, `land`, and `clean`.

### Documented but not shipped yet

This documentation describes the autonomy decision recorded in
[`SPEC.md` §10](SPEC.md), which is being delivered across five issues. The
decision is final; the code is not all written. Nothing below works today:

| Marked | What it is | Ships in |
|---|---|---|
| `drydock gate --as <actor>`, `drydock land` arming auto-merge | Verdict attribution as a flag; unattended merge | **#3** |
| The `## Operating policy` block in a generated `DOCK.md` | Policy rendered where the agent will read it | **#4** |
| `/drydock <issue>`, `.github/prompts/drydock.prompt.md`, `.github/agents/drydock-orchestrator.md` | The orchestrator and its trigger | **#5** |

Two consequences worth stating outright:

- **Attribution works today, but through the environment, not a flag.**
  `drydock gate` reads `DRYDOCK_ACTOR` and stamps it into the receipt. Passing
  `--as agent:drydock-reviewer` does nothing — unknown flags are silently
  ignored, so the verdict would be recorded under your own username. Use
  `DRYDOCK_ACTOR` until #3 lands.
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
- npm publication is a release operation outside this repository change. Until
  publication, use the tagged GitHub package-spec command shown above.

## License

MIT
