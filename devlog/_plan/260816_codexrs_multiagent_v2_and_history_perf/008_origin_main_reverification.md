# 008 — origin/main 재검증 (9dd22890f → 49db349ff, +181 커밋)

사용자가 "myth는 OpenAI 공식 컨펌"이라고 지적하여, 로컬 체크아웃이 4일 뒤처져 있던 것을
확인하고 `git fetch` 후 181개 신규 커밋을 재조사했다.

## 로컬 체크아웃이 실제로 오래되어 있었다

| | 커밋 | 날짜 |
| --- | --- | --- |
| 재검증 전 로컬 HEAD | `9dd22890f` | 2026-08-12 |
| `origin/main` | `49db349ff` | 2026-08-15 |
| 격차 | **181 커밋** | |

005의 웹 조사가 `27.6s → 1.7s` / `741턴` / `~98%` 수치의 1차 출처를 찾지 못한 것은
사실이지만, **그것이 수치가 틀렸다는 뜻은 아니다**. 공식 발표(사용자 확인)를 신뢰하고,
아래는 그 발표를 뒷받침하는 런타임 패치를 커밋으로 특정한 결과다.

## 런타임 자체를 바꾼 패치 (성능 계열, 신규 181커밋 내)

| 커밋 | PR | 무엇을 바꿨나 |
| --- | --- | --- |
| `1bb6384c1` | #38604 | **resume 왕복 제거.** 레거시 rollout을 `excludeTurns`로 resume할 때 app-server가 페이지네이션 로딩을 거부 → TUI가 재시도하던 구조. 세션 피커가 알아낸 history mode를 resume 흐름으로 전달해 재시도 자체를 없앰 |
| `c4941302c` | #38774 | `codex exec` 영속 스레드도 페이지네이션 히스토리 사용 |
| `80ceab7aa` | #38358 | `context_manager/normalize.rs` orphan 출력 정규화 최적화 — 단일 패스 수집, orphan이 있을 때만 압축 |
| `8d4d57387` | #38244 | 히스토리 materialization/lineage/paging/turn lookup을 **불변 rollout ID 기준**으로 재키잉 |
| `42bb50d50` | #38413 | 메타데이터 업데이트가 스레드를 materialize하지 않아도 되게 — 불필요한 읽기 제거 |
| `7093e8c48` | #38217 | 서브에이전트용 캐시 MCP 서버 lazy 시작 |
| `42b5f05ce` | #38623 | MCP 툴 카탈로그 캐시에 네임스페이스 설명 보존 |
| `3d7bb2dd2` | #38242 | TUI active-cell 레이아웃 측정 캐싱 |
| `1ba9ce891`, `91d6f4899`, `49db349ff`, `5186e2ccc` | #38822 등 | TUI 렌더링 할당/클론 제거 |

`thread-store` + `history` + `context_manager` + `app-server/request_processors` 누적 diff:
**51파일, +3102 / −727**. 즉 런타임 패치는 실재하며, 규모도 크다.

## 그럼에도 이 유닛의 두 결론은 그대로 유효하다

`origin/main` 최신 소스로 직접 재확인:

1. **G1 (Luna 위임).** `multi_agents_common.rs:36-42` `model_supports_multi_agent_backend`는
   여전히 `Disabled`만 배제한다. `models.json`도 그대로 sol/terra=`v2`, **luna=`v1`**,
   gpt-5.5/5.4/5.4-mini/5.2=`null`. → opencodex의 `isEligibleV2SubagentEntry`가 `v1`을
   배제하는 한 Luna는 계속 로스터에 없다. **변경 없음.**
2. **G3 (ordinal).** `thread_history_materialization.rs`의
   "paginated rollout line for {thread_id} is missing an ordinal" 하드 에러가 그대로 존재.
   `update_thread_metadata.rs`도 여전히 `paginated` 분기 후 레거시 `SessionMeta` 경로를
   건너뛴다(`:87`, `:99`, `:121-123`). **변경 없음.**

## 002의 "PROXY-VISIBLE vs LOCAL-ONLY" 판정도 유지된다

신규 성능 패치는 TUI 렌더링, app-server resume 프로토콜, SQLite 히스토리 프로젝션,
MCP lazy 시작에 집중되어 있다. `ResponsesApiRequest`(`codex-rs/codex-api/src/common.rs`)
필드는 이 계열에서 바뀌지 않았다. 프록시가 보는 와이어는 여전히 `/v1/responses/compact`
계열이 유일한 예외다.

## 정정 사항

`000_plan.md`와 `002`가 "`27.6s → 1.7s`는 UNVERIFIED"라고 적은 것은 **웹 1차 출처를 찾지
못했다**는 의미로 한정되어야 하며, 공식 발표를 부정하는 근거로 읽혀서는 안 된다. 수치를
뒷받침하는 런타임 패치는 위 표대로 실재한다. 다만 `332eac4b8`의 N+1 제거가 로컬 SQLite
쿼리 수 감소라는 **메커니즘 분석 자체는** 소스로 확인된 그대로다 — "요청"이 프로바이더
HTTP 요청이 아니라는 점이 opencodex 관점에서 중요한 부분이고, 그 판단은 바뀌지 않는다.

## 후속 (신규 커밋에서 발견, 로드맵 영향)

- `395723b23` (#38619) "Source multi-agent instructions from the model catalog" — 멀티에이전트
  role instruction이 **모델 카탈로그에서** 공급되도록 바뀌었다. opencodex는 카탈로그를
  합성하므로 Phase 1의 후속 작업으로 조사 필요. 새 work-phase 후보 (**G14**).

