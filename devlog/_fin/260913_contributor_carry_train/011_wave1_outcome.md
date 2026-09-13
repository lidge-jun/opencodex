# wp2/wp3 — Wave 1 outcome

All eight wave-1 lanes are on dev. Lane S landed last, after the security review
it was held for changed the diff.

## What landed

| Lane | Tip | Merge commit | Carried |
| --- | --- | --- | --- |
| L | #4481 | d865aacf93 | #4382 luvs01, #4413 rrmlima |
| B | #4480 | 2af30c2d0e | #4381 luvs01, #4388 luvs01, #4460 AgenticLab-SH |
| X | #4474 | 2296e485d6 | #4077 laerad777, residue only |
| I1 | #4486 | a3ca64f605 | issues #4425, #4442 |
| I2 | #4482 | 990cd8cce5 | issues #4430, #4435 |
| C | #4487 | 55bb9f3fef | #4438 Yongzhaooo, #4389 olddonkey, #4457 jeongjin0 |
| R | #4489 | 3f76ce415d | #4455 jeongjin0, #4409 yxr1995-maker, #4387 luvs01 |
| S | #4477 | 981b53e7d0 | #4447 Veritas-7, plus the review fix c39098ba3d |

Every merge was gated the same way: a Cross-platform CI run concluded success on
the exact tip head SHA, the merge commit was verified with
git merge-base --is-ancestor against origin/dev afterwards, and the
Co-authored-by trailers were read out of the landed commits rather than the pull
request bodies.

## The security hold earned its keep

#4477 was green on df7cbd5b7b for hours before it merged. It carries #4447, which
touches src/server/auth-cors.ts and src/server/management/provider-routes.ts, so
MAINTAINERS.md requires explicit security review and a green tip is not that
review. Splitting it out of lane B is what made the hold enforceable: as lane B's
tip it would have landed as a side effect of a lane merge.

The review changed the outcome, which is the argument for the hold existing at
all. The threat model established that overlay tolerance is openai-only, that the
destination and auth keys stay byte-pinned, and that PATCH is an explicit
per-field allowlist so a request cannot introduce a novel key. It also established
that the canonical OpenAI seed defines only four keys — adapter, authMode, baseUrl,
codexAccountMode — so "ignore keys the seed never defines" reaches nearly every
config key, which is a much wider door than the description implied.

That width is where the finding was. The author had already denied
allowPrivateNetwork, correctly: it is patchable, it disables destination DNS
classification, and overlay tolerance would have persisted it on the ChatGPT
forward row. headers sits in exactly the same class and was not covered. Canonical
OpenAI has no registry staticHeaders, the PATCH field mask writes headers with a
shallow merge, and the forward adapter applies provider.headers to the upstream
request before the incoming forward headers — so a persisted value wins whenever
the caller omits that header. A dashboard-session
PATCH {"headers":{"chatgpt-account-id":"..."}} would have ridden every subsequent
ChatGPT request that did not carry the header itself. POST still refused it; PATCH,
the editor and reload did not.

c39098ba3d denies headers on canonical openai the same way and adds the missing
PATCH regression. The test was driven red before it was accepted: removing the
guard fails exactly that case and nothing else in the file.

Two process notes worth keeping. The finding came from an independent reviewer
rather than the main pass, which had stopped at the field-policy map and concluded
headers were redacted — true for editor admission, false for the PATCH mask, which
has its own allowlist. And the tip's first run failed in select-windows-runner with
no failing step; re-running the failed jobs on the same commit turned it green, so
the exact-head evidence survived rather than needing a new head.

Recorded follow-up: the overlay tolerance is a denylist and denylists rot.
PROVIDER_CONFIG_FIELD_POLICY forces a new provider field to be classified but does
not force an overlay decision, so a future editor field touching a trust boundary
becomes silently reachable on the canonical row. codexToolMode is the current
example. The durable fix is an explicit overlay allowlist plus a guard test.

## The credit defect this wave surfaced

Lane I1 implemented #4442 as an ordinary fix, because the candidate harvest found
no pull request owning that issue. There was one: draft #4465 by maoxin1234,
opened 2026-09-13T05:43Z, after the harvest and before the lane. It proposed the
same normalization in the same two files.

The landed implementation is a superset — it adds the backup-id compatibility
fallback, the native-residue path and the structure doc — but it supersedes a
contributor proposal that came first, which AGENTS.md treats as requiring a
trailer. The I1 merge commit therefore names maoxin1234, and #4465 was closed with
that stated rather than closed as a duplicate.

The generalizable failure is the harvest, not the lane. A scored inventory is a
snapshot, and an issue lane must re-check for an owning pull request at dispatch
time rather than trusting the snapshot it was planned from. Wave 2 lanes I3 and I4
do that check before implementing.

## What #4086 turned out to be

Lane R's fourth planned link was already on dev as d6723f7f3, with its own
Co-authored-by trailer for Eleven-is-cool. The lane attempted the carry before
concluding that, and the modify/delete conflict on
structure/04_transports-and-sidecars.md — a file the #4276 SSOT restructure had
deleted — is what prompted the check. The landed version is a superset of the
branch.

That is the second time in this train that a planned carry was already satisfied
on dev; #4170 in lane L was the first. Both were found by attempting the work
rather than by reading the plan, which is the argument for lanes re-verifying
their own inputs.

## Disposition executed

Closed with evidence comments naming the landing pull request and merge commit:
source pull requests #4382, #4413, #4170, #4381, #4388, #4460, #4077, #4438,
#4389, #4457, #4455, #4409, #4387, #4171, #4086, #4465, plus the carry links that
GitHub did not auto-close (#4479, #4473, #4485). Issues #4425, #4442, #4430,
#4435, #4439, #4456, #4412 and #3729 were closed the same way.

## Honest limits

Non-tip pull requests merged without their own ci check, under the recorded owner
authorization for tip-only CI. Every dev run triggered by these merges ended
cancelled by the concurrency group as the next merge superseded it, which is the
workflow behaving as configured; the batch regression gate is a completed dev run
on a commit containing everything, and that belongs to wp5 rather than here.
