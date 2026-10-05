# Deliberately flawed coach prompts

These two prompts exist only to build the Jev gold set. **Never use them in the bot.**

The gold set needs bad coach replies as well as good ones, so that each Jev check has roughly 30–40% positive examples. The real coach (`prompts/coach.md`) rarely makes these mistakes, so these prompts make them on purpose: often, but not in every message, so each run gives a mix of good and bad replies.

- `does-the-work.md`: a helpful-doer coach. It often supplies the work itself (SQL or code sketches, email wording, sample sizes, step lists, analysis suggestions) and sometimes asks how the work will be done. Gives examples for the `did_task` and `below_top_level` checks.
- `interrogator.md`: an over-thorough coach. It often asks two or three things in one message, drills into method, tools and steps, presses people to define "happy with it", and sometimes states a deadline or recipient the person never gave as settled. Gives examples for `several_asks`, `below_top_level` and `filled_in_outcome`.

Neither prompt touches customer or suspect details, so they add nothing for `third_party_details`.

## How to use them

Run the personas with no judge (cheaper, and the replies get labelled afterwards anyway):

```
npm run eval -- --judge none --only personas --coach-prompt eval/bad-coach/does-the-work.md
npm run eval -- --judge none --only personas --coach-prompt eval/bad-coach/interrogator.md
```

Each run prints that it uses a different coach prompt and is for building the Jev gold set, not a release check. Expect many personas to fail: that is the point. The transcripts land in `data/eval/`, ready for `npm run jev:label`.

Like the rest of the gold set, use them only with the fictional sample team and tracker.
