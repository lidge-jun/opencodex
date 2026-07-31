# WP6 — Provider workspace custom models: PR #449 통합과 provenance/retry 수선

## A-gate 반영 — 수정 설계 확정 (CANONICAL)

독립 감사 `VERDICT: GO-WITH-FIXES (blockers=4)`. 아래가 canonical 계약이며, 문서 뒷부분의
기존 diff 제안 중 이와 충돌하는 부분은 무효다.

감사가 확인한 사항(재검증 불필요): #448의 provider-scoped 입력·빈 ID·namespaced ID·중복
거부·즉시 반영이 모두 충족된다. WP5(#389)와 파일 충돌이 없고 `parseSelectedModels()`는
`selected`만 읽으므로 additive `liveModelCounts`와 호환된다. custom POST는 `config.customModels`만
immutable append하므로 provider 설정 필드 유실이 없다.

### 결함 1 — provenance 보존: source-side live count

감사가 네 접근을 비교했다.

| 접근 | 판정 |
|---|---|
| ID 차집합 (PR 현재) | **불가.** 동일 ID overlap에서 provenance가 소실된다 |
| catalog row별 `source` 필드 | 표현력은 높으나 custom override dedup에서 live row가 제거되므로 스키마·merge 정책을 광범위하게 바꿔야 한다 |
| 기존 discovery status 재사용 | **불충분.** 실패 상태가 이전 성공 count를 덮어 stale이 live-origin인지 판정 불가 |
| **source-side live count** | **채택.** 최소 변경으로 `0` / non-zero / 실패 후 stale을 정확히 구분 |

핵심: **`live.length`는 configured alias 증강 *전에* capture한다.** 그러지 않으면 configured row가
live count를 오염시킨다.

```
 // src/codex/model-cache.ts
+const liveModelCounts = new Map<string, number>();
+
+export function getProviderLiveModelCount(provider: string): number | undefined {
+  return liveModelCounts.get(provider);
+}
+
 export function clearProviderDiscoveryStatus(provider: string): void {
   discoveryStatus.delete(provider);
+  liveModelCounts.delete(provider);
 }
```

```
 // src/codex/catalog/provider-fetch.ts — Cursor 성공 branch
-markProviderDiscoveryOk(name);
+markProviderDiscoveryOk(name, liveResult.models.length);

 // 일반 OpenAI-list branch
 const live = items.map(...).filter(...);
+const liveModelCount = live.length; // configured alias 증강 전에 capture
 ...
-markProviderDiscoveryOk(name);
+markProviderDiscoveryOk(name, liveModelCount);
```

management DTO에 `liveModelCounts`를 additive로 싣고, GUI는 추론 대신 그 값을 쓴다.

```
-  const customSet = new Set(customModels);
-  const hasLiveModels = base.some(id => !customSet.has(id));
   const fallback = configuredModels?.length ? configuredModels : defaultModel ? [defaultModel] : [];
-  const primary = base.length > 0 && (hasLiveModels || customSet.size === 0) ? base : fallback;
+  const primary = hasLiveModels ? base : fallback;
   return [...new Set([...primary, ...customModels])];
```

결과 분리: live `0` + custom-only → configured fallback + custom / live `>0` + overlap →
live·custom row만 / 실패 + stale → 마지막 성공 count 유지.

### blocker 3 — 기본값이 wiring 누락을 은폐한다 (중요)

count 인수와 GUI prop을 **required로 만든다.** optional/default로 두면 production branch에서
전달을 빠뜨려도 typecheck가 통과하고 조용히 count `0`으로 오분류한다.

```
- export function markProviderDiscoveryOk(provider: string, liveModelCount = 0): void {
+ export function markProviderDiscoveryOk(provider: string, liveModelCount: number): void {
```

```
- hasLiveModels?: boolean;
+ hasLiveModels: boolean;
```

`DetailSlotData` → `ProviderDetails` → `ProviderModels` 전 구간에서 required로 두어 props-down
누락이 컴파일 오류가 되게 한다. required화에 따라 기존 직접 호출도 수정 범위에 포함한다:
`tests/provider-discovery-log-suppression.test.ts`의 `markProviderDiscoveryOk(P)` → `(P, 0)`.

### 결함 2 — GET 실패 후 복구: 명시적 Retry CTA + epoch

| 접근 | 판정 |
|---|---|
| effect dependency만 변경 | 재실행 트리거가 별도로 필요하고 자동 반복은 불필요한 요청을 만든다 |
| Add 클릭 시 lazy GET | 한 번의 Add가 GET→POST 2단계가 되어 실패 의미가 모호하고 race 처리가 복잡 |
| **Retry CTA + epoch effect** | **채택.** 가장 명확하고 기존 provider model retry UX와 일치 |

```
 const [customModelsReady, setCustomModelsReady] = useState(false);
+const [customModelsLoadFailed, setCustomModelsLoadFailed] = useState(false);
+const [customModelsLoadEpoch, setCustomModelsLoadEpoch] = useState(0);
 ...
 .then(rows => {
+  setCustomModelsLoadFailed(false);
+  setCustomError("");
   setCustomModelsReady(true);
 })
 .catch(() => {
   if (!active) return;
   setCustomModelIds([]);
+  setCustomModelsReady(false);
+  setCustomModelsLoadFailed(true);
   setCustomError(t("models.networkError"));
 });
-}, [apiBase, item.name, t]);
+}, [apiBase, item.name, t, customModelsLoadEpoch]);
+
+const retryCustomModels = () => {
+  setCustomModelsReady(false);
+  setCustomModelsLoadFailed(false);
+  setCustomError("");
+  setCustomModelsLoadEpoch(epoch => epoch + 1);
+};
```

에러 표시 옆에 `customModelsLoadFailed`일 때만 Retry 버튼을 렌더링한다.

회귀 테스트는 **같은 mount 안에서** `GET fail → Retry → GET success → Add 활성화 → POST 정확히 1회`
전 구간을 확인해야 한다.

### blocker 4 — 활성화 테스트의 실제 배치

Cursor는 `globalThis.fetch` mock으로 활성화할 수 없다. HTTP/2 protobuf fixture가 필요하며 기존
harness가 `tests/cursor-hardening.test.ts`에 있다.

| 시나리오 | 배치 |
|---|---|
| Cursor 성공 branch | `tests/cursor-hardening.test.ts`의 `withDiscoveryServer()`로 `/api/selected-models` 호출 후 count 확인 |
| 일반 non-empty / empty / 성공→실패 stale | `tests/codex-catalog.test.ts`에서 management route 호출 |
| malformed/negative/NaN 파서 | `tests/provider-workspace-data.test.ts`에 `parseLiveModelCounts` 회귀 |

허용 changed-file ledger에 `tests/cursor-hardening.test.ts`,
`tests/provider-discovery-log-suppression.test.ts`, `tests/provider-workspace-data.test.ts`를 추가한다.

**4개 discovery 시나리오는 축소하지 않는다.** `markProviderDiscoveryOk()`만 직접 호출하는
테스트로 줄이면 production branch가 count 기록을 빠뜨려도 green이 된다.

## 루프 계약

- **Archetype:** clean-applying GUI PR을 현재 `dev` 위에 흡수한 뒤, 발견된 correctness/recovery 결함을 source-to-view 계약까지 추적해 함께 수선하는 integration-and-repair.
- **Trigger:** 이슈 #448은 provider Models 탭에서 custom model을 직접 추가할 수 없고 custom-only catalog가 configured fallback을 가리는 문제를 보고한다. PR #449는 기능을 추가하지만 ID 겹침을 provenance로 오인하고 최초 GET 실패 뒤 Add를 영구 비활성화한다.
- **Goal:** PR #449 head `eeb61e9b9dae51d88d8db207b9c2287e97076a99`를 적용하고, live discovery의 실제 모델 수를 additive DTO로 보존해 overlap을 올바르게 판정하며 custom-model lookup을 같은 mount 안에서 재시도할 수 있게 한다.
- **Non-goals:** global Models editor 재설계, custom model schema 확장, provider routing 변경, PR #445 통합, 보안 경계 변경, custom model 삭제/편집 UI 추가.
- **Verifier:** pinned head/apply 확인 → focused pure/GUI/backend tests → GUI lint/build → typecheck/full suite/privacy scan. C 단계 독립 reviewer는 overlap과 fail→retry→POST 두 경로를 별도로 재현한다.
- **Stop condition:** PR patch와 아래 repair delta가 모두 적용되고 모든 검증이 exit 0이며, live 여부를 custom ID 차집합으로 추론하는 코드와 remount-only 복구 경로가 남지 않는다.
- **Terminal outcomes:** `MERGE_OK`, `REWORK`, `STALE`(PR head/base 또는 dev 기준점 drift), `BLOCKED`(계약된 provenance plumbing 없이 correctness를 만족할 수 없음).

## 착수 시점 사실

- 기준 시각: 2026-07-25 KST.
- worktree: `/Users/jun/.codex/worktrees/ebcd/opencodex`.
- 실제 checkout은 **detached HEAD**이며 `HEAD == origin/dev == 037e8f5e4fa32a82e4149acc509554f157656dad`. 브랜치 checkout은 하지 않는다.
- PR #449: base `dev`, head `eeb61e9b9dae51d88d8db207b9c2287e97076a99`, 6 files, `+388/-7`.
- PR 파일: `gui/src/components/provider-workspace/ProviderDetails.tsx`, `ProviderModels.tsx`, `gui/src/provider-workspace/report.ts`, `gui/src/styles/provider-workspace-shell.css`, `gui/tests/provider-model-custom-add.test.tsx`, `tests/provider-workspace-state.test.ts`.
- `gh pr diff 449 --repo lidge-jun/opencodex` 전량 494줄과 `gh issue view 448 --repo lidge-jun/opencodex`의 본문을 확인했다. 이슈는 OPEN이며 provider-scoped add, duplicate/name-spacing guard, immediate appearance, custom-only fallback 보존을 요구한다.
- apply 확인: `gh pr diff 449 --repo lidge-jun/opencodex | git apply --check -` → exit 0, 출력 없음(clean).
- #445와 #449의 changed-file 교집합은 0개다. 기능 충돌은 없지만 #445는 auth/provider validation 보안 경계이므로 이 WP에서 적용하지 않는다.

## 변경 계약

### 적용 순서와 파일 ledger

1. 아래 head assertion 뒤 PR patch를 그대로 적용한다.

```bash
test "$(gh pr view 449 --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid)" = "eeb61e9b9dae51d88d8db207b9c2287e97076a99"
gh pr diff 449 --repo lidge-jun/opencodex | git apply -
```

2. PR 파일은 모두 **MODIFY/NEW as-is**로 먼저 들어간다.
3. 우리 delta는 다음 파일만 허용한다.

| 파일 | 동작 | 계약 |
|---|---|---|
| `src/codex/model-cache.ts` | MODIFY | 성공한 live discovery의 실제 row count를 별도 provenance로 보존 |
| `src/codex/catalog/provider-fetch.ts` | MODIFY | Cursor/일반 성공 시 live row count 기록 |
| `src/server/management/model-routes.ts` | MODIFY | `/api/selected-models`에 additive `liveModelCounts` DTO 추가 |
| `gui/src/provider-workspace/usage.ts` | MODIFY | unknown DTO에서 finite non-negative count만 파싱 |
| `gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx` | MODIFY | count map을 detail slot까지 props-down |
| `gui/src/components/provider-workspace/ProviderDetails.tsx` | MODIFY | `hasLiveModels`를 `ProviderModels`에 전달 |
| `gui/src/components/provider-workspace/ProviderModels.tsx` | MODIFY | provenance 사용 + GET in-place retry |
| `gui/src/provider-workspace/report.ts` | MODIFY | ID 차집합 추론 제거 |
| `tests/provider-workspace-state.test.ts` | MODIFY | custom/live 동일 ID overlap 회귀 |
| `gui/tests/provider-model-custom-add.test.tsx` | MODIFY | first GET failure → Retry → Add 복구 회귀 |
| `tests/codex-catalog.test.ts` | MODIFY | live count 0/overlap/실패 stale 보존 DTO 회귀 |

DELETE는 없다. `gui/src/pages/CodexAuth.tsx`, `src/server/management/provider-routes.ts` 등 #445 파일은 수정 금지다.

### PR snapshot의 결함 1 — custom ID 차집합으로 live provenance를 추론

PR #449가 `gui/src/provider-workspace/report.ts`에 추가하는 실제 코드는 다음과 같다.

```ts
const customSet = new Set(customModels);
const hasLiveModels = base.some(modelId => !customSet.has(modelId));
const fallback = configuredModels && configuredModels.length > 0
  ? configuredModels
  : defaultModel ? [defaultModel] : [];
const primary = base.length > 0 && (hasLiveModels || customSet.size === 0)
  ? base
  : fallback;
```

이 코드는 provenance가 아니라 ID 동일성을 본다. custom `same-id`가 나중에 live `/models`에도 등장하면 catalog merge가 custom metadata를 우선해 동일 ID 한 행만 남기고, 위 식은 live row가 있었음에도 `hasLiveModels=false`로 판정한다. 그러면 configured fallback이 authoritative live catalog에 다시 섞인다.

#### 1-A. backend가 live row count를 보존

`src/codex/model-cache.ts` — 기존 status shape를 깨지 않도록 count는 별도 map/accessor로 추가한다. 실패 시 stale live catalog가 계속 쓰일 수 있으므로 count를 지우지 않고, 명시적 status clear에서만 지운다.

```diff
@@
 const failureAt = new Map<string, number>();
 const discoveryStatus = new Map<string, ProviderModelDiscoveryStatus>();
+const liveModelCounts = new Map<string, number>();
@@
-export function markProviderDiscoveryOk(provider: string): void {
+export function markProviderDiscoveryOk(provider: string, liveModelCount = 0): void {
   discoveryStatus.set(provider, { status: "ok" });
+  liveModelCounts.set(provider, Math.max(0, Math.floor(liveModelCount)));
 }
+
+/** Last successful live-discovery row count; retained while stale cache is authoritative. */
+export function getProviderLiveModelCount(provider: string): number | undefined {
+  return liveModelCounts.get(provider);
+}
@@
 export function clearProviderDiscoveryStatus(provider: string): void {
   discoveryStatus.delete(provider);
+  liveModelCounts.delete(provider);
 }
@@
 export function clearModelCache(provider?: string): void {
   if (provider) {
     cache.delete(provider);
     failureAt.delete(provider);
     discoveryStatus.delete(provider);
+    liveModelCounts.delete(provider);
   } else {
     cache.clear();
     failureAt.clear();
     discoveryStatus.clear();
+    liveModelCounts.clear();
   }
 }
```

`src/codex/catalog/provider-fetch.ts` — 성공한 upstream 결과 자체의 count를 기록한다. 일반 경로는 configured aliases를 합치기 전, exposure filter를 통과한 live rows의 개수를 capture해야 하며 custom merge 뒤 배열 길이를 쓰면 같은 결함이 재발한다.

```diff
@@
-      markProviderDiscoveryOk(name);
+      markProviderDiscoveryOk(name, liveResult.models.length);
@@
     const live = items.map(m => applyProviderConfigHints(name, prov, {
@@
     }, contextCap))
       .filter(m => shouldExposeProviderModel(name, m.id));
+    const liveModelCount = live.length;
@@
-    markProviderDiscoveryOk(name);
+    markProviderDiscoveryOk(name, liveModelCount);
```

`src/server/management/model-routes.ts` — import와 `/api/selected-models` 응답을 additive하게 확장한다. 기존 `available`/`selected` consumers는 깨지지 않는다.

```diff
@@
 import { getProviderRegistryEntry } from "../../providers/registry";
+import { getProviderLiveModelCount } from "../../codex/model-cache";
@@
   if (url.pathname === "/api/selected-models" && req.method === "GET") {
     const models = await fetchAllModels(config);
     const available: Record<string, string[]> = {};
     for (const m of models) (available[m.provider] ??= []).push(m.id);
     const selected: Record<string, string[]> = {};
+    const liveModelCounts: Record<string, number> = {};
     for (const [name, prov] of Object.entries(config.providers)) {
       if (Array.isArray(prov.selectedModels) && prov.selectedModels.length > 0) selected[name] = [...prov.selectedModels];
+      const liveCount = getProviderLiveModelCount(name);
+      if (liveCount !== undefined) liveModelCounts[name] = liveCount;
     }
-    return jsonResponse({ selected, available });
+    return jsonResponse({ selected, available, liveModelCounts });
   }
```

`gui/src/provider-workspace/usage.ts` — parser를 추가한다.

```diff
@@
 export type ProviderModelCounts = Record<string, number>;
 export type ProviderAvailableModels = Record<string, string[]>;
 export type ProviderSelectedModels = Record<string, string[]>;
+export type ProviderLiveModelCounts = Record<string, number>;
+
+/** Parse source-side live discovery counts without inferring provenance from model ids. */
+export function parseLiveModelCounts(data: unknown): ProviderLiveModelCounts {
+  if (!data || typeof data !== "object") return {};
+  const raw = (data as { liveModelCounts?: unknown }).liveModelCounts;
+  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
+  return Object.fromEntries(Object.entries(raw).flatMap(([provider, count]) => (
+    typeof count === "number" && Number.isFinite(count) && count >= 0
+      ? [[provider, Math.floor(count)]]
+      : []
+  )));
+}
```

`ProviderWorkspaceShell.tsx` → `ProviderDetails.tsx` → `ProviderModels.tsx` props-down diff:

```diff
diff --git a/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx b/gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx
@@
-import { countAvailableModels, parseAvailableModels, parseSelectedModels, type ProviderAvailableModels, type ProviderModelCounts, type ProviderSelectedModels } from "../../provider-workspace/usage";
+import { countAvailableModels, parseAvailableModels, parseLiveModelCounts, parseSelectedModels, type ProviderAvailableModels, type ProviderLiveModelCounts, type ProviderModelCounts, type ProviderSelectedModels } from "../../provider-workspace/usage";
@@
   availableModels: string[];
+  hasLiveModels: boolean;
   selectedModels: string[];
@@
   const [availableModels, setAvailableModels] = useState<ProviderAvailableModels>({});
+  const [liveModelCounts, setLiveModelCounts] = useState<ProviderLiveModelCounts>({});
@@
           setAvailableModels(parseAvailableModels(data));
+          setLiveModelCounts(parseLiveModelCounts(data));
@@
             availableModels: availableModels[selectedItem.name] ?? [],
+            hasLiveModels: (liveModelCounts[selectedItem.name] ?? 0) > 0,
             selectedModels: selectedModels[selectedItem.name] ?? [],
diff --git a/gui/src/components/provider-workspace/ProviderDetails.tsx b/gui/src/components/provider-workspace/ProviderDetails.tsx
@@
   availableModels,
+  hasLiveModels,
   selectedModels,
@@
   availableModels: string[];
+  hasLiveModels: boolean;
   selectedModels: string[];
@@
             apiBase={apiBase}
             availableModels={availableModels}
+            hasLiveModels={hasLiveModels}
             selectedModels={selectedModels}
```

#### 1-B. `filterModels`는 explicit provenance만 사용

PR 적용 직후 `report.ts` before와 최종 after:

```diff
 export function filterModels(
   base: string[],
   defaultModel: string | undefined,
   query: string,
   configuredModels?: string[],
   customModels: string[] = [],
+  hasLiveModels = false,
 ): string[] {
-  const customSet = new Set(customModels);
-  const hasLiveModels = base.some(modelId => !customSet.has(modelId));
   const fallback = configuredModels && configuredModels.length > 0
     ? configuredModels
     : defaultModel ? [defaultModel] : [];
-  const primary = base.length > 0 && (hasLiveModels || customSet.size === 0)
-    ? base
-    : fallback;
+  const primary = hasLiveModels ? base : fallback;
   const list = [...new Set([...primary, ...customModels])];
```

`ProviderModels.tsx` 호출부와 fallback label도 동일 provenance를 사용한다.

```diff
@@
   apiBase,
   availableModels,
+  hasLiveModels = false,
@@
   apiBase: string;
   availableModels: string[];
+  hasLiveModels?: boolean;
@@
-    () => filterModels(availableModels, item.defaultModel, query, configuredModels, customModelIds),
-    [availableModels, item.defaultModel, query, configuredModels, customModelIds],
+    () => filterModels(availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels),
+    [availableModels, item.defaultModel, query, configuredModels, customModelIds, hasLiveModels],
@@
-  const showingConfiguredFallback = availableModels.length === 0 && configuredModels.length > 0;
+  const showingConfiguredFallback = !hasLiveModels && configuredModels.length > 0;
```

`tests/provider-workspace-state.test.ts`의 PR 추가 테스트를 아래로 교체한다. 두 호출의 base/custom ID는 동일하지만 provenance만 달라 결과가 달라져야 한다.

```diff
-    test("custom-only catalog rows do not suppress configured fallback models", () => {
+    test("explicit live provenance survives a custom/live id overlap", () => {
       expect(filterModels(
-        ["claude-opus-5.1-custom"],
+        ["overlap-model"],
         "ignored-default",
         "",
         ["claude-opus-5"],
-        ["claude-opus-5.1-custom"],
-      )).toEqual(["claude-opus-5", "claude-opus-5.1-custom"]);
+        ["overlap-model"],
+        false,
+      )).toEqual(["claude-opus-5", "overlap-model"]);
       expect(filterModels(
-        ["live-model", "claude-opus-5.1-custom"],
+        ["overlap-model"],
         "ignored-default",
         "",
         ["configured-fallback"],
-        ["claude-opus-5.1-custom"],
-      )).toEqual(["live-model", "claude-opus-5.1-custom"]);
+        ["overlap-model"],
+        true,
+      )).toEqual(["overlap-model"]);
     });
```

`tests/codex-catalog.test.ts`에는 아래 케이스를 추가한다. assertion은 request body/token/path/
account ID를 검사하거나 출력하지 않는다.

**활성화 요구 (A-gate blocker 4 반영, C-ACTIVATION-GROUNDING-01).**
`markProviderDiscoveryOk(provider, 1)`을 직접 호출하고 DTO만 검사하는 테스트는
**불충분하다.** 그렇게 하면 `src/codex/catalog/provider-fetch.ts`의 Cursor branch나 일반
branch에서 count 인자를 빠뜨려 기본값 `0`이 쓰여도 테스트가 green이 된다. 즉 원래 결함이
프로덕션 discovery 경로에 그대로 남는다.

따라서 다음 두 테스트는 **실제 discovery 경로를 통과**해야 한다.

| 테스트 | 트리거 방법 | 관찰 대상 (실행 증거) |
|---|---|---|
| Cursor branch 활성화 | Cursor discovery 응답을 mock하고 `fetchAllModels()`를 호출 | `/api/selected-models` DTO의 `liveModelCounts[provider]`가 mock한 모델 수와 일치 |
| 일반 OpenAI-list branch 활성화 | `/models` 형태 응답을 mock하고 `fetchAllModels()`를 호출 | 동일 |
| 성공한 empty list | 빈 `data: []`를 mock하고 같은 경로 통과 | count가 `0`이고 custom-only 오분류가 발생하지 않음 |
| 실패 후 stale 보존 | 위 성공 뒤 discovery 실패를 mock | 마지막 성공 count가 유지됨 |

`markProviderDiscoveryOk`를 직접 호출하는 unit 테스트는 보조로 남겨도 된다.
**위 네 케이스 전부가 필수 수용 기준이다** (A-gate 라운드2 blocker 5 반영). 두 branch만
테스트하면, 성공한 empty list에서 count `0`을 기록하지 않거나 실패 시 마지막 성공 count를
지워버려도 green이 된다. 네 케이스 모두 실제 discovery 경로(`fetchAllModels()` 또는
management route)를 통과해야 하며, 하나라도 없으면 WP6의 C는 통과로 볼 수 없다.

### PR snapshot의 결함 2 — 최초 custom GET 실패 뒤 Add 영구 비활성

PR의 실제 코드에서 `customModelInvalid`는 `!customModelsReady`이면 항상 true이고, GET catch는 ready를 true로 바꾸지 않는다. effect 재실행 trigger도 `[apiBase, item.name, t]`뿐이라 동일 provider mount에서는 복구할 수 없다.

```ts
const customModelInvalid = !customModelsReady || ...;
// ...
.catch(() => {
  if (!active) return;
  setCustomModelIds([]);
  setCustomError(t("models.networkError"));
});
```

`ProviderModels.tsx` 최종 repair diff:

```diff
@@
   const [customModelIds, setCustomModelIds] = useState<string[]>([]);
   const [customModelsReady, setCustomModelsReady] = useState(false);
+  const [customModelsLoadFailed, setCustomModelsLoadFailed] = useState(false);
+  const [customModelsLoadEpoch, setCustomModelsLoadEpoch] = useState(0);
@@
         setCustomModelIds(rows.flatMap(row => {
@@
         }));
+        setCustomModelsLoadFailed(false);
+        setCustomError("");
         setCustomModelsReady(true);
@@
         setCustomModelIds([]);
+        setCustomModelsReady(false);
+        setCustomModelsLoadFailed(true);
         setCustomError(t("models.networkError"));
       });
     return () => { active = false; };
-  }, [apiBase, item.name, t]);
+  }, [apiBase, item.name, t, customModelsLoadEpoch]);
+
+  const retryCustomModels = () => {
+    setCustomModelsReady(false);
+    setCustomModelsLoadFailed(false);
+    setCustomError("");
+    setCustomModelsLoadEpoch(epoch => epoch + 1);
+  };
@@
-      {customError && <p className="pws-inline-error" role="alert">{customError}</p>}
+      {customError && (
+        <div className="pws-inline-error" role="alert">
+          <span>{customError}</span>
+          {customModelsLoadFailed && (
+            <button type="button" className="btn btn-ghost btn-sm" onClick={retryCustomModels}>
+              {t("pws.retry")}
+            </button>
+          )}
+        </div>
+      )}
```

`gui/tests/provider-model-custom-add.test.tsx`의 `quick-add stays blocked when custom-model lookup fails`를 복구 테스트로 교체한다.

```diff
-test("quick-add stays blocked when custom-model lookup fails", async () => {
-  let posts = 0;
+test("quick-add retries a failed custom-model lookup in place and recovers", async () => {
+  let gets = 0;
+  let posts = 0;
   globalThis.fetch = (async (_input, init) => {
-    if (!init?.method || init.method === "GET") throw new Error("offline");
+    if (!init?.method || init.method === "GET") {
+      gets += 1;
+      if (gets === 1) throw new Error("offline");
+      return Response.json([]);
+    }
     posts += 1;
-    return Response.json({ id: "unexpected" }, { status: 201 });
+    return Response.json({ id: "custom-1" }, { status: 201 });
   }) as typeof fetch;
   const emptyItem = { ...item, models: [], defaultModel: undefined } as WorkspaceItem;
-  const { root, input, addButton } = await mountProviderModels([], undefined, emptyItem);
+  const { root, container, input, addButton } = await mountProviderModels([], undefined, emptyItem);
   await enterModelId(input, "unknown-custom");
   await act(async () => { await Promise.resolve(); });
 
   expect(addButton.disabled).toBe(true);
-  expect(posts).toBe(0);
+  const retry = [...container.querySelectorAll("button")]
+    .find(button => button.textContent?.trim() === "Retry") as HTMLButtonElement;
+  await act(async () => {
+    retry.click();
+    await Promise.resolve();
+    await Promise.resolve();
+  });
+  expect(gets).toBe(2);
+  expect(addButton.disabled).toBe(false);
+  await act(async () => {
+    addButton.click();
+    await Promise.resolve();
+  });
+  expect(posts).toBe(1);
```

## 검증

```bash
git diff --check
bun test tests/provider-workspace-state.test.ts tests/codex-catalog.test.ts
(cd gui && bun test tests/provider-model-custom-add.test.tsx)
(cd gui && bun run lint && bun run build)
bun run typecheck
bun run test
bun run privacy:scan
```

변경 범위 확인:

```bash
git diff --name-only -- \
  src/codex/model-cache.ts src/codex/catalog/provider-fetch.ts \
  src/server/management/model-routes.ts gui/src/provider-workspace/usage.ts \
  gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx \
  gui/src/components/provider-workspace/ProviderDetails.tsx \
  gui/src/components/provider-workspace/ProviderModels.tsx \
  gui/src/provider-workspace/report.ts gui/src/styles/provider-workspace-shell.css \
  gui/tests/provider-model-custom-add.test.tsx tests/provider-workspace-state.test.ts \
  tests/codex-catalog.test.ts
```

## 수용 기준

- [ ] PR #449 pinned head가 기준점에 clean apply된다.
- [ ] custom-only + live count 0이면 configured fallback과 custom row가 함께 보인다.
- [ ] custom/live 동일 ID overlap + live count > 0이면 configured fallback이 섞이지 않는다.
- [ ] live count는 ID 차집합이 아니라 성공한 discovery source에서 온다.
- [ ] 최초 custom-model GET 실패 시 Add는 안전하게 disabled지만 Retry CTA가 보인다.
- [ ] 같은 mount에서 Retry 성공 후 유효한 ID의 Add가 enabled되고 POST가 정확히 1회 발생한다.
- [ ] #445 파일은 변경되지 않는다.
- [ ] focused, GUI lint/build, typecheck, full tests, privacy scan이 모두 통과한다.

## 실행 영수증  _(C/D 단계에서 작성)_

- 적용 SHA:
- changed-file ledger:
- focused tests:
- GUI lint/build:
- typecheck/full/privacy:
- 독립 reviewer 판정:
- terminal outcome:
