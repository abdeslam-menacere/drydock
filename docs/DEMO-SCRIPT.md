# 90-second demo — shot by shot

**Audience:** non-technical, or technical-but-skeptical. **Rule: show the outcome, hide the plumbing.** Never say "worktree," "branch," or "SHA" out loud.

Total: ~90 seconds. Screen recording plus voiceover. Do not over-produce it.

---

### Shot 1 — The pain (0:00–0:12)

**Visual:** Four chaotic terminal windows overlapping, agents mid-output, a merge conflict visible. Slightly too fast to read. Zoom out to show the mess.

**VO:** "Three AI agents on one project. They're editing the same files, undoing each other's work, and you're the one cleaning it up."

*Why it works: everyone who has tried this has felt exactly this. Don't explain it — show it and let recognition do the work.*

---

### Shot 2 — The reframe (0:12–0:22)

**Visual:** Cut to black. One line of text fades in: **What if you ran AI like a team instead of a chatbot?**

**VO:** "The problem isn't the AI. It's that nobody's running it like a team."

---

### Shot 3 — Assign the work (0:22–0:38)

**Visual:** A clean GitHub issue: *"Add refund endpoint."* Cut to one terminal. Type slowly, one command:

```
drydock start 412
```

Output appears line by line.

**VO:** "One task, one command. That task now has its own private workspace and its own dedicated developer. Nothing it does can touch anything else."

*Say "private workspace," never "git worktree."*

---

### Shot 4 — Parallel, calm (0:38–0:52)

**Visual:** Run `start` twice more, fast. Then `drydock status` — the clean table of three docks.

**VO:** "Three tasks at once. Three separate developers. Zero collisions."

*This is the money shot. Hold on the status table for a full three seconds. The contrast with Shot 1 is the entire pitch.*

---

### Shot 5 — The gate (0:52–1:12)

**Visual:** Run `drydock land 412`. It **fails**, in red:

```
✗ Dock #412 cannot land:
  • "review" is STALE (passed @ 84896226, HEAD is 264fd89a)
```

**VO:** "And here's the part that matters. The reviewer approved this. Then the AI changed it. So the approval is void — and it cannot ship until someone looks again."

*Deliberately show the failure, not the success. Anyone can demo a green checkmark. Showing your tool refusing to ship code is what makes a skeptical senior engineer sit up.*

---

### Shot 6 — Payoff (1:12–1:25)

**Visual:** Re-run the gates, then `land`. A clean pull request opens with the gate receipt table visible in the body.

**VO:** "Reviewed, verified, shipped. Every time, or it doesn't ship at all."

---

### Shot 7 — Close (1:25–1:32)

**Visual:** Logo, name, one line: **Drydock — every feature gets its own dock. Nothing ships unreviewed.** Repo URL.

---

## Rules that make or break it

- **Real example, tiny scope.** "Add refund endpoint" — recognizable, concrete, boring. Not "build an app."
- **Plain English throughout.** Private workspace, not worktree. Approval is void, not gate is stale.
- **Lead the failure, not the success.** Shot 5 is why people star the repo.
- **Under two minutes.** Energy over completeness.
- **Don't polish.** A scrappy clear demo beats a slick confusing one. Ship v1 with a plain screen recording.

## Thumbnail / social frame

Split image: left, the four-window chaos from Shot 1. Right, the clean three-row status table. No text needed.
