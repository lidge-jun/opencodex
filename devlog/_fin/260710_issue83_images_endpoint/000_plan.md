# 260710 — /v1/images relay for codex's built-in image_gen (issue #83)

## Problem

GitHub issue #83: the built-in `image_gen` tool fails instantly with
`http 404 Not Found: {"error":{"message":"Unknown endpoint: POST /v1/images/generations",...}}`.

The 404 is ours: codex-rs's standalone image-generation extension executes CLIENT-SIDE —
it POSTs `{base_url}/images/generations` (edits variant: `/images/edits`) with the same
ChatGPT bearer auth it uses for chat (`ext/image-generation`, request body
`{prompt, background, model:"gpt-image-2", quality, size}`, expected response
`{created, data:[{b64_json}]}`, both strict serde). Under Design B injection `base_url`
IS the proxy, and the request died on the `/v1/*` JSON-404 guard (previously even
test-pinned as an intentional 404 in server-auth.test.ts).

Why now: codex 0.144.0 graduated `image_generation` from the disabled-by-default
`imagegenext` experiment to Stage::Stable / default-enabled, so ChatGPT-signed-in users
started hitting the tool organically. The hosted `image_generation` tools[] entry on
`/v1/responses` was never affected (passthrough already forwards it); only the
extension's direct REST call 404'd.

## Fix

New relay route `POST /v1/images/{generations,edits}` (src/server/images.ts), inserted
before the /v1/* guard with the standard data-plane preamble (drain 503, requireApiAuth,
origin check, withCors, request log with `client_cancel` meta on 499).

Upstream selection (`findImagesUpstreams` collects BOTH candidates; selection is
per-request):

1. **ChatGPT forward provider** — preferred, same precedence as the vision/web-search
   sidecars; it is the backend codex itself would have called absent the base_url
   override, so request/response bodies relay verbatim (no mapping). Auth via
   `resolveCodexAuthContext`/`headersForCodexAuthContext`: forwarded caller bearer, or
   the routed multi-account pool token. Guards:
   - `startServer` auto-upserts a `chatgpt` forward entry into every config, so the
     forward candidate is only used when the resolved headers actually carry an
     authorization value — otherwise an unauthenticated request would bounce off
     chatgpt.com as an opaque `{"detail":"Unauthorized"}`.
   - A bearer equal to the proxy's own admission secret (non-loopback binds accept
     `Authorization: Bearer <OPENCODEX_API_AUTH_TOKEN>`) is stripped before selection —
     the proxy secret must never be relayed to chatgpt.com
     (`isProxyAdmissionSecret`, extracted from `hasValidApiAuth`).
   - Forward-auth FAILURES (pool cooldown 429, reauth 401, affinity 409) are captured,
     not returned: a configured keyed provider still serves the request, and the
     captured error only surfaces when no keyed candidate exists. Without this, "all
     pool accounts cooling down" would 429 image_gen while api.openai.com sat idle.
   - Pool upstream outcomes are recorded via `sidecarOutcomeRecorder` (status /
     timeout / connect_error), keeping rotation failover signals alive.
2. **Keyed openai-responses provider** (e.g. api.openai.com) — fallback when no
   relayable ChatGPT auth; its `/v1/images/*` is the real platform Images API. URL is
   normalized like the adapter (`baseUrl.replace(/\/v1\/?$/,"")` + `/v1/images/…`), so
   baseUrl with or without `/v1` both work; forward URLs stay bare
   (`${baseUrl}/images/…`, the ChatGPT-backend convention).
3. **Neither** — honest 400 (`invalid_request_error`) naming the fix
   (`codex features disable image_generation` or add an OpenAI provider). 400, not 5xx:
   codex retries every 5xx up to 5 total attempts and this is a permanent config state.

Relay details: `readJsonRequestBody` (zstd/gzip decode + 256MB cap) → JSON re-serialize →
`fetchWithResetRetry` (stale keep-alive resets) with a `config.images.timeoutMs`
(default 300s) timeout linked to the client abort; response buffered (single JSON
document, few MB) and passed through status+content-type+body verbatim so upstream
plan-gating errors stay legible. Client cancel returns 499 (`client_closed_request`),
never a fake 502; genuine timeout returns 504 (retriable by codex, acceptable for a
transient hang).

Deliberately NOT done:

- No auto-injection of `[features] image_generation = false` — it would remove a
  capability the relay makes work, and openai/codex#21952 suggests app-server ignores
  the flag anyway. Documented as a user opt-out instead (docs-site codex-integration,
  en/ko/zh-cn).
- No image generation via routed providers (Gemini image models etc.) — the adapter
  event pipeline has no image-output event; separate feature, not this bug fix.

## Tests

tests/server-images.test.ts (16): forward relay (auth + path + body), edits path,
pool-token override (caller bearer must not leak), zstd body decode, keyed fallback +
`/v1` URL normalization (with and without suffix), unauthenticated-request gate (keyed
fallback / 401), forward-auth-failure fallback (keyed / surfaced 401), no-upstream 400,
upstream error passthrough, 504 timeout via `config.images.timeoutMs`, GET falls to 404
guard, non-loopback auth/origin, admission-secret never relayed.
server-auth.test.ts's 404-guard list swaps `/v1/images/generations` for
`/v1/realtime/sessions`.
