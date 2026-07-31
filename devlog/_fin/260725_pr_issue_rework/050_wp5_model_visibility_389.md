# WP5 — PR #389 최종 model visibility 통합

## A-gate 반영 — `Models.tsx` 충돌 해소 계약 (CANONICAL)

독립 감사가 `VERDICT: FAIL`, blocker 3건을 냈다. 핵심은 **이 문서가 실제 두 conflict를 실행
가능하게 규정하지 않았다**는 것이다. 아래가 canonical 해소 계약이며, 문서 뒷부분의
`renderProviderGroup` snippet은 **비규범 참고자료**로만 읽는다.

### 실측된 사실

- `git apply --3way --check`는 exit 0을 반환하지만 `Models.tsx`에 "with conflicts"를 명시한다.
  실제 3-way 합성은 **conflict marker 2개, exit 2**다.
- 나머지 14개 파일은 3-way clean.
- 충돌 원인: PR patch base의 **구형 인라인 GUI**와 현재 dev의 **workspace 추출 구조**가
  같은 원본 범위를 서로 다르게 수정했다. dev에는 Classic 뷰 철거(`fa1af1b2`)와 레이아웃
  복원(`9b37ef5a`, `c258b31b`)이 들어가 있다.
- GitHub merge 상태도 `CONFLICTING`이다.

### conflict 1 — controls 영역

| side | 내용 |
|---|---|
| current (`Models.tsx:767` 부근) | `controlsBlock`의 `models-control-top-row`, Tooltip 기반 Shadow Call UI |
| incoming | 구형 `page-head` + subtitle + status 블록에 `effectiveVisibleCount` 적용 |

**해소: current side를 전부 유지하고 incoming `page-head`는 폐기한다.**
대신 PR이 의도한 count 반영을 현재 구조에 이식한다.

- workspace rail 전체 count(`Models.tsx:1193` 부근)를 `effectiveVisibleCount`로 바꾼다.
- provider별 rail count(`:1197` 부근)도 `modelVisible()` 기준으로 계산한다.

### conflict 2 — group 렌더링 영역

| side | 내용 |
|---|---|
| current (`:965`, `:1216` 부근) | `collapseControls`, `emptyStateBlock`, `visibleGroups.map(group => renderGroup(group))` |
| incoming | 구형 인라인 `groups.map(...)` 전체 |

**해소: current side를 유지하고 incoming 인라인 map은 폐기한다.**
PR의 visibility 로직만 현재 `renderGroup()`(`:557` 부근)으로 **수동 이식**한다:

- provider-local `isVisible`
- active count
- visible-first stable sort
- `allOn` / `allOff`
- target 생성과 `applyVisibility`
- row Switch, 색상, 취소선, tooltip status

### 빈 provider 규칙 (blocker 2)

PR head는 bulk controls를 `rows.length > 0`일 때만 렌더링한다. 반면 **현재 workspace는 버튼을
항상 렌더링한다**(`:621` 부근). 따라서 `rows.length > 0 && rows.every(...)`만 이식하면 빈
provider에서 두 버튼이 활성화되고 **빈 targets PUT이 400으로 실패한다.**

계약: controls를 `rows.length > 0`으로 감싸거나 `rows.length === 0`일 때 두 버튼을 명시적으로
disable한다. 빈 provider GUI 회귀 테스트를 유지한다.

### 3-way가 올바르게 합성하므로 보존할 부분

import, `selectedModels`, generation refs, atomic load/action, `setSelectedProvider` stale
cleanup. 특히 **`nextGroups` 기반 cleanup을 반드시 보존**한다.

### GUI build 위험 (사전 경고)

- conflict 2에서 current만 택하고 visibility 이식을 생략하면, 자동 삭제된 `apply`/`toggle`을
  `renderGroup`이 계속 참조해 **TypeScript build가 깨진다.**
