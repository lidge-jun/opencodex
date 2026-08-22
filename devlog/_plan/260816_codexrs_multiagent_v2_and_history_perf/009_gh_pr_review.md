# 009 — gh PR 직접 리뷰 (로컬 ff → 49db349ff)

008은 `git log`만으로 재검증했다. 이 문서는 사용자 요청에 따라 **로컬을 fast-forward한 뒤
`gh`로 PR 본문을 직접 읽어** 성능 주장을 커밋이 아니라 **PR 서술 기준으로** 검증한 결과다.

## Fast-forward

`git merge --ff-only origin/main` → `9dd22890f` (08-12) → **`49db349ff` (08-15)**, 181 커밋.
`git rev-list --left-right --count HEAD...origin/main` = `0 0`. 충돌 없음, 로컬 변경 없음
(`.codexclaw/` untracked만 존재).

## 검색으로 확인한 것: 수치 자체는 PR에 없다

`gh api search/issues` 로 리포지토리 전체를 조회한 결과:

| 쿼리 | total_count |
| --- | --- |
| `repo:openai/codex is:pr 27.6s` | **0** |
| `repo:openai/codex is:pr "98% fewer"` | **0** |
| `741` (PR) | 무관한 2025년 릴리스 PR 1건뿐 |

즉 `27.6s → 1.7s / 741턴 / ~98%` 라는 **문구**는 공개 PR 본문에 존재하지 않는다. 005의
"1차 웹 출처 없음"과 일치한다. 공식 발표를 신뢰한다면, 그 수치는 사내 벤치마크이고
**공개된 것은 그 수치를 만든 코드**다. 아래가 그 코드다.

## PR 본문이 직접 서술한 성능 메커니즘

`gh pr view` 로 본문을 읽어 확인:

| PR | 병합 | PR이 **직접 서술한** 문제/해결 |
| --- | --- | --- |
| **#36384** | 07-31 | Why: "Loading the summary view **issued a separate item query for every returned turn**." → 요약 뷰 쿼리에 first-user/final-agent 아이템을 조인. **N+1 제거를 PR이 명시** |
| **#32234** | 07-10 | 페이지네이션 히스토리 전용 DB `thread_history_1.sqlite` 신설 — "avoid adding lock contention to the main state store" |
| **#33364** | 07-15 | app-server가 `historyMode: "paginated"` 지원. resume이 **전체 히스토리 로딩 대신** `excludeTurns: true` 요구, `turnsBackwardsCursor`/`itemsBackwardsCursor` 반환 |
| **#36948** | 08-04 | Why: "Paginated threads **should not require the TUI to load and render their entire history** when a session is resumed." → 경계 있는 초기 페이지만 하이드레이션 |
| **#36949** | 08-04 | 렌더 행 예산까지만 스캔, 반복 커서에서 페이지네이션 중단 |
| **#36950** | 08-04 | 스크롤 시 페이지 단위 로드, 레거시 서버 폴백 |
| **#36951** | 08-04 | 페이지네이션 resume/transcript/fork를 bounded 요청으로 유지 |
| **#38604** | 08-14 | Why: 레거시 rollout을 `excludeTurns`로 resume하면 app-server가 거부 → **TUI가 재시도**. 피커의 history mode를 resume에 전달해 **왕복 자체를 제거** |
| **#34563** | 07-21 | 상속된 fork 계보를 세그먼트 단위로 페이지네이션 |
| **#34361** | 07-20 | 토큰 사용량 replay에서 **전체 히스토리 clone 회피** |
| **#38774** | 08-15 | `codex exec` 영속 스레드도 페이지네이션 사용 |

"긴 대화 로딩이 느리고 메모리를 먹는다"는 증상에 대해, PR들이 스스로 밝힌 원인은
**턴마다 쿼리 1회(N+1) + 전체 트랜스크립트 로드/렌더 + 전체 히스토리 clone + 불필요한
resume 재시도**다. 발표된 수치의 방향과 정확히 일치한다.

## 그래도 프록시 와이어는 그대로다 (`49db349ff` 기준 재확인)

`ResponsesApiRequest` (`codex-rs/codex-api/src/common.rs:252`) 필드 전량:
`model, instructions, input, tools, tool_choice, parallel_tool_calls, reasoning, store,
stream, stream_options, include, service_tier, prompt_cache_key, text, client_metadata` —
**이 계열에서 바뀐 것 없음**. 해당 파일의 최근 커밋은 `12c115d55` "Reduce cloning when
building Responses requests" 로 clone 최적화이지 필드 변경이 아니다.

`CompactionInput` (`common.rs:28-42`)도 9개 필드 그대로.

결론: 002의 **PROXY-VISIBLE vs LOCAL-ONLY 판정 유지**. 성능 작업은 TUI 렌더링 / app-server
resume 프로토콜 / SQLite 프로젝션 / MCP lazy 시작에 있고, opencodex가 보는 HTTP 와이어에는
없다. opencodex가 해야 할 일은 여전히 "새 포맷을 깨뜨리지 않기"다.

## 두 P0도 최신 HEAD에서 그대로 (`49db349ff`)

1. `multi_agents_common.rs:36-42` — `Disabled`만 배제. `models.json` luna = `"v1"` 유지.
2. `thread_history_materialization.rs` — ordinal 누락 시 하드 에러 유지.
   `update_thread_metadata.rs:87,99,121` — `paginated` 분기 유지.

## G14 확정: 카탈로그가 멀티에이전트 지시문을 공급한다 (#38619)

`gh pr view 38619` 본문: "Add model-catalog messages for root and subagent roles, explicit
delegation, and delegation hints. Resolve role instructions in **config, catalog, then
bundled-default order**."

신규 타입 (`codex-rs/protocol/src/openai_models.rs:577-592`):

```rust
pub struct MultiAgentMessages { pub role: Option<MultiAgentRoleMessages>, pub mode: Option<MultiAgentModeMessages> }
pub struct MultiAgentRoleMessages { pub root: Option<String>, pub subagent: Option<String> }
pub struct MultiAgentModeMessages { pub explicit: Option<String>, pub hint_text: Option<String> }
```

`ModelMessages.multi_agent` (`:534`) 아래로 들어간다. **opencodex는 `model_messages` 를
이미 합성/변형한다** — `src/codex/catalog/metadata.ts:300-308` 이 `instructions_template` 을
`identifyRoutedModel` 로 재작성하고, `src/codex/data/upstream-models.json` 이 8개 네이티브
행에 `model_messages` 를 담고 있다. 즉 이 스냅샷은 `multi_agent` 서브트리를 모르는 상태이며,
라우팅된 모델에 대해 role/mode 지시문이 누락되거나 낡은 채로 공급될 수 있다.

**분류: missed-opportunity → 잠재적 silent-degradation.** Phase 1의 후속 work-phase 후보
(신규 decade doc `060`)로 등록 권고. 이번 문서 사이클에서는 구현하지 않는다.

## 정정

008이 "008 시점에 `fetch` 했다"고만 적었으므로, 실제 **ff는 이 문서 시점에 수행**됐다.
로컬 `main` 은 이제 `49db349ff` 이며 `origin/main` 과 동일하다.

