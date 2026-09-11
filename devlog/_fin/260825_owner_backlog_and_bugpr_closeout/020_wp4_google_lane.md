# 020 — wp4: Google adapter lane (#2510, #2512, #2513)

No merge-order dependency between #2510 and the other two (#2510 touches
`google-errors.ts`; #2512/#2513 touch `google.ts`), but #2512 and #2513 will
textually conflict and must be sequenced.

### #2510 — Antigravity quota exhaustion classification
Defect: the transient guard matches `retry after` but not the standard `retry-after`
spelling (`src/adapters/google-errors.ts:33-51`), so
`Quota exceeded; retry-after: 60` is classified as permanent exhaustion via
`isQuotaExhaustedBody` (`:104-113`). A transient 429 then suppresses retry and can
trigger account-fallback exhaustion.
Fix: add the hyphenated spelling to the transient guard; regression in
`tests/google-errors.test.ts`. Effort XS.

### #2512 — max output token clamp
Defect: substring matching (`src/adapters/google.ts:51-58`) treats any id containing
`pro`/`oss` as known, silently capping every unknown model at 16,384. The PR's own
tests lock that fallback in (`tests/google-output-clamp.test.ts:5-12`), and it
contradicts `structure/02_config-and-codex-home.md:321` (explicit request values win).
Fix: exact-id matching with an explicit unknown-model passthrough; rewrite the test to
pin passthrough rather than the silent cap.

### #2513 — thought-signature replay
Defect: durable lookup applies to every Google mode (`src/adapters/google.ts:268-277`)
but eviction is restricted to Cloud Code Assist/Vertex (`:631-646`), so AI Studio
keeps rejected signatures cached — replay-store poisoning. Separately the new
persistence suite writes without `OPENCODEX_HOME` isolation
(`tests/google-signature-history-roundtrip.test.ts:605`), so it can touch the
operator's real config.
Fix: apply eviction across all modes; sandbox the test home.