- incoming을 택하면 `collapseControls`/`emptyStateBlock` 선언과 `visibleGroups` 흐름을 잃거나
  구형 inline map이 중복된다.
- conflict 1에서 incoming을 택하면 Tooltip과 `models-control-*` DOM/CSS가 제거되고 JSX wrapper
  균형이 깨질 가능성이 높다.
- 유지 필수: `models-provider-card`, `models-provider-head`, `models-provider-actions`,
  `models-shadow-*` class와 `ProviderModelGroup` props.

### 추가 필수 테스트 (blocker 3)

현재 GUI 테스트는 pending poll을 건너뛰는 single-flight만 검증하고, **stale-generation 경로를
활성화하지 않는다.** generation guard가 회귀해도 통과한다.

계약: 다음 순서를 만들어 최신 models/selection/count가 유지됨을 단언한다.

1. 초기 load 완료
2. poll fetch를 보류(pending)
3. toggle의 forced refresh가 먼저 완료
4. 보류했던 오래된 poll이 나중에 도착

### 감사가 확인한 안전 사항 (재검증 불필요)

- backend는 provider object를 교체하지 않고 `selectedModels`와 top-level `disabledModels`만
  변경한다. API key/base URL/adapter/custom 필드 유실 없음.
- physical `combo`, shared-prefix alias, stale bare native disable 세 분기는 management API
  테스트로 실제 활성화된다.
- 기존 통합 4커밋과 충돌 없음. `fc517004`는 `OcxUsage`만 확장하고 `#370`은 `router.ts`를
  건드리지 않는다.
- docs-site 5개 로케일이 네 가지 의미(allowlist AND not-disabled, individual-on 원자적 조정,
  All-on의 allowlist 제거, future discovery 모델 활성화)에서 모두 일치한다. 모순 없음.

## 루프 계약

- **Archetype:** C3 cross-surface integration (management API + GUI + docs) with configuration-preservation audit.
- **Trigger:** Models UI가 `disabledModels`만 보고 switch 상태를 계산해 provider `selectedModels` allowlist와 최종 Codex visibility가 어긋난다.
- **Goal:** PR #389 head `1e1fa598088c76803409d4022e85d1f1de7504d4`를 최신 dev에 rebase해 allowlist와 blocklist를 원자적으로 조정하고 GUI가 최종 visibility를 표시하게 한다.
- **Non-goals:** provider credential/API key/base URL/adapter/custom provider schema 변경, combo routing 전략 변경, 모델 discovery 정책 변경, 새 번역 키 추가, GUI 재디자인.
- **Verifier:** 구현자 + 독립 reviewer. 기존 4개 리뷰 지적의 회귀(physical combo, shared-prefix alias, stale native disable, concurrent/stale GUI load)를 focused tests와 full gates로 재검증한다.
- **Stop condition:** `Models.tsx` 최신-dev conflict를 계약대로 해소하고 15개 파일이 모두 반영되며 backend/GUI/full/typecheck/lint/build/privacy/docs gates가 0으로 끝날 때.
- **Terminal outcomes:** `DONE`, `REBASE_REQUIRED`, `AWAIT_CI`, `BLOCKED_CONFIG_LOSS`, `BLOCKED_REGRESSION`.

## 착수 시점 사실

- checkout HEAD와 `origin/dev`: `037e8f5e4fa32a82e4149acc509554f157656dad` (detached worktree at exact dev tip; checkout 없음).
- PR: `#389 fix(models): make switches reflect final visibility`, base `dev`, head `1e1fa598088c76803409d4022e85d1f1de7504d4`, 15 files, `+677/-71`.
- GitHub은 현재 `reviewDecision=CHANGES_REQUESTED`로 표시하지만 독립 diff review상 기존 4개 지적은 head에서 모두 해결됐다.
- PR patch 전량 확인: `gh pr diff 389 --repo lidge-jun/opencodex` = **1148 lines**.
- 필수 direct apply 검사:

