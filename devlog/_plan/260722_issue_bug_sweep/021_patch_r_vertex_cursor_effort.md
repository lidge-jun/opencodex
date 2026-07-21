# 021 — 패치 계획 R: Vertex 모델 가시성 + Cursor/콤보 effort capability (#202, #179)

- 소스 RCA: `005_rca_r_registry_capability.md` (리뷰어 검증·정정 완료)
- Cursor 라이브 조사 추적: `008_research_cursor_effort_metadata.md` (본 구현 단위와 분리)
- 위험도: 낮음~중간 (카탈로그 진단 + 콤보 wire 계약)
- 선행 조건: 없음. R-a(Vertex)와 R-b(effort)는 독립 커밋 가능하다.

## 결정

- R-a PRIMARY는 사용자 설정 `providers.<name>.models` + `liveModels: false`이다. 이 계약은 이미
  `docs-site/src/content/docs/reference/configuration.md:152-153,234-264`와
  `docs-site/src/content/docs/ko/reference/configuration.md:140-141,222-253`에 명시되어 있으므로
  문서 파일을 추가 수정하지 않는다.
- `src/providers/registry.ts:649`의 `google-vertex`에는 이번 패치에서 정적 `models`나
  `liveModels: false`를 넣지 않는다. 정적 seed는 정확한 모델 ID 열거, 날짜가 찍힌 Vertex 1차
  증거, 추가·갱신·제거 lifecycle 정책이 모두 마련된 후 별도 패치로만 승격한다.
- Cursor 라이브 모델 확인은 `008_research_cursor_effort_metadata.md`가 소유한다. 본 패치는 현재
  코드 두 SOT가 서로 모순되지 않게 만드는 기계적 불변식만 구현한다.

## 파일 변경 맵

| 파일 | 작업 | 내용 |
|------|------|------|
| `src/codex/catalog.ts` | MODIFY | `/models` non-2xx/예외에 provider·URL class·fallback 경고 추가 |
| `tests/vertex-catalog.test.ts` | NEW | Vertex 사용자 설정 모델 노출과 discovery 실패 진단 회귀 |
| `src/combos/types.ts` | MODIFY | 정규화된 `defaultEffort`를 nullable로 변경하고 미지정 값을 `null`로 보존 |
| `src/combos/request.ts` | MODIFY | 대상 effort capability를 입력받아 `[]`/unknown이면 기본 effort 주입 생략 |
| `src/server/responses.ts` | MODIFY | registry-merged target의 effort ladder를 해석해 콤보 request builder에 전달 |
| `gui/src/combo-workspace-data.ts` | MODIFY | GUI item/draft/PUT 타입과 정규화를 nullable로 변경 |
| `gui/src/components/ComboWorkspace.tsx` | MODIFY | `None (target default)` 선택지와 null change 처리 |
| `tests/combos.test.ts` | MODIFY | null 정규화 및 capability별 request 주입 회귀 |
| `tests/combo-workspace-data.test.ts` | MODIFY | GUI null parse/draft/PUT 왕복 회귀 |
| `src/adapters/cursor/discovery.ts` | MODIFY | effort-map 엔트리와 metadata를 정합화하고 generic ladder fallback 제거 |
| `tests/cursor-discovery.test.ts` | MODIFY | 명시 tier가 없는 reasoning metadata의 fail-closed 회귀 |
| `tests/cursor-static-catalog.test.ts` | MODIFY | `supportsReasoningEffort` ↔ effort-map 양방향 불변식 |
| `tests/cursor-effort-suffix.test.ts` | MODIFY | `grok-4.5-fast`의 코드상 tier suffix 회귀 유지 |

## R-a — Vertex 사용자 구성 모델 + 실패 진단

### Diff R-a1 — `src/codex/catalog.ts:1286-1293,1344-1347`

Before (현행 실측):

