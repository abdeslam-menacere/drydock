# Rolling out on GitHub Enterprise

## Two distribution paths

### Path A — Template repository (start here)

Mark the repo **Settings → Template repository**. A colleague clicks **Use this template**, gets a new repo with your structure and a clean history — no fork, no inherited commits.

Then in their new repo:

```bash
node bin/drydock.js init --yes
node bin/drydock.js doctor
```

Best for: greenfield projects, first internal pilots. Lowest friction, zero install.

### Path B — CLI into an existing repo

Drydock installs without becoming a project dependency:

```bash
cd existing-service
npx --yes drydock@latest init --yes --dry-run
npx --yes drydock@latest init --yes
npx --yes drydock@latest doctor
```

Before npm publication, pin the approved GitHub release:

```bash
npx --yes --package github:abmenace_microsoft/drydock#<tag> drydock init \
	--cli-spec github:abmenace_microsoft/drydock#<tag>
```

The exact spec is persisted and generated VS Code tasks use it. No package
dependency, lockfile, global install, repository setting, Copilot plugin, or
BMAD module is installed automatically.

The skills can be installed into Copilot CLI independently of the CLI itself:

```bash
copilot plugin install <your-org>/drydock
```

Best for: the 95% of real work that happens in repos that already exist. npm is
the canonical published source; tagged GitHub package specs are the controlled
pre-release and fallback source.

### Enterprise rollout controls

- Standardize one exact `--cli-spec`, gate list, base branch, and optional-asset
	profile in automation. Use `--dry-run` in change review.
- Treat `conflict` as a manual integration decision. Reruns never overwrite a
	project-owned file, including malformed config and JSONC VS Code files.
- Require `drydock doctor` in rollout evidence. `unknown` GitHub enforcement
	means an authorized maintainer must verify the Settings rule manually.
- Rollback through version control: remove created files, remove the two marked
	append blocks, and revert strict-JSON merges. There is no package or
	server-side state for Drydock to uninstall.

Ship both. Lead with A in the demo, invest in B.

## Before you pilot internally

1. **Check what's already sanctioned.** GitHub Agent HQ and Mission Control cover adjacent ground and may already be approved. Position Drydock as the gate layer *underneath* whatever agent your org has blessed, not as a competitor to it.
2. **Confirm the OSS review process.** Publishing under a company org — even MIT — usually needs approval. Start it early; it's the long pole.
3. **Trademark and naming.** Verify `drydock` on npm, the GitHub org, and a trademark search before you commit to the name in docs and URLs. Renaming after launch costs you every link you earned.
4. **BMAD licensing.** BMAD is MIT. Depending on it as a custom module is clean, but confirm your org's OSS policy covers transitive npm dependencies.

## Pilot design

Pick **one team, one repo, four weeks.** Measure three things and nothing else:

| Metric | Why |
|---|---|
| Review rework rate | % of docks that fail a gate at least once. If it's near zero, your gates are rubber stamps and the pilot is already failing. |
| Time from issue open to merge | The number leadership cares about |
| Concurrent docks per developer | Finds your real attention ceiling. Expect 3–5. |

Do not measure lines of code or PR count. Those go up regardless and prove nothing.

## The internal pitch

Not: "an AI engineering organization." That reads as hype and invites a governance review you don't want yet.

Instead: **"Agents can't merge unreviewed code. Here's the enforcement."**

Governance-first framing gets you a much friendlier reception in an enterprise than productivity-first framing, and it happens to be true.
