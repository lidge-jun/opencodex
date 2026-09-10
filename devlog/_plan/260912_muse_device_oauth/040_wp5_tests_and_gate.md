# wp5 — tests, gate, and what stays undone

Tests are written alongeach phase, not saved for the end; this document is the matrix they
must satisfy and the gate that closes the unit. Every test injects `fetch`, `sleep`, `now`,
`platform`, `readPointer` and `readKeychain`. None performs network, Keychain or real-clock
IO, which is both the existing convention
(`tests/providers/meta-muse-oauth.test.ts:37-46`) and a hard constraint of this unit: no
live Meta credential may be exercised.

**NEW** `tests/providers/meta-muse-device.test.ts`
**NEW** `tests/providers/muse-key-quota.test.ts`
**MODIFY (additions only)** `tests/providers/meta-muse-oauth.test.ts`

## A. Device core (`meta-muse-device.test.ts`)

A canary account token and a canary key are used throughout, both synthetic, following the
existing `CANARY` convention. The fetch fake routes by URL, the shape of
`tests/oauth/chatgpt-device-auth.test.ts:50-87`, except that `sleep` is injected and
records its arguments, so a poll branch costs microseconds instead of the 1.9 real seconds
that file currently asserts.

| # | Case | Assertion |
|---|---|---|
| 1 | Authorization request shape | Body carries `client_id=1031625952748946`; headers carry `x-api-version: 1.0.0`; `redirect: "error"` |
| 2 | Authorization parse | `verification_uri_complete` preferred for `onAuth.url`; `deviceCode` is the **user** code |
| 3 | Missing `device_code` | `kind === "device-authorization"` |
| 4 | Non-2xx authorization | Message contains the status and **not** a body canary |
| 5 | Pending then success | Exactly 3 token calls; recorded sleeps `[interval, interval]` |
| 6 | `slow_down` | Second sleep is first + 5000 |
| 7 | 429 with `Retry-After: 12` | Sleep is 12000 |
| 8 | 429 with `Retry-After` beyond the cap | Sleep is 60000 |
| 9 | `Retry-After` as an HTTP date | Sleep is the clamped delta from injected `now` |
| 10 | `expired_token` | `kind === "device-expired"` |
| 11 | `access_denied` | `kind === "device-denied"` |
| 12 | Unknown error code | `kind === "device-token"`, and exactly **one** token call — no further polling |
| 13 | Deadline passed before a poll | `device-expired`, zero further token calls |
| 14 | 200 arriving after the deadline | `device-expired`; the token is not returned |
| 15 | Sleep never exceeds the remaining time | Recorded sleep <= remaining at each step |
| 16 | `interval: "0.001"` (string) | Sleep is 1000, the floor |
| 17 | `expires_in: 999999` | Deadline is capped at 30 minutes from injected `now` |
| 18 | Abort before start, and mid-poll | `kind === "cancelled"` both times |
| 19 | Mint request shape | `{"onboard":true}`, `Authorization: Bearer <account token>`, `x-api-version` |
| 20 | Mint 429 | `kind === "mint-rate-limited"`, `retryAfterMs` set, message names the wait |
| 21 | Mint non-2xx | `kind === "mint-http"`; message has the status and **not** the body canary |
| 22 | `is_subs_active: false` | `kind === "subscription-inactive"` |
| 23 | `require_payment` with `action_url` | `kind === "entitlement-required"`; `actionUrl` present and in the message |
| 24 | `require_payment_action_url` only | Same, via the alias |
| 25 | No key, no payment signal | `kind === "missing-api-key"` |
| 26 | Key failing the `LLM|` grammar | `kind === "mint-invalid"` |
| 27 | No `user_id` and no `user_email` | `kind === "missing-identity"` |
| 28 | `user_email` only | `accountId` falls back to the lowercased email |
| 29 | Success | `access === refresh === key`; `expires === Number.MAX_SAFE_INTEGER`; `source === "oauth"`; `muse.oauthAccessToken` set; `muse.mintedAt` from injected `now` |
| 30a | W1 persistence | A credential round-tripped through `normalizeCredential` keeps `muse.oauthAccessToken`; without the store change it is lost, which guards the silent-drop failure |
| 30b | W2 slot identity | With an email present the credential sets `email` and NOT `accountId`, and `muse.userId` carries `user_id`; with no email it falls back to `accountId = user_id` |
| 30c | W3 late 200 | A 200 carrying a token after the local deadline passed is ACCEPTED, not discarded |
| 30d | W4 final poll | A pending poll with 3s left and a 5s interval sleeps 3s and polls again rather than expiring unpolled |
| 30e | W5 billable warning | A payload with a usable key plus `require_payment` returns the key AND emits an onProgress warning naming the action URL |
| 30 | Separation invariant | `access` and `refresh` do **not** contain the account token, and `JSON.stringify(creds.access)` does not parse as an object |

Case 30 is the regression guard for `002` §A. If a later refactor adopts the reference's
packed-JSON bearer, this test fails.

## B. Selection order (additions to `meta-muse-oauth.test.ts`)

`deps.loginDevice` is injected as a counting stub, so order is asserted without running a
grant. The existing 351 lines must pass unmodified.

