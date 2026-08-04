# 030 — WP4: claude `aliases` + `SupportedEfforts` 판정 + 잔여 정리

선행: WP2(`010`)의 `codex.ProviderIsConfigured`.
상태: 계획.

## 표면 1 — `/api/claude-code`의 `aliases`

`go/internal/management/runtime_settings.go:204-212`:

```go
if a.registry != nil {
	for _, m := range a.registry.ListModels() {
		alias := m.ID
		if !(m.Provider == "anthropic" && strings.HasPrefix(m.ID, "claude-")) && ... {
			alias = "claude-ocx-" + m.Provider + "--" + m.ID
		}
		aliases = append(aliases, claudeAlias{ID: alias, DisplayName: m.ID + " (" + m.Provider + ")"})
	}
}
```

오라클(`src/server/management/agent-settings-routes.ts:630-639`):

```ts
const aliases: { id: string; display_name: string }[] = [];
for (const slug of listCatalogNativeSlugs()) {
  if (!disabled.has(slug)) aliases.push({ id: claudeCodeNativeAlias(slug), display_name: `${slug} (native)` });
}
for (const m of models) {
  if (isDisabled(m.provider, m.id)) continue;
  aliases.push({ id: claudeCodeAlias(m.provider, m.id), display_name: `${m.id} (${m.provider})` });
}
```

`models`는 같은 핸들러 `:616`의 `await fetchAllModels(config)` — config-scoped. 그리고
비활성 모델도 `continue`로 뺀다.

즉 go의 alias 목록은 **두 축 모두** 어긋나 있다: 미설정 프로바이더가 들어오고, 비활성
모델도 들어온다. 사용자가 겪는 것: Claude Code 모델 목록에 설정한 적 없는 프로바이더의
`claude-ocx-<provider>--<model>` 별칭이 대량으로 뜨고, 고르면 라우팅이 실패한다.

### 변경 (A-phase 감사에서 수정됨)

처음 계획은 alias 루프를 `codex.FilterVisibleRuntimeModels`로 감싸는 것이었다.
**감사에서 뒤집혔다** — WP3와 같은 이유다. 그 필터는 `selectedModels` allowlist까지
적용하는데, 오라클의 alias 루프는 비활성만 거른다:

```ts
// src/server/management/agent-settings-routes.ts:636-638
for (const m of models) {
  if (isDisabled(m.provider, m.id)) continue;
  aliases.push({ id: claudeCodeAlias(m.provider, m.id), display_name: `${m.id} (${m.provider})` });
}
```

`models`는 `:616`의 `fetchAllModels(config)`이므로 config-scoped이고, `isDisabled`는
`:622`의 `disabledModels` 비교뿐이다. allowlist는 없다.

즉 alias가 원하는 집합은 WP3가 고친 `availableModels()`와 **정확히 같다**: 프로바이더
스코프 + 비활성 제외, allowlist 미적용. 오라클도 두 필드를 같은 `models` 배열에서
뽑는다.

그래서 두 필드를 하나의 원천에서 파생시킨다. WP3가 `availableModels()`를 슬러그
문자열 목록으로 만들어 두었으므로, alias 루프가 그것을 그대로 쓸 수는 없다(alias는
`m.Provider`와 `m.ID`를 따로 필요로 한다). 모델 엔트리를 반환하는 형제 헬퍼를 하나
추가하고, **WP3의 `availableModels()`가 그 위의 얇은 슬러그 변환기가 되도록** 재배치한다:

```go
+// visibleRegistryModels is the model set both `available` and `aliases` are
+// derived from on /api/claude-code, mirroring the single `models` array the
+// oracle uses for both (agent-settings-routes.ts:616, :624, :636).
+//
+// Filter contract — the three axes are NOT interchangeable:
+//   - provider scope: ROUTED rows only. Native passthrough rows come from a
+//     separate oracle path (listCatalogNativeSlugs) and never consult
+//     config.providers, because fetchProviderModels returns [] under forward
+//     auth (provider-fetch.ts:247-248).
+//   - disabledModels: applied to BOTH native and routed rows.
+//   - selectedModels: applied to NEITHER. No consumer of this list calls
+//     filterCatalogVisibleModels.
+//
+// The returned entries keep the registry's own id form: bare for native rows,
+// provider-prefixed for routed rows (registry/registry.go:403-406). Callers that
+// need a bare model id must strip the prefix themselves.
+func (a *API) visibleRegistryModels() []types.ModelEntry
```

alias 루프는 같은 헬퍼를 직접 쓴다:

```go
 	if a.registry != nil {
-		for _, m := range a.registry.ListModels() {
+		// Same source as `available` above — the oracle derives both fields from
+		// one `models` array (agent-settings-routes.ts:616), and deriving them
+		// separately is how they drifted apart.
+		for _, m := range a.visibleRegistryModels() {
 			alias := m.ID
```

이렇게 하면 WP3와 WP4가 같은 술어를 공유하므로 두 필드가 다시 어긋날 수 없다.

