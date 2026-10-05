# Weekly Coach bot

A planning coach for a small team. Each week it:

- **On Monday**, messages each person, offers the items still open from last week ("do you plan to finish this off?"), and coaches them one short question at a time towards at most three outcomes for the week. For each one it asks at most two things: what gets handed to whom by Friday, and what could block it (access, people to talk to, decisions). The OKR key result (KR) is named in passing or shown in the recap as "(KR 2.1?)", or "(no KR)" for business as usual, never asked as its own question. It asks for a first step only if someone is stuck. It stays at the level of what, not how, and never does the task itself. Three quick bullets are plenty if someone already knows their week.
- **Mid-week**, checks in: "how's it going, anything new in the way?"
- **On Friday**, reviews: "how did it go, what helped, what carries over?", and asks whether to do anything differently next week.
- **Logs the plan** to Notion against the team's OKRs. It writes to its own database and only *suggests* changes to the OKR tracker, which the person confirms.
- **Posts a team summary**, nudges people who go quiet, and warns them before anything is escalated to their manager.

Replies stream word by word. A chat turn reads only local data and never waits on Notion, so the first words should appear in about 2 seconds.

> **Status: Phase 1 of 6.** It is a coaching chat in your terminal, with a pass/fail check of tone and speed. Nothing is saved yet. See [docs/design.md](docs/design.md) for the full design and [docs/ask-IT.md](docs/ask-IT.md) for what IT needs to set up later.

## Try it (Phase 1)

You need Node.js 22 or newer and an Anthropic API key.

```bash
npm install
cp .env.example .env              # then open .env and paste your key after ANTHROPIC_API_KEY=
npm run chat -- --as amara        # chat as one of the sample team members
```

Answer the opener about your open items, then say what you want to be true by Friday. You should get one short question at a time: who gets each piece of work and when, and what could block it. It ends with a one-line-per-outcome recap, each line with its KR (or "(no KR)"), and the line "If anything's off or too much, say what to change. Otherwise type /done." After each reply a grey line shows how long the first words took and whether the prompt cache was used. Type `/done` (or press Ctrl+C) to finish.

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
| 13 scripted personas (one-word answerer, "write the SQL for me", overloaded, back from leave and dictating, answers in step lists, three quick bullets, fraud vocabulary...) role-played against the coach and graded by a separate model | 12 or more pass: one ask per message, at most 80 words, never does the task, stays at the top level (no method or step lists, no drilling into "happy with it"), frames done as a handover, asks about blockers, links a KR that fits, reaches the wrap-up within the question budget |
| 20 planning messages full of fraud vocabulary (mule accounts, SIM-swap, device tampering...) | 0 refused |
| Time to first words, from pressing Enter (including any retry; failed turns count at their full wait) | Median 2.0 s or less over at least 30 replies. This is measured from your machine, not the hosted bot. |

Each chat stops at the coach's wrap-up, as it would when the person types `/done`. The **question budget** is two coach replies per outcome, plus two (the outcomes question and the wrap-up), plus one for each carry-over beyond the first; the results show how many chats reached the wrap-up and how many stayed within budget. Run it twice, once as above and once with `--thinking off`, to compare quality and speed.

Every run uses the same simulated Monday (5 Oct 2026), so results don't depend on the day you run it. A `?` next to a persona means the helper models (the simulated person or the judge) had trouble, not the coach: rerun it with `npm run eval -- --persona <id>`. Full transcripts are saved under `data/eval/`, which is git-ignored.

`npm run check` runs the type checker and the offline tests. These use a fake model and need no key.

## Jev reply checks (optional, early access)

Jev, from TypeSafe AI, answers yes/no questions about a piece of text in well under a second, for a tiny fraction of a cent. It writes no text, so it **cannot make the coach's first words appear sooner**, and the chat is already cheap (about $5–15 a month for the team). People get through planning faster because the coach now asks fewer questions. Jev earns its place in two narrower jobs:

1. **A quick check while improving the coach prompt.** `npm run eval -- --judge jev` checks every coach reply for five things: did the coach do the task itself, go below the top level, ask more than one thing, fill in an outcome the person never gave, and did customer or suspect details appear. The Jev part costs about a tenth of a cent a run. Opus stays the judge for the real pass/fail (`--judge opus`, the default); `--judge both` runs both and reports how often they agree.
2. **Later, a background quality monitor** (Phase 5, and only if the data-protection officer approves TypeSafe AI, which is hosted in the US). It would check replies after they are sent, never hold one back, and never make a decision about a person.

