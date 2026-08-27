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

## Routing (`SPEC.md` §11)

*Which* gates a change must pass is derived from its diff, not asserted by its author and not fixed globally. Three rules govern anything you build here:

- **Routing allocates judgement, never verification.** Tests, lint, and typecheck are not routable and no exemption reaches them. Routing decides how much review and QA attention to spend on top of a floor that always runs.
- **A route is derived, twice.** It is a pure projection of `(diff at sha, policy at base)` — never stored, always recomputed. CI re-derives it from the *base* branch's config, never the pull request's, and enforces `claimed ⊇ derived`.
- **Anything the author controls may only add gates, never remove them.** That covers labels, branch names, and the risk scorer alike. The deterministic router is the security boundary; an agent is never the sole detector of a known risk class.

Flow mode (§11.5) moves *when* gates bind, not whether. SHA binding, ordering, and no-bypass are identical in every mode.

## Testing

`node test/smoke.test.js` runs the full loop against a scratch repo. Any change to a command must keep it passing.
