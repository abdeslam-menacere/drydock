# Why four roles and not seven

Most agent-role frameworks ship an Analyst, a PM, an Architect, a Scrum Master, a Product Owner, a Developer, a QA, and an Orchestrator. Drydock ships four. This is deliberate.

## The test a role has to pass

**A role exists only if it owns a gate with a pass/fail verdict and a real consequence for failing.**

Apply that test:

| Candidate role | Owns a gate? | Verdict |
|---|---|---|
| Dock Developer | No, but it's the unit of work | Keep |
| Principal Reviewer | Yes — blocks QA | Keep |
| QA Validator | Yes — blocks the PR | Keep |
| Orchestrator | Yes — owns gate *ordering and isolation*, and stops the loop when a gate fails | **Keep** |
| Product Owner | No — the human writes the issue | **Cut** |
| Scrum Master | No — ceremony and status reporting; the orchestrator that replaced it owns gates, a Scrum Master does not | **Cut** |
| Release Manager | No — that's branch protection and CI | **Cut** |
| Architect | Sometimes — but BMAD's `bmm` module already does this at planning time | **Delegate to BMAD** |

Everything that failed the test was ceremony: a persona that produces a document a human then approves. That's the human doing the work with extra token cost and an illusion of process.

## The specific case against a Product Owner agent

The GitHub issue is the requirement. You wrote it. An agent that expands your issue into a PRD which you then approve has not removed work from you — it has added a review step and a new place for requirements to drift. Worse, it launders your uncertainty into confident prose, which is exactly the failure the review gate exists to catch.

Keep the human as PO. It's the one role that cannot be delegated, because it's the one that owns the definition of "correct."

## The specific case for an Orchestrator agent

This one was cut in the first draft, on the grounds that orchestration was just `drydock start`. That was true while a human sat between every step. Once the loop runs unattended (`SPEC.md` §10), it stops being true, because something has to own the property that makes an agent-recorded verdict worth anything at all: **the reviewer must not be the developer, and must not have read the developer's account of its own work.**

A gate is only as good as the context boundary around it. `drydock gate` can enforce ordering and SHA binding; it cannot enforce that the agent producing the verdict came to the diff cold. Only whoever spawns the agents can do that. That is a gate-owning responsibility — it passes the test on the second attempt, for a reason that did not exist when it failed the first.

It is also the role that decides when to stop. A failed gate re-spawns the developer with the findings, up to a configured retry budget; after that the loop halts and reports rather than grinding. Without an owner, "give up and escalate" is nobody's job, and an unattended loop with no give-up condition is a runaway.

## What the four actually do

**Orchestrator** — runs the loop: fetch the issue, `drydock start`, spawn the developer, batch every clarifying question into one round *before* code is written, spawn the reviewer and QA with fresh context, record their verdicts, `drydock land`. It never writes production code and never overrides a gate. Its one hard rule is the context boundary: reviewer and QA receive the issue text and the diff, never the developer's summary.

**Dock Developer** — implements one issue in one worktree. Its hardest constraint isn't writing code, it's *not* writing code: scope creep is an automatic review failure, so it must route noticed problems into `Follow-ups` instead of fixing them.

**Principal Reviewer** — checks scope discipline first, design second, and explicitly does *not* check style. It is instructed to fail things. A gate with a 100% pass rate is not a gate.

**QA Validator** — does not re-review design. Scores acceptance criteria adversarially and demands evidence per criterion. "The code looks like it does this" is not evidence.

## Where these live

One file per role in `.github/agents/`, which is simultaneously Copilot's custom-agent path, a plain instruction file readable by Claude Code and Cursor, and the target that Drydock's BMAD agent definitions point at.

Three of the four are there today: `drydock-dev.md`, `drydock-reviewer.md`, `drydock-qa.md`. **`drydock-orchestrator.md` is not shipped yet — it arrives in #5**, along with the `/drydock` prompt that invokes it. Until then the orchestrator is a decided role with no contract file, and its work is done by whoever is driving the loop by hand.

One source of truth. When the model landscape changes again, you keep your process.