```text
$ gh pr diff 389 --repo lidge-jun/opencodex | git apply --check -
error: patch failed: gui/src/pages/Models.tsx:10
error: gui/src/pages/Models.tsx: patch does not apply
exit 1
```

- 진단용 `git apply --3way --check --verbose` 결과: docs 5개, 새 파일 3개, GUI test, combos/router/management/tests는 clean; `gui/src/pages/Models.tsx`만 conflict 합성. 최신 dev rebase와 해당 파일 수동 conflict resolution이 필수다.

### 대상 파일

| 파일 | 종류 |
|---|---|
| `docs-site/src/content/docs/guides/web-dashboard.md` | MODIFY |
| `docs-site/src/content/docs/ja/guides/web-dashboard.md` | MODIFY |
| `docs-site/src/content/docs/ko/guides/web-dashboard.md` | MODIFY |
| `docs-site/src/content/docs/ru/guides/web-dashboard.md` | MODIFY |
| `docs-site/src/content/docs/zh-cn/guides/web-dashboard.md` | MODIFY |
| `gui/src/model-visibility.ts` | NEW |
| `gui/src/pages/Models.tsx` | MODIFY + REBASE CONFLICT |
| `gui/tests/model-visibility.test.tsx` | NEW |
| `gui/tests/models-empty-provider.test.tsx` | MODIFY |
| `src/combos/index.ts` | MODIFY |
| `src/combos/types.ts` | MODIFY |
| `src/router.ts` | MODIFY |
| `src/server/management/model-routes.ts` | MODIFY |
| `tests/combos.test.ts` | MODIFY |
| `tests/model-visibility-management-api.test.ts` | NEW |

DELETE는 없다.

## 변경 계약

### 적용 원칙과 patch 권위

1148-line PR patch가 incoming 변경의 원본 권위다. 구현자는 먼저 head와 line count를 고정한다.

```bash
test "$(gh pr view 389 --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid)" = \
  "1e1fa598088c76803409d4022e85d1f1de7504d4"
gh pr diff 389 --repo lidge-jun/opencodex > /tmp/pr-389.patch
test "$(wc -l < /tmp/pr-389.patch | tr -d ' ')" = "1148"
git apply --3way /tmp/pr-389.patch
```

`Models.tsx` conflict는 아래 current-dev preservation 계약으로 수동 해소한다. 나머지 파일은 PR patch를 verbatim 유지한다.

### `gui/src/model-visibility.ts` — NEW

전체 public contract:

```ts
export type ProviderModelMap = Record<string, string[]>;
export interface ModelVisibilityTarget { id: string; native?: boolean; }
export type ModelVisibilityScope = "models" | "provider";

export function parseSelectedModels(value: unknown): ProviderModelMap
export async function fetchSelectedModels(apiBase: string, fetchImpl?: typeof fetch): Promise<ProviderModelMap>
export function modelIncluded(selected: ProviderModelMap, provider: string, modelId: string, native?: boolean): boolean
export function modelVisible(selected: ProviderModelMap, provider: string, modelId: string, native: boolean, blocked: boolean): boolean
export async function putModelVisibility(
  apiBase: string,
  scope: ModelVisibilityScope,
  provider: string,
  targets: ModelVisibilityTarget[],
  enabled: boolean,
  fetchImpl?: typeof fetch,
): Promise<Response>
export function shouldApplyLoadGeneration(request: number, current: number): boolean
```

정확한 핵심 구현:

```diff
+export function modelIncluded(
+  selected: ProviderModelMap,
+  provider: string,
+  modelId: string,
+  native = false,
+): boolean {
+  if (native) return true;
+  const allowlist = selected[provider];
+  return !allowlist || allowlist.length === 0 || allowlist.includes(modelId);
+}
+
+export function modelVisible(
+  selected: ProviderModelMap,
+  provider: string,
+  modelId: string,
+  native: boolean,
+  blocked: boolean,
+): boolean {
+  return modelIncluded(selected, provider, modelId, native) && !blocked;
+}
```