### 라우팅 행의 접두 처리 — 감사에서 추가된 항목

감사(리뷰어 019fadf7, Medium)가 짚은 것: 레지스트리의 라우팅 행 `ID`는 이미
`provider/model` 형태인데(`registry/registry.go:403`), alias 분기는 그것을 bare id로
가정한다. 현재 조건(`runtime_settings.go:230`)이 `!strings.Contains(m.ID, "/")`를
요구하므로, 라우팅 행은 **접두 분기를 아예 타지 못하고** `alias = m.ID`로 떨어진다.

라이브 응답으로 확인했다:

```
{"id": "cursor/auto", "display_name": "cursor/auto (cursor)"}
{"id": "alibaba-token-plan-intl/MiniMax-M2.5", "display_name": "alibaba-token-plan-intl/MiniMax-M2.5 (alibaba-token-plan-intl)"}
```

오라클은 `claudeCodeAlias(m.provider, m.id)`와 `` `${m.id} (${m.provider})` ``를 쓰므로
(`agent-settings-routes.ts:637-638`), id는 `claude-ocx-cursor--auto`, 표시는
`auto (cursor)`여야 한다. 지금은 둘 다 틀렸고, 표시명은 프로바이더 이름을 두 번 적는다.

**이 유닛에서 함께 고친다.** 별개 결함으로 미루지 않는 이유: alias 루프를 새 헬퍼로
갈아끼우는 바로 그 줄을 건드리므로, 지금 고치지 않으면 "이 줄은 봤지만 틀린 건 놔뒀다"가
된다. 그리고 alias 형태를 못박은 테스트가 하나도 없어(`rg "claude-ocx-" go/internal/management/*_test.go`
무결과) 회귀 위험도 낮다.

```go
 		for _, m := range a.visibleRegistryModels() {
-			alias := m.ID
-			if !(m.Provider == "anthropic" && strings.HasPrefix(m.ID, "claude-")) && m.Provider != "" && !strings.Contains(m.Provider, "--") && !strings.Contains(m.Provider, "/") && !strings.Contains(m.ID, "/") {
-				alias = "claude-ocx-" + m.Provider + "--" + m.ID
-			}
-			aliases = append(aliases, claudeAlias{ID: alias, DisplayName: m.ID + " (" + m.Provider + ")"})
+			// ListModels namespaces routed ids, while the alias form is built from
+			// the bare one (oracle: claudeCodeAlias(m.provider, m.id),
+			// agent-settings-routes.ts:637). Without the strip a routed row kept its
+			// prefixed id as its own alias and named its provider twice.
+			id := strings.TrimPrefix(m.ID, m.Provider+"/")
+			alias := id
+			if !(m.Provider == "anthropic" && strings.HasPrefix(id, "claude-")) && m.Provider != "" && !strings.Contains(m.Provider, "--") && !strings.Contains(m.Provider, "/") && !strings.Contains(id, "/") {
+				alias = "claude-ocx-" + m.Provider + "--" + id
+			}
+			aliases = append(aliases, claudeAlias{ID: alias, DisplayName: id + " (" + m.Provider + ")"})
 		}
```

`!strings.Contains(id, "/")` 가드는 남긴다 — 벤더 네임스페이스가 인코딩되지 않은 채로
들어오는 경우 `claude-ocx-p--vendor/model`이라는 잘못된 셀렉터가 생기는 것을 막는다.

### 네이티브 alias 형태는 이 유닛에서 바꾸지 않는다

