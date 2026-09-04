# wp5 — passive Muse subscription quota

Own PR, base `dev`, **after wp4 lands** (it needs the `meta-muse` provider to exist).
Branch: `codex/meta-muse-passive-quota`.

Research and unresolved questions live in `003` §E and `004`. This document is
implementation only.

## Why this is a separate phase

Every other provider's quota is **probe-shaped**: `maybeFetchProviderQuota` dispatches to
a function that issues an HTTP request and returns a `ProviderQuota`. Meta has no such
endpoint (`003` §E). Its quota arrives as an SSE event on streaming turns, so obtaining a
fresh value would mean spending a real inference turn.

That inverts the seam, and the inversion is the whole phase: writes come from the
streaming path, reads are cache-only, and "refresh" does not exist.

## Decisions taken here, so Build does not have to make them

| Question | Decision |
|---|---|
| Where to observe | `createSseInspector` in `src/server/relay.ts`, which already parses every passthrough SSE frame |
| Translated path | **Not covered.** `openai-responses.ts`'s switch drops unknown types (`004` Q3). Documented gap, not a silent one |
| Which account | the account that **served** the turn, read after failover may have moved it |
| `supportsPerAccountQuota` | **stays false.** A new cache-only accessor is added instead — see below |
| Refresh semantics | none; `ocx account refresh meta-muse` must not issue an inference call |

### Why `supportsPerAccountQuota` stays false

That predicate gates `fetchAccountQuota`, whose fallback branch sends any
non-Kiro/non-Antigravity bearer to `fetchAnthropicUsageQuota` — flipping it without a
dedicated branch ships a Meta key to Anthropic. But even *with* a branch it is the wrong
predicate: it means "this provider can be probed", and Meta cannot.

So the flag stays false and a second, honest predicate is added:
`hasPassiveAccountQuota(provider)`, true for `meta-muse`, which the read path consults
for cached rows without ever reaching a probe.

## NEW `src/providers/muse-subscription-usage.ts`

```ts
/** The event Meta emits on streaming turns. Shape from 003 §E, measured 2026-09-03. */
export function parseMuseSubscriptionUsage(payload: unknown): ProviderQuota | null;
```

Rules, all mandatory (`[C5]`):

| Source | Target | Rule |
|---|---|---|
| `subscription.window.used_percent` | `fiveHourPercent` | `normalizePercent`; assign **only** if `window_duration_mins === 300` |
| `subscription.window.resets_at` | `fiveHourResetAt` | `normalizeResetAt` (Unix seconds) |
| `subscription.weekly.used_percent` | `weeklyPercent` | `normalizePercent` |
| `subscription.weekly.resets_at` | `weeklyResetAt` | `normalizeResetAt` |
| — | `updatedAt` | `Date.now()`, never from the payload |
| `subscription.tier` | — | **dropped**: an opaque numeric id, not the label the CLI prints |

Returns `null` — never throws — when the payload is not an object, carries no
`subscription`, or yields no usable window. A `window_duration_mins` other than `300`
goes to `customWindows` with its duration as the label rather than being forced into the
five-hour slot. Either window may be absent independently.

## MODIFY `src/server/relay.ts`

Add one optional handler to `SseInspectorHandlers`:

```ts
  /** Fires for a `response.subscription_usage` frame. Meta-only today. */
  onSubscriptionUsage?(payload: unknown): void;
```

`createSseInspector` already decodes every frame; this adds a type check and a call. No
behavior changes when the handler is absent, which is every other provider.

## MODIFY `src/server/responses/core.ts`

At the passthrough inspector construction, pass `onSubscriptionUsage` **only** when the
resolved provider is `meta-muse`. The handler:

1. `parseMuseSubscriptionUsage(payload)`; bail on `null`.
2. Resolve the serving account: `genericFailoverAccountId` if failover moved it, else the
   account resolved at dispatch. Attribution to the dispatch-time account would be wrong
   precisely when it matters most.
3. `recordPassiveAccountQuota("meta-muse", accountId, quota)`.

## MODIFY `src/providers/quota.ts`

```ts
/** Providers whose per-account quota is observed passively, never probed. */
export function hasPassiveAccountQuota(provider: string): boolean {
  return provider === "meta-muse";
}

/** Write a quota observed in-band. Generation-fenced, like the probe writers. */
export function recordPassiveAccountQuota(provider: string, accountId: string, quota: ProviderQuota): void;
```

`recordPassiveAccountQuota` mirrors the existing probe writers at `quota.ts:1380`, with
one correction the A-gate caught: capturing the generation immediately before the write
cannot see a config or account change that happened EARLIER in the turn, which is exactly
the case that matters. So the CALLER captures `captureConfigGeneration()` when it resolves
the serving credential and passes it in, and the writer discards if the generation moved
since. Then write
`accountQuotaCache.set(accountCacheKey(provider, accountId), { ts: Date.now(), quota })`,
then `persistAccountQuotaCache()` so a restart keeps the last observation.

The read path gains `hasPassiveAccountQuota` alongside `supportsPerAccountQuota` so
cached Meta rows are served, and **no** dispatch branch is added to
`maybeFetchProviderQuota` — there is nothing to fetch.

## MODIFY `src/server/management/oauth-account-routes.ts`

The `quota=1` enrichment returns cached rows for a passive provider and never triggers a
probe. When no observation exists yet, the row is absent rather than an error: a user who
has not run a streaming turn has no quota, which is correct.

## MODIFY `gui/src/hooks/useProviderAccountPools.ts` + the account row

Render the observation time with the percentages — "5h 12% · observed 14m ago". A passive
value can be arbitrarily old and must not be presented as live. Absent quota renders
nothing, not a zero bar.

## Tests

`tests/muse-subscription-usage.test.ts` — parser, fixture-driven:
the measured payload; `window_duration_mins: 600` → `customWindows`, not
`fiveHourPercent`; weekly-only; window-only; `used_percent: 150` CLAMPED to 100 by
`normalizePercent` (quota-wire clamps rather than rejects - assert the clamp); missing `subscription`; non-object; `tier` never surfaced;
`updatedAt` local.

`tests/muse-passive-quota-cache.test.ts` — `recordPassiveAccountQuota` writes under the
serving account key; a generation bump discards the write; the row persists and rehydrates;
`hasPassiveAccountQuota("meta-muse")` true while `supportsPerAccountQuota("meta-muse")`
stays **false** (the exfiltration guard from wp4 must survive this phase).

`tests/relay-sse-subscription-usage.test.ts` — the inspector invokes the handler for a
recorded transcript containing the event, does not invoke it for one without, and is
unaffected when the handler is absent.

No live call, no real Keychain, in any test.

## Verification

```bash
bun test tests/muse-subscription-usage.test.ts tests/muse-passive-quota-cache.test.ts \
         tests/relay-sse-subscription-usage.test.ts tests/meta-muse-oauth.test.ts
bun run test:changed
bun x tsc --noEmit
bun run privacy:scan
bun run lint:gui
cd gui && bun run build
```

## Terminal outcome

`DONE` when a streaming `meta-muse` turn populates the account's 5-hour and weekly
percentages, the dashboard shows them with their observation age, a restart preserves the
last observation, and no code path issues an inference call to refresh a quota.
