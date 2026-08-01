# 041 — 마감 증거

선행: WP2(`010`), WP3(`020`), WP4(`030`), 그리고 WP5의 동시성 정리.
상태: 완료.

## 랜딩한 커밋

브랜치 `codex/260729-go-model-list-provider-filter` (기준 `9014787d3`, dev2-go).

| 커밋 | 내용 |
| --- | --- |
| `2a8395c9c` | 로드맵 문서 유닛 |
| `2b1dc3dc1` | `GET /api/models` 스코프, `codex.ProviderIsConfigured` 추가 |
| `c98c45f83` | `/api/selected-models` `available` 스코프, `availableModels()` 스코프+비활성, `codex.ModelIsDisabled` 추가 |
| `7b85e62d5` | `/api/claude-code` `aliases` 스코프, 라우팅 접두 수정, `SupportedEfforts` 근거 주석 |
| `09f655517` | 카탈로그 필터가 순회하는 설정의 스냅샷 정리, claude-code 단일 스냅샷 |

`git push`는 하지 않았다 — 사용자 승인 사항.

## 최종 라이브 측정

새 바이너리를 격리된 홈과 포트 10880에 띄우고 사용자의 실제 설정(프로바이더 10개)을
읽혔다. 사용자의 10100 인스턴스는 건드리지 않았다.

| 표면 | BEFORE | AFTER | 미설정 누출 |
| --- | --- | --- | --- |
| `GET /api/models` | 199행 / 26 프로바이더 | 96행 / 8 프로바이더 | `[]` |
| `GET /api/selected-models` `available` | 26 키 | 8 키 | `[]` |
| `GET /api/subagent-model-fallback` | 199 슬러그 | 31 슬러그 | `[]` |
| `GET /api/claude-code` `available` | 199 슬러그 | 31 슬러그 | `[]` |
| `GET /api/claude-code` `aliases` | 199 항목 / 26 프로바이더 | 31 항목 / 8 프로바이더 | `[]` |

`aliases`와 `available`의 개수가 일치한다 — 두 필드가 같은 스냅샷에서 나온다는 증거다.

alias 형태도 오라클과 맞다:

```
BEFORE  {"id": "cursor/auto", "display_name": "cursor/auto (cursor)"}
AFTER   {"id": "claude-ocx-cursor--claude-4-sonnet-1m", "display_name": "claude-4-sonnet-1m (cursor)"}
```

8과 10의 차이는 과잉 차단이 아니다. `opencode-free`와 `opencode-go`는 설정에 있으나
레지스트리에 모델을 기여하지 않는다.

## 정적 게이트

```
cd go && go build ./... && go vet ./... && go test ./... -count=1     → exit 0
go test -race ./internal/management/ ./internal/codex/ -count=1        → ok
```

teardown: 임시 인스턴스 종료 확인(`remaining=[]`, `10880=000`), 사용자 인스턴스
`10100=200` 무손상.

## 감사 이력

총 6라운드, gpt-5.5 서브에이전트. 채택한 블로커 14건.

| 사이클 | 라운드 | 판정 | 주요 블로커 |
| --- | --- | --- | --- |
| WP1 | 1 | FAIL(6) | picker 라우트에 `selectedModels` 오적용, 얕은 config 복사, 인용 오류 |
| WP1 | 2 | FAIL(4) | 네임스페이스 id 정규화 누락, 네이티브 행 과잉 차단, 모순된 수용 기준 |
| WP2 | 1 | PASS | (Low 2건 채택: 기존 `cloneProviders` 재사용, 정확한 생존 집합 단언) |
| WP3 | 1 | PASS | (Low 1건 채택: 고정된 테스트 갱신) |
| WP4 | 1 | GO-WITH-FIXES(1) | 라우팅 행 접두 미제거 |
| WP5 | 1 | GO-WITH-FIXES(3) | 남은 얕은 복사 2건, claude-code 이중 스냅샷 |

감사가 실제로 방향을 바꾼 지점이 둘 있다. 하나는 "picker니까 기존 필터를 재사용하자"는
판단으로, 그대로 갔으면 누출을 막으면서 allowlist를 설정한 사용자에게서 모델을 부당하게
숨겼을 것이다. 다른 하나는 네이티브 행으로, 오라클이 그것을 라우팅 카탈로그가 아닌
`listCatalogNativeSlugs`로 공급한다는 사실을 놓쳤으면 `openai`를 명시하지 않은 설정에서
네이티브 모델이 통째로 사라졌을 것이다.

리뷰어 3명은 무응답/압축 오류로 은퇴시켰다(DISPATCH-RETIRE-01). 그중 두 번은 좁은
질문 패킷으로 재발주해 답을 받았다 — 넓은 패킷이 압축 한계를 건드린 것으로 보인다.

## 남기는 것

세 항목 모두 이 유닛의 결함이 아니라 **더 오래되고 더 넓은** 발산이다.

1. **raw 인코딩 이전 형태의 비활성 매칭.** `disabledModels`에 `p/vendor/model`처럼
   인코딩 전 형태로 저장된 항목은 go의 **어떤** 필터도 잡지 못한다. `ListModels`가
   인코딩된 id만 내보내므로 내부 슬래시가 필터에 닿기 전에 사라진다. 오라클은 카탈로그
   모델에 원본 id를 들고 있어 매칭한다. 수정하지 않은 `FilterVisibleRuntimeModels`로
   직접 탐침해 같은 한계를 확인했다 — 이번 변경이 만든 회귀가 아니다.
2. **네이티브 슬러그 형태.** `available`의 네이티브 항목이 go에서는
   `openai/gpt-5.6-luna`(namespaced), 오라클에서는 `gpt-5.6-luna`(bare)다. 선행 유닛
   `260729_go_parity_chase/050`이 이미 지목했다.
3. **네이티브 alias 형태.** 오라클은 `claudeCodeNativeAlias`와 `(native)` 표기를 쓰고
   go는 `claude-ocx-openai--<slug>`와 `(openai)`를 쓴다. 2번과 같은 뿌리이며, 세 라우트와
   GUI 저장 형태를 함께 봐야 하는 별개 유닛이다.
