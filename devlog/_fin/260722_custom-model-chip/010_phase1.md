# Phase 1: 백엔드 — types + CRUD API + catalog merge

> 리뷰어 Erdos FAIL 2건 반영 완료 (routedSlug dedup + provider validation)

## 1. src/types.ts 변경

### 1.1 OcxCustomModel 인터페이스 추가

`OcxConfig` 인터페이스 앞에 새 인터페이스 추가:

```ts
/** 사용자가 대시보드에서 직접 추가한 커스텀 모델 정의. */
export interface OcxCustomModel {
  /** 고유 ID (crypto.randomUUID()) */
  id: string;
  /** 프로바이더 키 (기존 providers[name]) */
  provider: string;
  /** 모델 슬러그 (프로바이더 접두사 없는 bare id) */
  modelId: string;
  /** 인간 가독 표시명 (선택, 슬래시 불가) */
  displayName?: string;
  /** 컨텍스트 윈도우 (토큰) */
  contextWindow?: number;
  /** 입력 모달리티 (선택, 기본 ["text"]) */
  inputModalities?: string[];
  /** 추가 시각 (ISO 8601) */
  addedAt?: string;
}
```

### 1.2 OcxConfig에 필드 추가

`disabledModels?: string[];` 뒤에:

```ts
/** 사용자가 대시보드에서 직접 추가한 커스텀 모델 목록. */
customModels?: OcxCustomModel[];
```

## 2. src/server/management-api.ts 변경

### 2.1 import 추가

파일 상단에 `crypto` import:
```ts
import { randomUUID } from "node:crypto";
```

기존 config import에 `isValidProviderName`, `hasOwnProvider` 추가:
```ts
import {
  // ... 기존 imports
  isValidProviderName,
  hasOwnProvider,
} from "../config";
```

### 2.2 GET /api/models 응답에 커스텀 모델 병합

기존 `return jsonResponse([...native, ...models.map(...)])` 를:

```ts
const customModels = (config.customModels ?? []).map(cm => {
  const namespaced = routedSlug(cm.provider, cm.modelId);
  return {
    provider: cm.provider,
    id: cm.modelId,
    namespaced,
    disabled: [...disabled].some(stored => slugEquals(stored, cm.provider, cm.modelId)),
    custom: true,
    customId: cm.id,
    displayName: cm.displayName,
    ...(cm.contextWindow ? { contextWindow: cm.contextWindow } : {}),
    ...(cm.inputModalities ? { inputModalities: cm.inputModalities } : {}),
  };
});
// 중복 제거: 커스텀 모델과 같은 namespaced를 가진 라우팅 모델은 커스텀 메타데이터 우선
const customNamespaced = new Set(customModels.map(c => c.namespaced));
const dedupedRouted = models.map(m => {
  const namespaced = routedSlug(m.provider, m.id);
  if (customNamespaced.has(namespaced)) return null;
  const contextCap = providerContextCap(config, m.provider);
  return {
    ...m,
    namespaced,
    disabled: [...disabled].some(stored => slugEquals(stored, m.provider, m.id)),
    ...(contextCap !== undefined ? { contextCap, contextCapped: m.contextCapped === true } : {}),
  };
}).filter(Boolean);
return jsonResponse([...native, ...dedupedRouted, ...customModels]);
```

### 2.3 CRUD 엔드포인트 4개

`/api/disabled-models` PUT 핸들러 뒤에 추가:

#### GET /api/custom-models
```ts
if (url.pathname === "/api/custom-models" && req.method === "GET") {
  return jsonResponse(config.customModels ?? []);
}
```

#### POST /api/custom-models
```ts
if (url.pathname === "/api/custom-models" && req.method === "POST") {
  let body: { provider?: unknown; modelId?: unknown; displayName?: unknown; contextWindow?: unknown; inputModalities?: unknown };
  try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
  if (!provider || !modelId) return jsonResponse({ error: "provider and modelId are required" }, 400);
  if (modelId.includes("/")) return jsonResponse({ error: "modelId must not contain /" }, 400);
  // 프로바이더 검증: 형식 + 존재 여부
  if (!isValidProviderName(provider)) return jsonResponse({ error: "invalid provider name" }, 400);
  if (!hasOwnProvider(config.providers, provider)) return jsonResponse({ error: "provider not configured" }, 404);
  const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : undefined;
  if (displayName?.includes("/")) return jsonResponse({ error: "displayName must not contain /" }, 400);
  const contextWindow = typeof body.contextWindow === "number" && body.contextWindow > 0 ? Math.floor(body.contextWindow) : undefined;
  const inputModalities = Array.isArray(body.inputModalities) ? body.inputModalities.filter((m): m is string => typeof m === "string") : undefined;
  // 중복 체크
  const existing = config.customModels ?? [];
  if (existing.some(cm => cm.provider === provider && cm.modelId === modelId)) {
    return jsonResponse({ error: "duplicate model" }, 409);
  }
  const entry: OcxCustomModel = {
    id: randomUUID(),
    provider,
    modelId,
    ...(displayName ? { displayName } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(inputModalities && inputModalities.length > 0 ? { inputModalities } : {}),
    addedAt: new Date().toISOString(),
  };
  config.customModels = [...existing, entry];
  const { saveConfig: save } = await import("../config");
  save(config);
  await refreshCodexCatalogBestEffort();
  return jsonResponse(entry, 201);
}
```