`parseSelectedModels`는 `{ selected: Record<string,string[]> }`만 허용하고 각 배열을 dedupe한다. `putModelVisibility`는 `PUT /api/model-visibility`에 `{scope,provider,targets,enabled}` JSON을 전송한다.

### `gui/src/pages/Models.tsx` — MODIFY + 최신 dev conflict resolution

현재 dev의 다음 요소는 절대 제거하지 않는다.

- `Tooltip` import 및 Shadow Call 설명 UI.
- `ProviderModelGroup` import, `renderProviderGroup(group)` 구조.
- `selectedProvider` workspace filtering과 `setSelectedProvider` stale-provider cleanup.
- combo summary/error/controls/modals 분리 및 현행 CSS class.

import merge의 정확한 after:

```diff
-import { Switch, Notice, EmptyState, Select, Tooltip } from "../ui";
+import { Switch, Notice, EmptyState, Select, Tooltip } from "../ui";
 ...
 import {
   buildProviderModelGroups,
   type ConfiguredProviderSummary,
   type ProviderDiscoverySummary,
   type ProviderModelGroup,
 } from "../models-groups";
+import {
+  fetchSelectedModels,
+  modelVisible,
+  putModelVisibility,
+  shouldApplyLoadGeneration,
+  type ProviderModelMap,
+  type ModelVisibilityScope,
+  type ModelVisibilityTarget,
+} from "../model-visibility";
```

switch 상태와 Shadow Call picker는 동일한 final visibility 함수를 사용한다.

```diff
-function activeModelOptions(models: ModelRow[], disabled: Set<string>): { value: string; label: string }[] {
+function activeModelOptions(
+  models: ModelRow[],
+  disabled: Set<string>,
+  selected: ProviderModelMap,
+): { value: string; label: string }[] {
   const options: { value: string; label: string }[] = [];
   for (const m of models) {
-    if (!disabled.has(m.id) && !disabled.has(m.namespaced)) {
+    const blocked = disabled.has(m.id) || disabled.has(m.namespaced);
+    if (modelVisible(selected, m.provider, m.id, m.native === true, blocked)) {
       options.push({ value: m.namespaced, label: m.namespaced });
     }
   }
   return options;
 }
```

state/load after는 current dev의 provider workspace cleanup을 포함해야 한다.

```diff
   const [models, setModels] = useState<ModelRow[]>([]);
   const [providers, setProviders] = useState<ConfiguredProviderSummary[]>([]);
   const [disabled, setDisabled] = useState<Set<string>>(new Set());
+  const [selectedModels, setSelectedModels] = useState<ProviderModelMap | null>(null);
 ...
   const busyRef = useRef(false);
+  const loadGenerationRef = useRef(0);
+  const loadPendingRef = useRef(false);
 ...
   const shadowModelOptions = useMemo(
-    () => activeModelOptions(models, disabled),
-    [models, disabled],
+    () => activeModelOptions(models, disabled, selectedModels ?? {}),
+    [models, disabled, selectedModels],
   );
```

