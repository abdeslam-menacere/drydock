# Rolling out on GitHub Enterprise

## Two distribution paths

### Path A — Template repository (start here)

Mark the repo **Settings → Template repository**. A colleague clicks **Use this template**, gets a new repo with your structure and a clean history — no fork, no inherited commits.

Then in their new repo:

```bash
drydock init
```

Best for: greenfield projects, first internal pilots. Lowest friction, zero install.

### Path B — CLI into an existing repo

Drydock is not on npm yet, so today this means vendoring the CLI or linking it
from a clone:

```bash
git clone https://github.com/<your-org>/drydock && (cd drydock && npm link)
cd existing-service
drydock init
```

The skills can be installed into Copilot CLI independently of the CLI itself:

```bash
copilot plugin install <your-org>/drydock
```

Best for: the 95% of real work that happens in repos that already exist. **This is the path that actually determines adoption** — nobody starts a new repo to try a tool. Publishing to npm is what makes it one line, and it is the single highest-leverage thing you can do for adoption.

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