감사 라운드 2(Medium #4)가 지적한 대로, 오라클은 네이티브와 라우팅에 **서로 다른 alias
함수**를 쓴다:

```ts
// agent-settings-routes.ts:631-634  네이티브
aliases.push({ id: claudeCodeNativeAlias(slug), display_name: `${slug} (native)` });
// agent-settings-routes.ts:636-638  라우팅
aliases.push({ id: claudeCodeAlias(m.provider, m.id), display_name: `${m.id} (${m.provider})` });
```

go의 현재 분기는 네이티브 행도 `claude-ocx-openai--<slug>`로 만들고 `(openai)` 표기를
쓴다. **이건 이 유닛의 버그가 아니라 형태 발산이고, 고치지 않는다.** 이유는 선행 유닛
`260729_go_parity_chase/050`의 "남기는 것"과 같다: 네이티브 슬러그 형태는 세 라우트와
GUI 저장 형태를 함께 봐야 하고, 여기서 바꾸면 이 유닛의 범위를 넘는 응답 변경이 된다.

따라서 `visibleRegistryModels`는 네이티브 행을 **포함해서** 반환하고, alias 루프의 기존
네이티브 처리 분기는 손대지 않는다. 이 유닛이 바꾸는 것은 오직 "미설정 프로바이더의
라우팅 행이 alias를 발급받지 않는다"와 "비활성 모델이 alias를 발급받지 않는다" 둘뿐이다.
D에서 형태 발산을 후속 후보로 다시 기록한다.

`FilterVisibleRuntimeModels`가 반환하는 네이티브 행은 `Provider == "openai"`이고 ID에
`/`가 없으므로, 기존 alias 분기가 이미 그것을 `claude-ocx-openai--gpt-5.6` 형태로 만든다.
오라클은 네이티브를 `claudeCodeNativeAlias(slug)` + `"(native)"` 표기로 따로 만든다.
**이 형태 차이는 이 유닛의 범위가 아니다** — 선행 유닛 `050`의 "남기는 것"이 지목한
네이티브 슬러그 형태 발산과 같은 뿌리이고, 세 라우트와 GUI 저장 형태를 함께 봐야
한다. 여기서는 **누출만** 막고, 형태 발산은 D에서 후속 후보로 재기록한다.

### 테스트

`go/internal/management/claude_aliases_scope_test.go` (신규):

1. 미설정 프로바이더의 alias가 없다.
2. 비활성 모델의 alias가 없다.
3. 설정된 프로바이더의 alias는 그대로 있고 `DisplayName` 형식이 변하지 않는다.
4. `anthropic`의 `claude-` 접두 모델은 여전히 별칭 없이 원본 ID로 나온다.
5. **네이티브 OpenAI alias는 `openai`가 설정에 없어도 계속 발급된다** — 형태
   (`claude-ocx-openai--...`)도 변하지 않는다.
6. 라우팅 행의 alias가 `claude-ocx-<provider>--<bare id>`이고 표시명이
   `<bare id> (<provider>)`이다 — 프로바이더 이름이 한 번만 나온다.

## 표면 2 — `server/router.go:50 SupportedEfforts`

```go
func (r ModelRouter) SupportedEfforts(resolved *types.ResolvedModel) []string {
	for _, model := range r.Registry.ListModels() {
		if model.Provider == resolved.Provider && model.ID == resolved.Model {
			return append([]string(nil), model.ReasoningEfforts...)
		}
	}
	return nil
}
```

### 판정: 고치지 않는다 (정당한 무필터)

이건 **목록이 아니다.** 입력은 이미 라우팅이 해석에 성공한 `*types.ResolvedModel`이고,
출력은 그 한 모델의 reasoning effort 배열이다. 사용자에게 프로바이더 목록을 보여주는
표면이 아니다.

여기에 config 스코프를 걸면 순효과는 **기능 손실**뿐이다: 라우팅이 이미 허용한 요청에
대해 effort 메타데이터만 `nil`이 되어, 지원되는 effort가 조용히 무시된다. 누출은 막지
못한다 — 애초에 이 함수는 아무것도 열거하지 않기 때문이다.

WP4는 동작을 바꾸지 않는다. 다만 다음 사람이 이 자리를 "빠뜨린 표면"으로 착각하지
않도록 근거 주석을 단다 — **동작 변경이 아닌 문서화 목적의 코드 변경**이며, 그
구분을 여기 명시한다(감사 지적 #5):

실제 함수 위치는 `go/internal/server/router.go:46-56`이다.

```go
+// Not config-scoped on purpose: the input is a model routing already resolved, so
+// this is a metadata lookup, not a user-facing list. Scoping it would only strip
+// efforts from requests the router already accepted.
 func (r ModelRouter) SupportedEfforts(resolved *types.ResolvedModel) []string {
```

## 표면 3 — 잔여 확인 (코드 변경 없음, 문서만)

`000_plan.md` §C가 프리셋 전체로 남겨야 할 표면 6개를 열거했다. WP4의 C에서 각각을
다시 확인하고, 하나라도 사용자 대면 목록으로 밝혀지면 goalplan에 work-phase를
추가한다(LOOP-UNIT-CHAIN-01). 특히:

- `management/providers.go:16 /api/provider-presets` — 오라클
  `deriveProviderPresets`도 레지스트리 전체를 준다. "추가할 수 있는 프로바이더"이므로
  스코프를 걸면 사용자가 새 프로바이더를 **추가할 수 없게 된다**. 절대 건드리지 않는다.
- `cli/init.go:22` — 같은 이유.

## 수용 기준

1. `/api/claude-code`의 `aliases`에 미설정 프로바이더 항목이 없다.
2. 같은 배열에 비활성 모델 항목이 없다.
3. `available`과 `aliases`가 같은 모델 집합(`visibleRegistryModels`)에서 파생된다.
4. 네이티브 alias의 존재와 형태가 변하지 않는다.
5. `SupportedEfforts`의 동작이 변하지 않고, 무필터 근거가 코드와 문서 양쪽에 남는다.
6. `/api/provider-presets`와 `ocx init` 메뉴의 출력이 변하지 않는다.

### 활성화 시나리오

alias 루프의 새 필터가 실제로 무언가를 지우는지 보려면, 테스트 레지스트리에 미설정
프로바이더와 비활성 모델이 **둘 다** 있어야 한다. alias 배열 길이만 세지 말고 특정
alias 문자열의 부재를 단언한다.

## 검증

```
cd go && go build ./... && go vet ./... && go test ./internal/management/ ./internal/server/ -count=1
```
