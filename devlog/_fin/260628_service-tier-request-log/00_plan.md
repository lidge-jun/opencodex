# 00 — Service Tier Request Log Plan

Date: 2026-06-28

## Goal

Capture Codex fast/priority requests accurately in opencodex request logs without pretending the model name changed. Codex persists `service_tier = "fast"`, codex-rs normalizes that to wire `service_tier: "priority"`, and upstream may independently report a response `service_tier` or model name. Logs must keep those concepts separate.

## Current Evidence

- Live `codex exec` succeeds through opencodex with `/Users/jun/.codex/config.toml` containing `service_tier = "fast"` and `[features].fast_mode = true`.
- Current `/api/logs` entries only include `model`, `provider`, `status`, `durationMs`, and stream close metadata.
- `src/responses/schema.ts` accepts `service_tier`, but `src/responses/parser.ts` does not copy it into `OcxRequestOptions.serviceTier` yet.
- `devlog/90_service-tier-fast/00_investigation.md` establishes the split: config spelling `fast`, runtime/catalog/request id `priority`.

## Plan

### MODIFY src/responses/parser.ts

After existing frequency/presence penalty option capture, copy `data.service_tier` into `options.serviceTier` when present.

### MODIFY src/server.ts

Extend request log metadata with optional fields:

- `requestedModel`: original incoming model string before routing rewrites.
- `requestedServiceTier`: incoming `parsed.options.serviceTier`, normally `priority` for Codex fast mode.
- `requestedSpeedLabel`: `fast` only when requested service tier is `priority` or legacy `fast`.
- `responseServiceTier`: service tier observed from upstream response payload when available.
- `resolvedModel`: upstream `openai-model` response header or first parsed response payload model when available.

Implementation shape:

1. Add a small exported helper to normalize speed labels.
2. Add mutable metadata fields to `logCtx` so HTTP and WebSocket paths share the same capture.
3. In `handleResponses`, capture requested model before route rewrite and requested service tier immediately after parsing.
4. On passthrough responses, capture `openai-model` from headers.
5. For passthrough JSON/SSE response bodies, inspect cloned/tee inspection streams to record response payload `model` and `service_tier` without changing client-facing bytes.
6. Keep logs honest: do not synthesize `gpt-5.5-fast`; display consumers can render `gpt-5.5 (fast)` from `requestedSpeedLabel`.

### MODIFY tests/responses-parser.test.ts

Add a parser regression proving `service_tier: "priority"` becomes `options.serviceTier === "priority"`.

### MODIFY tests/request-log.test.ts

Add metadata tests for fast label normalization and filtering preservation with the new optional fields.

### Verification

Run:

```bash
bun test tests/responses-parser.test.ts tests/request-log.test.ts tests/openai-responses-passthrough.test.ts tests/ws-endpoint.test.ts
bun x tsc --noEmit
bun test tests
```

Then run a live `codex exec` smoke against the already-running local ocx and confirm `/api/logs` includes `requestedServiceTier`/`requestedSpeedLabel` after restarting if necessary.

## Commit

One atomic commit: `feat(logs): capture service tier metadata`.

