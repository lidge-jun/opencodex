# 000 — go 런타임 미설정 프로바이더 누출 전수조사

브랜치 `codex/260729-go-model-list-provider-filter` (기준 `9014787d3`, dev2-go), 작성 2026-07-29.
워크트리 `/Users/jun/.codex/worktrees/98eb-go`.
세션 goalplan: `.codexclaw/goalplans/go-runtime-unconfigured-provider-leakage-full-sw/`.

## 신고된 증상과 실측

사용자 신고: "선택되지 않은 프로바이더의 모델들도 모델 목록에 뜬다 (go에서만)".

라이브 프록시(`127.0.0.1:10100`, go 런타임)에 실제로 물었다:

```
GET /api/models  →  199행 / 26 프로바이더
~/.opencodex/config.json providers  →  10개
  alibaba-token-plan-intl, anthropic, cursor, google-antigravity, kimi,
  openai, opencode-free, opencode-go, xai, zenmux
```

응답에만 있는 16개: `anthropic-apikey`, `bizrouter`, `cloudflare-workers-ai`,
`deepseek`, `github-copilot`, `google`, `kimi-code`, `kiro`, `minimax`,
`minimax-cn`, `moonshot`, `neuralwatt`, `openai-apikey`, `openrouter`,
`orcarouter`, `umans`, `zai`, `zhipu-bigmodel`. 사용자가 설정한 적 없는
프로바이더들이고, 그중 다수는 키가 없어 라우팅되지도 않는다.

## 뿌리

`go/internal/cli/serve.go:335`:

```go
base := registry.New().Entries()   // 내장 프리셋 전체(약 26개)
...
for name, provider := range cfg.Providers { ... }   // 사용자 설정을 그 위에 덮어씀
configured := registry.New(base...)
```

`configuredRegistry`라는 이름과 달리, 이 레지스트리는 **설정 여부와 무관하게 내장
프리셋 전체를 싣는다.** 사용자 설정은 그 위에 얹히는 오버레이일 뿐이다. 따라서
`ProviderRegistry.ListModels()`(`registry/registry.go:397`)는 항상 프리셋 전체의 모델을
뱉는다.

이 설계 자체는 라우팅 관점에서 합리적이다 — `ResolveModel`이 프리셋 baseURL/adapter를
알아야 하고, `configuredComboProviders`(`serve.go:239`)도 프리셋 전체를 순회한다.
**문제는 레지스트리가 아니라, 그 레지스트리를 사용자 대면 목록으로 그대로 흘리는
표면들이다.**

### 오라클은 구조적으로 이 문제가 없다

TS에는 "프리셋 전체 레지스트리"에서 목록을 만드는 경로가 아예 없다.
`gatherRoutedModels`(`src/codex/catalog/provider-fetch.ts:492` 선언, 스코프는 `:505-511`)가
유일한 라우팅 카탈로그 원천이고, 그 첫 동작이 곧 스코프다:

```ts
const activeProviders = Object.entries(config.providers)
  .filter(([, prov]) => prov.disabled !== true)
```

증강 경로 두 개도 설정을 벗어나지 않는다:

- `augmentRoutedModelsWithRegistryOpenAiApiRows`(선언 `:618`) — 본문 첫 두 줄(`:622-623`)이
  `const configured = config.providers[OPENAI_API_PROVIDER_ID];`와
  `if (!configured || configured.disabled === true) return models;`
- `augmentRoutedModelsWithJawcodeMetadata`(선언 `:671`) — `providerNames`로 `activeProviders`의
  이름만 받는다(호출부 `:516`).

즉 오라클에서 "설정 안 한 프로바이더의 모델"은 카탈로그에 **들어올 방법이 없다.**
go는 원천이 프리셋 전체이므로, 각 소비 표면이 스스로 걸러야 한다.

## 이미 있는 필터와 그 한계

`go/internal/codex/catalog_visibility.go:15 FilterVisibleRuntimeModels`가 올바른
config-scoped 필터다:

```go
provider, configured := cfg.Providers[model.Provider]
if !configured || provider.Disabled { continue }
```

`/v1/models`(`server/data_plane.go:36`)는 이미 이걸 통과시킨다. **그래서 데이터 평면은
정상이고, 관리 평면만 샌다.**

하지만 이 필터는 두 가지를 **추가로** 한다:

1. `disabled[...]` — 사용자가 끈 모델을 목록에서 **제거**한다.
2. `provider.SelectedModels` allowlist를 적용한다.

