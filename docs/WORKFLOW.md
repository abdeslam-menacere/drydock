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

**Not shipped yet — #2.** There is no interview and no `config` command;
`drydock config` exits with `Unknown command: config`. Until #2 lands, every
run is the manual path below.

## Per feature

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
2. `drydock start 412` — branch, worktree, `DOCK.md` with the operating policy rendered into it. Policy block **not shipped yet — #4**.
3. Spawns the developer to **plan only**, and collects every ambiguity in one batch.
4. Asks you that batch — once, before any code exists. This is the only point in a clean run where it needs you.
5. Spawns the developer to implement.
6. Spawns the reviewer with fresh context: the issue text and `git diff`, and nothing else. It is not given the developer's summary. See `SPEC.md` §10.3.
7. `drydock gate 412 review --as agent:drydock-reviewer` — `--as` **not shipped yet — #3**; today, `DRYDOCK_ACTOR=agent:drydock-reviewer drydock gate 412 review --pass`.
8. Spawns QA the same way → `drydock gate 412 qa --as agent:drydock-qa`
9. `drydock land 412` — PR opens with the gate receipt. Auto-merge arming **not shipped yet — #3**.
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

Run the gates yourself from there. The steps below are identical either way — the
gates do not care who records the verdict, only that it is fresh, ordered, and
not self-issued.

### 3. Review gate

```bash
drydock gate 412 review --pass --note "scope clean, tests real"
```

Run the reviewer agent first, then record its verdict. An agent that records its
own verdict attributes it through `DRYDOCK_ACTOR`, which lands in the receipt's
`By` column:

```bash
DRYDOCK_ACTOR=agent:drydock-reviewer drydock gate 412 review --pass --note "scope clean"
```

**Not shipped yet — #3.** The equivalent flag,
`drydock gate 412 review --pass --as agent:drydock-reviewer`, arrives in #3.
Do not use it before then: unknown flags are ignored rather than rejected, so
the verdict is recorded under your own username — an agent verdict filed as a
human one.

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

### 5. Land

```bash
drydock land 412 --dry-run   # preview the PR body first
drydock land 412
```

Verifies every gate is `pass` **and** stamped with the current HEAD, pushes, and opens the PR with the gate receipt embedded. CI re-verifies server-side.

**Not shipped yet — #3.** `land` does not arm auto-merge, so the merge itself is still yours to click once the checks are green.

If an agent committed after the gates passed:

```
✗ Dock #412 cannot land:
  • "review" is STALE (passed @ 84896226, HEAD is 264fd89a)
```

Re-run the gates. This is working as intended.

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
