# Copilot instructions — this repository

This project uses **Drydock**: every GitHub issue gets its own branch, its own
git worktree, and its own agent session, and nothing opens a pull request until
review and QA have both passed against the current commit.

Read this before doing anything. If you are inside a dock worktree, read that
dock's `DOCK.md` first — it is your complete brief and it wins on scope.

## The invariant

> One issue → one branch → one worktree → one agent → gated merge.

Every rule below follows from it. A change that weakens it needs a human
decision recorded in `SPEC.md`, not a commit message.

## Where am I

| If you see | You are in | Do |
|---|---|---|
| `DOCK.md` at the root | a dock worktree | Work only on that one issue |
| `drydock.config.json` at the root | the main repo | Coordinate; don't implement features here |

`drydock status` answers this at any time, from anywhere in the repo.

## Working in a dock

1. **One issue only.** A bug, refactor, or missing test unrelated to your issue
   goes under `## Follow-ups` in `DOCK.md` as a proposed new issue. Do not fix it.
   Out-of-scope changes fail review — this is the most common failure by far.
2. **Stay inside the worktree.** Sibling directories are other docks with other
   agents actively working. Never read or modify anything outside your root.
3. **Record assumptions.** Ambiguity gets written into `## Assumptions` in
   `DOCK.md`, then you proceed. Silent guessing is the failure mode this entire
   system exists to prevent.
4. **Never switch branches, rebase, or merge.** You have no merge authority.
   Your work ends at a reviewable commit.
5. **Small, atomic commits.** Conventional messages (`feat:`, `fix:`, `test:`).
6. **Run the tests and report real output.** Never claim tests pass without
   running them. A behavioural change with no test fails QA.

## Gates

Gate verdicts bind to a commit SHA and go stale on any new commit. That is the
core of the product.

- Gates run in order: `review` → `qa`. QA is refused until review passes.
- If you commit after a gate passes, it goes stale and must be re-run. Working
  as intended.
- **Do not add an override, `--skip-gates`, or `--force` that bypasses
  verification.** If a bypass is genuinely needed it belongs in branch protection,
  where it is auditable.
- Do not edit `.drydock/docks/*.json` by hand. Do not hand-write a gate receipt
  into a PR body.

## Finishing

Post a summary containing: what changed in one paragraph, every file touched and
why, real test output, every assumption made, and anything you deliberately did
**not** do and why.

Then stop. A human runs `drydock gate <issue> review`. You do not proceed past
this point, and you never merge.

## This repo's own constraints

If you are modifying Drydock itself rather than using it:

- **Zero runtime dependencies.** Node standard library and `git` only. Adding an
  npm dependency needs an explicit human decision — the dependency-free property
  is a feature.
- ES modules, Node ≥ 20.12.
- No network calls except through the `gh` CLI.
- State lives in git. No database, no cache, no daemon.
- Business logic lives in `src/commands/`. `src/lib/` stays dumb.
- `node test/smoke.test.js` must keep passing.
