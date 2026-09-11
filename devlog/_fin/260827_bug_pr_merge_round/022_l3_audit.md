# L3 audit — reviewer findings and dispositions

The independent reviewer audited `codex/l3-cherry-picks-260827` (PR #2721) and
returned VERDICT: FAIL. Nine findings; four required code changes. All are fixed.

| # | Finding | Disposition |
|---|---|---|
| 1 | `status` backfill correctly scoped to `type === "message"`, uses `"status" in item` so a falsy value is never overwritten | confirmed, no change |
| 2 | `created_at` exclusion verified causally (73/74 before, 74/74 after) | confirmed |
| 3 | The status/created_at split survives on FIXTURE CONTENTS, not on a principled difference | recorded in 021 |
| 4 | **`response.queued` produced `completed`** — an unstarted message marked finished | fixed `6877f646f` |
| 5 | **The regenerated fixture resurrected `stealth/ox-alpha`**, removed in `328931265` | fixed `45c3d31eb` |
| 6 | **The self-correction justification is false** | fixed `ad8ab4f70` |
| 7 | Dropping the PR's test file was right (it reintroduced both ox-alpha ids) | confirmed |
| 8 | Split is clean; one stray ` *` comment line | fixed `8af9ff2bf` |
| 9 | No status coverage lost by deleting the created_at tests; 148/148 at head | confirmed |

## Finding 6 is the one worth remembering

I wrote a provenance comment saying it was acceptable to record the reporter's
unverified ladders BECAUSE `refreshCommandCodeReasoningEfforts()` would re-read the
public profile and replace a wrong row after the first upstream rejection. I had read
that function and it does exactly what I described — in the code.

The reviewer ran it against the live site instead:

```
gpt-5.6-luna                          -> UNDEFINED
google/gemini-3.7-flash               -> UNDEFINED
deepseek/deepseek-v4-flash-vision-exp -> UNDEFINED
```

Confirmed independently: all three URLs return 200, and
`grep -c -i 'reasoning efforts'` on the fetched HTML is 0. The pages ship the ladder
inside a serialized React payload whose `reasoningEfforts` array is EMPTY in the
delivered bytes. `parsedProfileEfforts` needs prose of the form
"Reasoning efforts ... are supported;", finds none, returns undefined — so the row is
never replaced. The same measurement returns 0 for `deepseek-v4-pro`, `GLM-5.3` and
`muse-spark-1.2`, so the mechanism is dead for EVERY row in the table, not just the
three added here.

The lesson is narrow and worth stating: a safety net that exists in the code is not a
safety net that functions. I cited a mechanism as the reason to accept unverified
data without testing that the mechanism fires. The reviewer tested it.

## Carried forward

The dead parser is a real pre-existing defect: `parsedProfileEfforts` should read the
embedded `reasoningEfforts` payload rather than prose. It is NOT fixed here — it
affects every row, it is not what #2647 reported, and bolting it onto a cherry-pick
lane would be exactly the scope creep this round is structured to avoid. It belongs
in its own cycle, and the source comment now says so plainly so the next person does
not re-derive the false justification.
