# Agent instructions — this repository

Read before making any change here.

## What this project is

Drydock is a CLI plus a set of agent contracts that enforce isolated execution and gated merges for AI coding agents. It is intentionally small.

## Hard constraints

- **Zero runtime dependencies.** Node standard library and `git` only. Do not add an npm dependency without an explicit human decision — the dependency-free property is a feature, not an accident.
- **ES modules, Node ≥ 20.12.**
- **No network calls** except through the `gh` CLI.
- State lives in git. Do not introduce a database, a cache, or a daemon.

## Architecture

```
bin/drydock.js      thin entry
src/cli.js          command routing and help
src/commands/*.js   one file per command, default-exported
src/lib/*.js        sh, git, gh, config, log — no business logic
```

Business logic belongs in `commands/`. `lib/` stays dumb.

## The invariant

One issue → one branch → one worktree → one agent → policy-gated merge. Any change that weakens it needs a decision recorded in `SPEC.md`, not a commit message. The move from human-gated to configurable autonomy is recorded in `SPEC.md` §10.

## Gates

Gate verdicts bind to a commit SHA and go stale on any new commit. This is the core of the product. Do not add an override flag, a `--skip-gates`, or a `--force` that bypasses verification. If a bypass is genuinely needed, it belongs in branch protection settings where it's auditable, not in the CLI.

Agents may record verdicts, attributed `agent:<role>` — today through the `DRYDOCK_ACTOR` environment variable, which `gate` stamps into the receipt (a `--as` flag arrives in #3). That is a change of *who*, not of *what*: ordering, SHA binding, and staleness apply identically. Two rules make an agent verdict worth something — the reviewer and QA agents must be context-independent from the developer agent, and the whole trail lands in the issue comments and the PR receipt.

How much of the loop runs unattended is configuration, not code. Do not hardcode an autonomy level, and do not remove the fully-manual path.

## Testing

`node test/smoke.test.js` runs the full loop against a scratch repo. Any change to a command must keep it passing.
