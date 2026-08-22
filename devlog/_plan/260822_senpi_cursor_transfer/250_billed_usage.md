# 250 — P-5 billed usage / cacheRead (T09)

## Evidence

Two live proxy turns (composer-2.5-fast) report sane Responses usage:
input_tokens 11085/11162, output 11/10, cached_tokens 0, no inflation, no
cacheRead > 3x input pathology. Transport-level runs report estimated usage
consistently (~101K totals on the big turns, matching payload size).

## Verdict: NOOP for the clamp

No evidence of senpi's billed-int64 pathology on this plan tier. T09 clamp
stays unimplemented; revisit only if live usage reports regress.