```ts
  const { url, headers } = buildModelsRequest(prov, apiKey, name);
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      markModelsFetchFailure(name);
      const stale = getStaleCached(name);
      return stale ? applyConfigHintsToCachedModels(name, prov, stale, contextCap) : configured;
    }
```

```ts
  } catch {
    markModelsFetchFailure(name);
    const stale = getStaleCached(name);
    return stale ? applyConfigHintsToCachedModels(name, prov, stale, contextCap) : configured;
  }
```

After:

```ts
  const { url, headers } = buildModelsRequest(prov, apiKey, name);
  const urlClass = new URL(url).hostname.endsWith("aiplatform.googleapis.com")
    ? "vertex-aiplatform"
    : "provider-models";
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      markModelsFetchFailure(name);
      const stale = getStaleCached(name);
      const fallback = stale ? "stale" : "configured";
      console.warn(
        `[opencodex] Provider model discovery for "${name}" failed with HTTP ${res.status} [urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return stale ? applyConfigHintsToCachedModels(name, prov, stale, contextCap) : configured;
    }
```

```ts
  } catch (error) {
    markModelsFetchFailure(name);
    const stale = getStaleCached(name);
    const fallback = stale ? "stale" : "configured";
    console.warn(
      `[opencodex] Provider model discovery for "${name}" threw ${error instanceof Error ? error.name : "unknown"} [urlClass=${urlClass}, fallback=${fallback}].`,
    );
    return stale ? applyConfigHintsToCachedModels(name, prov, stale, contextCap) : configured;
  }
```

로그에는 전체 URL, query, token, 헤더를 넣지 않는다. `urlClass`만 남겨 credential/프로젝트 경로
유출을 막는다. fallback은 실제 반환 분기와 동일한 `stale` 또는 `configured`만 기록한다.

### Diff R-a2 — `tests/vertex-catalog.test.ts` 신규

Before: 파일 없음.

After:

```ts
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
let warn: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  warn?.mockRestore();
  warn = undefined;
});

function vertexProvider(name: string): OcxConfig {
  return {
    providers: {
      [name]: {
        adapter: "google" as const,
        googleMode: "vertex" as const,
        baseUrl: "https://aiplatform.googleapis.com",
        apiKey: "test-key",
        models: ["publisher-model-a"],
      },
    },
  };
}

