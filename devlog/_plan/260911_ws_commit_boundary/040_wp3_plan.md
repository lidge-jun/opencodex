# wp3 — liveness replaces the fixed prelude deadline

Previous D (wp2): honest 502/504 with the non-replayable marker landed at 42988a1693; draft PR #4256 opened so remote CI runs on that head. Direction unchanged.

## Files and exact changes

### src/server/responses/codex-ws-wire.ts
- CODEX_WS_LIVENESS_PING_INTERVAL_MS = 15_000.
- CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS keeps 90_000; its comment now defines it as the longest inbound silence (no message frame, no pong) tolerated before the first response event.
- CodexWsFailureStage gains pings and pongs (numbers); codexWsFailureDetail appends " pings=N pongs=N" after elapsed, inside the bracket.

### src/server/responses/codex-ws-exchange.ts
- Counters pings, pongs. Timers silenceTimer (replaces preludeTimer) and pingTimer.
- armSilence(): clearTimeout(silenceTimer); if (responseCommitted || terminal) return; silenceTimer = setTimeout(() => failStream("codex websocket response prelude timed out" + detail, 504), CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS).
- schedulePing(): only when typeof ws.ping === "function"; pingTimer = setTimeout(() => { if (responseCommitted || terminal) return; try { ws.ping(); pings += 1; } catch { return; } schedulePing(); }, CODEX_WS_LIVENESS_PING_INTERVAL_MS).
- onPong(): pongs += 1; if (!responseCommitted) armSilence(). Listener added with the others, removed in cleanup().
- After a successful send on the metadata path: armSilence(); schedulePing(). onMessage calls armSilence() while !responseCommitted (after the terminal guard).
- commitResponse() and cleanup() clear both timers; cleanup() removes the pong listener.
- The non-metadata path is untouched (commits at send; no liveness).

### docs-site/src/content/docs/reference/configuration/server.md
- Replace the "fixed 90-second response-prelude deadline" paragraph: silence-based liveness, ping every 15 s, any inbound frame or pong resets, 90 s of nothing settles a non-replayable 504, closes/transport errors before the first response event settle 502, connectTimeoutMs remains the outer bound and a pre-response connect timeout is the same 504; no HTTP resend either way.

### Tests
- tests/responses/ws-upstream.test.ts, new describe "prelude liveness": (a) a socket whose ping() emits pong stays alive across 7 x 15 s steps (105 s > 90 s) and the response still completes with one send and zero HTTP; (b) a socket whose ping() never pongs settles 504 at 90 s with pongs=0 in the message; (c) after response.created the pinger stops (no further ping calls across 60 s). The existing first-response-deadline test already covers a socket without ping().
- tests/responses/ws-failure-stage.test.ts: stage() defaults pings: 0, pongs: 0; the two exact toBe strings gain " pings=0 pongs=0".

## Verification
NOT RUN locally (owner rule). Remote CI on the final head in wp4.

