# 010 — wp2: inject `experimental_realtime_ws_base_url` with the loopback override

## Goal
When `ocx start` installs Design B loopback routing (`openai_base_url = "http://127.0.0.1:<port>/v1"`),
also install a marker-owned root `experimental_realtime_ws_base_url` with the SAME value, so codex-rs
(`core/src/realtime_conversation.rs:1194-1206`) sends the WebRTC sideband join back through the proxy.

## Files
- `src/codex/injected-marker.ts`
  - add `REALTIME_WS_BASE_URL_KEY = "experimental_realtime_ws_base_url"`, `isRootRealtimeWsBaseUrlLine(line)`.
  - `stripJournaledOpenaiBaseUrl(content, injectedUrl)`: also drop a root `experimental_realtime_ws_base_url`
    line whose value === injectedUrl (plus its marker line). Value evidence survives app reserialization (#1798).
  - `hasInjectedOpenaiBaseUrl` unchanged (openai_base_url stays the ownership signal).
- `src/codex/inject.ts`
  - `buildRealtimeWsBaseUrlLine(target)` → `experimental_realtime_ws_base_url = <toml string of target.baseUrl>`.
  - `stripInjectedOpenaiBaseUrl(content)`: drop marker-owned `experimental_realtime_ws_base_url` lines too
    (same marker-adjacency rule). Must run before `removeOcxSection` (it keys on the marker line).
  - new `setRootRealtimeWsBaseUrlForTarget(content, target)`: mirror of `setRootOpenaiBaseUrlForTarget`;
    a user-owned (unmarked) key is kept, returns `keptUserRealtimeWsBaseUrl`.
  - Design B branch (L972-978): after `setRootOpenaiBaseUrlForTarget`, if `!keptUserBaseUrl` call
    `setRootRealtimeWsBaseUrlForTarget`. When the user owns `openai_base_url` we inject nothing (existing rule).
  - Legacy provider-table mode: NOT injected (the public ingress needs the opencodex API key, which the
    sideband auth headers cannot carry) — documented residual.
  - `stripOpencodexConfigResult` (L1390-1401): `stripInjectedOpenaiBaseUrl` + journaled strip already cover it
    after the helper changes; add a regression assertion.
  - Summary message: mention "voice sideband override" in the Design B success line (L1304).

## Tests (tests/codex-inject.test.ts, tests/codex-injected-marker.test.ts)
1. loopback inject writes both keys, each preceded by the marker; second run is idempotent (byte-equal).
2. user-owned `experimental_realtime_ws_base_url = "https://my.gateway/v1"` (no marker) survives injection
   and restore.
3. restore/strip removes both marker-owned keys; app-reserialized (comments dropped) config is restored via
   journal value match.
4. user-owned `openai_base_url` → neither key injected (keptUserBaseUrl path).
5. legacy target (non-loopback) → no realtime key written.

## Checks
`bun run typecheck`; `bun test tests/codex-inject.test.ts tests/codex-injected-marker.test.ts tests/codex-inject-integration.test.ts`.