`/api/models`(대시보드 모델 페이지)는 끈 모델을 제거하면 **안 된다** — `disabled: true`로
표시해서 사용자가 다시 켤 수 있어야 한다. 오라클도 그렇게 한다: 라우팅 행은
`model-routes.ts:110-112`, 커스텀 행은 `:86`에서 `disabled` **플래그**를 계산할 뿐 행을
버리지 않는다. go 테스트도 그걸 못박고 있다
(`management/models_catalog_test.go:57` "disabled row"). 그러므로 **`/api/models`에
`FilterVisibleRuntimeModels`를 그대로 재사용하는 것은 과잉 차단이며 금지**다.

### allowlist(`selectedModels`)는 어디에 속하는가 — 감사에서 확정

`FilterVisibleRuntimeModels`가 하는 세 번째 일(`catalog_visibility.go:57`
`provider.SelectedModels`)은 **picker 라우트 전부에 적용되는 것이 아니다.** 오라클에서
allowlist를 적용하는 함수는 `filterCatalogVisibleModels`(`provider-fetch.ts:469-489`)
하나뿐이고, 그 호출자는 넷뿐이다:

```
src/codex/catalog/sync.ts:485
src/server/management/agent-settings-routes.ts:85
src/server/management/shared.ts:189
src/server/management/shared.ts:220
```

`/api/models`, `/api/selected-models`, `/api/subagent-model-fallback`,
`/api/claude-code` — 이 유닛이 고치는 네 라우트는 **어디에도 없다.** 따라서 이 유닛의
모든 수정은 allowlist를 건드리지 않는다. 이 사실을 놓치면 누출을 막으면서 정반대
방향의 과잉 차단을 새로 만든다(A-phase 감사가 실제로 그 오류를 잡아냈다).

→ 필요한 것은 더 약한 술어 하나: **프로바이더 스코프만** 보는 필터.

## 전수조사 결과 — 표면 목록

`rg`로 `ListModels()` / `Entries()` / `registry.Providers` / `registry.New()` 호출을
전부 훑고, 각각을 오라클 대응 핸들러와 대조했다.

### A. 필터 누락 — 고쳐야 하는 것

| # | go 위치 | 표면 | 오라클 대응 | 필요한 필터 | 증상 |
| --- | --- | --- | --- | --- | --- |
| 1 | `management/models.go:41` | `GET /api/models` | `model-routes.ts:67-68` | 프로바이더 스코프만 | **신고된 버그.** 대시보드 모델 목록에 미설정 프로바이더 |
| 2 | `management/models.go:290` | `GET /api/selected-models` `available` | `model-routes.ts:324-327` | 프로바이더 스코프만 | 모델 선택 UI가 미설정 프로바이더를 제안 |
| 3 | `management/runtime_settings.go:60` | `availableModels()` → `:121`, `:199` | `agent-settings-routes.ts:352-359`, `:616-628` | 스코프 + disabled | 서브에이전트 폴백/claude-code `available` |
| 4 | `management/runtime_settings.go:205` | `/api/claude-code` `aliases` | `agent-settings-routes.ts:636-638` | 스코프 + disabled | 미설정 프로바이더의 claude 별칭 발급 |

**필터 열이 세 라우트에서 서로 다르다는 점이 이 유닛의 핵심이다.** 하나의 만능 필터로
통일하려는 유혹이 정확히 A-phase가 잡아낸 오류였다. 1·2번은 비활성 모델을 남겨야 하고
(각각 플래그로 표시하거나 그냥 나열), 3·4번은 비활성을 빼야 하며, **넷 다 allowlist는
적용하지 않는다.**

3번은 선행 유닛 `260729_go_parity_chase`의 `010`/`050`이 "남기는 것"으로 명시적으로
미룬 항목이다. 그 문서는 비활성 모델 필터만 다뤘고 **프로바이더 스코프는 다루지
않았다.** 이 유닛이 그 후속이다.

### B. 이미 올바른 것 (회귀 방지 대상)

| go 위치 | 근거 |
| --- | --- |
| `server/data_plane.go:36` `/v1/models` | `FilterVisibleRuntimeModels` 적용 |
| `management/grok.go:115` grok 후보 | 동일 |
| `management/claude_desktop.go:230` | 동일 |
| `management/runtime_settings.go:97` `availableModelsExcludingDisabled` | 동일 |
| `management/runtime_settings.go:248` / `cli/runtime_management.go:347` claude context windows | 동일 |
| `cli/claude_desktop.go:159` | 동일 |
| `cli/grok_lifecycle.go:57` | 동일 |

### C. 프리셋 전체가 정당한 것 (건드리지 않음)

