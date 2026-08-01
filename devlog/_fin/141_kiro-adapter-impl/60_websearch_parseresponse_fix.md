# 60 — web_search → parseResponse fix (kiro-only live failure)

## Symptom
Real Codex CLI → opencodex proxy (`localhost:10100`) → kiro showed `Reconnecting… 1/5…5/5`
then `We're currently experiencing high demand, which may cause temporary errors.` **for kiro
only** — every other provider worked. Reproduced headlessly with `codex exec -m
kiro/claude-sonnet-4.6` (exit 1).

## Diagnosis (evidence-driven)
1. Minimal `curl` to `/v1/responses` with a kiro model **succeeded** (200, streamed exact text)
   → adapter + eventstream + Responses bridge are fine for a plain request.
2. Captured the **real** 53 KB Codex request via a throwaway capture server (codex `-c
   model_providers.opencodex.base_url=…`). Diff vs the minimal request: 17 `tools` (incl.
   hosted `web_search`), 21 KB instructions, `reasoning:{effort:"none"}`.
3. Replayed the captured request to the running proxy → **HTTP 500**
   `{"error":{"message":"web-search sidecar requires a non-streaming adapter"}}`.
4. Source: `src/web-search/loop.ts:111` — when Codex sends the `web_search` tool the proxy runs
   the model in a **non-streaming** agentic loop and hard-requires `adapter.parseResponse`.
   anthropic/google/openai-chat implement it; **kiro had only `parseStream`** → 500 → Codex
   retried → "high demand". That is exactly why *only* kiro failed.

## Fix (commit dd1d924)
`src/adapters/kiro.ts`: hoisted the eventstream decode into a module-level
`parseKiroStream(response)` generator; `parseStream` delegates to it and a new
`parseResponse(response): Promise<AdapterEvent[]>` drains it into an array. CodeWhisperer only
ever returns an AWS eventstream (no non-stream mode), so draining is the correct equivalent.
Registry/buildRequest unchanged. Tests: `tests/kiro-adapter.test.ts` +2 (parseResponse present;
parity with parseStream).

## Verification
- Restarted the workspace proxy (it ran pre-fix code in memory; Bun has no hot-reload).
- `codex exec -m kiro/claude-sonnet-4.6 "…hello-codex-exec-kiro"` → **exit 0**, replied
  `hello-codex-exec-kiro`.
- Captured 53 KB request replay → now streams to `response.completed` (no 500).
- Adapter 10/10, full suite 608/608, `tsc` 0. Backend employee read-only verify: DONE, plus a
  preemptive scan found **no other kiro-only adapter-capability gap** (passthrough/vision are
  config/forward concerns, not adapter methods).

## Follow-up (not a bug, config-only)
If kiro models cannot accept image input natively, list them in `noVisionModels` so the vision
sidecar pre-describes images (analogous to the reasoning-ignore registry metadata).
