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

One issue → one branch → one worktree → one agent → gated merge. Any change that weakens it needs a human decision recorded in `SPEC.md`, not a commit message.

## Gates

Gate verdicts bind to a commit SHA and go stale on any new commit. This is the core of the product. Do not add an override flag, a `--skip-gates`, or a `--force` that bypasses verification. If a bypass is genuinely needed, it belongs in branch protection settings where it's auditable, not in the CLI.

## Testing

`node test/smoke.test.js` runs the full loop against a scratch repo. Any change to a command must keep it passing.