| go 위치 | 왜 정당한가 |
| --- | --- |
| `management/providers.go:16` `/api/provider-presets` | "추가할 수 있는 프로바이더" 목록. 오라클 `deriveProviderPresets`도 레지스트리 전체 |
| `management/providers.go:29` `/api/providers` GET | 이미 `a.config.Providers`만 순회 — 설정 스코프 |
| `management/provider_destination.go:50` | 프리셋의 private-network 기본값 조회. 목록 아님 |
| `cli/init.go:22` `ocx init` 메뉴 | 초기 설정 시 고를 후보 목록 |
| `cli/serve.go:239` `configuredComboProviders` | 콤보 타깃 해석용 내부 맵. 사용자 대면 목록 아님 |
| `cli/cursor_discovery.go:36` | cursor 프리셋 단건 조회 |

### D. 런타임 조회 — 목록이 아니므로 스코프 대상 아님

| go 위치 | 성격 |
| --- | --- |
| `server/router.go:46-56` `SupportedEfforts` | 목록이 아니라 **이미 라우팅이 해석한** 모델의 effort 조회. 스코프를 걸면 정상 요청이 effort를 잃는다. WP4에서 근거 주석만 단다 |
| `cli/live_config.go:53` | 설정 변경 시 레지스트리 재구성. 사용자 대면 출력이 아니다 |

### 스윕 대장 (분류 근거)

감사 지적 #6에 따라 분류 기준을 명시한다. 각 호출부는 넷 중 하나다:

| 분류 | 뜻 | 조치 |
| --- | --- | --- |
| user-facing list | 사용자가 보고 고르는 목록 | 오라클 대응부의 필터를 그대로 이식 |
| runtime lookup | 이미 해석된 대상의 메타데이터 조회 | 무필터 유지 + 근거 주석 |
| preset picker | "추가할 수 있는 것" 목록 | 프리셋 전체 유지 |
| internal map | 라우팅/콤보 해석용 내부 자료구조 | 무필터 유지 |

§A는 user-facing list, §C는 preset picker + internal map, §D는 runtime lookup이다.

## 과잉 차단 금지선

세 가지를 깨면 안 된다. WP2 이후 모든 사이클의 회귀 기준이다.

1. **비활성 모델은 `/api/models`에 남아야 한다** (`disabled: true`). 이걸 지우면
   사용자가 다시 켤 방법이 사라진다.
2. **콤보/커스텀 행은 살아야 한다.** 콤보는 go 레지스트리에 들어오지 않으므로
   (`rg "combo" go/internal/registry` 무결과) 레지스트리 필터가 콤보를 지울 수는 없지만,
   커스텀 모델 행(`customRows`)은 레지스트리와 무관하게 합쳐지므로 필터를 **엉뚱한
   지점**에 넣으면 함께 잘린다. 필터는 `entries` 순회 안쪽에만 건다.
3. **네이티브 OpenAI 행은 살아야 한다.** `openai`는 사용자 설정에 있으므로 스코프
   술어를 통과하지만, 프리셋에 없는 설정에서도 네이티브 행이 유지되는지 테스트로
   못박는다.

## 작업 단계 지도 (의존 순서)

PHASE-SPLIT-01: 노력이 아니라 의존 구조로 나눴다. 공용 술어가 먼저 서야 나머지가
그걸 소비한다.

| 단계 | 문서 | 내용 | 선행 |
| --- | --- | --- | --- |
| WP2 | `010` | 공용 스코프 술어 + `/api/models` (신고 버그) | 없음 |
| WP3 | `020` | `/api/selected-models` + `availableModels()` 2개 소비처 | WP2의 술어 |
| WP4 | `030` | claude `aliases` + `SupportedEfforts` 판정 + 잔여 정리 | WP2의 술어 |
| WP5 | `040` | 전체 검증: build/test/라이브 재측정/문서 마감 | WP2-4 |

## 검증 계약

각 구현 사이클의 C는 최소한:

```
cd go && go build ./... && go vet ./... && go test ./internal/management/ ./internal/server/ ./internal/codex/ -count=1
```

WP5는 여기에 전체 스위트와 **라이브 재측정**을 더한다: 새 바이너리를 빌드해
`GET /api/models`를 다시 찍고, 프로바이더 수가 26 → 10으로 떨어지는 것을 읽는다.

### 활성화 시나리오 (C-ACTIVATION-GROUNDING-01)

이 유닛이 추가하는 조건 분기는 "프로바이더가 설정에 없으면 건너뛴다" 하나다. 죽은
분기로 통과하지 않으려면 **설정에 없는 프로바이더가 레지스트리에 실재하는 상태**에서
측정해야 한다. 사용자의 실제 설정이 정확히 그 상태다(26 vs 10). 빈 목록이나 프로바이더
수 무변화는 어느 쪽도 통과가 아니다.
