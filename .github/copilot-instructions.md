# Copilot instructions — this repository

This project uses **Drydock**: every GitHub issue gets its own branch and its own
agent session, and nothing merges until the gates its diff calls for have passed
against the commit that is about to land.

Read this before doing anything. If there is a `DOCK.md` at the root, read it
first — it is your complete brief and it wins on scope, and its `## Operating
policy` block tells you how much of the loop runs unattended here. In **flow
mode** there is no `DOCK.md`: the issue is the brief, and `drydock status` tells
you which dock you are in. If no policy is stated anywhere, assume the manual
posture: implement, commit, post your summary, and stop at the review gate.

## The invariant

> One issue → one branch → one workspace → one agent → policy-gated merge.

Every rule below follows from it. A change that weakens it needs a decision
recorded in `SPEC.md`, not a commit message. See `SPEC.md` §10 for the autonomy
decision and §11 for the heaviness decision.

## Where am I

`drydock status` answers this from anywhere in the repo, and it is the only
answer that is always right — a dock does not necessarily have its own
directory.

| If you see | You are in | Do |
|---|---|---|
| `DOCK.md` at the root | a dock worktree | Work only on that one issue |
| `drydock status` naming a dock on your current branch | a branch-mode dock | Work only on that one issue |
| neither | the main repo | Coordinate; don't implement features here |

## Working in a dock

1. **One issue only.** A bug, refactor, or missing test unrelated to your issue
   goes under `## Follow-ups` in `DOCK.md`, or in an issue comment if this dock
   has no `DOCK.md`, as a proposed new issue. Do not fix it. Out-of-scope changes
   fail review — this is the most common failure by far.
2. **Stay inside your workspace.** If you have your own worktree, sibling
   directories are other docks with other agents actively working: never read or
   modify anything outside your root. If your dock is a plain branch in the main
   checkout, the boundary is the branch — never switch away from it.
3. **Record assumptions.** Ambiguity gets written into `## Assumptions` in
   `DOCK.md`, or into an issue comment where there is none, then you proceed.
   Silent guessing is the failure mode this entire system exists to prevent.
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
record. The router, its additive rules, and flow mode all ship; the risk scorer
(#26) and the `po` gate (#24) do not yet. The rules that govern any part of it:

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

## Profiles

`profile: "flow"` moves *when* gates bind — to the pull request rather than to
every commit — and `worktree: "auto"` gives a dock its own directory only when
one is actually needed. Neither changes *what* binds. In every profile: gates
bind to a SHA, run in order, go stale on a new commit, and cannot be skipped. A
failed or stale gate blocks `land` in flow mode exactly as in dock mode.

What flow mode does give up is the local enforcement layer, which is why
`drydock-gates` must be a required status check before anyone selects it. Say
so if you find it configured without one; do not compensate by adding a local
check that flow mode is meant not to have.

## The one gate you cannot record

A gate node may declare `actor: "human"` (`"gateNodes": { "po": { "actor":
"human" } }`). `drydock gate` refuses an `agent:` verdict on it, and that
refusal is the point: everything else here is agents checking agents, which
converges on confident agreement. If you are an agent and a `po` gate is
blocking, say so and stop — do not record it, do not work around it, and do not
propose removing it.

`drydock preview <issue>` is how a human gets something to look at. Its verdict
binds to the commit the preview was serving, so if you commit while a preview
is up, you have invalidated it: say so in your summary.

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