Jev can't be fine-tuned. "Tuning" means rewording its questions (`eval/jev-questions.json`), recalibrating its probabilities against our own labels, and setting a threshold per check (the probability above which a reply counts as flagged). Before trusting it, check it against labelled examples. Everything below uses the fictional sample team:

```bash
# .env needs ANTHROPIC_API_KEY and TYPESAFE_API_KEY
# 1. Make transcripts without a judge (cheaper): the real coach three times, each deliberately bad coach twice
npm run eval -- --judge none --only personas
npm run eval -- --judge none --only personas --coach-prompt eval/bad-coach/does-the-work.md
npm run eval -- --judge none --only personas --coach-prompt eval/bad-coach/interrogator.md
# 2. Opus labels every coach reply, then relabels 100 to see how often it agrees with itself
npm run jev:label
npm run jev:label -- --repeat-check 100
# 3. Check Jev against the labels
npm run jev:eval
```

Aim for about 500 labelled replies: `jev:label` prints the count and how many of each check came out "yes" (each needs roughly 30–40%). It also refuses transcripts that weren't made with the sample team and tracker. Labelling costs roughly $10–20 for 500 replies.

The first `jev:eval` creates `data/jev-gold/human-labels.csv` with 100 replies: 70 where Jev and Opus disagreed most clearly, spread across the five checks, and 30 picked at random, mixed together so you can't tell which is which. Open it in Excel, put Y or N in each check column (leave a cell blank if unsure), save it as CSV UTF-8 and run `npm run jev:eval` again. Your labels win over Opus's. Later runs only read the sheet; `npm run jev:eval -- --more-labels` adds another 100. Rows are only ever added, never changed.

| Check, per flag | Pass mark |
|---|---|
| Recall: share of real cases Jev catches | 0.90 or more |
| Precision: share of Jev's flags that are right | 0.60 or more |
| AUROC: how well its probabilities rank real cases above the rest | 0.85 or more |
| Calibration error after recalibration | 0.10 or less |
| Labels | at least 150 |
| Flip rate: the same reply asked 30 times changes its answer (`--repeats 30 --sample 50`, on by default) | 5% or less |
| Your labels vs Opus's, on the 30 random rows (once 30 are labelled) | agree 80% or more, otherwise the check shows "labels untrustworthy" and its definition needs tightening |

It also reports speed (median, 95th percentile, and how many calls took over 2 seconds, the monitor's time limit). Each run with enough labels writes `eval/jev-calibration.json`, which `npm run eval -- --judge jev` then uses. To see whether Jev does better with the whole conversation than with the last four turns, run `npm run jev:eval -- --context-turns 0 --no-write`; if it scores better, run it again without `--no-write` so the calibration switches to it. Like `jev:label`, it refuses transcripts that weren't made with the sample team and tracker unless you add `--allow-real-data`.

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
| `scripts/chat.ts`, `scripts/eval.ts` | The chat and the Phase 1 check |
| `eval/` | Personas, refusal prompts, the grading instructions, the Jev questions and the two bad coach prompts |
| `src/adapters/jev/JevClassifier.ts`, `scripts/jev-label.ts`, `scripts/jev-eval.ts` | The Jev reply checks, the Opus labelling step and the Jev check against the labels |
| `docs/` | The design and the IT checklist |

## Roadmap

1. **Coach in a terminal** (this phase): tone, speed and the question budget, with a pass/fail check run with thinking on and off. Plus the Jev eval judge and its calibration check.
2. **It remembers the week**: plan, mid-week check-in, Friday review and next week's carry-overs, stored locally. A Save card to confirm each item's KR ("No KR (business as usual)" is an option). Phone, ID, device and account numbers are masked before anything is sent to Claude or stored.
3. **Notion log**: the "Weekly Plans & Check-ins" database with confirmed rows only (never blocker text), suggested tracker updates (dry-run first), and a quarter-rollover script.
4. **The week runs itself**: scheduler, nudges kept out of the coach's memory, a menu card and date pickers instead of typed commands, a counts-only team summary with help requests, and [Copy my update], tried in Microsoft's local Teams test tool.
5. **Pilot**: hosted on Azure with real Teams and no Microsoft Graph permissions, after IT approval and a data-protection notice to staff. Optionally Jev as a background monitor, if the data-protection officer agrees.
6. **Optional later**: calendar free time through a narrowly scoped Graph permission.

Approvals take weeks, so start the requests in [docs/ask-IT.md](docs/ask-IT.md) now, even though they are only needed from Phase 3.
