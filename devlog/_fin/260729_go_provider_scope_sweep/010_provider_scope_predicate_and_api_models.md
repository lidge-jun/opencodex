# 010 — WP2: 공용 스코프 술어 + `GET /api/models`

선행: 없음. 이 유닛의 기반층이다.
상태: 계획.

## 목표

신고된 버그를 고친다: `/api/models`가 설정에 없는 프로바이더의 행을 내보내지 않게
한다. 동시에 **비활성 모델은 계속 내보낸다**(`disabled: true`).

## 왜 새 헬퍼가 필요한가

`FilterVisibleRuntimeModels`는 세 가지를 한꺼번에 한다: (a) 프로바이더 스코프,
(b) `disabledModels` 제거, (c) `selectedModels` allowlist. `/api/models`에는 (a)만
필요하다. (b)를 적용하면 사용자가 끈 모델이 대시보드에서 사라져 다시 켤 수 없고,
기존 테스트(`models_catalog_test.go:57`)가 즉시 깨진다.

그래서 (a)만 떼어낸 술어를 `codex` 패키지에 새로 만든다. 기존 필터도 그 술어를
재사용하게 해서 두 경로가 갈라지지 않도록 한다.

## 변경 지도

### MODIFY `go/internal/codex/catalog_visibility.go`

새 export 함수와, 기존 필터의 인라인 조건을 그 함수로 교체:

```go
+// ProviderIsConfigured reports whether a routed model's provider is one the user
// actually configured and left enabled. The Go registry seeds EVERY built-in
// preset (cli/serve.go:335) so routing can resolve them, which means every
// user-facing list must re-apply the config scope the oracle gets for free:
// gatherRoutedModels only ever iterates Object.entries(config.providers) with
// disabled !== true (src/codex/catalog/provider-fetch.ts:505).
+func ProviderIsConfigured(cfg config.Config, provider string) bool {
+	entry, configured := cfg.Providers[provider]
+	return configured && !entry.Disabled
+}
```

`FilterVisibleRuntimeModels` 내부(현재 `:43-46`):

```go
-		provider, configured := cfg.Providers[model.Provider]
-		if !configured || provider.Disabled {
-			continue
-		}
+		if !ProviderIsConfigured(cfg, model.Provider) {
+			continue
+		}
```

`provider` 변수는 아래 `provider.SelectedModels`에서 계속 쓰이므로, 그 사용처는
별도로 조회한다:

```go
-		if len(provider.SelectedModels) > 0 && !slices.Contains(provider.SelectedModels, modelID) {
+		if selected := cfg.Providers[model.Provider].SelectedModels; len(selected) > 0 && !slices.Contains(selected, modelID) {
 			continue
 		}
```

동작은 완전히 동일하다. 기존 테스트가 그대로 통과해야 한다.

### MODIFY `go/internal/management/models.go`

`modelCatalogRows`의 `entries` 순회(현재 `:76`)에 스코프 가드를 넣는다. **넣는 위치가
중요하다** — 네이티브 판정 뒤, 커스텀 병합 앞이 아니라, 라우팅 행으로 내려가기
직전이다. 네이티브 `openai` 행은 `openai`가 설정에 있으므로 술어를 통과하지만,
설정이 비어 있는 엣지 케이스에서도 네이티브 행이 사라지지 않도록 네이티브 분기를
가드보다 **앞에** 둔다:

```go
 	for _, entry := range entries {
 		// ListModels already namespaces routed ids (bare for native GPT passthrough).
 		id := strings.TrimPrefix(entry.ID, entry.Provider+"/")
 		row := modelCatalogRow{...}
 		if entry.Provider == "openai" && !strings.Contains(entry.ID, "/") {
 			row.Native = true
 			native = append(native, row)
 			continue
 		}
+		// The registry carries every built-in preset so routing can resolve one the
+		// user may add later; the catalog must only advertise providers that are
+		// actually configured. The oracle never has to filter here because
+		// gatherRoutedModels starts from config.providers (provider-fetch.ts:505).
+		// Scoped INSIDE the entries loop on purpose: custom-model rows are merged
+		// below from config, not from the registry, and must not be dropped.
+		if !codex.ProviderIsConfigured(cfg, entry.Provider) {
+			continue
+		}
 		if entry.Provider == "combo" {
```

`cfg`가 필요하므로 함수 앞부분의 잠금 구간에서 함께 읽는다(현재 `:43-47`):

```go
 	a.mu.RLock()
 	disabled := append([]string(nil), a.config.DisabledModels...)
 	caps := cloneIntMap(a.config.ProviderContextCaps)
 	custom := sortedCustomModels(a.customModels)
+	cfg := config.Config{Providers: cloneProviderMap(a.config.Providers)}
 	a.mu.RUnlock()
```

`a.config` 전체를 복사하지 않는 이유: `config.Config`는 큰 구조체이고 여기서 필요한
것은 `Providers` 맵뿐이다. 얕은 복사로 맵을 공유하면 잠금 밖에서 읽는 순간 경쟁이
된다. 기존 `cloneIntMap` 옆에 같은 형태의 헬퍼를 둔다:

```go
+func cloneProviderMap(in map[string]config.ProviderConfig) map[string]config.ProviderConfig {
+	out := make(map[string]config.ProviderConfig, len(in))
+	for name, entry := range in {
+		out[name] = entry
+	}
+	return out
+}
```

`ProviderConfig` 자체는 값 복사로 충분하다 — 술어가 읽는 필드는 `Disabled`(bool)와
`SelectedModels`(이 경로에서는 안 읽음)뿐이다.

import에 `codex`는 이미 있고(`models.go:11`), `config`는 새로 추가한다.

### NEW 테스트 `go/internal/management/models_provider_scope_test.go`

기존 `catalogRegistry` 대신 미설정 프로바이더를 포함한 스텁을 쓴다:

```go
+type scopeRegistry struct{}
+
+func (scopeRegistry) ListModels() []types.ModelEntry {
+	return []types.ModelEntry{
+		{ID: "gpt-5.6", Provider: "openai"},
+		{ID: "configured/kept", Provider: "configured"},
+		{ID: "configured/off", Provider: "configured"},
+		{ID: "unconfigured/leaked", Provider: "unconfigured"},
+		{ID: "switchedoff/model", Provider: "switchedoff"},
+	}
+}
```

검증 3종:

1. `unconfigured/leaked`가 응답에 **없다** — 신고된 버그.
2. `switchedoff/model`(설정에 있으나 `Disabled: true`)이 **없다**.
3. `configured/off`(`DisabledModels`에 등록)는 **있고** `disabled: true`다 — 과잉 차단
   금지선 1.
4. 네이티브 `gpt-5.6` 행이 살아 있다.

## 수용 기준

1. `/api/models`에 미설정 프로바이더 행이 없다.
2. 프로바이더 단위로 꺼진 프로바이더의 행이 없다.
3. 비활성 **모델**은 여전히 행으로 나오며 `disabled: true`다.
4. 네이티브 행, 커스텀 행, 콤보 우선순위 동작이 변하지 않는다.
5. `models_catalog_test.go`의 기존 단언이 수정 없이 통과한다.

### 활성화 시나리오

테스트 레지스트리에 **설정에 없는 프로바이더가 실재**해야 새 분기가 실행된다.
`unconfigured/leaked`가 그 역할이다. 이 행이 없으면 가드가 죽어 있어도 통과한다.

## 검증

```
cd go && go build ./... && go vet ./... && go test ./internal/management/ ./internal/codex/ -count=1
```
