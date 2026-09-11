# 070 — round-2 rescan after wp5 and wp6

Scanned at `dev` 330470e74 plus PR #3119 in flight. Every open `bug`-labelled issue scored
on the same four-axis 0-80 rubric the train has used: blast radius, data/credential/
durability risk, reproducibility and evidence quality, shippability.

## Closed by this train

| issue | phase | landed |
| --- | --- | --- |
| #3071 | wp1 | PR #3089 |
| #3032 | wp2 | PR #3097 |
| #3026 | wp3 | PR #3103 |
| #3029 | wp4 | PR #3110 |
| #3008 | wp5 | PR #3118 |
| #3019 | wp6 | PR #3119 (open) |

## Remaining open bug issues

| issue | blast | risk | evidence | ship | total | note |
| --- | --- | --- | --- | --- | --- | --- |
| #3024 catalog drops a callable configured model | 18 | 12 | 19 | 19 | **68** | Verified in source: `isDatedVariantId` at `provider-fetch.ts:939` accepts only `\d{8}`, and the fold at `:1672` is one-directional |
| #3094 `ocx models new-policy` / `new-arrivals` unreachable | 14 | 6 | 20 | 20 | **60** | Verified: the dispatch allowlist at `models.ts:448` omits both names, so they fall through |
| #2999 native-main refresh can overwrite external Codex writers | 15 | 19 | 17 | 12 | **63** | Credential durability, but the fix is a coordination protocol change, not a patch |
| #3108 combo default reasoning effort arrives as `none` | 15 | 6 | 17 | 17 | **55** | |
| #3051 Cursor discovery fails on HTTP/2 pre-header EOF | 12 | 5 | 17 | 18 | **52** | Retry classification only |
| #3009 Windows service repair fails at a fixed 20s | 12 | 8 | 16 | 15 | **51** | |
| #3064 Windows non-ASCII profile path rolls back install | 10 | 8 | 18 | 14 | **50** | Narrow to non-ASCII profile names |
| #3021 encrypted subagent payload surfaced as ciphertext | 10 | 12 | 13 | 12 | **47** | Reporter withheld the payload, correctly; hard to reproduce |
| #3070 OpenAI usage decreases with custom providers configured | 14 | 10 | 10 | 10 | **44** | Needs instrumentation before a fix can be named |
| #3059 restore dialog loses focus | 8 | 3 | 18 | 18 | **47** | Accessibility, single dialog |
| #2813 Codex reserve mode hides routed models | 12 | 4 | 14 | 8 | **38** | Upstream client behaviour |

## Verdict

**No open bug issue scores >= 70.** #3024 is the highest at 68 and the closest call: it is
verified in source and cheap to fix, but a configured model dropping out of the catalog
degrades a listing rather than risking credentials or durability, and the model stays
callable by id. It does not clear the bar this train set at wp0.

The four remaining >= 50 items (#3024, #2999, #3094, #3108) are the natural next train if
the bar is lowered, in that order — #3024 and #3094 are both source-verified and small,
#2999 is the only remaining credential-durability item, and #3108 is a routing correctness
bug with a clean reproduction.

## Bug-labelled PRs

None open that this train has not already superseded. #3020's core sequence was carried
into wp6 with credit rather than rebased, per the wp6 plan.

