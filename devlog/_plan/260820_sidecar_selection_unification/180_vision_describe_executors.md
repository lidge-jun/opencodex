# 180 — Routed describe executor + dispatch (wp3, REVISED)

Depends on: 170 (revised).

## src/vision/routed-describe.ts (new)

Loopback POST http://127.0.0.1:{config.port}/v1/chat/completions:

```json
{ "model": "<namespaced routed id>", "stream": false,
  "messages": [
    { "role": "system", "content": "<describe instruction>" },
    { "role": "user", "content": [
      { "type": "text", "text": "<context>" },
      { "type": "image_url", "image_url": { "url": "<data:/https:>" } }
    ]}]}
```

- Auth: none on loopback binds (resolveApiAuth admits loopback without a
  token); when OPENCODEX_API_AUTH_TOKEN is set, send it as Authorization
  bearer (auth-cors.ts:399-400 accepts bearer on /v1/chat/completions).
- signalWithTimeout(settings.timeoutMs) + cancelBodyOnAbort;
  sidecarEnter("vision"); redactSecretString on error paths; response text
  from choices[0].message.content; DESC clamp caller-side (existing).
- validateImageUrl reused (data: mime allowlist + 20MB, https passthrough).
- The chat inbound translates image_url → input_image and every adapter
  compiles its own wire (anthropic blocks, CCA inlineData, xai Responses),
  so provider coverage is the router's, not this file's.

## planVisionSidecar routed arm

VisionPlan gains { backend: "routed", routedModel: string }. Arm requires
explicit model + plan-time modelAcceptsImageInput !== false (recursion
fence). executeDescription routed arm calls describeImageRouted.

## Tests

vision-routed.test.ts: wire shape against a mock loopback server; recursion
fence (text-only target never plans routed); timeout/error taxonomy;
redaction. E2E: routed describer via a second mock provider.


## Audit round 2 amendments (2026-08-22)

- **Admission ladder (blocker 2):** token =
  configuredApiAuthToken() || loadServiceTokenFromFile(env) || first
  config.apiKeys entry; sent as `x-opencodex-api-key` (never Authorization —
  gateway-cache.ts:77-86 rule); omitted entirely on loopback binds where
  isApiAuthRequired is false.
- **Terminal marker:** executor sets `x-opencodex-vision-describe: 1`; the
  core.ts plan site checks it and strips images instead of planning vision.
- Executor also passes stream:false and reads choices[0].message.content;
  non-2xx → {error} with redacted body slice.


## Audit round 3 amendment (2026-08-22) — marker propagation

The chat→responses bridge rebuilds headers from the FORWARD_HEADERS allowlist
(chat-completions.ts:198-203, openai-responses.ts:28-36), which would DROP
`x-opencodex-vision-describe` before the plan site — on exactly the one path
recursion lives. Therefore:

- The marker is detected AT THE CHAT SURFACE (raw req.headers before the
  bridge) and carried as an explicit option/flag into handleResponses
  (`visionDescribeTerminal: true`), not as a header the bridge must
  preserve. The Responses surface ALSO honors the raw header directly for
  native /v1/responses callers.
- Regression test drives the FULL chat-surface path: marked POST to
  /v1/chat/completions with an image + text-only routed model → assert the
  plan site STRIPS (no describe dispatch, no recursion), while the same
  unmarked POST plans normally. A predicate-only test is insufficient and
  would stay green with the marker broken.

