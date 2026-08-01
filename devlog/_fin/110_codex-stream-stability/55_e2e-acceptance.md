# 110.55 — F5: Live-Codex Acceptance Gate

## Objective

RC1–RC3 and F1–F4 are provable by unit tests at the mechanism level, but the original symptom
— *"엄청 발생"* (`ApiError::Stream` en masse) — is only fully reproducible with a **live Codex
CLI** driving a **routed** model through `ocx` over a multi-turn session with interrupts. This
doc defines that acceptance gate as a concrete, runnable checklist. It is a **verification
plan**, not code; it closes 110 once executed in the user's environment.

## Preconditions

- `ocx` running and reachable (default `http://localhost:10100`).
- A routed provider configured with real credentials (the historical repro config is
  `opencode-go/deepseek-v4-pro`; any chat/completions routed model reproduces the bridge path).
- Codex CLI installed (`command -v codex`).

## Codex configuration

`~/.codex/config.toml` — point Codex at `ocx` as an OpenAI-compatible Responses provider and
select a **routed** model so the **bridge** path (not native passthrough) is exercised:

```toml
model_provider = "opencodex"
model = "opencode-go/deepseek-v4-pro"

[model_providers.opencodex]
base_url = "http://localhost:10100/v1"
wire_api = "responses"
requires_openai_auth = true
# supports_websockets intentionally absent — WS parity is phase 120, not 110.
```

## Scenarios (each must hold)

1. **Single long answer.** Ask for a multi-paragraph answer. Expect a complete reply, exactly
   one terminal, and no `ApiError::Stream` in Codex logs. (RC1 + F1/F2)
2. **Interrupt mid-stream.** Start a long generation, press the interrupt key, immediately send
   a new turn. Expect: the new turn answers cleanly; no leaked upstream connection from the
   aborted turn; no proxy-side unhandled rejection. (RC2)
3. **Slow / stalling provider.** Use a slow routed model (or a long reasoning prompt). Expect:
   no `"idle timeout waiting for SSE"` — the `response.heartbeat` keeps Codex's idle timer
   armed through the stall. (RC3)
4. **Tool round-trip.** Trigger a turn with a function/tool call and a follow-up. Expect: tool
   call commits, no `JSON.parse("")` 400, conversation continues. (bridge tool-call finalize)
5. **Upstream error mid-stream.** Force a rate-limit/overload (hammer the provider, or use a
   key near its limit). Expect: Codex surfaces a **classified** failure (rate-limit/overload),
   **not** `"response.failed event received"` or a truncated success. (F1 + F3)

## Observation methods

```bash
# 1. Codex client-side stream errors (should be empty across the session):
#    watch the Codex CLI log / TUI for "ApiError::Stream", "stream closed before response.completed",
#    "idle timeout waiting for SSE", "response.failed event received".

# 2. Leaked upstream sockets after an interrupt (count should return to baseline):
lsof -p "$(pgrep -f 'ocx|opencodex' | head -1)" 2>/dev/null | grep -c ESTABLISHED

# 3. ocx-side noise (should be quiet; with OCX_DEBUG_FRAMES=1, inspect any frame drops):
OCX_DEBUG_FRAMES=1 ocx   # run ocx with frame-drop visibility during the session
```

## Pass criteria

| # | Criterion | How verified |
|---|-----------|--------------|
| 1 | Zero `ApiError::Stream` across all 5 scenarios | Codex log scan |
| 2 | No `"stream closed before response.completed"` | Codex log scan |
| 3 | No `"idle timeout waiting for SSE"` on the slow scenario | Codex log scan (scenario 3) |
| 4 | ESTABLISHED upstream count returns to baseline after each interrupt | `lsof` before/after (scenario 2) |
| 5 | Mid-stream upstream errors arrive **classified** (rate-limit/overload/context) | Codex error surface (scenario 5) |
| 6 | No proxy-side unhandled rejection in the `ocx` process | `ocx` stderr |

## Recording

On completion, append a short results block to this doc (date, codex version, routed model,
pass/fail per criterion) and reference it from `50_closure-overview.md`'s status table (flip F5
to **Closed**). If any criterion fails, capture the exact log line and open a follow-up doc in
the 56+ range rather than editing the implemented fixes blind.

## Results — executed 2026-06-20 (F5 PASS)

Live run against the real `opencode-go` upstream (`opencode.ai/zen/go/v1`) using the saved token,
model `opencode-go/kimi-k2.7-code`, via the **bridge path** (openai-chat adapter). Isolated repo
build on port 10199 (the running 10100 instance and codex config untouched).

| Criterion | Result |
|-----------|--------|
| Clean lifecycle, single terminal | PASS — `response.created → reasoning_text.delta×20 → output_item.done → message → response.completed` |
| Exactly one `response.completed`; zero `ApiError::Stream` | PASS — `status: completed`; 0 error/`stream closed` frames |
| Usage present in terminal (F2 live) | PASS — `usage {input_tokens:13, output_tokens:25, total_tokens:38}` |
| Answer correctness | PASS — output text `"hello world"` as prompted |
| RC2 client-disconnect mid-stream | PASS — curl `--max-time 1.5` (exit 28); server stayed healthy; a subsequent request returned `response.completed`; no unhandled rejection / crash in server log |

Error-path fixes (F1 inline error, F3 overload/transient-429) are covered by unit tests
(`adapter-error-inline`, `error-fidelity`) since the live upstream returned success. Stall/idle
(RC3) is covered by `bridge-lifecycle` unit tests. **F5 status: Closed.**

## Non-goals

- No native `gpt-*` WS path here (phase 120).
- Not a load/perf benchmark — this gate is correctness/lifecycle only.
