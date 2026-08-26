# 160 — Vision external-backend research (xai Grok / Antigravity Gemini describers)

Continuation of #2188. Web-search shipped four external backends (L6-L9, docs
060-090); the vision sidecar still dispatches only openai-forward and
anthropic-OAuth. GUI evidence: the vision dropdown lists only Codex/Claude
rows while the web-search dropdown already lists Grok/Gemini.

## Current vision dispatch inventory

- Types: `OcxVisionSidecarConfig.backend?: "openai" | "anthropic"` (src/types.ts).
- Union: `VisionSidecarBackend` (src/vision/eligibility.ts:30) — 2 arms.
- Candidate mapping: `visionBackendForCandidate` (eligibility.ts:150-165) —
  native/openai → openai; anthropic only via the resolved OAuth provider name.
- Options: `visionEligibleModelOptions` (eligibility.ts:201+) iterates
  `["openai","anthropic"] as const` and injects `BASELINE_VISION_MODELS`.
- Enabled backends: `enabledVisionBackends`
  (src/server/management/vision-sidecar-options.ts:31-43); empty-auth fallback
  returns both universal sides.
- Write gate: `visionDescriberIsProvablyBlind` (vision-sidecar-options.ts:94+)
  probes ONLY the openai/anthropic vendor tables.
- PUT validation: config-routes.ts:594-596 rejects backends outside the two
  literals; hint fall-through at :623; claude-code override near :738-740.
- Runtime plan: `planVisionSidecar` (src/vision/index.ts) — anthropic arm and
  openai-forward arm only. `resolveVisionBackend`: explicit > anthropic-if-auth
  > openai.
- GUI: `SidecarBackend = "openai" | "anthropic"` (gui/src/pages/
  dashboard-shared.ts:62, claude-manual-env.ts:8). NOTE: this type is shared
  with WebSearchModelOption and is ALREADY stale — the server emits
  xai/gemini/exa web rows today.

## Wire research (from shipped web-search executors, probe-verified 2026-08-20/21)

### xai describe wire

Mirror src/web-search/xai-executor.ts: POST `https://api.x.ai/v1/responses`
(origin pinned; provider baseUrl honored only on same origin), stored OAuth
bearer via `getValidAccessToken`, `redirect: "manual"`. Body for describe:

```json
{
  "model": "<settings.model>",
  "instructions": "<describe instruction>",
  "input": [{ "role": "user", "content": [
    { "type": "input_text", "text": "<context>" },
    { "type": "input_image", "image_url": "<data: or https: url>" }
  ]}],
  "reasoning": { "effort": "<low|medium|high>" },
  "stream": true
}
```

SSE reduction: reuse the `response.output_text.delta` / `.done` handling
shape from parseXaiResponsesSSE, without the citation/source machinery.
Grok Responses accepts `input_image` with data URLs (same shape the OpenAI
forward describer already posts — describe.ts builds input_image parts).

### Gemini (Antigravity CCA) describe wire

Mirror src/web-search/gemini-executor.ts: POST
`{registry base}/v1internal:generateContent`, `ANTIGRAVITY_REQUEST_UA`,
token + projectId via `getValidAccessTokenSnapshot`, envelope:

```json
{
  "model": "<wireModelId from resolveAntigravityEffortWireModel>",
  "userAgent": "antigravity", "requestType": "agent",
  "project": "<projectId>", "requestId": "agent-<uuid>",
  "request": {
    "systemInstruction": { "role": "user", "parts": [{ "text": "<describe instruction>" }] },
    "contents": [{ "role": "user", "parts": [
      { "text": "<context>" },
      { "inlineData": { "mimeType": "<mime>", "data": "<base64>" } }
    ]}]
  }
}
```

inlineData shape matches src/adapters/google.ts:972/:1233. Response mapping:
`candidates[0].content.parts[].text` join (mapCcaGroundedResponse shape,
minus grounding). https: image URLs cannot be inlined without proxy-side
fetch — REJECTED for gemini describe (data: URLs only, documented delta,
same stance as anthropic-describe's stricter base64 rule).

## Metadata facts

- xai vendor table: bare grok-2/grok-3/grok-4 are `text`-only; grok-4.x
  fast/4.3/4.5/4.6 and grok-2-vision are `text,image`.
- No bare model id collides across the four vendor tables (openai 48,
  anthropic 26, xai 32, google 43; collision scan 2026-08-21: zero) — the
  "vendor tables never disagree" premise of visionDescriberIsProvablyBlind
  survives widening to four families.

## Audit deltas folded into this unit (sol-medium audit, 2026-08-21)

- **Blocker A**: `BASELINE_VISION_MODELS` is a TOTAL
  `Record<VisionSidecarBackend, string>`; widening the union without a
  decision breaks typecheck. Decision → doc 170: baselines become
  descriptor-owned (only openai/anthropic carry one).
- **Blocker B**: `visionDescriberIsProvablyBlind` collapses non-anthropic
  hints to openai and probes two families; a bare grok id absent from
  candidates would slip the gate. Decision → doc 170: probe all four vendor
  families.
- Empty-auth fallback stays `["openai","anthropic"]` — never offer
  xai/gemini unauthenticated.
- GUI shared `SidecarBackend` must split (web-search has exa; vision does
  not).
- New executors: `sidecarEnter("vision")` (NOT "web-search"),
  `signalWithTimeout` + `cancelBodyOnAbort`, `redactSecretString` on all
  error paths, timeout-bounds.ts as single authority.

