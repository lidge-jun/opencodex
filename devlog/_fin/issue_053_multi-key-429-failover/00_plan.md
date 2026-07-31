# Issue #53 — Multi-key 429 failover for non-OpenAI providers

Date: 2026-07-07
Owner: Main session, C2 ordinary product slice.
Status: DONE.
Verify: `bun x tsc --noEmit` green; `bun test ./tests/` 1580 pass / 0 fail.

## Problem

The Codex provider (OpenAI) has sophisticated multi-account failover via
`src/codex/routing.ts`: on 429 it puts the account in cooldown, clears thread
affinity, and rotates to the next lowest-usage account. Non-OpenAI providers
already have an `apiKeyPool` mechanism (`src/providers/api-keys.ts`,
`OcxProviderConfig.apiKeyPool`) for storing multiple API keys, but the pool was
management-only (add/remove/switch active key via `/api/providers/keys`). When a
non-OpenAI upstream returned 429, the error was forwarded directly to the client
with no retry.

## Root cause

The non-passthrough adapter path in `handleResponses()` (`src/server/responses.ts`)
checked `!upstreamResponse.ok` and immediately returned the error to the client.
No code path attempted to rotate `apiKeyPool` entries on rate-limit errors.

## Design

### New module: `src/providers/key-failover.ts`

In-memory cooldown map keyed by `${providerName}\0${keyId}`. Mirrors the
`codex/routing.ts` cooldown pattern but scoped to API-key pools:

- `hasKeyPoolFailover(provider)` — fast check: key-auth + pool.length >= 2.
- `rotateKeyOn429(config, providerName, retryAfterHeader)` — puts the current key
  in cooldown (respects `Retry-After`), picks the next non-cooldown key round-robin,
  swaps `provider.apiKey` + persists config. Returns a new provider config or `null`
  if all keys are in cooldown.
- `clearKeyCooldowns(providerName?)` — reset for tests / key management.
- `getKeyCooldownUntil(providerName, keyId)` — testing visibility.

Cooldown defaults to 60s, caps at 10 min. Retry-After header (seconds or
HTTP-date) is honored when present.

### Wiring: `src/server/responses.ts`

In the non-passthrough adapter path, after the first upstream fetch:

1. If `!upstreamResponse.ok && status === 429 && hasKeyPoolFailover(route.provider)`:
2. Call `rotateKeyOn429()`. If a rotated config is returned:
3. Rebuild adapter + request with the new key.
4. Create a fresh AbortController and retry the fetch once.
5. If the retry also fails (or all keys are in cooldown), fall through to the
   original error handler.

The passthrough path (OpenAI forward) is unaffected — it has its own Codex account
routing. OAuth providers are also unaffected — they authenticate differently.

The WebSocket path delegates to `handleResponses()`, so it gets failover
automatically.

### What is NOT changed

- `src/types.ts` — `apiKeyPool` already exists.
- `src/providers/api-keys.ts` — management CRUD unchanged.
- Codex account routing — already handled by `codex/routing.ts`.
- OAuth multiauth — already handled by `oauth/index.ts`.
- Only ONE retry per request — avoids cascading retries.

## Files touched

| File | Change |
|------|--------|
| `src/providers/key-failover.ts` | New: cooldown + rotation logic |
| `src/server/responses.ts` | Wire 429 retry into non-passthrough adapter path |

## Verification

- `bun x tsc --noEmit` — exit 0
- `bun test ./tests/` — 1580 pass / 0 fail
