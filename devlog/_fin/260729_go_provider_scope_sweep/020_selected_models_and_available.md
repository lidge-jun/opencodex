# 020 — WP3: `/api/selected-models` `available` + `availableModels()` 소비처

선행: WP2(`010`)의 `codex.ProviderIsConfigured`.
상태: 계획.

## 무엇이 깨져 있나

두 계열 모두 "사용자가 고를 수 있는 모델" 목록인데, 레지스트리 전체를 그대로 준다.

### 계열 1 — `GET /api/selected-models`의 `available`

`go/internal/management/models.go:288-295`:

```go
available := map[string][]string{}
if a.registry != nil {
	for _, model := range a.registry.ListModels() {
		available[model.Provider] = append(available[model.Provider], ...)
	}
}
```

오라클(`src/server/management/model-routes.ts:325-327`):

```ts
const models = await fetchAllModels(config);
const available: Record<string, string[]> = {};
for (const m of models) (available[m.provider] ??= []).push(m.id);
```

`fetchAllModels` → `gatherRoutedModels` → `config.providers`만 순회. 즉 오라클의
`available` 키 집합은 **설정된 프로바이더 이름들뿐**이다. go는 26개 키를 준다.

사용자가 겪는 것: 모델 선택 화면이 설정하지도 않은 프로바이더 섹션을 잔뜩 그린다.
거기서 모델을 고르면 `selectedModels`에 저장은 되지만 라우팅되지 않는다.

오라클은 여기서 `disabledModels`를 **거르지 않는다**(그냥 `models`를 그대로 편다).
따라서 go도 프로바이더 스코프만 걸고 비활성 모델은 남긴다 — `FilterVisibleRuntimeModels`
재사용은 여기서도 과잉이다.

### 계열 2 — `availableModels()`

`go/internal/management/runtime_settings.go:56-75`. 소비처 두 곳:

| 소비처 | go | 오라클 |
| --- | --- | --- |
| `GET /api/subagent-model-fallback` (`:121`) | `a.availableModels()` | `agent-settings-routes.ts:352-363` |
| `GET /api/claude-code` `available` (`:199`) | `a.availableModels()` | `agent-settings-routes.ts:616-628` |

오라클 두 곳 모두 `fetchAllModels(config)`에서 출발하므로 config-scoped이고, 추가로
`disabledModels`도 거른다:

```ts
// :355 subagent-model-fallback
const visibleRouted = [...new Set(models
  .filter(m => ![...disabled].some(stored =>
    stored === catalogModelSlug(m) || slugEquals(stored, m.provider, m.id)))
  .map(catalogModelSlug))];
```

```ts
// :628 claude-code
...models.filter(m => !isDisabled(m.provider, m.id)).map(m => `${m.provider}/${m.id}`),
```

선행 유닛 `260729_go_parity_chase/010`은 이 비활성 필터 누락을 알고도 "형제 라우트의
응답 바이트를 바꾸므로 별개 결함"이라며 미뤘고, `050`의 "남기는 것"에도 그대로 남아
있다. **이 유닛이 그 후속이며, 프로바이더 스코프까지 함께 정리한다.**

즉 두 소비처는 이미 `availableModelsExcludingDisabled()`(`:88`)가 하는 일과 정확히
같은 것을 원한다. 그 함수는 `FilterVisibleRuntimeModels`를 쓰므로 프로바이더 스코프와
비활성 제외를 모두 만족한다.

## 결정 (A-phase 감사에서 수정됨)

처음 계획은 "`availableModels()`를 지우고 두 소비처를
`availableModelsExcludingDisabled()`로 옮긴다"였다. **감사에서 뒤집혔다.**

리뷰어가 짚은 것(High): `availableModelsExcludingDisabled`는
`FilterVisibleRuntimeModels`를 쓰므로 `provider.SelectedModels` allowlist까지 적용한다
(`go/internal/codex/catalog_visibility.go:57`). 그런데 오라클의 두 라우트는 그것을
적용하지 **않는다**. 직접 확인했다:

```ts
// src/server/management/agent-settings-routes.ts:352-359  (subagent-model-fallback)
const models = await fetchAllModels(config);
const disabled = new Set(config.disabledModels ?? []);
const visibleRouted = [...new Set(models
  .filter(m => ![...disabled].some(stored =>
    stored === catalogModelSlug(m) || slugEquals(stored, m.provider, m.id)))
  .map(catalogModelSlug))];
```

