# DONE — WS broken-pipe gate + vision sidecar fix (260707)

Audit: gpt-5.5 (Hilbert) PASS-WITH-FIXES; all adopted. Second gpt-5.5 explorer (Anscombe)
provided the codex-rs WS transport evidence.

## Root causes
1. Broken pipe: codex-rs built-in `openai` provider hardcodes supports_websockets=true
   (model-provider-info/src/lib.rs:352) — under Design B codex always tries the WS
   transport. opencodex config websockets:false only controlled catalog flags; the
   /v1/responses upgrade handler accepted sockets anyway. Proxy-side socket closes
   (restart, account invalidation 4001) surfaced as "failed to send websocket request:
   IO error: Broken pipe" on codex's next response.create write.
2. Per-model WS gating impossible: model only exists in the response.create frame
   (codex-api/src/common.rs:215); upgrade carries no model. Connect-time 426 →
   WebsocketStreamOutcome::FallbackToHttp (client.rs:1419) → force_http_fallback flips
   session-scoped disable_websockets (client.rs:425). So "WS only for gpt" cannot exist;
   what CAN exist is a clean global off, which is what the user effectively asked for
   (websockets:false in config == only-HTTP for everything through the proxy).
3. Vision sidecar not firing: planVisionSidecar keys on provider.noVisionModels
   (vision/index.ts:74); opencode-go registry entry had none. glm-5.2 on Zen Go is
   text-only (opencode.ai/data/zhipu/glm-5-2). Kimi K2.7 Code is text+image+video —
   deliberately NOT listed (jawcode metadata + catalog test expect multimodal).
4. Web-search sidecar: audited, no same-class gap.

## Shipped
- src/server.ts: /v1/responses upgrade returns 426 when websocketsEnabled(config) is
  false (after origin check, before auth resolution). codex falls back to HTTP for the
  session — no more half-open sockets from a disabled feature.
- src/providers/registry.ts: opencode-go noVisionModels = ["glm-5.2"].
- tests: server-auth "426 when WS disabled" + websockets:true opt-in on the 3 WS
  integration fixtures; provider-registry-parity opencode-go noVisionModels assertion.

## Verification
bun test ./tests/ → 1544 pass / 0 fail (159 files); bun x tsc --noEmit → exit 0.

## Notes
- Config already has websockets:false, so after ocx restart codex sessions will 426→HTTP
  once per session and stop hitting broken pipes.
- Parked WIP from interrupted work-phase 2 (anthropic thinking-signature): src/types.ts
  AdapterEvent additions + src/responses/reasoning-envelope.ts exist but are not yet wired;
  plan + audit live in devlog/_plan/260707_anthropic-thinking-signature/.