```diff
-  const load = useCallback(async () => {
+  const load = useCallback(async (force = false): Promise<boolean> => {
+    if (loadPendingRef.current && !force) return false;
+    loadPendingRef.current = true;
+    const generation = ++loadGenerationRef.current;
     try {
       const [data, capsData] = await Promise.all([
-        fetch(`${apiBase}/api/models`).then(r => r.json()) as Promise<ModelRow[]>,
-        fetch(`${apiBase}/api/provider-context-caps`).then(r => r.json()) as Promise<ProviderContextCapsResponse>,
+        fetch(`${apiBase}/api/models`).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))) as Promise<ModelRow[]>,
+        fetch(`${apiBase}/api/provider-context-caps`).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))) as Promise<ProviderContextCapsResponse>,
       ]);
-      const providerData = await fetch(`${apiBase}/api/providers`).then(r => r.json()) as ConfiguredProviderSummary[];
+      const [providerData, selectionData] = await Promise.all([
+        fetch(`${apiBase}/api/providers`).then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status)))) as Promise<ConfiguredProviderSummary[]>,
+        fetchSelectedModels(apiBase),
+      ]);
+      if (!shouldApplyLoadGeneration(generation, loadGenerationRef.current)) return false;
       void loadV2();
       void loadShadowCall();
       const nextGroups = buildProviderModelGroups(data, providerData);
       setSelectedProvider(prev => (
         prev !== null && !nextGroups.some(group => group.provider === prev) ? null : prev
       ));
       setModels(data);
       setProviders(providerData);
       setDisabled(collectDisabledNamespaced(data));
+      setSelectedModels(selectionData);
       ...
+      return true;
     } catch {
-      setOk(false); setStatus(t("models.loadFail"));
+      if (shouldApplyLoadGeneration(generation, loadGenerationRef.current)) {
+        setOk(false); setStatus(t("models.loadFail"));
+      }
+      return false;
     } finally {
-      setLoading(false);
+      if (shouldApplyLoadGeneration(generation, loadGenerationRef.current)) {
+        loadPendingRef.current = false;
+        setLoading(false);
+      }
     }
```

기존 `apply(nextDisabled)`와 `toggle(ns)`를 삭제하고 다음 atomic action으로 교체한다.

```diff
+  const effectiveVisibleCount = useMemo(() => {
+    if (!selectedModels) return 0;
+    return models.filter(model => modelVisible(
+      selectedModels,
+      model.provider,
+      model.id,
+      model.native === true,
+      disabled.has(model.namespaced),
+    )).length;
+  }, [disabled, models, selectedModels]);
+
+  const applyVisibility = async (
+    scope: ModelVisibilityScope,
+    provider: string,
+    targets: ModelVisibilityTarget[],
+    enabled: boolean,
+  ) => {
+    ++loadGenerationRef.current;
+    setBusy(true);
+    busyRef.current = true;
+    setStatus("");
+    let errorKey: "models.saveFailed" | "models.networkError" | null = null;
+    try {
+      const response = await putModelVisibility(apiBase, scope, provider, targets, enabled);
+      if (!response.ok) errorKey = "models.saveFailed";
+    } catch {
+      errorKey = "models.networkError";
+    } finally {
+      const refreshed = await load(true);
+      if (errorKey) { setOk(false); setStatus(t(errorKey)); }
+      else if (refreshed) { setOk(true); setStatus(t("models.applied")); }
+      setBusy(false);
+      busyRef.current = false;
+    }
+  };
```

모든 기존 mutation 후 `await load()`는 `await load(true)`로 바꾼다. initial load가 끝났는데 `selectedModels`가 null이면 error Notice를 표시한다.

현재 dev의 `renderProviderGroup({provider, rows, native, liveModels, discovery}: ProviderModelGroup)` 내부 diff:

