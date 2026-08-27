# Getting started

Fifteen minutes, from an empty repo to a gated pull request.

> Anything marked **Not shipped yet — #N** is a decided behaviour that has not
> landed; `#N` is the issue that delivers it. Everything unmarked works today.
> The full list is in the README under *Honest status*. Sections 4 through 8
> below are entirely unmarked — that is the loop you can run right now.

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
code .
```

`init` writes `drydock.config.json`, creates `.drydock/docks/`, updates
`.gitignore`, and runs a preflight check telling you what's missing.

That is the whole setup. From here on the loop is one line in Copilot Chat:

```
/drydock 1
```

The first time you run it, Drydock asks how you want the loop to behave — full
autopilot, trust-but-verify, or fully manual — writes your answer to
`drydock.config.json`, and never asks again. `drydock config` reopens it.

**Not shipped yet — #5.** `/drydock` has no prompt file behind it yet. Skip to
[step 4](#4-open-a-dock) and run the loop by hand; the gates, the receipt, and
the CI check are all real today. The interview and `drydock config` are real
too — run `drydock init` and it will ask.

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

**Auto-merge requires it.** If you let Drydock arm auto-merge on the pull
requests it opens, `drydock-gates` must be a **required** status check on the
branch. A required check makes GitHub wait for a verified receipt before
merging. Without one there is nothing to wait for, so the pull request merges
the moment it opens — unverified, and strictly worse than no automation at all.
The unattended loop has no human backstop; this rule is the backstop.

`drydock init` checks both settings and tells you which is missing. It cannot
set them for you — they are repository settings, and a tool that could grant
itself merge rights would be the wrong tool.

---

## 2. Write an issue

Use the **Feature (Drydock)** issue template. It asks for four things, and the
one that matters most is **Explicitly out of scope** — that field is what the
review gate scores against, and naming what *not* to do is the cheapest
scope-creep prevention available.

If the issue needs two branches, it is two issues.

---

## 3. Run it

In Copilot Chat, in VS Code, at the repo root:

```
/drydock 1
```

**Not shipped yet — #5.** This whole section describes the orchestrated loop,
which has no prompt file and no orchestrator contract yet. It is here because
the behaviour is decided (`SPEC.md` §10) and because it is what sections 4
through 8 add up to. To work an issue today, start at
[step 4](#4-open-a-dock).

The orchestrator fetches the issue, opens the dock, and runs the loop:

1. `drydock start 1` — branch, worktree, and a generated `DOCK.md`.
2. A developer agent **plans only**, and hands back every ambiguity in one batch.
3. You answer that batch. Once, before any code exists. In a clean run this is
   the only point that needs you.
4. The developer implements.
5. A reviewer agent is spawned with the issue text and `git diff` — and nothing
   else. It does not get the developer's summary, so the gate is a review rather
   than a countersignature.
6. `drydock gate 1 review --pass --as agent:drydock-reviewer --sha <what it read>`
7. QA the same way → `drydock gate 1 qa --pass --as agent:drydock-qa --sha <what it tested>`
8. `drydock land 1` — a pull request opens with the gate receipt.
9. CI verifies the receipt; GitHub merges when it's green.

A failed gate sends the developer back with the findings, up to the configured
retry budget, then stops and reports.

Everything the agents did — plan, assumptions, findings, real test output,
verdicts — is posted to the issue as it happens. Nobody watched the run, so that
trail and the receipt are the record of what was approved and against which
commit.

The rest of this guide walks the same loop by hand. Read it even if you never
run it that way: it is what the orchestrator is doing on your behalf, and it is
what you fall back to when a run goes wrong.

---

## 4. Open a dock

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

## 5. Hand it to Copilot

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
- `--deny-tool='shell(git push)'` — the agent does not push. Landing goes through
  `drydock land`, after the gates.

### Load the skills

`.github/copilot-instructions.md` is picked up from the repo automatically. The
four **skills** — the loop, dock switching, reading the audit trail, and GitHub
operation policy — need installing once:

```bash
copilot plugin marketplace add <you>/<your-repo>
copilot plugin install drydock@drydock
copilot plugin list          # → drydock (v0.1.0)
```

Two things worth knowing:

- **Private repo?** Export a token first, or the install fails with a misleading
  `Access is denied (os error 5)`:
  ```bash
  export GH_TOKEN="$(gh auth token)"
  ```
- `copilot plugin install <owner>/<repo>` (direct, without a marketplace) also
  works today but the CLI warns it is **deprecated** — marketplace installs are
  the path that will keep working.

**In VS Code instead:** open the dock folder, then <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> →
*Tasks: Run Task* → **Drydock: open a Copilot session for this dock**. Every
other step below has a task too.

---

## 6. Gate it

Gates run in order. QA is refused until review passes.

```bash
drydock gate 1 review --pass --note "scope clean, tests real"
drydock gate 1 qa     --pass --note "criteria met, probed edge cases"
```

Run the reviewer and QA agents first (`.github/agents/`), then record their
verdict. An agent recording a verdict passes `--as`, which `drydock gate` stamps
into the receipt's `By` column, so the receipt always shows who decided:

```bash
REVIEWED=$(git -C <worktree> rev-parse HEAD)   # before it reads anything
drydock gate 1 review --pass --as agent:drydock-reviewer --sha "$REVIEWED" --note "scope clean"
```

`--sha` names the commit the agent actually read. If the dock committed while
the review was running, Drydock refuses the verdict instead of binding it to a
commit nobody examined — re-read the new commit and record against that. Agents
must pass it; humans may omit it, being the same person who just read the diff.

`DRYDOCK_ACTOR=agent:drydock-reviewer` is an equivalent fallback for
attribution. Prefer the flag: it is scoped to the one invocation that carries
it, whereas the variable persists for the life of the shell and a forgotten one
files an agent's verdict under your name — the one direction of error this
system exists to prevent.

**Fail freely:**

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

## 7. Land

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

## 8. Clean up

```bash
drydock clean 1          # after merge
drydock clean --merged   # sweep everything landed
```

---

## Running several at once

```
/drydock 1 2 3
```

**Not shipped yet — #5.** By hand:

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
Orchestrated, the isolation comes from spawning each agent with fresh context
instead, and you stay in one chat — **not shipped yet — #5.**

**Practical ceiling is three to five — while you are the one reviewing.** Not
because the tooling strains, but because reviewing is human and does not
parallelize. If your gates are backing up, you have too many docks open — not
too few agents. Drydock is built to make that visible rather than hide it.

Running unattended moves the ceiling to a different question: how many diffs are
you willing to have merged without reading them? Decide that when you set the
autonomy level, not per issue.

---

## Troubleshooting

**`No drydock.config.json found`** — you are outside the repo entirely. Inside a
dock worktree is fine; Drydock resolves state to the main repo.

**`Gate "review" has not passed`** — gates are ordered. Run review first.

**`Dock #N cannot land: "review" is STALE`** — you committed after gating.
Re-run the stale gates. There is deliberately no bypass flag, and autonomy does
not change that — an agent that cannot pass its own gates does not merge.

**A pull request merged without CI having run** — auto-merge is on but
`drydock-gates` is not a **required** status check on the branch. Fix the branch
protection rule; see step 1. `drydock land` arms auto-merge, and arming it
against an unprotected branch is what produces this — the check is the backstop,
not the arming.

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
| [`ROLES.md`](ROLES.md) | Why four roles and not seven |
| [`../SPEC.md`](../SPEC.md) | Invariants, state model, threat model, the autonomy decision |
| [`ADOPTION.md`](ADOPTION.md) | Rolling out on GitHub Enterprise |
