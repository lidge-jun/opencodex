# 030 — Phase 3: connectTimeoutMs fallback unification (120s → 200s)

## Problem (verified 2026-07-16)

The documented repo-wide default for `connectTimeoutMs` is 200_000
(`src/types.ts:420-421` — comment at :420 documents "Default 200000", property at :421), and every other consumer honors it:

- `src/server/responses.ts:694` — `config.connectTimeoutMs ?? 200_000`
- `src/server/responses.ts:903` — `connectTimeoutMs: config.connectTimeoutMs ?? 200_000`
- `src/server/responses.ts:935` — `config.connectTimeoutMs ?? 200_000`
- `src/web-search/index.ts:149` — `config.connectTimeoutMs ?? 200_000`
- `src/web-search/loop.ts:234` — `deps.connectTimeoutMs ?? 200_000`

The one outlier is the Anthropic native passthrough:

- `src/server/claude-messages.ts:211` — `config.connectTimeoutMs ?? 120_000`

Impact: with `connectTimeoutMs` unset, a NON-streaming passthrough request
(`stream:false` — headers arrive only when the full response is ready, so extended
thinking can legitimately take minutes) gets 504'd at 120s on this path while every
other surface would have waited 200s. Streaming requests are unaffected (headers
arrive early; deadline cleared per PR #136). Inconsistent-fallback bugs are silent:
setting the config key masks the drift entirely.

## Diff (copy-paste executable)

`src/server/claude-messages.ts` (currently line 211, inside
`anthropicNativePassthrough`'s `fetchWithHeaderDeadline` call):

```diff
   const result = await fetchWithHeaderDeadline(
     `${base}${pathname}${search}`,
     { method: "POST", headers, body: JSON.stringify(body) },
-    config.connectTimeoutMs ?? 120_000,
+    config.connectTimeoutMs ?? 200_000,
     req.signal,
   );
```

## Test impact (verified)

`rg -n "connectTimeoutMs" tests/claude-messages-endpoint.test.ts` → both passthrough
tests SET the value explicitly (`= 200` at :183, `= 60_000` at :259), so the fallback
change breaks nothing. Add one assertion-level note: no new test is strictly required
for a constant fallback, but if desired, a unit test can assert the default by
invoking `fetchWithHeaderDeadline` indirectly with config lacking the key — optional.

## Direction check (timeout-history alignment)

30s → 100s (`b62a1450`) → 200s (`1496b932` era, documented at `src/types.ts:420-421`).
Raising this fallback 120s → 200s moves WITH that history (more patience for slow
headers), never against it. No path becomes stricter.

## Class call

C1 — one-constant change, existing tests unaffected, config override path unchanged.
