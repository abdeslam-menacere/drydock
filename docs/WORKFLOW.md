# The Drydock loop

New here? Start with [`GETTING-STARTED.md`](GETTING-STARTED.md) instead — it
walks the same loop with setup, screenshots of the output, and troubleshooting.
This page is the condensed reference.

## Setup, once per repo

```bash
cd your-repo
drydock init
```

Then, on GitHub → Settings → Branches → add a rule for `main`:
- Require a pull request before merging
- Require status checks to pass → select **Drydock Gates / Verify gate receipt**
- Do not allow bypassing

Without that last step Drydock is advice. With it, Drydock is policy.

## Per feature

### 1. Write the issue

Use the Drydock issue template. The field that matters most is **Explicitly out of scope** — it's what the review gate scores against, and it's the cheapest scope-creep prevention available.

If the issue needs two branches, it's two issues.

### 2. Open the dock

```bash
drydock start 412
```

Creates `feat/412-add-refund-endpoint`, a worktree at `../.docks/412-add-refund-endpoint`, a generated `DOCK.md`, and (optionally) an editor window on it.

### 3. Hand it to an agent

In the dock's editor or terminal, point your agent at the dock:

```
Read DOCK.md. You are drydock-dev. Implement this issue.
```

Copilot picks up `.github/agents/drydock-dev.md` as a custom agent. Claude Code and Cursor read it as instructions. With BMAD installed, invoke the `drydock-dev` agent directly.

The agent works only inside that directory. Sibling docks are live.

### 4. Review gate

```bash
drydock gate 412 review --pass --note "scope clean, tests real"
```

Run the reviewer agent first, then record its verdict. Fail freely:

```bash
drydock gate 412 review --fail --note "touches auth/, unrelated to #412"
```

A gate that always passes is a rubber stamp and makes the whole system worthless.

### 5. QA gate

```bash
drydock gate 412 qa --pass
```

Blocked until review passes. Ordering is enforced.

### 6. Land

```bash
drydock land 412 --dry-run   # preview the PR body first
drydock land 412
```

Verifies every gate is `pass` **and** stamped with the current HEAD, pushes, opens the PR with the gate receipt embedded. CI re-verifies server-side.

If an agent committed after the gates passed:

```
✗ Dock #412 cannot land:
  • "review" is STALE (passed @ 84896226, HEAD is 264fd89a)
```

Re-run the gates. This is working as intended.

### 7. Clean up

```bash
drydock clean 412        # after merge
drydock clean --merged   # sweep everything landed
```

## Running several at once

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

**Practical ceiling: three to five.** Not because Drydock can't handle more, but because you can't review more. If your gates are backing up, you have too many docks open, not too few agents. That is the real constraint and Drydock is designed to make it visible rather than hide it.
