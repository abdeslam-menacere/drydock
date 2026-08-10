---
name: dock-lifecycle
description: >
  Drive the Drydock loop for a GitHub issue: open a dock, implement inside it,
  record review and QA gate verdicts, land the pull request, and clean up. Use
  this skill whenever the user wants to start work on an issue, asks "what do I
  run next", wants to pass or fail a gate, wants to open a PR for finished work,
  or hits a "cannot land / gate is STALE" error. Covers the drydock CLI command
  surface and the rules that make gates meaningful.
---

# The Drydock loop

One issue → one branch → one worktree → one agent → gated merge.

Run every `drydock` command from anywhere inside the repository, including from
inside a dock worktree. State always resolves to the main repo.

## Execution order

### 1. Open the dock

```bash
drydock start <issue>
```

Fetches the issue with `gh`, creates `feat/<issue>-<slug>`, a worktree under
`../.docks/`, and a generated `DOCK.md` — the agent's entire brief.

If the user has not written an issue yet, make them write one first. The issue
is the unit of work; there is no dock without it. The highest-value field is
**Explicitly out of scope**, because that is what the review gate scores against.

### 2. Implement

Work **only inside the dock worktree**. Sibling directories are other docks with
other agents live in them.

- Small, atomic commits with conventional messages.
- Record ambiguity under `## Assumptions` in `DOCK.md` and proceed. Never guess silently.
- Anything out of scope goes under `## Follow-ups` as a proposed new issue. Do not fix it.
- Never switch branches, rebase, or merge. You do not have merge authority.

### 3. Gates, in order

```bash
drydock gate <issue> review --pass --note "scope clean, tests real"
drydock gate <issue> qa     --pass --note "criteria met, probed edge cases"
```

`qa` is refused until `review` has passed. This is enforced, not documented.

A verdict is stamped with the exact commit it saw. **Any new commit invalidates
every gate on that dock.** If you commit after a gate passes, re-run the gate —
that is the system working, not a bug.

Fail freely:

```bash
drydock gate <issue> review --fail --note "touches auth/, unrelated to the issue"
```

A gate that always passes is a rubber stamp and makes the whole system worthless.

### 4. Land

```bash
drydock land <issue> --dry-run   # inspect the PR body first
drydock land <issue>
```

Verifies every gate is `pass` **and** stamped with current HEAD, pushes, and
opens the PR with a gate receipt embedded in the body. A GitHub Action re-verifies
that receipt against the PR head SHA.

### 5. Clean up after merge

```bash
drydock clean <issue>
drydock clean --merged      # sweep everything landed
```

## When landing is refused

```
✗ Dock #412 cannot land:
  • "review" is STALE (passed @ 84896226, HEAD is 264fd89a)
```

Someone committed after the gate passed. Re-run the stale gates against the new
HEAD. Do not look for a bypass flag — there is deliberately none, and adding one
would defeat the entire product. If a bypass is genuinely needed it belongs in
branch protection settings, where it is auditable.

## Checking state

```bash
drydock status
```

```
#412   review:✓  qa:⚠stale   open   Add refund endpoint
```

`✓` passed · `✗` failed · `·` not run · `⚠stale` new commits since it passed.

## Hard rules

- Never record a gate verdict for work you implemented yourself without saying so.
  Self-certification is the known hole in this system; a human runs the command.
- Never edit `.drydock/docks/*.json` by hand to change a verdict or SHA.
- Never hand-open a pull request to skip gates. CI will reject it for having no receipt.