```diff
-    const activeCount = rows.filter(m => !disabled.has(m.namespaced)).length;
+    const isVisible = (model: ModelRow) => modelVisible(
+      selectedModels,
+      provider,
+      model.id,
+      model.native === true,
+      disabled.has(model.namespaced),
+    );
+    const activeCount = rows.filter(isVisible).length;
 ...
-    const sorted = [...filtered].sort((a, b) => Number(disabled.has(a.namespaced)) - Number(disabled.has(b.namespaced)));
+    const sorted = [...filtered].sort((a, b) => Number(!isVisible(a)) - Number(!isVisible(b)));
 ...
-    const allOn = rows.every(m => !disabled.has(m.namespaced));
-    const allOff = rows.every(m => disabled.has(m.namespaced));
-    const bulkToggle = (enable: boolean) => {
-      const next = new Set(disabled);
-      for (const m of rows) { if (enable) next.delete(m.namespaced); else next.add(m.namespaced); }
-      apply(next);
-    };
+    const allOn = rows.length > 0 && rows.every(isVisible);
+    const allOff = rows.length > 0 && rows.every(model => !isVisible(model));
+    const targets = rows.map(model => ({ id: model.id, ...(model.native ? { native: true } : {}) }));
+    const bulkToggle = (enable: boolean) => {
+      void applyVisibility("provider", provider, targets, enable);
+    };
 ...
-    const off = disabled.has(m.namespaced);
+    const on = isVisible(m);
 ...
-    <Switch on={!off} onClick={() => toggle(m.namespaced)} ... />
+    <Switch on={on} onClick={() => void applyVisibility(
+      "models", provider, [{ id: m.id, ...(m.native ? { native: true } : {}) }], !on,
+    )} ... />
```

page total active count도 `models.length - disabled.size`가 아니라 `effectiveVisibleCount`를 사용한다. Provider workspace의 `visibleGroups.map(renderProviderGroup)` 구조는 유지한다.

### `src/combos/types.ts`, `src/combos/index.ts`, `src/router.ts` — MODIFY

shared owner를 한 곳으로 만든다.

```diff
 export const COMBO_NAMESPACE = "combo";
+
+export function preservesPhysicalComboProvider(
+  config: Pick<OcxConfig, "providers" | "combos">,
+): boolean {
+  return Object.hasOwn(config.providers, COMBO_NAMESPACE)
+    && Object.keys(config.combos ?? {}).length === 0;
+}
```

`src/combos/index.ts`에서 export하고 router와 management route가 동일 helper를 import한다.

```diff
-  const preservePhysicalComboProvider =
-    hasOwnProvider(config.providers, COMBO_NAMESPACE)
-    && Object.keys(config.combos ?? {}).length === 0;
-  if (!bypassCombos && !preservePhysicalComboProvider) {
+  if (!bypassCombos && !preservesPhysicalComboProvider(config)) {
```

`Object.hasOwn`이므로 prototype 상속된 `combo`는 physical provider로 오인하지 않는다.

### `src/server/management/model-routes.ts` — MODIFY

`PUT /api/model-visibility`를 `PUT /api/disabled-models` 뒤에 추가한다. 요청은 plain object, scope enum, provider name, boolean enabled, non-empty deduped targets를 검증한다. native target은 provider=`openai` 및 `nativeModelRows()` slug에 한정한다.

핵심 상태 전이의 정확한 after:

```ts
const providerConfig = hasOwnProvider(config.providers, provider) ? config.providers[provider] : undefined;
const isVirtualComboNamespace = provider === COMBO_NAMESPACE && !preservesPhysicalComboProvider(config);

const knownComboSelectors = new Set(
  Object.entries(config.combos ?? {}).flatMap(([id, combo]) => [
    comboModelId(id),
    comboPublicModelId(id, combo),
  ]),
);

let disabled = [...new Set(config.disabledModels ?? [])];
if (body.enabled) {
  if (scope === "provider") {
    if (providerConfig && !isVirtualComboNamespace) delete providerConfig.selectedModels;
    if (isVirtualComboNamespace) {
      disabled = disabled.filter(stored => !knownComboSelectors.has(stored));
    } else {
      const nativeIds = provider === "openai"
        ? disabledNativeSlugs({ disabledModels: disabled })
        : new Set<string>();
      disabled = disabled.filter(stored => (
        knownComboSelectors.has(stored)
        || (!stored.startsWith(`${provider}/`) && !nativeIds.has(stored))
      ));
    }
  } else {
    if (!isVirtualComboNamespace && providerConfig?.selectedModels && providerConfig.selectedModels.length > 0) {
      const additions = targets.filter(target => !target.native).map(target => target.id);
      providerConfig.selectedModels = [...new Set([...providerConfig.selectedModels, ...additions])];
    }
    disabled = disabled.filter(stored => !targets.some(target => matchesTarget(stored, target)));
  }
} else {
  for (const target of targets) {
    const canonical = target.native
      ? target.id
      : isVirtualComboNamespace
        ? comboModelId(target.id)
        : routedSlug(provider, target.id);
    if (!disabled.some(stored => matchesTarget(stored, target))) disabled.push(canonical);
  }
}

config.disabledModels = disabled;
saveConfig(config);
await refreshCodexCatalogBestEffort();
```

