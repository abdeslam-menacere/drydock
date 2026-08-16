# `drydock eject` — requirements

Status: implemented on `feat/eject` · Spec owner: the human · Version 1

---

## 1. Why this exists

Drydock ships as a GitHub repository template. Clicking **Use this template** copies Drydock's *entire implementation* into the new project: `bin/`, `src/`, `test/`, `skills/`, its README, its SPEC, its `package.json`.

The consequence, measured on a real project (`abdeslam-menacere/ModelTree`):

| | |
|---|---|
| Files that are the project's | 30 |
| Files that are Drydock's | **58** |
| The project's own README | replaced by Drydock's |
| Where the project's app ended up | `web/`, because the root was taken |

Drydock had claimed `README.md`, `SPEC.md`, `AGENTS.md`, `package.json`, `src/`, `test/`, and `docs/` — every path a project needs first. The project's own documentation ended up filed *inside* Drydock's `docs/`.

The root cause is a category error in distribution: **a template is starter code you own and edit; Drydock is infrastructure you consume and upgrade.** Template files are meant to become yours. Infrastructure files must stay pristine so they can be updated. Shipping infrastructure through a template channel produces both failure modes at once — you inherit files you don't want, and you can never receive upstream fixes without a hand-merge.

`eject` is the exit. It converts a template-instantiated repo into one that *consumes* Drydock properly, and it does so as an ordinary, reviewable refactor.

**A tool that cannot be uninstalled is a tool people will not install.** That is the real requirement behind this command.

---

## 2. Scope

### In scope
- Removing Drydock's vendored implementation from a consuming repository
- Preserving the per-project footprint so the repo keeps working
- A full-uninstall mode
- Making the change reviewable and revertible through git

### Out of scope
- Publishing the CLI to npm (separate, and a prerequisite for the recommended install path)
- Migrating GitHub **issues** between repositories (separate; issues about Drydock filed on a consuming project belong upstream)
- Redesigning the template itself
- Any change to gate semantics, SHA binding, or merge enforcement

---

## 3. Command surface

```
drydock eject [--purge] [--yes] [--dry-run]
```

| Flag | Effect |
|---|---|
| *(none)* | **Detach.** Remove Drydock's tooling; keep the working footprint. The repo still uses Drydock, via a globally installed CLI. |
| `--purge` | **Uninstall.** Also remove config, state, workflow, and agent contracts. No Drydock left. |
| `--yes` | Skip the confirmation prompt. |
| `--dry-run` | Print the plan and exit. Changes nothing. |

Undeclared flags are **rejected**, not ignored — `--force` must fail loudly rather than being silently swallowed.

---

## 4. Functional requirements

### R1 — Classify every path, never guess

Removal operates on **fixed whitelists only**. No globbing, no heuristics, no "looks like Drydock." The cost of a wrong guess is somebody's source file.

**R1.1 Tooling — always removed**

```
bin/  src/  skills/  bmad-module/  .claude-plugin/
plugin.json  drydock.code-workspace
test/smoke.test.js
```

**R1.2 Documentation — removed by name, never by directory**

```
docs/GETTING-STARTED.md   docs/WORKFLOW.md   docs/ROLES.md
docs/ADOPTION.md          docs/DEMO-SCRIPT.md
```

> Removing `docs/` wholesale would have destroyed ModelTree's `docs/product/PRODUCT-BRIEF.md` and `docs/adr/0001-static-first-architecture.md`. This requirement exists because of that near-miss.

**R1.3 `test/` is not Drydock's to delete.** Remove `test/smoke.test.js` specifically. Remove the `test/` directory only if it is left empty.

**R1.4 Identity files — removed only while they are still Drydock's**

`README.md`, `SPEC.md`, and `AGENTS.md` are removed **only if their content still fingerprints as Drydock's**. Once a project has written its own README over the top, the file is theirs and must survive, with the reason reported.

**R1.5 Never deleted, only reported**

`package.json` and `LICENSE` are always left in place. Both are files a repository must have, and inventing a replacement is worse than leaving a wrong one with a note saying so. Report them as *"yours to deal with."*

**R1.6 The footprint — kept on detach, removed on purge**

```
drydock.config.json                    policy
.drydock/                              audit trail
.github/workflows/drydock-gates.yml    server-side enforcement
.github/agents/drydock-*.md            role contracts
.github/ISSUE_TEMPLATE/feature.yml     scope-disciplined issue form
```

Target footprint after detach: **~7 files, ~25 KB, confined to `.github/` and `.drydock/`** — colliding with no namespace a project wants.

### R2 — Leave the repo working, not merely smaller

**R2.1** `.vscode/tasks.json` invokes `node ${workspaceFolder}/bin/drydock.js`, which eject is about to delete. Detach **must** repoint those tasks at the installed `drydock` binary. Purge must remove the Drydock tasks and keep the project's own.