| # | Case | Assertion |
|---|---|---|
| 31 | darwin, credential present, plain login | Import wins; device stub never called |
| 32 | darwin, no pointer | Device stub called once; its credential returned |
| 33 | darwin, pointer without a Meta account | Device stub called |
| 34 | Keychain read times out | **Throws** `/within 5s/`; device stub never called (fold 2) |
| 35 | Corrupt pointer JSON | **Throws**; device stub never called |
| 36 | Unsupported storage backend | **Throws**; device stub never called |
| 37 | `importLocal: "off"` (forceLogin) | Import never attempted; device stub called |
| 38 | `OAUTH_PROVIDERS["meta-muse"].login` with `{forceLogin:true}` | Maps to `importLocal: "off"` |
| 39 | Non-darwin, plain login | Device stub called; paste **not** the first resort |
| 40 | Device fails, `onManualCodeInput` present | Paste path runs; `source === "manual"`; the reason names the device failure |
| 41 | Device fails, no `onManualCodeInput`, darwin | Throws; message names the device failure |
| 41b | Device fails, no paste surface, win32 | Message contains the device reason **and** `dev.meta.ai` **and** `META_MODEL_API_KEY` (fold 3) |
| 41c | Empty paste on win32 | Message still contains `no credential to import` (fold 3) |
| 41d | No `loginDevice` stub, with `fetchImpl`, `sleep` and `now` injected | The device attempt receives all three: zero real network calls, zero real timer waits, and the deadline derives from the injected clock (fold 1) |
| 42 | Device cancelled | Rethrown; no paste prompt |
| 43 | Consent warning | Still emitted before the first read, on every path including device |
| 44 | `refreshMetaMuseToken` with a device credential | `muse` preserved; `source === "oauth"` |
| 45 | `refreshMetaMuseToken` with a manual credential | `source === "manual"`; no `muse` invented |
| 46 | Registry header | `getProviderRegistryEntry("meta-muse")?.staticHeaders` is `{"x-api-version":"1.0.0"}` |
| 47 | User override wins | `mergeRegistryStaticHeaders(entry.staticHeaders, {"X-Api-Version":"9"})` keeps `9` |

## C. Quota (`muse-key-quota.test.ts`)

| # | Case | Assertion |
|---|---|---|
| 48 | `window_duration_mins: 300` | `fiveHourPercent` and `fiveHourResetAt` set |
| 49 | A non-300 window | Lands in `customWindows` with its real duration label, never in the five-hour slot |
| 50 | `weekly` | `weeklyPercent` and `weeklyResetAt` set |
| 51 | `subs_usage` absent | Returns `null`; nothing is rendered as zero |
| 52 | `is_subs_active: false` | Returns `null` |
| 53 | Probe body | No `onboard` key is sent |
| 54 | Failure engages backoff | Second call within 5 minutes performs **zero** fetches |
| 55 | Backoff expiry | A call after 5 minutes (injected `now`) fetches again |
| 55b | Success TTL | A second call 1 minute after a SUCCESS performs zero fetches |
| 55c | Success TTL is unconditional | `fetchMuseKeyQuotaSnapshot` takes no force parameter by design, so the TTL cannot be bypassed at this level; only injected `now` advancing past 5 minutes permits another mint |
| 56 | Per-account isolation | Account A's backoff does not silence account B |
| 57 | Key never escapes | The returned object has no `apiKey`/`api_key` and no value containing the canary key |
| 58 | Never throws | A fetch that rejects yields `null`, not an exception |

Dispatch coverage is added to the file named below: probe preferred, passive fallback,
probe failure non-fatal, and — the case the audit asked for — a FORCED refresh through the
dispatcher still mints at most once per success TTL, since `forceRefresh` never reaches the
probe. That assertion belongs at the dispatcher, not at the snapshot function, which has no
such parameter.

Dispatch coverage is added to
`tests/providers/muse-passive-quota-cache.test.ts`, which already owns the auth-store and
cache fixtures for this provider.

## D. The gate

Run from the worktree root, fresh, with output read in full:

```bash
bun run test \
  tests/providers/meta-muse-device.test.ts \
  tests/providers/meta-muse-oauth.test.ts \
  tests/providers/muse-key-quota.test.ts \
  tests/providers/muse-subscription-usage.test.ts \
  tests/providers/muse-passive-quota-cache.test.ts \
  tests/providers/muse-passive-quota-observation.test.ts \
  tests/providers/provider-account-quota.test.ts \
  tests/providers/provider-quota-observed-marker.test.ts \
  tests/gui/oauth-tos-warning.test.ts \
  tests/ci-workflows/docs-provider-billing-claims.test.ts
bun run typecheck
bun run privacy:scan
```

`privacy:scan` is not optional here. It is the script that detects the `LLM|` key grammar
(`devlog/_fin/260903_muse_spark_plan_oauth/003` §A), and this unit adds code and documents
that talk about that grammar. A unit handling credential material closes with that scan
green or it does not close.

The C phase records the command, exit code and output tail through `cxc receipt test`.
Every criterion in the bound goalplan is met only with that fresh output attached — a
passing earlier run is not evidence for a later tree.

## E. Follow-ups this unit deliberately does not take

Each is a candidate work-phase, appended by a later P if the user wants it. None is a
silent omission.

1. **Automatic remint on a 401.** We now hold the account token, so an expired or revoked
   key could be re-minted in place instead of forcing a full re-login. That touches the
   refresh and failover paths, which are shared with every other provider.
2. **`x-api-version` for `meta-model`.** Same base URL, different credential class. One
   line, but it changes a provider outside this unit's scope.
3. **Per-account probing.** `supportsPerAccountQuota` still excludes `meta-muse`; the probe
   writes through the cache instead (`030` §D). A real per-account reader would let the GUI
   refresh each account's row independently.
4. **Shared CLI device-code rendering.** `src/oauth/login-cli.ts:97-106` ignores
   `deviceCode` and always opens a browser; every device provider in this repo relies on
   the code being duplicated into `instructions`. Fixing that helps kimi, nous, copilot and
   ChatGPT device logins as well, which is exactly why it does not belong to a
   single-provider unit.
5. **Live verification.** No request in this unit reached Meta. The first real device login
   should be run by the repository owner on his own account, with the observed request and
   response shapes recorded as a new 000-range measurement doc.