**config-preservation 불변식:** provider object를 재구성하거나 교체하지 않는다. 해당 `providerConfig.selectedModels`만 append/delete하고 top-level `config.disabledModels`만 바꾼다. 따라서 `apiKey`, `baseUrl`, `adapter`, `authMode`, `liveModels`, `models`, custom provider fields는 그대로 남아야 한다.

**alias 불변식:** 일반 provider All-on은 `knownComboSelectors.has(stored)`를 먼저 보존하므로 `anthropic/fast`처럼 provider prefix와 겹치는 combo public alias를 지우지 않는다. virtual combo provider All-on만 canonical/public selector를 지운다.

**stale native 불변식:** openai All-on은 `disabledNativeSlugs()`가 식별한 bare native disable을 제거한다. combo selector와 다른 provider entries는 보존한다.

### 테스트 파일 — NEW/MODIFY

`gui/tests/model-visibility.test.tsx` NEW:

```ts
test("final visibility helpers normalize selections and stale generations", () => {
  expect([
    modelVisible({ proxy: ["a"] }, "proxy", "a", false, false),
    modelVisible({ proxy: ["a"] }, "proxy", "b", false, false),
    modelVisible({ openai: ["other"] }, "openai", "gpt-5.6-sol", true, true),
  ]).toEqual([true, false, false]);
  expect(parseSelectedModels({ selected: { proxy: ["a", "a", "b"] } })).toEqual({ proxy: ["a", "b"] });
  expect(() => parseSelectedModels({ selected: { proxy: "a" } })).toThrow();
  expect(shouldApplyLoadGeneration(4, 5)).toBe(false);
});
```

`gui/tests/models-empty-provider.test.tsx` MODIFY: 기존 discovery-failure fixture를 final visibility integration으로 확장한다. 반드시 다음을 모두 단언한다.

- pending initial `/api/models` 중 poll이 중복 fetch를 만들지 않음.
- allowlist 2개 + blocklist 1개에서 `2/5 active`.
- excluded model on은 `{scope:"models", enabled:true}` atomic PUT 후 `3/5`.
- 500 실패는 UI를 다시 fetch해 원래 off 상태 유지 + `Save failed`.
- All-on은 allowlist를 empty로 만들고 `5/5`; All-off는 `0/5`.
- Shadow Call picker에는 final-visible model만 존재.
- discovery failure badge는 계속 표시.

`tests/combos.test.ts` MODIFY: physical combo helper true/false 및 inherited provider false를 추가한다.

`tests/model-visibility-management-api.test.ts` NEW(268 lines): 아래 8개 test를 verbatim 유지한다.

1. excluded/blocked individual enable 및 disable 시 allowlist 보존.
2. provider All-on은 future-proof All mode, All-off는 현재 target만 block.
3. openai All-on은 stale bare native ids 제거, combo selectors 보존.
4. physical `combo` provider + no combos는 routed provider처럼 동작.
5. shared-prefix combo alias는 일반 provider All-on에서 보존되고 combo All-on에서만 제거.
6. virtual combos 우선 시 colliding physical combo allowlist untouched.
7. canonical/aliased combo rows toggle.
8. raw allowlist ids/canonical routed slugs 및 malformed/unknown/native mismatch/prototype target 거부; invalid 요청 후 config unchanged.

