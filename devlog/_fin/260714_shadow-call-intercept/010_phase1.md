# 010 — Phase 1: Full Implementation

Single-phase implementation — all changes ship together.

## Server Core (types.ts + responses.ts)

### src/types.ts
- ADD: `OcxShadowCallInterceptConfig` interface after line 381
- ADD: `shadowCallIntercept?: OcxShadowCallInterceptConfig` to `OcxConfig`

### src/server/responses.ts
- INSERT between line 462 (logCtx.requestedModel) and line 469 (let route):
  - Check config.shadowCallIntercept?.enabled
  - If enabled and parsed.modelId.startsWith("gpt-5.4-mini"), rewrite:
    - parsed.modelId = config.shadowCallIntercept.model
    - parsed._rawBody.model = same
    - parsed.options.reasoning = "low"
    - parsed._rawBody.reasoning = { effort: "low" }
    - logCtx.shadowCallRewrittenFrom = original model id

## Management API (management-api.ts)

- ADD GET /api/shadow-call-settings (after line ~270, sidecar-settings PUT)
- ADD PUT /api/shadow-call-settings (same location)
- Follow exact pattern of sidecar-settings handlers

## GUI (Dashboard.tsx + Models.tsx)

### Dashboard.tsx
- ADD ShadowCallData interface
- ADD state: shadowCall, setShadowCall
- ADD fetch /api/shadow-call-settings in useEffect
- ADD saveShadowCall function (PUT)
- ADD panel below vision sidecar panel (line ~815)

### Models.tsx
- ADD similar shadow call section below picker order description

## i18n (ko.ts + en.ts)

- ADD dash.shadowCallIntercept, dash.shadowCallInterceptHint, dash.shadowCallWarning
- ADD dash.shadowCallOriginal, models.shadowCallIntercept, models.shadowCallInterceptHint

## Docs

- NEW docs/shadow-call-intercept.md
