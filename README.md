# ⚓ Drydock

**Every feature gets its own dock. Nothing ships unreviewed.**

A GitHub **repository template** that bootstraps a project where every issue gets
its own branch, its own git worktree, and its own AI agent session — and where a
pull request cannot open until review and QA have both passed **against the
current commit**.

Built for [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)
and VS Code. Works with any agent that reads instruction files.

```bash
drydock start 412                 # issue #412 → branch, worktree, agent brief
drydock gate 412 review --pass    # principal review
drydock gate 412 qa --pass        # QA validation
drydock land 412                  # gates verified → PR opened with a receipt
drydock clean 412                 # worktree and branch removed
```

**[→ Getting started](docs/GETTING-STARTED.md)** — empty repo to gated PR in fifteen minutes.

---

## Start here

Click **Use this template → Create a new repository**, then:

```bash
gh repo clone <you>/<your-new-repo>
cd <your-new-repo>
node bin/drydock.js init
```

You get, wired together and ready:

| | |
|---|---|
| `bin/`, `src/` | The CLI. Zero runtime dependencies — Node's standard library and `git`. |
| `skills/` | Copilot CLI skills: the loop, dock switching, the audit trail, GitHub operation policy |
| `.github/copilot-instructions.md` | Repo-wide agent rules, picked up automatically |
| `.github/agents/` | The three role contracts — developer, reviewer, QA |
| `.github/workflows/drydock-gates.yml` | Server-side gate enforcement |
| `.github/ISSUE_TEMPLATE/` | An issue form built around *explicitly out of scope* |
| `.vscode/` | Tasks for every dock command, plus extension recommendations |

Optionally install the skills into Copilot CLI globally:

```bash
copilot plugin install <you>/<your-new-repo>
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
Resume it later by name.

## Works with your agent

The behavioural contracts live in `.github/`, which is simultaneously:

- GitHub Copilot's instructions and custom-agents path
- readable by Claude Code, Cursor, and Codex as plain instruction files
- the source that Drydock's BMAD agent definitions point at

One set of files, every agent. When you switch models next year, you keep your process.

## The roles

Three, not seven. A role only exists here if it owns a **gate with a pass/fail verdict**.

| Role | Gate | Question it answers |
|---|---|---|
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
| [`docs/ROLES.md`](docs/ROLES.md) | Why three roles and not seven |
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

**Known limits, stated plainly:**

- A receipt whose SHA matches the PR head passes CI *without any gate having
  run*. Someone with write access can fabricate one. Drydock raises the cost and
  creates an audit trail; it is not a substitute for CODEOWNERS. Closing this is
  the v0.4 milestone — see [`SPEC.md` §4.4](SPEC.md).
- Automatic conflict arbitration between concurrent docks is the next milestone
  and is not built yet.
- Not published to npm. The CLI ships in the template; use `npm link` or
  `node bin/drydock.js`.

## License

MIT
