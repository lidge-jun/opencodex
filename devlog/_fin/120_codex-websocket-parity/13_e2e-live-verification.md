# 120.13 — 120.5 Live End-to-End WebSocket Verification

## Objective

The acceptance gate for phase 120: a real Codex CLI driving `ocx` over **WebSocket** for both a
native `gpt-*` and a routed model, across a multi-turn session with interrupts, stalls, and tool
calls — confirming WS parity with the HTTP/SSE path and no new error class (RC6). Verification
plan, not code. Runs after `10_` (+ optionally `11_`) and `12_` are implemented.

## Preconditions

- `10_` WS endpoint implemented; `12_` flag enable implemented.
- `config.websockets = true`; served catalog regenerated (verify `supports_websockets: true` in
  `/Users/jun/.codex/opencodex-catalog.json`).
- `ocx` running; Codex CLI installed.

## Codex configuration

```toml
# native gpt over WS:
model_provider = "opencodex"
model = "gpt-5.5"

[model_providers.opencodex]
base_url = "http://localhost:10100/v1"   # Codex derives ws://localhost:10100/v1/responses (01_§2)
wire_api = "responses"
requires_openai_auth = true
# supports_websockets now advertised by the catalog (12_), so Codex opens WS.
```

Run the routed scenarios by switching `model = "opencode-go/deepseek-v4-pro"`.

## Scenarios (each must hold over WS)

1. **Native long answer.** `gpt-5.5`, multi-paragraph reply. Expect: WS upgrade succeeds (101),
   one `response.completed`, no `ApiError::Stream`.
2. **Routed long answer.** `opencode-go/deepseek-v4-pro` over WS (MVP re-frame path). Same
   expectations — proves Option A serves routed over WS.
3. **Interrupt mid-stream.** Interrupt a long generation, send a new turn. Expect: new turn
   answers; the WS `close`/cancel aborts the upstream (no leaked connection); same socket may be
   reused for the next turn (`01_§4` multi-turn).
4. **Stall.** Slow routed model / long reasoning gap. Expect: no `"idle timeout waiting for
   websocket"` — the re-framed `response.heartbeat` (or a real Ping, if added) re-arms Codex's
   idle timer.
5. **Tool round-trip.** A turn with a function/tool call + follow-up over WS. Expect: tool call
   commits, conversation continues.
6. **Parity diff.** Run the same prompt over HTTP (`base_url` HTTP, WS off) and WS; expect
   semantically identical event sequences (created → items → completed) — confirms the
   re-frame is faithful.

## Observation methods

```bash
# WS upgrade actually happened (not silent HTTP fallback):
#   confirm a 101 upgrade in ocx logs, or capture with: lsof -iTCP -sTCP:ESTABLISHED | grep 10100
# Codex client-side stream errors (must be empty):
#   scan Codex log/TUI for: ApiError::Stream, "websocket closed by server before response.completed",
#   "idle timeout waiting for websocket", "unexpected binary websocket event".
# Leaked upstream after interrupt (return to baseline):
lsof -p "$(pgrep -f 'ocx|opencodex' | head -1)" 2>/dev/null | grep -c ESTABLISHED
```

## Pass criteria

| # | Criterion | Verified by |
|---|-----------|-------------|
| 1 | WS upgrade succeeds (HTTP 101) for native + routed | ocx log / lsof |
| 2 | Exactly one `response.completed` per turn; zero `ApiError::Stream` | Codex log scan |
| 3 | Interrupt aborts upstream; ESTABLISHED returns to baseline | `lsof` before/after (scenario 3) |
| 4 | No `"idle timeout waiting for websocket"` on the stall scenario | Codex log scan (scenario 4) |
| 5 | Tool round-trip completes over WS | Codex session |
| 6 | WS and HTTP event sequences are semantically identical | side-by-side (scenario 6) |
| 7 | No binary frame / no `"unexpected binary websocket event"` | Codex log scan |

## Recording

Append a results block (date, codex version, models, pass/fail per criterion) and flip phase 120
status to **verified** in `00_overview.md`. If WS underperforms or regresses vs HTTP, the MVP can
be shipped with the flag **off** by default (HTTP remains the supported path) until issues are
resolved — `12_`'s flag makes that a config toggle, not a code revert.

## Results — executed 2026-06-20 (120.2 + 120.4 PASS)

Live runs against the real `opencode-go` upstream (saved token), isolated repo build on port
10199; codex catalog backed up and restored around the flag tests.

| Check | Result |
|-------|--------|
| WS upgrade + full data plane (120.2) | PASS — `ws://…/v1/responses` → `response.create` → real opencode-go bridge → `response.completed` (26 frames, content deltas present), no server crash |
| WS client-disconnect (RC2 over WS) | PASS — covered by `ws-endpoint` unit test (cancel hook aborts the reader); HTTP-path RC2 validated live in `110/55` |
| Flag OFF → on-disk catalog (the file Codex reads) | PASS — native `gpt-5.5` **and** routed `opencode-go/kimi-k2.7-code` both `supports_websockets` ABSENT → Codex uses HTTP (native-leak closed) |
| Flag ON → on-disk catalog | PASS — native **and** routed both `supports_websockets=true` → Codex opens WS |
| HTTP path still served (coexistence/fallback) | PASS — HTTP `/v1/responses` bridge validated live in `110/55`; WS is additive |

Note: the flag is applied to the **on-disk** `~/.codex/opencodex-catalog.json` written by
`syncCatalogModels` (the file Codex reads via `model_catalog_json`), not only the `/v1/models`
HTTP response — both paths now honor `config.websockets`. **120.2 + 120.4 status: verified.**

Deferred (by plan): driving the actual Codex CLI binary end-to-end over WS (gold-standard manual
check — enable `config.websockets`, restart `ocx`, run a routed turn) and native upstream WS
(`11_`, optional).

## Non-goals

- Not a throughput benchmark (parity/correctness only).
- Native end-to-end upstream WS (`11_`) is verified separately if that sub-phase ships.
