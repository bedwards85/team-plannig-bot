# Weekly Coach bot

A planning coach for a small team. Each week it:

- **On Monday**, messages each person, offers the items still open from last week ("do you plan to finish this off?"), and coaches them one short question at a time. It asks what done looks like by Friday, the few steps to get there, the blockers (access, people to talk to, decisions), and which OKR key result (KR) the work supports. It never does the task itself.
- **Mid-week**, checks in: "how's it going, anything new in the way?"
- **On Friday**, reviews: "how did it go, what helped, what carries over?"
- **Logs the plan** to Notion against the team's OKRs. It writes to its own database and only *suggests* changes to the OKR tracker, which the person confirms.
- **Posts a team summary**, nudges people who go quiet, and warns them before anything is escalated to their manager.

Replies stream word by word. A chat turn reads only local data and never waits on Notion, so the first words should appear in about 2 seconds.

> **Status: Phase 1 of 5.** It is a coaching chat in your terminal, with a pass/fail check of tone and speed. Nothing is saved yet. See [docs/design.md](docs/design.md) for the full design and [docs/ask-IT.md](docs/ask-IT.md) for what IT needs to set up later.

## Try it (Phase 1)

You need Node.js 22 or newer and an Anthropic API key.

```bash
npm install
cp .env.example .env              # then open .env and paste your key after ANTHROPIC_API_KEY=
npm run chat -- --as amara        # chat as one of the sample team members
```

Describe a task you have this week. You should get one short question at a time, ending with something like "Sounds like KR 1.2. Right?". After each reply a grey line shows how long the first words took and whether the prompt cache was used. Type `done` to finish.

Other options:

```bash
npm run chat -- --as thabo --thinking off       # compare speed with thinking switched off
npm run chat -- --as wanjiru --touchpoint review  # try the Friday review (checkin also works)
```

The sample people are amara, thabo, wanjiru, pieter, lindiwe, and jordan (the lead). They and their OKR tracker are **fictional**, because this repository is public.

## The Phase 1 check

```bash
npm run eval
```

This calls the real API and costs roughly $1–2 per run. It prints PASS or FAIL for each of three checks:

| Check | Pass mark |
|---|---|
| 10 scripted personas (one-word answerer, "write the SQL for me", overloaded, fraud vocabulary...) role-played against the coach and graded by a separate model | 9 or more pass: one question per message, at most 80 words, never does the task, asks about blockers, links a KR |
| 20 planning messages full of fraud vocabulary (mule accounts, SIM-swap, device tampering...) | 0 refused |
| Time to first words | Median 2.0 s or less over at least 30 replies. This is measured from your machine, not the hosted bot. |

Full transcripts are saved under `data/eval/`, which is git-ignored.

`npm run check` runs the type checker and the offline tests. These use a fake model and need no key.

## Using your real team and OKRs

Never commit real names or Notion content to this repository. Instead:

1. Copy `config/team.sample.yaml` to `config/team.local.yaml` and edit it.
2. Export your tracker into `fixtures/tracker.local.json` (same shape as the sample).
3. In `.env`, set `TEAM_CONFIG=config/team.local.yaml` and `TRACKER_FIXTURE=fixtures/tracker.local.json`.

Files ending in `.local.yaml` and `.local.json` are git-ignored. Before sending real team members' chats to the API, complete the data-protection steps in [docs/ask-IT.md](docs/ask-IT.md).

## Where things are

| Path | What it is |
|---|---|
| `prompts/coach.md` | The coach's instructions: tone, the coaching sequence, and what it never does |
| `src/core/conversation.ts` | One coaching conversation: append-only history, refusal and retry handling |
| `src/core/promptAssembly.ts` | How each request is laid out so that most of it is served from the prompt cache |
| `src/adapters/anthropic/ClaudeLLM.ts` | The Claude call: Sonnet 5.5, low effort, streaming |
| `src/domain/okr.ts` | Turns the OKR tracker into the text the coach sees, and picks each person's open items |
| `scripts/chat.ts`, `scripts/eval.ts` | The two commands above |
| `eval/` | Personas, refusal prompts, and the grading instructions |
| `docs/` | The design and the IT checklist |

## Roadmap

1. **Coach in a terminal** (this phase): tone and speed, with a pass/fail check.
2. **It remembers the week**: plan, mid-week check-in, Friday review and next week's carry-overs, stored locally.
3. **Notion log**: the "Weekly Plans & Check-ins" database, plus suggested tracker updates (dry-run first).
4. **The week runs itself**: scheduler, nudges, escalation, holidays and the team summary, plus Teams in Microsoft's local test tool.
5. **Pilot**: hosted on Azure with real Teams, after IT approval and a data-protection notice to staff.