describe("Vertex catalog configuration", () => {
  test("models + liveModels false exposes configured Vertex ids without discovery", async () => {
    globalThis.fetch = (() => { throw new Error("must not fetch"); }) as typeof fetch;
    const config = vertexProvider("vertex-static");
    config.providers["vertex-static"]!.liveModels = false;
    const rows = await gatherRoutedModels(config);
    expect(rows).toContainEqual(expect.objectContaining({
      provider: "vertex-static",
      id: "publisher-model-a",
    }));
  });

  test("non-2xx diagnostic identifies provider, URL class, and configured fallback", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (() => Promise.resolve(new Response("missing", { status: 404 }))) as typeof fetch;
    await gatherRoutedModels(vertexProvider("vertex-http"));
    expect(warn.mock.calls.flat().join(" ")).toContain(
      'Provider model discovery for "vertex-http" failed with HTTP 404 [urlClass=vertex-aiplatform, fallback=configured]',
    );
  });

  test("exception diagnostic identifies provider, URL class, and configured fallback", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (() => { throw new TypeError("offline"); }) as typeof fetch;
    await gatherRoutedModels(vertexProvider("vertex-throw"));
    expect(warn.mock.calls.flat().join(" ")).toContain(
      'Provider model discovery for "vertex-throw" threw TypeError [urlClass=vertex-aiplatform, fallback=configured]',
    );
  });
});
```

각 실패 케이스가 서로 다른 provider id를 사용하고 `afterEach`가 전체 cache를 비우므로 cooldown이
다음 케이스를 가리지 않는다. `/v1/models`는 `gatherRoutedModels()`의 동일 결과를 소비하는 서버
표면이므로 이 단위에서는 catalog choke point를 직접 검증한다.

## R-b — 콤보 effort null + capability-aware 주입

### Diff R-b1 — `src/combos/types.ts:18-23,163-169`

Before (현행 실측):

```ts
export interface NormalizedComboConfig {
  strategy: OcxComboStrategy;
  stickyLimit: number;
  defaultEffort: OcxComboDefaultEffort;
  targets: Array<Required<OcxComboTarget>>;
}
```

```ts
export function normalizeComboConfig(raw: OcxComboConfig): NormalizedComboConfig {
  return {
    strategy: raw.strategy ?? "failover",
    stickyLimit: raw.stickyLimit ?? 1,
    defaultEffort: raw.defaultEffort ?? COMBO_DEFAULT_EFFORT,
```

After:

```ts
export interface NormalizedComboConfig {
  strategy: OcxComboStrategy;
  stickyLimit: number;
  defaultEffort: OcxComboDefaultEffort | null;
  targets: Array<Required<OcxComboTarget>>;
}
```

```ts
export function normalizeComboConfig(raw: OcxComboConfig): NormalizedComboConfig {
  return {
    strategy: raw.strategy ?? "failover",
    stickyLimit: raw.stickyLimit ?? 1,
    defaultEffort: raw.defaultEffort ?? null,
```

같은 계약을 `comboDefaultEffort()`에도 적용해 미지정 값을 `medium`으로 복원하지 않고 `null`로
반환한다. `COMBO_DEFAULT_EFFORT` export는 남은 참조를 제거한 뒤 미사용이면 삭제한다.

### Diff R-b2 — `src/combos/request.ts:11-28`

Before (현행 실측):

```ts
export function concreteComboRequestBody(
  body: unknown,
  target: Pick<OcxComboTarget, "provider" | "model">,
  defaultEffort: OcxComboDefaultEffort | null,
): Record<string, unknown> {
  const clone = structuredClone(body) as Record<string, unknown>;
  clone.model = `${target.provider}/${target.model}`;
  if (!defaultEffort) return clone;
```

After:

```ts
const warnedUnsupportedDefaults = new Set<string>();

export function concreteComboRequestBody(
  body: unknown,
  target: Pick<OcxComboTarget, "provider" | "model">,
  defaultEffort: OcxComboDefaultEffort | null,
  targetReasoningEfforts: readonly string[] | undefined,
): Record<string, unknown> {
  const clone = structuredClone(body) as Record<string, unknown>;
  clone.model = `${target.provider}/${target.model}`;
  if (!defaultEffort) return clone;
  if (!targetReasoningEfforts?.includes(defaultEffort)) {
    const key = `${target.provider}/${target.model}:${defaultEffort}`;
    if (!warnedUnsupportedDefaults.has(key)) {
      warnedUnsupportedDefaults.add(key);
      console.debug("[opencodex] combo default effort omitted", {
        provider: target.provider,
        model: target.model,
        requestedEffort: defaultEffort,
        capability: targetReasoningEfforts === undefined ? "unknown" : "unsupported",
      });
    }
    return clone;
  }
```

`[]`와 unknown(`undefined`)은 모두 주입을 생략한다. 지원 목록에 요청 effort가 없을 때도 임의
클램프하지 않고 생략한다. 사용자가 request에 직접 보낸 `reasoning.effort`는 기존처럼 보존하며,
이 guard는 콤보의 `defaultEffort`를 새로 주입하는 경우에만 적용한다. 테스트 격리를 위해
`resetComboEffortWarningStateForTests()`를 export한다.

### Diff R-b3 — `src/server/responses.ts:621-629`

Before (현행 실측):

```ts
    const childBody = concreteComboRequestBody(
      rawBody,
      pick.target,
      comboDefaultEffort(config, comboId),
    );
```

After:

```ts
    const targetRoute = routeModel(config, `${pick.target.provider}/${pick.target.model}`);
    const childBody = concreteComboRequestBody(
      rawBody,
      pick.target,
      comboDefaultEffort(config, comboId),
      supportedLadderFor({ provider: targetRoute.provider, modelId: targetRoute.modelId }),
    );
```

`routeModel()`의 registry-merged provider를 사용해 저장 config에 없는 registry capability도
반영한다. `supportedLadderFor()`는 `src/server/effort-policy.ts:101-115`의 기존 해석기를 import해
새 capability 해석기를 만들지 않는다.

### Diff R-b4 — `gui/src/combo-workspace-data.ts:6-10,18-25,59-63,152-169,232-239`

Before (현행 실측):

```ts
export type ComboEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export const COMBO_DEFAULT_EFFORT: ComboEffort = "medium";
// ...
  defaultEffort: ComboEffort;
// ...
export function normalizeDefaultEffort(raw: unknown): ComboEffort {
  return typeof raw === "string" && (COMBO_EFFORTS as string[]).includes(raw)
    ? (raw as ComboEffort)
    : COMBO_DEFAULT_EFFORT;
}
```

After:

```ts
export type ComboEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export const COMBO_EFFORTS: ComboEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
// ...
  defaultEffort: ComboEffort | null;
// ...
export function normalizeDefaultEffort(raw: unknown): ComboEffort | null {
  return typeof raw === "string" && (COMBO_EFFORTS as string[]).includes(raw)
    ? (raw as ComboEffort)
    : null;
}
```

`toPutBody()`의 `defaultEffort`도 `ComboEffort | null`, `emptyDraft()`는
`defaultEffort: null`로 바꾼다. 따라서 parse → edit → PUT과 신규 draft 모두 null을 보존한다.

### Diff R-b5 — `gui/src/components/ComboWorkspace.tsx:122-146`

Before (현행 실측):

```tsx
}: {
  id: string;
  value: ComboEffort;
  onChange: (next: ComboEffort) => void;
  disabled?: boolean;
}) {
// ...
      onChange={(e) => onChange(e.target.value as ComboEffort)}
    >
      {COMBO_EFFORTS.map((effort) => (
```

After:

```tsx
}: {
  id: string;
  value: ComboEffort | null;
  onChange: (next: ComboEffort | null) => void;
  disabled?: boolean;
}) {
// ...
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value as ComboEffort)}
    >
      <option value="">None (target default)</option>
      {COMBO_EFFORTS.map((effort) => (
```

### Diff R-b6 — `tests/combos.test.ts:162-199,390-408`

Before: request builder 테스트는 capability 인자가 없고, 미지정 combo effort를 `medium`으로 기대한다.

After 핵심 케이스:

```ts
expect(concreteComboRequestBody(raw, target, "high", ["low", "high"]).reasoning)
  .toEqual({ effort: "high" });
expect(concreteComboRequestBody(raw, target, "high", []).reasoning).toBeUndefined();
expect(concreteComboRequestBody(raw, target, "high", undefined).reasoning).toBeUndefined();
expect(concreteComboRequestBody(raw, target, "high", ["low", "medium"]).reasoning)
  .toBeUndefined();
expect(normalizeComboConfig({ targets: [{ provider: "a", model: "m1" }] }).defaultEffort)
  .toBeNull();
expect(comboDefaultEffort(baseConfig(), "free")).toBeNull();
```

동일 warning key를 두 번 호출해 `console.debug` 1회만 발생하는 케이스와, client-owned
`reasoning.effort`가 capability와 무관하게 보존되는 기존 케이스도 유지한다.

### Diff R-b7 — `tests/combo-workspace-data.test.ts`

Before: GUI 모델은 항상 문자열 effort로 복구된다.

After 핵심 케이스:

```ts
expect(parseComboList({ combos: [{ id: "free", targets: [] }] })[0]?.defaultEffort).toBeNull();
expect(emptyDraft().defaultEffort).toBeNull();
expect(toPutBody({ ...emptyDraft("free"), targets: [{ provider: "a", model: "m1" }] })
  .combo.defaultEffort).toBeNull();
```

## R-c — Cursor metadata 불변식(라이브 조사와 분리)

### Diff R-c1 — `src/adapters/cursor/discovery.ts:167-168,191-200`

Before (현행 실측):

```ts
  { id: "grok-4.5", contextWindow: 500_000, supportsReasoningEffort: true },
  { id: "grok-4.5-fast", contextWindow: 500_000 },
```

```ts
      model.supportsReasoningEffort === true
        ? cursorModelEffortLadder(model.id) ?? [...CURSOR_REASONING_EFFORTS]
        : [],
```

After:

```ts
  { id: "grok-4.5", contextWindow: 500_000, supportsReasoningEffort: true },
  { id: "grok-4.5-fast", contextWindow: 500_000, supportsReasoningEffort: true },
```

```ts
      model.supportsReasoningEffort === true
        ? cursorModelEffortLadder(model.id) ?? []
        : [],
```

현재 `src/adapters/cursor/effort-map.ts:29-32`에는 2026-07-09 GetUsableModels 근거와
`grok-4.5-fast`의 명시 tier가 이미 있으므로 metadata 쪽 누락을 보정한다. 향후 라이브 재검증으로
tier를 제거한다면 같은 커밋에서 flag도 제거해야 하며, 그 판단은 008 연구 노트의 산출물이다.

### Diff R-c2 — `tests/cursor-static-catalog.test.ts:39-51`

Before: `supportsReasoningEffort: true`인 모델에 tier가 있는지 한 방향만 검사한다.

```ts
const reasoningEffortModels = CURSOR_STATIC_MODELS.filter(
  model => model.supportsReasoningEffort === true,
);
for (const model of reasoningEffortModels) {
  expect(cursorModelHasEffortTiers(model.id)).toBe(true);
}
```

After:

```ts
for (const model of CURSOR_STATIC_MODELS) {
  expect(
    model.supportsReasoningEffort === true,
    `Cursor model ${model.id} metadata and effort-map must agree`,
  ).toBe(cursorModelHasEffortTiers(model.id));
}
```

이 equality가 `supportsReasoningEffort: true` → map entry와 map entry → flag를 동시에 강제한다.
`tests/cursor-discovery.test.ts`에는 명시 tier가 없는 임의 모델을 넣었을 때 fallback ladder 대신
`[]`가 나오는 케이스를 추가하고, `tests/cursor-effort-suffix.test.ts`에는
`grok-4.5-fast`의 medium/high/xhigh literal suffix 케이스를 유지한다.

## 명시적 비채택 / 후속 게이트

- `src/providers/registry.ts`에 Vertex static seed 추가: 정확한 ID + 날짜가 있는 Vertex 1차 증거 +
  lifecycle 정책이 없으므로 보류.
- Vertex publisher discovery 구현: location/project/publisher 시맨틱이 필요한 별도 작업이며 본 패치
  범위 밖.
- Cursor.com 라이브 확인 결과에 따라 코드를 선택하는 조건부 구현: `008_research_cursor_effort_metadata.md`
  로 분리. 021 구현은 현재 코드 근거의 불변식만 따른다.
- 지원하지 않는 콤보 effort를 임의 clamp: target default와 다른 요청을 만들 수 있어 생략 정책 채택.

## 수용 기준 / 검증

- [ ] `bun test tests/vertex-catalog.test.ts`
- [ ] `bun test tests/combos.test.ts`
- [ ] `bun test tests/combo-workspace-data.test.ts`
- [ ] `bun test tests/cursor-effort-suffix.test.ts`
- [ ] `bun test tests/cursor-discovery.test.ts`
- [ ] `bun test tests/cursor-static-catalog.test.ts`
- [ ] `bun run typecheck`
