# wp5 — #5539 effort wire mapper: dropped this train

#5539 (Haven2026) makes the effort mapper run for every Responses and native Chat request,
even when the provider declares no effort ladder. Current `dev` deliberately keeps an
unknown ladder byte-equivalent: `src/adapters/openai-responses/reasoning.ts:258` returns the
body untouched when `configuredReasoningEfforts` is undefined, and native Chat maps only
pinned or capped values (`src/server/chat-native.ts:153`). The contract is pinned by
`tests/responses/openai-responses-passthrough.test.ts:867` and documented in
`structure/catalog.md:517`. The carry would reverse it for every provider, including alias
maps such as `low -> disabled`.

Two maintainer reviews (the 260923 bundle round and release train 4) declined the same change
and asked for a sanitized current-`dev` reproduction. None exists, and this lane has no
provider credential that shows the 400. A provider-scoped fix needs that reproduction first.

Disposition: no PR; reported to the coordinator as dropped with this reason.

Confirmed 2026-09-28 by the lane's architect (D2) and the roadmap audit reviewer, both
reading the current guard and passthrough test. The source PR stays open and untouched; this
lane does not comment on or close contributor PRs.
