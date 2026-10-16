# wp3 — expose the Anthropic subscription tier (#3777)

The OpenAI provider already reports a per-account `plan` string, so a consumer can weight each
account's remaining quota by its tier. The Anthropic provider reports rich quota and no tier at
all, so a six-account Claude pool has no meaningful aggregate capacity number.

Surface, bottom to top:

- `src/providers/quota.ts` `fetchAnthropicUsageQuota` — read the subscription tier from a real
  field in the upstream usage/billing response.
- `src/oauth/index.ts` — add `plan: string | null` to the OAuth account summary.
- `src/server/management/oauth-account-routes.ts` — carry it on the management DTO.
- `src/cli/account-api.ts` — carry it on the CLI DTO. This file is why the layer chains on wp2,
  which already rewrites it.
- The Anthropic GUI rows.

Hard constraint from the issue and from the maintainer: if the upstream response carries no tier
field, land `plan: null` plus documentation saying so. Do not infer a Max x5 / x20 mapping from
quota percentages — the issue reporter already established that percentages are normalized per
account and carry no tier information, so a guess would be indistinguishable from data.

The explicit `null` matters: it lets a consumer tell "unknown tier" apart from "OpenCodex too old
to report one".
