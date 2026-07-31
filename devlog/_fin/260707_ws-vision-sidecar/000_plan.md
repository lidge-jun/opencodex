# Work-phase 3: WS broken-pipe + vision sidecar gaps (260707)

## Findings (evidence-verified)
1. Broken pipe ("failed to send websocket request: IO error: Broken pipe (os error 32)"):
   - codex-rs built-in `openai` provider hardcodes supports_websockets=true
     (model-provider-info/src/lib.rs:352); Design B (openai_base_url override) means codex
     ALWAYS tries the Responses-WS transport against the proxy.
   - opencodex config has websockets:false, but the /v1/responses upgrade handler
     (src/server.ts:2384) accepts upgrades UNCONDITIONALLY — the flag only controls
     catalog/config-toml flag injection (moot under Design B).
   - When the proxy closes a socket (restart/drain, account invalidation close 4001) codex
     discovers it on the next response.create WRITE -> broken pipe. codex retries
     (stream_max_retries=5, responses_retry.rs:31-48) then falls back to HTTP, but surfaces
     the error when retries exhaust mid-stream.
2. Per-model WS gating is impossible at upgrade time: model is only in the response.create
   frame (codex-api/src/common.rs:215); upgrade carries no model (client.rs:914 headers,
   provider.rs:53 url). HTTP 426 at connect -> WebsocketStreamOutcome::FallbackToHttp ->
   force_http_fallback flips session-scoped disable_websockets (client.rs:425, comment:207).
   So "WS only for gpt" cannot exist; only global on/off per session.
3. Vision sidecar not firing for text models: planVisionSidecar requires
   modelInList(provider.noVisionModels, modelId) (src/vision/index.ts:74), but the
   opencode-go registry entry has NO noVisionModels (registry.ts:247-262) — kimi-k2.7-code /
   glm-5.2 / kimi-k2.7-code-highspeed are text-only, so images flow natively into a
   text-only API instead of being described. lidge-gemma (user-config provider) also
   unmarked but that is user config, not registry.
4. Web-search sidecar: no same-class gap (fires on _webSearch tool presence; WS path
   forwards authorization; describeImages already keyed on noVisionModels).

## Fix scope (B)
- src/server.ts upgrade branch: when websocketsEnabled(config) is false, return the
  existing 426 response instead of accepting the upgrade -> codex cleanly falls back to
  HTTP for the session; no more half-open sockets from a "disabled" feature.
- src/providers/registry.ts opencode-go: noVisionModels = ["glm-5.2", "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed"] (text-only models on the Go endpoint).
- tests: ws-endpoint 426-when-disabled; registry seed assertion.
Out of scope: per-model WS gating (impossible, documented above); thinking-signature
work-phase (parked: src/types.ts + src/responses/reasoning-envelope.ts WIP intact).

## Verification
bun test ./tests/ && bun x tsc --noEmit
