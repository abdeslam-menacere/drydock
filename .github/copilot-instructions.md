# Copilot instructions — this repository

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
decision and §11 for the heaviness decision.

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
- Which gates apply is derived from the diff (`drydock route <issue>`), not chosen. Policy is read from the base branch, so a pull request cannot shorten its own route; touching `drydock.config.json`, a workflow, or `CODEOWNERS` takes the maximum path. `routing.rules` add by union, never first-match-wins, and a label may only add gates. Routing decides *how much judgement*, never *how much verification*.
- If you commit after a gate passes, it goes stale and must be re-run. Working
  as intended.
- **Do not add an override, `--skip-gates`, or `--force` that bypasses
  verification.** If a bypass is genuinely needed it belongs in branch protection,
  where it is auditable.
- Do not edit `.drydock/docks/*.json` by hand. Do not hand-write a gate receipt
  into a PR body.
- A verdict may be recorded by an agent, attributed `agent:<role>`. Pass it
  explicitly, together with the commit you examined:
  `drydock gate <issue> <name> --pass --as agent:drydock-reviewer --sha <reviewed>`.
  Capture that SHA *before* you start reading — if the dock commits while you
  review, Drydock refuses the verdict rather than binding it to a commit nobody
  read, and you re-read the new one. `--sha` is required for agents, optional
  for humans. `DRYDOCK_ACTOR` still works as an attribution fallback, but prefer
  the flag — the variable outlives the command that set it, and a stale one
  files your verdict under someone else's name. A verdict is only worth
  something if the reviewer and QA agents never saw the developer's summary or
  session — issue text and `git diff` only. Do not review your own work.

## Routing

*Which* gates apply is derived from the diff, not chosen. `SPEC.md` §11 is the
record; none of it ships in `v0.1.0`. If you are implementing any part of it:

- **Routing allocates judgement, never verification.** Tests and lint always
  run. No exemption reaches them. Routing only decides how much review and QA
  attention to spend on top.
- **A route is never stored.** It is a pure projection of `(diff at sha, policy
  at base)`, recomputed every time — which is what makes it compose with gate
  staleness without special cases.
- **CI re-derives it from the base branch**, never from the pull request, and
  checks `claimed ⊇ derived`. A PR that could supply the rules judging it would
  make the whole mechanism decorative.
- **Anything the author controls may only add gates, never remove them** —
  labels, branch names, and the risk scorer alike.

Do not build a route-shortening path of any kind. That is the `--force` this
project refuses, wearing a better name.

## Finishing

Post a summary containing: what changed in one paragraph, every file touched and
why, real test output, every assumption made, and anything you deliberately did
**not** do and why. Post it to the issue as well as to the session — with no
human watching the loop, the comment trail is the only oversight there is.

Then stop and hand off to the review gate. Whether that gate is run by a human
or by a reviewer agent is set by this repo's configuration; either way it is not
you, and you do not run it against your own work.

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
