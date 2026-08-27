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

One issue → one branch → one worktree → one agent → policy-gated merge. Any change that weakens it needs a decision recorded in `SPEC.md`, not a commit message. The move from human-gated to configurable autonomy is recorded in `SPEC.md` §10; making process cost proportional to blast radius is recorded in §11.

## Gates

Gate verdicts bind to a commit SHA and go stale on any new commit. This is the core of the product. Do not add an override flag, a `--skip-gates`, or a `--force` that bypasses verification. If a bypass is genuinely needed, it belongs in branch protection settings where it's auditable, not in the CLI.

Agents may record verdicts, attributed `agent:<role>` — pass `--as agent:<role>` to `drydock gate`, which stamps it into the receipt. `DRYDOCK_ACTOR` is the fallback, and the flag deliberately wins over it: an environment variable outlives the command that set it, and a stale one files a verdict under the wrong name. That is a change of *who*, not of *what*: ordering, SHA binding, and staleness apply identically.

An agent must also pass `--sha <reviewed>` — the commit it examined, captured before it started reading. Binding a verdict to HEAD at write time is not the same thing: a dock that commits mid-review moves HEAD, and the verdict would silently cover a diff nobody read. Drydock refuses a `--sha` that is not HEAD rather than recording it elsewhere; the answer to a moved dock is to re-read it. Humans may omit the flag. See `SPEC.md` §4.1.

Two rules make an agent verdict worth something — the reviewer and QA agents must be context-independent from the developer agent, and the whole trail lands in the issue comments and the PR receipt.

How much of the loop runs unattended is configuration, not code. Do not hardcode an autonomy level, and do not remove the fully-manual path.

## Routing

Which gates a dock owes is derived from its diff against the base branch, not chosen globally. `deriveRoute` in `src/commands/route.js` is a pure projection — never persist a route, never let a dock carry one. It is mirrored verbatim into `.github/workflows/drydock-gates.yml` inside `// --- drydock:derive-route ---` markers because the workflow is scaffolded into consuming repos and cannot import this source; `test/smoke.test.js` extracts that copy and asserts the two agree. If you change one, change both.

Three rules are load-bearing:

- **Policy comes from the base branch**, never the PR head. A pull request must not be able to shorten the route that judges it.
- **Fail closed.** Unreadable diff, binary file, rename, oversize, or a touch of `drydock.config.json` / `.github/workflows/**` / `CODEOWNERS` → every gate.
- **Routing allocates judgement, never verification.** SHA binding, ordering, and staleness apply identically on every route.

`routing.rules` are additive and combine by **union**, never first-match-wins — risks compose, and union is what makes adding a rule a monotone operation. Author-controlled signals (`label`) may only add; `validateRouting` refuses a config that tries to reach below the baseline with one, and refuses unknown gate names, rather than letting either fail silently.

An absent `routing` block must reproduce v0.1 behaviour exactly. That is why `routing` is deliberately not in `DEFAULTS`.

Two more rules from `SPEC.md` §11 govern anything you add here:

- **Routing allocates judgement, never verification.** Tests, lint, and typecheck are not routable and no exemption reaches them. Routing decides how much review and QA attention to spend on top of a floor that always runs.
- **Anything the author controls may only add gates, never remove them.** That covers labels, branch names, and the risk scorer alike. The deterministic router is the security boundary; an agent is never the sole detector of a known risk class.

## The risk scorer (`SPEC.md` §11.4)

`src/commands/scorer.js` lets one agent contribute to the route. Everything about it follows from a single property: **it may only add**, and that is enforced by the *shape of the parsed response*, not by the prompt. `parseScore` reads `add` and nothing else. Do not add a `remove`, `exempt`, or `skip` field, and do not make the prompt the thing that stops removal — a field that does not exist cannot be talked into existing by text inside a diff.

- **Layered above `deriveRoute`, never inside it.** `routeForDock` = deterministic route, then `applyScore`. CI re-derives only the deterministic floor and checks `claimed ⊇ derived`, so the scorer's nondeterminism is structurally harmless. Keep it that way.
- **Evidence is mandatory** — a file and a line range that intersect the diff's changed lines. The failure mode being defended against is noise, not security.
- **A proposal binds to a SHA** and goes stale like a verdict. `land` recomputes; `status` and `route` read it off disk. Nothing except `score` and `land` may ever spawn a model.
- **Fail-open is legal here and nowhere else.** Unavailable, malformed, timed out → the deterministic route, plus a note on the receipt. Never throw, never block.
- **§10.3 applies:** issue and diff only, never the developer's summary — and `scorer.model` must be set explicitly, because agents on one model agree with each other at scale.

If an addition is a gate only a human can record while `autonomy.level` is `full`, say so loudly and post to the issue. A dock that stalls in silence is an outage nobody can explain.

## Profiles and workspaces (`SPEC.md` §11.5)

Flow mode moves *when* gates bind — to the pull request instead of to every commit — and `worktree: "auto"` allocates a directory only when concurrency or a pinned process actually needs one. Neither changes *what* binds: SHA binding, ordering, staleness, and no-bypass are identical in every mode, and a failed or stale gate blocks `land` in both. Flow mode has no local enforcement layer left, so `drydock-gates` being a required check is a precondition for it, not a nicety — do not add a local substitute.

Two consequences for code you write here: nothing may assume a dock has its own directory (`dock.worktree` may be the main checkout), and nothing may assume `DOCK.md` exists.

## Human gates and previews (`SPEC.md` §11.6)

A gate node may declare `actor: "human"`, and `drydock gate` refuses an `agent:` verdict on it. This is the single place agent autonomy does not reach, and it exists because a graph of agents reviewing agents converges on confident agreement — some evidence has to originate outside it. Do not add a way for an agent to record one, and do not add `po` to the default gate list.

The verdict binds to the SHA the **preview was serving**, not to `HEAD`. If the dock advanced, `gate` refuses. This is §4.1 applied to product acceptance and it is the whole point: a product owner approves what they saw.

A preview is ephemeral runtime, not state. Its record lives in gitignored `.drydock/tmp/`, a recorded pid is verified before it is believed, and nothing here may grow into a supervisor or a daemon — `node:child_process` with `detached: true` and `unref()`, no process manager.

## Testing

`node test/smoke.test.js` runs the full loop against a scratch repo. Any change to a command must keep it passing.