#### PUT /api/custom-models/:id
```ts
const customPutMatch = url.pathname.match(/^\/api\/custom-models\/([^/]+)$/);
if (customPutMatch && req.method === "PUT") {
  const id = decodeURIComponent(customPutMatch[1]);
  let body: { displayName?: unknown; contextWindow?: unknown; inputModalities?: unknown; modelId?: unknown };
  try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
  const list = config.customModels ?? [];
  const idx = list.findIndex(cm => cm.id === id);
  if (idx === -1) return jsonResponse({ error: "not found" }, 404);
  const cm = { ...list[idx] };
  if (typeof body.modelId === "string" && body.modelId.trim()) {
    if (body.modelId.includes("/")) return jsonResponse({ error: "modelId must not contain /" }, 400);
    cm.modelId = body.modelId.trim();
  }
  if (body.displayName !== undefined) {
    const dn = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (dn.includes("/")) return jsonResponse({ error: "displayName must not contain /" }, 400);
    cm.displayName = dn || undefined;
  }
  if (body.contextWindow !== undefined) {
    cm.contextWindow = typeof body.contextWindow === "number" && body.contextWindow > 0 ? Math.floor(body.contextWindow) : undefined;
  }
  if (body.inputModalities !== undefined) {
    cm.inputModalities = Array.isArray(body.inputModalities) ? body.inputModalities.filter((m): m is string => typeof m === "string") : undefined;
  }
  list[idx] = cm;
  config.customModels = list;
  const { saveConfig: save } = await import("../config");
  save(config);
  await refreshCodexCatalogBestEffort();
  return jsonResponse(cm);
}
```

#### DELETE /api/custom-models/:id
```ts
const customDelMatch = url.pathname.match(/^\/api\/custom-models\/([^/]+)$/);
if (customDelMatch && req.method === "DELETE") {
  const id = decodeURIComponent(customDelMatch[1]);
  const list = config.customModels ?? [];
  const idx = list.findIndex(cm => cm.id === id);
  if (idx === -1) return jsonResponse({ error: "not found" }, 404);
  list.splice(idx, 1);
  config.customModels = list.length > 0 ? list : undefined;
  const { saveConfig: save } = await import("../config");
  save(config);
  await refreshCodexCatalogBestEffort();
  return jsonResponse({ ok: true });
}
```

## 3. src/codex/catalog.ts 변경

### 3.1 fetchAllModels()에 커스텀 모델 포함

`fetchAllModels` 함수의 반환 배열에 커스텀 모델을 추가:

```ts
// fetchAllModels 내부, 라우팅 모델 수집 후:
const customModels = (config.customModels ?? []).map(cm => ({
  id: cm.modelId,
  provider: cm.provider,
  ...(cm.contextWindow ? { contextWindow: cm.contextWindow } : {}),
  ...(cm.inputModalities ? { inputModalities: cm.inputModalities } : {}),
}));
// 기존 라우팅 모델과 합치되 중복 제거 (커스텀 우선, routedSlug 기준)
const customKeys = new Set(customModels.map(c => routedSlug(c.provider, c.id)));
const deduped = routed.filter(m => !customKeys.has(routedSlug(m.provider, m.id)));
return [...deduped, ...customModels];
```

## 4. 검증

- `bun test --isolate tests` — 기존 테스트 회귀 없음
- `curl http://localhost:10100/api/custom-models` — 빈 배열 반환
- `curl -X POST ... -d '{"provider":"test","modelId":"my-model"}'` — 404 (provider not configured)
- `curl -X POST ... -d '{"provider":"alibaba-token-plan-intl","modelId":"my-model"}'` — 201 + entry
- `curl http://localhost:10100/api/models | jq '.[] | select(.custom)'` — 커스텀 모델 존재

## 5. 리뷰어 결함 수정 이력

| # | 결함 | 수정 |
|---|------|------|
| 1 | dedup에 raw template string 사용 → routedSlug()와 불일치 | `routedSlug(cm.provider, cm.modelId)` 사용 |
| 2 | provider 검증 없음 → 슬래시/제어문자 허용 | `isValidProviderName()` + `hasOwnProvider()` 추가 |