```ts
// src/server/management/agent-settings-routes.ts:621-628  (claude-code)
const disabled = new Set(config.disabledModels ?? []);
const isDisabled = (provider, id) => [...disabled].some(stored => slugEquals(stored, provider, id));
const available = [ ...listCatalogNativeSlugs().filter(ns => !disabled.has(ns)),
  ...models.filter(m => !isDisabled(m.provider, m.id)).map(m => `${m.provider}/${m.id}`) ];
```

`filterCatalogVisibleModels`(allowlist를 적용하는 함수)의 호출자를 전부 뒤지면
`catalog/sync.ts:485`, `agent-settings-routes.ts:85`, `shared.ts:189`·`:220`뿐이고
**이 두 라우트는 없다.**

따라서 원래 계획대로 옮기면 allowlist를 설정한 사용자에게서 모델이 **부당하게
사라진다** — 이 유닛이 막으려던 과잉 차단을 스스로 저지르는 셈이다.

### 수정된 결정

`availableModels()`를 **지우지 않는다.** 대신 그 안에 **프로바이더 스코프 + 비활성
제외**만 넣는다. allowlist는 건드리지 않는다.

단, 스코프는 **라우팅 행에만** 건다. 네이티브 OpenAI 행은 별도 분기다 — 감사 라운드 2의
지적(High #2)이고, 오라클에서 근거를 확인했다:

```ts
// agent-settings-routes.ts:360-362 / :624-628 — 네이티브는 config.providers를 보지 않는다
const available = [
  ...listCatalogNativeSlugs().filter(ns => !disabled.has(ns)),
  ...visibleRouted,
];
```

네이티브가 프로바이더 스코프를 타지 않는 이유는 구조적이다:
`fetchProviderModels`(`provider-fetch.ts:247-248`)가 `authMode === "forward"`이면 즉시
`[]`를 반환하므로, **네이티브 모델은 애초에 라우팅 카탈로그에 들어오지 않는다.**
오라클의 네이티브 목록은 `listCatalogNativeSlugs()`라는 완전히 다른 경로에서 온다.
go에서 `openai` 프로바이더 스코프로 네이티브를 거르면, 오라클이 계속 보여주는 모델을
숨기게 된다.

go 레지스트리에서 네이티브 행의 식별자는 명확하다(`registry/registry.go:403-406`):
`provider.ID == "openai"`일 때만 `id = model.ID`로 접두 없이 나간다. 즉
`Provider == "openai" && !strings.Contains(ID, "/")`가 네이티브 판정이고, 이는
`FilterVisibleRuntimeModels`(`catalog_visibility.go:22`)와 `modelCatalogRows`
(`management/models.go:86`)가 이미 쓰는 것과 같은 술어다.

세 계열이 서로 다른 필터 조합을 요구한다는 것이 확인됐으므로, 그 차이를 코드에
명시적으로 남긴다:

| 헬퍼 | 프로바이더 스코프 | disabledModels | selectedModels | 소비처 |
| --- | --- | --- | --- | --- |
| `availableModels()` (수정 후) | **라우팅 행에만** 적용 | 적용 | **미적용** | `subagent-model-fallback`, `claude-code` |
| `availableModelsExcludingDisabled()` | 적용 | 적용 | 적용 | `subagent-models`, `injection-model` |

두 번째 행이 오라클과 맞는지는 이 유닛의 범위가 아니다 — 선행 유닛이 세운 것이고,
`agent-settings-routes.ts:85`가 실제로 `filterCatalogVisibleModels`를 쓰므로 맞는
것으로 보인다. WP5에서 재확인만 한다.

## 변경 지도

### MODIFY `go/internal/management/models.go` (`handleSelectedModels` GET)

```go
 		available := map[string][]string{}
 		if a.registry != nil {
 			for _, model := range a.registry.ListModels() {
+				// The registry carries every built-in preset; the picker must only
+				// offer providers the user configured. Oracle: available is built
+				// from fetchAllModels, i.e. config.providers only
+				// (model-routes.ts:325). disabledModels is deliberately NOT applied
+				// here — the oracle does not filter it on this route either.
+				if !codex.ProviderIsConfigured(cfg, model.Provider) {
+					continue
+				}
 				available[model.Provider] = append(available[model.Provider], strings.TrimPrefix(model.ID, model.Provider+"/"))
 			}
 		}
```

`cfg`는 위쪽 `a.mu.RLock()` 구간(현재 `:281-287`)에서 `Providers` 맵 복사로 함께 읽는다
— WP2가 추가한 `cloneProviderMap`을 재사용한다.

`openai` 네이티브 행은 `openai`가 설정에 있으므로 통과한다. 오라클도 이 라우트에서
네이티브를 특별 취급하지 않는다.

### MODIFY `go/internal/management/runtime_settings.go`

호출부(`:121`, `:199`)는 **바꾸지 않는다.** `availableModels()` 본체만 고친다:

공용 술어를 먼저 `codex` 패키지에 세운다. 감사 라운드 2 High #1이 지적한 대로,
**bare id로 정규화하지 않고 `SlugEquals`에 넘기면 매칭이 조용히 실패한다** —
레지스트리 라우팅 행의 `ID`는 이미 `provider/model` 형태이고
(`registry/registry.go:403`), `SlugEquals(stored, provider, id)`는 `id`가 bare라고
가정한다(`registry/slug.go:33-35`). 선행 유닛 `050`이 `p/p/hidden` 이중 접두로 겪은
것과 같은 뿌리다.

`FilterVisibleRuntimeModels`가 이미 올바른 정규화를 하고 있으므로
(`catalog_visibility.go:48-54`), 그 로직을 그대로 함수로 뽑는다:

```go
+// ModelIsDisabled reports whether a registry row is switched off, tolerating every
+// form disabledModels may have been stored in. rawID may already carry the provider
+// prefix (registry.ListModels namespaces routed ids at registry/registry.go:403),
+// so it is normalized to a bare id before the slug-tolerant comparison the oracle
+// uses (src/providers/slug-codec.ts:55).
+//
+// Stored entries are TrimSpace'd to match the existing behavior of both halves of
+// the current check: the prebuilt map is keyed on strings.TrimSpace(id)
+// (catalog_visibility.go:18) and disabledBySlug trims too (:67).
+func ModelIsDisabled(disabledModels []string, provider, rawID string) bool {
+	modelID := strings.TrimPrefix(rawID, provider+"/")
+	publicID := provider + "/" + modelID
+	for _, stored := range disabledModels {
+		stored = strings.TrimSpace(stored)
+		if stored == rawID || stored == publicID || registry.SlugEquals(stored, provider, modelID) {
+			return true
+		}
+	}
+	return false
+}
```

### 동작 동일성 확인 (구현 전 필독)

현재 `FilterVisibleRuntimeModels`는 두 갈래로 나눠 검사한다(`:16-19`, `:54`):

```go
disabled[strings.TrimSpace(id)] = true      // 맵 키는 trim된 형태
...
if disabled[model.ID] || disabled[publicID] || disabledBySlug(cfg.DisabledModels, ...)
```

맵 **조회**는 trim되지 않은 `model.ID`/`publicID`로 하지만 **키**가 trim되어 있으므로,
결과적으로 "저장값을 trim한 뒤 비교"와 같다. 새 함수는 저장값을 trim해 비교하므로
동치다. 빈 문자열 저장값도 양쪽 다 어떤 실제 ID와도 일치하지 않으므로 동작이 같다.

`FilterVisibleRuntimeModels`의 해당 블록(`:50-54`)을 이 함수 호출로 교체하고, 더 이상
쓰이지 않게 되는 `disabled` 맵과 `disabledBySlug`는 남은 사용처를 확인한 뒤 정리한다
(네이티브 분기 `:27-29`가 여전히 맵을 쓰므로 맵 자체는 남는다).

`registry` 패키지는 `codex`를 import 하지 않으므로(`rg -n "internal/codex" go/internal/registry/` 무결과)
`codex` → `registry` 방향 의존만 늘어나고 순환은 생기지 않는다.

기존 테스트 `go/internal/codex/catalog_visibility_test.go`가 수정 없이 통과해야 한다 —
통과하지 않으면 추출이 동치가 아니라는 뜻이므로 되돌린다.

그 위에서 `availableModels()`:

```go
 func (a *API) availableModels() []string {
+	a.mu.RLock()
+	providers := cloneProviderMap(a.config.Providers)
+	disabled := append([]string(nil), a.config.DisabledModels...)
+	a.mu.RUnlock()
 	seen := map[string]bool{}
 	result := []string{}
 	if a.registry != nil {
 		for _, model := range a.registry.ListModels() {
+			native := model.Provider == "openai" && !strings.Contains(model.ID, "/")
+			// Provider scope applies to ROUTED rows only. Native passthrough rows
+			// reach the oracle through listCatalogNativeSlugs(), not through
+			// config.providers (agent-settings-routes.ts:360-362), because
+			// fetchProviderModels returns [] for forward auth
+			// (provider-fetch.ts:247-248). Scoping them here would hide models the
+			// oracle still offers.
+			//
+			// disabledModels IS applied to both; selectedModels is NOT applied to
+			// either — neither consumer of this list calls
+			// filterCatalogVisibleModels.
+			if !native {
+				if entry, ok := providers[model.Provider]; !ok || entry.Disabled {
+					continue
+				}
+			}
+			if codex.ModelIsDisabled(disabled, model.Provider, model.ID) {
+				continue
+			}
 			slug := model.ID
 			if model.Provider != "" && !strings.Contains(model.ID, "/") {
 				slug = model.Provider + "/" + model.ID
 			}
 			if slug != "" && !seen[slug] {
 				seen[slug] = true
 				result = append(result, slug)
 			}
 		}
 	}
 	return result
 }
```

네이티브 슬러그가 `openai/gpt-5.6` 형태로 나가는 것(오라클은 bare)은 선행 유닛 `050`이
"남기는 것"으로 남긴 별개 발산이며, 이 유닛에서 바꾸지 않는다. 여기서는 그 형태를
**유지한 채** 누출만 막는다.

`availableModels()`의 기존 주석에서 "deliberately stays unfiltered / their missing
filter is tracked separately" 문장을 지운다. 그 미해결 상태가 여기서 닫힌다.

`availableModelsExcludingDisabled`(`:85`)의 잠금 처리도 함께 고친다 — 리뷰어 지적
(Medium): `cfg = *a.config`는 `Providers` 맵 헤더만 복사하므로 잠금 해제 뒤
`FilterVisibleRuntimeModels`가 순회하는 동안 관리 API 쓰기와 경쟁한다.

```go
 	a.mu.RLock()
 	var cfg config.Config
 	if a.config != nil {
 		cfg = *a.config
+		cfg.Providers = cloneProviderMap(a.config.Providers)
+		cfg.DisabledModels = append([]string(nil), a.config.DisabledModels...)
 	}
 	a.mu.RUnlock()
```

### MODIFY 기존 테스트

`go/internal/management/agents_available_test.go`에 선행 유닛이 남긴
`...IsUnfilteredButWellFormed` 계열 단언이 있다. 그 라우트가 이제 필터를 타므로 테스트
이름과 단언을 갱신한다 — 이번에도 **의도적 갱신**이며, 근거는 위 오라클 인용이다.

### NEW 테스트 `go/internal/management/selected_models_scope_test.go`

1. `available` 맵의 키 집합이 설정된 프로바이더 이름들과 정확히 같다.
2. 미설정 프로바이더 키가 없다.
3. 비활성 **모델**은 `available`에 남는다(오라클이 안 거름).
4. `selected` 맵은 변하지 않는다.

그리고 `subagent-model-fallback`/`claude-code` 응답에서 미설정 프로바이더 슬러그가
사라지는 단언을 추가한다.

## 수용 기준

1. `/api/selected-models`의 `available` 키가 설정된 프로바이더로 한정된다.
2. 같은 라우트에서 **비활성 모델은 계속 나온다** — 오라클(`model-routes.ts:324-337`)이
   거기서 `disabledModels`를 보지 않는다.
3. `/api/subagent-model-fallback`과 `/api/claude-code`의 `available`에 미설정
   프로바이더 슬러그가 없다.
4. 그 두 라우트에서 비활성 모델도 사라진다(오라클 일치, 선행 유닛의 미해결 항목 해소).
5. **네이티브 OpenAI 슬러그는 `openai`가 설정에 없거나 꺼져 있어도 계속 나온다** —
   비활성 처리된 경우만 빠진다.
6. `availableModels()` 심볼과 그 두 호출부(`:121`, `:199`)가 **그대로 남는다.**
   어떤 호출부도 `availableModelsExcludingDisabled()`로 옮기지 않는다(라운드 1에서
   기각된 수정 방향).
7. `chosen`/`models`/`pollMs` 등 나머지 키의 값과 순서가 변하지 않는다.

### 활성화 시나리오

테스트 설정에 미설정 프로바이더 1개 + 설정됐지만 `Disabled: true`인 프로바이더 1개 +
비활성 모델 1개 + **`openai`를 설정에서 뺀 케이스**를 둔다. 네 축이 각각 다른 이유로
처리되므로, 하나라도 빠지면 어떤 분기가 죽었는지 드러난다. 특히 마지막 축은 네이티브
분기가 실제로 스코프를 우회하는지 증명한다.

비활성 매칭은 두 슬러그 형태(`p/m`, 그리고 alias 인코딩 형태)를 각각 저장해 두고 둘 다
걸러지는지 본다 — 선행 유닛 `050`이 세운 계약이고, 정규화를 빠뜨리면 여기서 깨진다.

## 검증

```
cd go && go build ./... && go vet ./... && go test ./internal/management/ ./internal/codex/ -count=1
rg -n "availableModelsExcludingDisabled" go/internal/management/runtime_settings.go
#   → :121과 :199가 이 함수를 부르지 않는 것을 눈으로 확인 (라운드 1 오류 재발 방지)
```
