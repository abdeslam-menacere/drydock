# The Drydock loop

New here? Start with [`GETTING-STARTED.md`](GETTING-STARTED.md) instead — it
walks the same loop with setup, screenshots of the output, and troubleshooting.
This page is the condensed reference.

> Anything marked **Not shipped yet — #N** is a decided behaviour that has not
> landed; `#N` is the issue that delivers it. Everything unmarked works today.
> The full list is in the README under *Honest status*.

## Setup, once per repo

```bash
cd your-repo
drydock init
```

Then, on GitHub → Settings → Branches → add a rule for `main`:
- Require a pull request before merging
- Require status checks to pass → select **Drydock Gates / Verify gate receipt**
- Do not allow bypassing

Without that last step Drydock is advice. With it, Drydock is policy. If the loop
is running unattended it is also the *only* thing standing between a bad diff and
`main`, so it is not optional — auto-merge with no required check merges
immediately and unverified.

The first run also asks how much of the loop you want unattended — full
autopilot, trust-but-verify, or fully manual. It asks once and writes the answer
to `drydock.config.json`. `drydock config` reopens it.

## Per feature

### 0. Pick the next one

```bash
drydock backlog --ready
```

Open issues with nothing blocking them and no dock holding them. Edges come
from sub-issues, or from `blocked-by: #N` in the body. `drydock backlog` without
`--ready` shows the whole graph — what is in flight, what is gated, and what is
waiting on what. `--json` is the same thing for an orchestrator.

### 1. Write the issue

Use the Drydock issue template. The field that matters most is **Explicitly out of scope** — it's what the review gate scores against, and it's the cheapest scope-creep prevention available.

If the issue needs two branches, it's two issues.

### 2. Run it

```
/drydock 412
```