### docs-site 5개 로케일 — MODIFY

각 locale의 비용 설명 뒤에 `Model visibility` 절을 추가하고 endpoint 표에 다음 API를 추가한다.

```diff
+## Model visibility
+
+The **Models** switches show final Codex visibility: a routed model is on only when its provider
+allowlist includes it (or no allowlist is set) and it is not disabled. Turning a model on reconciles
+both filters atomically; **All on** clears the provider allowlist so newly discovered models are also on.
 ...
+| `GET /api/selected-models` · `PUT /api/model-visibility` | Read provider allowlists and atomically change the final visibility of one model or provider group. |
```

ja/ko/ru/zh-cn은 PR patch의 번역을 verbatim 사용한다. 다섯 문서 모두 다음 네 의미가 모순 없이 같아야 한다.

1. final visibility = allowlist 통과 AND not disabled.
2. individual on = 두 필터 원자적 reconciliation.
3. All-on = provider allowlist 제거.
4. 새 discovery model도 All-on 상태에서는 visible.

## 검증

focused gates:

```bash
bun test tests/combos.test.ts tests/model-visibility-management-api.test.ts
(cd gui && bun test tests/model-visibility.test.tsx tests/models-empty-provider.test.tsx)
```

repo gates:

```bash
bun run typecheck
bun run lint:gui
bun run build:gui
bun run test
bun run privacy:scan
(cd docs-site && bun run build)
```

config/locale audit:

```bash
git diff --check
git diff -- src/server/management/model-routes.ts tests/model-visibility-management-api.test.ts
rg -n "Model visibility|モデルの表示|모델 노출|Видимость моделей|模型可见性|api/model-visibility" \
  docs-site/src/content/docs/guides/web-dashboard.md \
  docs-site/src/content/docs/{ja,ko,ru,zh-cn}/guides/web-dashboard.md
```

검증 중 별도 확인:

- physical `combo` + `combos:{}`에서 router와 management route가 모두 `preservesPhysicalComboProvider()`를 사용.
- shared-prefix alias `anthropic/fast`가 anthropic All-on에서 보존되고 combo All-on에서 제거.
- `apiKey/baseUrl/adapter` 및 test fixture의 다른 provider fields가 PUT 전후 동일.
- GUI switch, active count, sort, Shadow Call picker가 모두 `modelVisible()` 기준.
- stale generation response가 최신 state를 덮지 않고 polling은 single-flight.
- 5 locale가 위 네 의미를 모두 포함하며 서로 반대 설명을 하지 않음.

## 수용 기준

- [ ] PR head가 `1e1fa598088c76803409d4022e85d1f1de7504d4`인지 재확인했다.
- [ ] 1148-line patch의 15개 파일이 모두 반영되고 DELETE가 없다.
- [ ] `Models.tsx` conflict 해소가 최신 Provider workspace/Tooltip/selectedProvider 구조를 보존한다.
- [ ] physical combo 판정 helper를 router와 management route가 공유한다.
- [ ] physical `combo` provider와 shared-prefix alias regression이 통과한다.
- [ ] provider config에서 `selectedModels` 외 API key/base URL/adapter/custom fields가 유실되지 않는다.
- [ ] All-on이 stale bare native disables를 제거하되 combo/other-provider entries를 보존한다.
- [ ] GUI의 switch/active count/sort/picker가 final visibility를 표시하고 stale load를 거부한다.
- [ ] docs-site 5 locale가 allowlist AND blocklist, atomic individual on, All-on allowlist clear, future discovery 의미에서 일치한다.
- [ ] focused backend, focused GUI, typecheck, GUI lint/build, full test, privacy scan, docs build가 모두 exit 0이다.
- [ ] 최신 dev 위 hosted CI를 재실행해 required checks가 exact head에서 green이다.

## 실행 영수증

_(C/D 단계에서 작성)_