**R2.2** Repointing applies only while the tasks still reference `./bin`, so a second run has nothing to do (see R4).

**R2.3** Purge must strip Drydock's `.gitignore` lines (`# Drydock`, `.drydock/tmp/`, `.docks/`) and keep every other ignore.

**R2.4** On detach, print how to keep using Drydock — the global install — because the repo's tooling has just been removed and the next command the user types would otherwise fail.

### R3 — Refuse rather than damage

| Condition | Behaviour |
|---|---|
| Working tree is dirty | **Refuse.** A clean tree is what makes this one `git checkout` away from undone. |
| Not confirmed, and stdin is not a TTY | **Refuse.** Require `--yes` explicitly. Agents and CI must never delete a source tree because nobody was there to say no. |
| `--purge` with docks in flight | **Refuse**, naming the docks. Purge deletes the manifests those docks run on. |
| Unknown flag | **Refuse**, naming the flag. |

`--dry-run` is exempt from the dirty-tree check, because it changes nothing.

### R4 — Idempotent

A second `eject` on an already-ejected repo reports **"Nothing to eject"** and exits 0. No partial work, no errors.

### R5 — Show the plan before doing anything

Every run prints four sections before acting:

```
Remove (n)     each path, with a file count for directories, and a total size
Rewrite        each file, and what will change about it
Keep           each retained path, and why it was kept
Yours to deal with — not touched
```

`--dry-run` prints exactly this and stops.

---

## 5. Non-functional requirements

- **Zero runtime dependencies.** Node standard library and `git` only.
- **ES modules, Node ≥ 20.12.**
- Business logic lives in `src/commands/eject.js`; `src/lib/` stays dumb.
- Argument parsing uses the existing `parseArgs` so undeclared flags surface.
- Confirmation uses the existing `interview`/`interactive` helpers, so a piped stdin never blocks.
- No network calls. `eject` is a purely local operation.

---

## 6. Acceptance criteria

- [x] Removes `bin/`, `src/`, `skills/`, `bmad-module/`, `plugin.json`, `drydock.code-workspace`
- [x] Removes Drydock's five docs by name and keeps `docs/product/` and `docs/adr/`
- [x] Removes `test/smoke.test.js`, and `test/` only when it is then empty
- [x] Removes `README.md`/`SPEC.md`/`AGENTS.md` only while they fingerprint as Drydock's
- [x] Keeps a README the project has rewritten, and says why
- [x] Never deletes `package.json` or `LICENSE`; reports both
- [x] Keeps config, `.drydock/`, gates workflow, and agent contracts on detach
- [x] Repoints `.vscode/tasks.json` at the installed CLI; leaves the project's own tasks alone
- [x] Refuses on a dirty working tree, and says why the clean tree matters
- [x] Refuses unconfirmed when non-interactive, while still printing the plan
- [x] Refuses `--purge` while a dock is in flight, naming it
- [x] Rejects undeclared flags
- [x] `--dry-run` changes nothing
- [x] Second run reports "Nothing to eject"
- [x] `--purge` removes the footprint, strips the ignore lines, drops the Drydock tasks, and keeps the project intact
- [x] The whole change is visible in `git status` and revertible

**Verification:** `node test/smoke.test.js` — 53 assertions cover the above; suite total 212 passing.

---

## 7. Known limitations

1. **Identity fingerprints are content matches.** A README that is *partly* rewritten but still opens with Drydock's heading will be removed. The clean-tree requirement makes this recoverable, but it is a real sharp edge.
2. **The recommended install path does not exist yet.** Detach tells the user to run `npm i -g drydock`; Drydock is not published to npm. Until it is, the honest instruction is `npm link` from a clone. **This is the highest-leverage follow-up.**
3. **Issues are not migrated.** Drydock bugs filed on a consuming repo stay there. GitHub only transfers issues between repos owned by the same account, so a cross-account move means recreate-and-close.
4. **No `--interactive` per-path selection.** Whole plan or nothing.
5. **It will happily eject Drydock's own repository.** A fresh template copy is byte-identical to Drydock itself, so there is no reliable way to tell them apart — the discriminator is intent, and the confirmation prompt is the only guard. The clean-tree requirement bounds the damage to one `git checkout`, but `--yes` in the wrong directory is a bad afternoon.

---

## 8. Open decisions

1. Should `init` record a manifest of what it wrote, so `eject` removes exactly that rather than matching a hardcoded list? More precise, and it would fix limitation 1 — but it adds state that can drift from reality.
2. Should the template stop shipping the CLI at all, making eject unnecessary for new projects? That is the deeper fix; eject remains needed for repos already created.
3. Should detach offer to open a PR, so the removal lands as a reviewed change rather than a local commit?
