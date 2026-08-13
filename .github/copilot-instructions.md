# Copilot instructions — this repository

<!-- drydock:start -->

This project uses **Drydock**: every GitHub issue gets its own branch, its own
git worktree, and its own agent session, and nothing opens a pull request until
review and QA have both passed against the current commit.

Read this before doing anything. If you are inside a dock worktree, read that
dock's `DOCK.md` first — it is your complete brief and it wins on scope. The
`## Operating policy` block in `DOCK.md` tells you how much of the loop runs
unattended here. **`drydock start` does not generate that block yet — it
arrives in #4.** If it is absent, assume the manual posture: implement, commit,
post your summary, and stop at the review gate.

## The invariant

> One issue → one branch → one worktree → one agent → policy-gated merge.

Every rule below follows from it. A change that weakens it needs a decision
recorded in `SPEC.md`, not a commit message. See `SPEC.md` §10 for the autonomy
decision.

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
4. **Never switch branches, rebase, or merge by hand.** Landing is `drydock land`
   after the gates pass, and merging is GitHub's once CI is green. Your work ends
   at a reviewable commit.
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
- A verdict may be recorded by an agent, attributed `agent:<role>` via the
  `DRYDOCK_ACTOR` environment variable. (`drydock gate --as` arrives in #3; it
  is not a flag today, and unknown flags are ignored rather than rejected.) It
  is only worth something if the reviewer and QA agents never saw the
  developer's summary or session — issue text and `git diff` only. Do not
  review your own work.

## Finishing

Post a summary containing: what changed in one paragraph, every file touched and
why, real test output, every assumption made, and anything you deliberately did
**not** do and why. Post it to the issue as well as to the session — with no
human watching the loop, the comment trail is the only oversight there is.

Then stop and hand off to the review gate. Whether that gate is run by a human
or by a reviewer agent is set by this repo's configuration; either way it is not
you, and you do not run it against your own work.

<!-- drydock:end -->

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
