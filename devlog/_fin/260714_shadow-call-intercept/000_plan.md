# 000 — Plan: Shadow Call Intercept

## Objective

Codex 앱이 내부적으로 보내는 gpt-5.4-mini 헬퍼 호출(제목 생성, 커밋 메시지 등)을
opencodex 프록시에서 가로채 사용자 지정 모델로 리라이트. effort는 low로 고정.
옵트인 방식(기본 비활성)으로 경고 표시.

## Context

- GitHub issues: #26288, #28741, #28821, #24208
- Codex 앱은 title generation, commit message에 gpt-5.4-mini (reasoningEffort=low) 하드코딩
- codex-rs에 설정 포인트 없음 — Electron 앱 클라이언트에서 직접 호출
- opencodex 프록시를 경유하는 것이 확인됨 (로그에 gpt-5.4-mini-2026-03-17 표시)

## Scope

- IN: config type, request intercept, management API, dashboard UI, models page UI, i18n, docs
- OUT: catalog changes, upstream codex-rs changes

## File Change Map

| File | Action | Description |
|------|--------|-------------|
| src/types.ts | MODIFY | Add OcxShadowCallInterceptConfig + shadowCallIntercept field to OcxConfig |
| src/server/responses.ts | MODIFY | Intercept gpt-5.4-mini before routeModel, rewrite model + force effort=low |
| src/server/management-api.ts | MODIFY | Add GET/PUT /api/shadow-call-settings endpoint |
| gui/src/pages/Dashboard.tsx | MODIFY | Shadow call intercept panel below sidecar panels |
| gui/src/pages/Models.tsx | MODIFY | Shadow call section below picker order |
| gui/src/i18n/ko.ts | MODIFY | Korean i18n strings |
| gui/src/i18n/en.ts | MODIFY | English i18n strings |
| docs/shadow-call-intercept.md | NEW | Feature documentation |

## Design

### Config shape (types.ts line ~381, after disabledModels)

```ts
interface OcxShadowCallInterceptConfig {
  enabled?: boolean;  // default false (opt-in)
  model?: string;     // replacement model from active routed models
}
// In OcxConfig:
shadowCallIntercept?: OcxShadowCallInterceptConfig;
```

### Intercept point (responses.ts line ~462-469)

After parseRequest/logCtx.requestedModel, before routeModel call:
- Match parsed.modelId.startsWith("gpt-5.4-mini")
- Rewrite modelId + _rawBody.model to configured replacement
- Force reasoning effort to "low" in both parsed.options and _rawBody
- Log shadowCallRewrittenFrom in request log context

### API (management-api.ts)

Follow existing sidecar-settings pattern (lines 197-270):
- GET /api/shadow-call-settings returns { enabled, model }
- PUT /api/shadow-call-settings accepts { enabled?, model? }, calls saveConfig

### GUI

Follow sidecar panel pattern in Dashboard.tsx (lines 753-815):
- Panel with toggle switch (enabled) + warning banner
- Info tooltip explaining what shadow calls are used for
- Model dropdown from active models list
- Read-only display of original model (gpt-5.4-mini-2026-03-17 · low)

## Accept Criteria

1. gpt-5.4-mini* requests rewritten when enabled=true
2. Effort forced to low for intercepted calls
3. Default off — no behavior change when unconfigured
4. Dashboard + Models page UI with toggle/dropdown
5. Warning banner on activation
6. Request log shows shadowCallRewrittenFrom
7. Docs page created
