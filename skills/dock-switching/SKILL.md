---
name: dock-switching
description: >
  Run several docks in parallel without leaking context between them, and switch
  cleanly from one piece of work to another. Use this skill when the user is
  juggling more than one issue, asks to pause work and come back to it, asks to
  resume a previous session, wants to know which dock they are in, or is worried
  about agents interfering with each other. Covers per-dock Copilot CLI sessions,
  directory scoping, and how many docks a human can actually sustain.
---

# Switching between docks

Worktrees isolate the filesystem. They do **not** isolate the conversation — and
a leaked requirement from another issue is the subtler failure. Pair each dock
with its own Copilot CLI session, scoped to its own directory.

## One session per dock

Start a session named after the dock, rooted in the dock's worktree:

```bash
cd ../.docks/412-add-refund-endpoint
copilot --name "dock-412" --add-dir .
```

Come back to it later by name:

```bash
copilot --resume "dock-412"
```

List what is in flight:

```bash
drydock status
```

The mapping to hold in your head is one line long:

> **issue #412 → branch `feat/412-…` → worktree `../.docks/412-…` → session `dock-412`**

If you cannot say which of those four you are in, stop and run `drydock status`
before touching anything.

## Scope the session to the dock

```bash
copilot --name "dock-412" --add-dir . --deny-tool='shell(git push)'
```

- `--add-dir .` keeps file access inside this worktree. Sibling docks are live;
  reading them leaks another issue's requirements into this one.
- Denying `git push` enforces the invariant that an agent has no merge authority.
  Landing is a human-run `drydock land`, after gates.

## Switching correctly

Before leaving a dock:

1. Commit or explicitly note uncommitted work — `drydock status` shows the dock,
   not your working tree.
2. Write anything unresolved into `## Assumptions` or `## Follow-ups` in `DOCK.md`.
   That file is the dock's memory; your session is not.
3. Note whether gates are currently fresh. If you commit later, they go stale.

When entering a dock:

1. `cd` into its worktree and re-read `DOCK.md` first. It is the complete brief.
2. Check `drydock status` for that issue's gate state before assuming anything.

## Do not

- Do not carry findings from one dock into another. Something you noticed in
  #415 that matters to #412 becomes a **new issue**, or a line under `Follow-ups`.
- Do not open one session over several worktrees. The isolation is the point.
- Do not reuse a dock branch for a second issue. One issue, one branch.

## How many at once

Practical ceiling is **three to five** — not because the tooling strains, but
because gate review is human and does not parallelize. If gates are backing up,
you have too many docks open, not too few agents. That is the real constraint,
and Drydock is designed to make it visible rather than hide it.