**Not shipped yet — #5.** There is no `.github/prompts/` directory, so
`/drydock` does not resolve, and no orchestrator contract exists to run behind
it. Use [the manual path](#the-manual-path) today; it is the same gates.

That's the whole loop. The orchestrator:

1. Fetches issue #412.
2. `drydock start 412` — branch, worktree, `DOCK.md` with the operating policy rendered into it.
3. Spawns the developer to **plan only**, and collects every ambiguity in one batch.
4. Asks you that batch — once, before any code exists. This is the only point in a clean run where it needs you.
5. Spawns the developer to implement.
6. Spawns the reviewer with fresh context: the issue text and `git diff`, and nothing else. It is not given the developer's summary. See `SPEC.md` §10.3.
7. `drydock gate 412 review --pass --as agent:drydock-reviewer --sha <what it read>`
8. Spawns QA the same way → `drydock gate 412 qa --pass --as agent:drydock-qa --sha <what it tested>`
9. `drydock land 412` — PR opens with the gate receipt, and auto-merge is armed when policy allows it.
10. GitHub merges when CI is green.

A failed gate re-spawns the developer with the findings, up to the configured
retry budget. After that the loop stops and reports rather than grinding.

Everything the agents did — plan, assumptions, findings, real test output,
verdicts — lands in the issue comments. With nobody watching the run, that trail
and the receipt are the audit record.

### The manual path

Still fully supported, it is what `human-gates` autonomy gives you, and it is
the only path that runs today. Open the dock yourself:

```bash
drydock start 412
```

Creates `feat/412-add-refund-endpoint`, a worktree, a generated `DOCK.md`, and (optionally) an editor window on it. Then point an agent at it:

```
Read DOCK.md. You are drydock-dev. Implement this issue.
```

Copilot picks up `.github/agents/drydock-dev.md` as a custom agent. Claude Code and Cursor read it as instructions. With BMAD installed, invoke the `drydock-dev` agent directly.

The agent works only inside that directory. Sibling docks are live.

Under `"profile": "flow"` there is no `DOCK.md` and possibly no directory — the
issue is the brief and the dock may be a plain branch in your existing checkout.
Point the agent at the issue instead:

```
You are drydock-dev. Implement issue #412. Work only on that issue.
```

Run the gates yourself from there. The steps below are identical either way — the
gates do not care who records the verdict, only that it is fresh, ordered, and
not self-issued.

### 2b. Check what this dock actually owes

```bash
drydock route 412
```

Without a `routing` block in `drydock.config.json` this always answers "every
gate" and you can ignore it. With one, the gates are derived from the dock's diff
against the base branch:

```
Route for #413 @ 4f2a91cd
  Required: (none)
  Why: every file matched the "docs-only" exemption

  exempt: docs-only → (no gates)
    README.md
    docs/WORKFLOW.md
```

The route is recomputed every time — it is never stored, and CI derives it again
independently from the same diff. Policy is read from the base branch, so a dock
cannot shorten its own route by editing the config; a diff that touches
`drydock.config.json`, `.github/workflows/**`, or `CODEOWNERS` takes every gate
automatically, as does anything binary, renamed, oversized, or unreadable.

An exemption has to cover the whole diff. One source file in a docs-only pull
request and the exemption stops applying — which is the entire point.

Rules go the other way: they only ever **add**.

```jsonc
"routing": {
  "baseline": ["review"],
  "exempt": [
    { "name": "docs-only", "only": true, "paths": ["**/*.md", "docs/**"], "gates": [] }
  ],
  "rules": [
    { "name": "auth",       "paths": ["src/auth/**"],   "gates": ["qa", "security"] },
    { "name": "migrations", "paths": ["migrations/**"], "gates": ["qa"] },
    { "name": "large",      "linesChanged": 400,        "gates": ["qa"] },
    { "name": "requested",  "label": "needs-security-review", "gates": ["security"] }
  ]
}
```

Four rules, not twenty. The required set is `baseline ∪ every rule that fires` —
**union, not first-match-wins**, because risks compose: a change touching both
`src/auth/` and `migrations/` needs both. Union is also what makes adding a rule
a safe act. It can never shorten anybody's route.

Within a single rule the conditions are ANDed, so
`{ "paths": ["src/auth/**"], "linesChanged": 400 }` reads as "a large change to
auth". Available conditions are `paths`, `filesTouched`, `linesChanged`,
`deletionRatio`, `label`/`labels`, and `codeowners`.

`label` is author-controlled, so it is allowed to add and nothing else. A label
in an `exempt` entry, or a rule carrying `only`, is refused when the policy is
first read, with an error naming the rule — a `trivial` label that quietly did
nothing would be worse than one that fails loudly. Unknown gate names are
refused the same way, rather than becoming a rule that silently never fires.

`codeowners: ["@org/payments"]` fires when the diff touches a path that team
owns; `codeowners: true` fires on any owned path. CODEOWNERS is read from the
base branch too, for the same reason the rest of the policy is.

### 3. Review gate

```bash
drydock gate 412 review --pass --note "scope clean, tests real"
```

Run the reviewer agent first, then record its verdict. An agent that records a
verdict attributes it with `--as`, which lands in the receipt's `By` column:

```bash
drydock gate 412 review --pass --as agent:drydock-reviewer --sha "$REVIEWED" --note "scope clean"
```

`--sha` is the commit it read, captured before it started. A dock that commits
mid-review moves HEAD, and a verdict bound to the new HEAD would pass a diff
nobody saw; Drydock refuses that rather than recording it. Agents must pass it,
humans need not.

`DRYDOCK_ACTOR=agent:drydock-reviewer` is an equivalent fallback for attribution,
and the flag deliberately outranks it. The variable persists for the life of a
shell, so one left over from an earlier command files the next verdict under the
wrong name — an agent verdict recorded as a human one.

Fail freely:

```bash
drydock gate 412 review --fail --note "touches auth/, unrelated to #412"
```

A gate that always passes is a rubber stamp and makes the whole system worthless. That is as true of an agent reviewer as a human one — which is why the reviewer never sees the developer's account of its own work.

### 4. QA gate

```bash
drydock gate 412 qa --pass
```

Blocked until review passes. Ordering is enforced.

### 4b. Show it to whoever asked for it

Optional, and only worth it once there is something to look at.

```bash
drydock preview 412        # http://localhost:4612, and the URL is posted to the issue
drydock preview            # what is running
drydock preview stop 412
```

The port comes from the issue number, so it can be bookmarked. With a `po` gate
configured (`"gateNodes": { "po": { "actor": "human" } }`) the product owner
records their verdict against what they saw:

```bash
drydock gate 412 po --pass --note "matches the issue"
```

Two refusals make this a gate rather than a demo: an `agent:` actor cannot
record it at all, and if the dock committed while they were looking, the
preview is stale and the verdict is refused. Restart the preview and look
again.

### 5. Land

```bash
drydock land 412 --dry-run   # preview the PR body first
drydock land 412
```

Verifies every gate is `pass` **and** stamped with the current HEAD, pushes, and opens the PR with the gate receipt embedded. CI re-verifies server-side. When policy allows it, `land` also arms auto-merge, so GitHub merges the moment the required checks go green.

If an agent committed after the gates passed:

```
✗ Dock #412 cannot land:
  • "review" is STALE (passed @ 84896226, HEAD is 264fd89a)
```

Re-run the gates. This is working as intended.

### Landing in flow mode

Under `"profile": "flow"` the order is inverted: `land` opens the pull request
with the gates still outstanding and prints the receipt with `⏳ pending` rows.
Recording a verdict afterwards rewrites the receipt in place, and CI re-checks
every row against the PR head, so the PR cannot go green until the route is
satisfied at the commit that is about to merge.

What does *not* change: a `fail` or a stale `pass` blocks `land` in flow mode
too, ordering is still enforced, and there is still no bypass flag. Flow mode
moves the binding point, not the binding.

Because there is no local enforcement step left, `drydock-gates` must be a
required status check before you select flow mode. `drydock init` warns about
this, and `land` repeats the warning every time it runs unenforced.

### 6. Clean up

```bash
drydock clean 412        # after merge
drydock clean --merged   # sweep everything landed
```

## Running several at once

```
/drydock 412 415 418
```

**Not shipped yet — #5.** Manually:

```bash
drydock start 412 && drydock start 415 && drydock start 418
drydock status
```

```
3 docks in flight
  #412   review:✓  qa:⚠stale        open    Add refund endpoint
  #415   review:·  qa:·             open    Fix webhook retry
  #418   review:✗  qa:·             changes-requested   Rate limit the API
```

**Practical ceiling: three to five — if you are the one reviewing.** Not because Drydock can't handle more, but because you can't review more. If your gates are backing up, you have too many docks open, not too few agents. That is the real constraint and Drydock is designed to make it visible rather than hide it.

Unattended, the ceiling moves to how many diffs you are willing to have merged
without reading them. That is a different question, and a harder one. Answer it
when you set the autonomy level, not per issue.
