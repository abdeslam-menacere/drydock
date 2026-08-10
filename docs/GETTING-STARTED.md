# Getting started

Fifteen minutes, from an empty repo to a gated pull request.

---

## 0. What you need

| | |
|---|---|
| **Node** | 20.12 or newer — `node --version` |
| **git** | any recent version |
| **[GitHub CLI](https://cli.github.com)** | `gh auth login` must show you logged in |
| **[Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli)** | optional but this is the point — `copilot --version` |
| **VS Code** | optional; the repo ships tasks and extension recommendations |

Check everything at once:

```bash
node --version && git --version && gh auth status && copilot --version
```

---

## 1. Create your project

Click **Use this template → Create a new repository** on GitHub, then:

```bash
gh repo clone <you>/<your-new-repo>
cd <your-new-repo>
node bin/drydock.js init
```

`init` writes `drydock.config.json`, creates `.drydock/docks/`, updates
`.gitignore`, and runs a preflight check telling you what's missing.

Make the CLI available as `drydock` (optional, but every example reads better):

```bash
npm link          # from the repo root — no dependencies are installed
drydock --help
```

Commit the scaffolding:

```bash
git add -A && git commit -m "chore: drydock init" && git push
```

### Turn on server-side enforcement

This is the step that turns Drydock from advice into policy. On GitHub:

**Settings → Branches → Add rule** for `main`:

- ☑ Require a pull request before merging
- ☑ Require status checks to pass → select **Drydock Gates / Verify gate receipt**
- ☑ Do not allow bypassing the above settings

Without this, the CLI is a convenience anyone can route around. With it,
a pull request that skipped the gates cannot merge.

---

## 2. Write an issue

Use the **Feature (Drydock)** issue template. It asks for four things, and the
one that matters most is **Explicitly out of scope** — that field is what the
review gate scores against, and naming what *not* to do is the cheapest
scope-creep prevention available.

If the issue needs two branches, it is two issues.

---

## 3. Open a dock

```bash
drydock start 1
```

```
✓ Issue #1: Add refund endpoint
✓ Worktree: ../.docks/1-add-refund-endpoint
✓ Branch:   feat/1-add-refund-endpoint
✓ Wrote DOCK.md (the agent brief for this dock)
```

You now have an isolated worktree beside your repo, on its own branch, with a
generated `DOCK.md` containing the issue, the rules, a definition of done, and
two empty sections the agent must fill in: **Assumptions** and **Follow-ups**.

> **Why those two sections.** The dominant failure of coding agents is not wrong
> code — it is confident code built on an unstated guess. `Assumptions` forces
> the guess into a reviewable file. `Follow-ups` gives scope creep somewhere
> legitimate to go; an agent that notices a real problem needs an alternative to
> fixing it, or it will fix it.

---

## 4. Hand it to Copilot

```bash
cd ../.docks/1-add-refund-endpoint
copilot --name "dock-1" --add-dir . --deny-tool='shell(git push)'
```

Then, in the session:

```
Read DOCK.md. Implement this issue.
```

What each flag buys you:

- `--name "dock-1"` — resume this exact conversation later with
  `copilot --resume "dock-1"`. One session per dock, so requirements from one
  issue never leak into another.
- `--add-dir .` — file access stays inside this worktree. Sibling docks are live.
- `--deny-tool='shell(git push)'` — the agent has no merge authority. Landing is
  a human decision, after gates.

The plugin's skills load automatically and teach Copilot the loop, how to switch
between docks, how to read the audit trail, and which GitHub operations are
never its to perform.

**In VS Code instead:** open the dock folder, then <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> →
*Tasks: Run Task* → **Drydock: open a Copilot session for this dock**. Every
other step below has a task too.

---

## 5. Gate it

Gates run in order. QA is refused until review passes.

```bash
drydock gate 1 review --pass --note "scope clean, tests real"
drydock gate 1 qa     --pass --note "criteria met, probed edge cases"
```

Run the reviewer and QA agents first (`.github/agents/`), then record their
verdict. **Fail freely:**

```bash
drydock gate 1 review --fail --note "touches auth/, unrelated to #1"
```

A gate that always passes is a rubber stamp, and it makes the whole system
worthless.

### The part that makes this different

Each verdict is stamped with the exact commit it saw:

```json
{ "verdict": "pass", "sha": "48defa0b…", "by": "you", "at": "…" }
```

Commit anything afterwards and every gate on that dock goes **stale**:

```
#1   review:⚠stale  qa:⚠stale   open   Add refund endpoint
```

The work cannot land until it is re-reviewed. This is the whole product. It
exists because the default behaviour of every approval-as-a-boolean workflow is:
agent gets approved, agent "just fixes one more thing," unreviewed code merges
under a green check.

---

## 6. Land

```bash
drydock land 1 --dry-run   # inspect the PR body first
drydock land 1
```

Verifies every gate is `pass` *and* stamped with the current HEAD, pushes the
branch, and opens a PR with a **gate receipt** in the body:

```
| Gate   | Verdict | Commit      | By  | Note                |
|--------|---------|-------------|-----|---------------------|
| review | ✅ pass | `48defa0b`  | you | scope clean         |
| qa     | ✅ pass | `48defa0b`  | you | criteria met        |
```

The **Drydock Gates** Action re-verifies that receipt against the PR head SHA
on every `opened`, `edited`, `synchronize`, and `reopened` event. Push another
commit and the check goes red — because the receipt no longer describes what
you are asking to merge.

---

## 7. Clean up

```bash
drydock clean 1          # after merge
drydock clean --merged   # sweep everything landed
```

---

## Running several at once

```bash
drydock start 1 && drydock start 2 && drydock start 3
drydock status
```

```
3 docks in flight
  #1   review:✓  qa:⚠stale   open                Add refund endpoint
  #2   review:·  qa:·        open                Fix webhook retry
  #3   review:✗  qa:·        changes-requested   Rate limit the API
```

One named Copilot session per dock; switch with `copilot --resume "dock-2"`.

**Practical ceiling is three to five.** Not because the tooling strains, but
because reviewing is human and does not parallelize. If your gates are backing
up, you have too many docks open — not too few agents. Drydock is built to make
that visible rather than hide it.

---

## Troubleshooting

**`No drydock.config.json found`** — you are outside the repo entirely. Inside a
dock worktree is fine; Drydock resolves state to the main repo.

**`Gate "review" has not passed`** — gates are ordered. Run review first.

**`Dock #N cannot land: "review" is STALE`** — you committed after gating.
Re-run the stale gates. There is deliberately no bypass flag.

**CI fails with `No Drydock gate receipt in this PR`** — the PR was opened by
hand. Close it and use `drydock land`.

**CI never runs at all** — check that Actions are enabled for the repository and
that your organization allows hosted runners. A workflow that fails in ~2 seconds
having executed no steps is a runner problem, not a Drydock problem.

**Copilot doesn't seem to know the rules** — confirm the plugin is installed
(`copilot plugin list`) and that `.github/copilot-instructions.md` is present.

---

## Where to go next

| | |
|---|---|
| [`WORKFLOW.md`](WORKFLOW.md) | The loop, condensed |
| [`ROLES.md`](ROLES.md) | Why three roles and not seven |
| [`../SPEC.md`](../SPEC.md) | Invariants, state model, threat model |
| [`ADOPTION.md`](ADOPTION.md) | Rolling out on GitHub Enterprise |
