# PR/Issue Triage — 2026-07-25

> 기준 시점: 2026-07-25 KST, `dev` 브랜치 기준
> 최근 머지 이력: #416, #397, #394, #393, #390, #383, #380, #379, #377, #369, #366, #364, #363, #362, #360, #359, #358, #356, #353, #352 (7/23~7/24)

---

## 1. PR 트리아지 (24건 open)

### TIER 1 — 즉시 클로즈 (판단 불필요)

| PR | 제목 | 근거 | 조치 |
|----|------|------|------|
| #419 | [WRONG BRANCH] Local/stable | `main` 타겟, enforce-target CI FAILURE | 클로즈 + dev 리타겟 안내 |
| #365 | [WRONG BRANCH] fix: multi-agent guidance dedupe | `main` 타겟, draft, CONFLICTING | 클로즈 + dev 리타겟 안내 |
| #339 | [WRONG BRANCH] fix: finish_reason stopReason | `main` 타겟, enforce-target FAILURE, CONFLICTING, CHANGES_REQUESTED | 클로즈 + dev 리타겟 안내 |

**판단 근거:** 세 PR 모두 `main` 타겟이라 enforce-target 워크플로우가 실패하고 있고, 제목에 [WRONG BRANCH]가 이미 표기되어 있음. AGENTS.md 정책상 feature PR은 `dev` 타겟이므로 클로즈가 명확함.

### TIER 2 — 클로즈 가능 (fix 이미 머지됨)

해당 없음 — 미머지 fix PR 중 클로즈 대상 없음.

### TIER 3 — 리뷰 후 머지 가능 (MERGEABLE, CI green, changes 미요청)

| PR | 제목 | 작성자 | 비고 |
|----|------|--------|------|
| #403 | feat(grok): auto-configure Grok Build | lidge-jun (본인) | 본인 PR — CI 확인 후 셀프머지 가능 |
| #408 | fix(service): retry Windows UAC elevation | Wibias | CI 전체 green 확인 필요 |
| #405 | feat(providers): canonical free provider directory | HaydernCenterpoint | 배치 제출 중 하나, MERGEABLE |
| #387 | feat: macOS menu bar companion | jaycho46 | CI 일부만 실행 (label+CodeRabbit), 전체 CI 확인 필요 |
| #385 | feat(providers): BizRouter preset | latemonk | CI 일부만 실행, 전체 CI 확인 필요 |

**판단 근거:** MERGEABLE이고 CHANGES_REQUESTED가 없으나, 아직 APPROVED 리뷰가 없음. 코드 리뷰 + CI 전체 통과 확인 후 머지 판단.

### TIER 4 — 변경 요청 응답 대기 (CHANGES_REQUESTED)

| PR | 제목 | 작성자 | 상태 |
|----|------|--------|------|
| #392 | feat(api-access): gateway endpoints + external catalog | Wibias | draft, MERGEABLE |
| #391 | feat: quota-aware subagent fallback chain (#374) | Wibias | draft, MERGEABLE |
| #389 | fix(models): switches reflect final visibility | csa906 | MERGEABLE |
| #376 | fix(cursor): estimate context after restart | HaydernCenterpoint | MERGEABLE, CI green |
| #370 | fix(codex): reset state after account switch | duansy123 | MERGEABLE |
| #337 | feat(gui): configure auto-switch threshold | csa906 | MERGEABLE |

**판단 근거:** 리뷰어가 변경을 요청한 상태. 작성자가 응답하거나 수정 푸시할 때까지 대기.

### TIER 5 — 컨플릭트 해결 필요 (CONFLICTING)

| PR | 제목 | 작성자 | 비고 |
|----|------|--------|------|
| #413 | feat: OpenRouter free-only model discovery | HaydernCenterpoint | CI green, dev 충돌 |
| #412 | Redesign connected provider workspace | HaydernCenterpoint | CI green, dev 충돌 |
| #411 | feat(gui): provider logo coverage | HaydernCenterpoint | CI green, dev 충돌 |
| #410 | fix(gui): Add Provider catalog scrolling | HaydernCenterpoint | CI green, dev 충돌 |
| #409 | feat(routing): evidence-based smart modes | HaydernCenterpoint | CI green, dev 충돌 |
| #407 | feat(gui): provider model loader | HaydernCenterpoint | CI green, dev 충돌 |
| #406 | feat(providers): safe model discovery | HaydernCenterpoint | CI green, dev 충돌 |
| #388 | feat: memory observability + watchdog | dev-shinyu | CHANGES_REQUESTED + 충돌 |

**판단 근거:** HaydernCenterpoint 7건은 7/24 동시 배치 제출. dev 브랜치가 빠르게 움직여 전부 충돌. 리베이스 후 재검토 필요. #388은 변경 요청 + 충돌 이중 대기.

### TIER 6 — Draft (진행 중 또는 장기 방치)

| PR | 제목 | 작성자 | 비고 |
|----|------|--------|------|
| #402 | fix(cursor): stop false shell blocked reports (#399) | Wibias | draft, MERGEABLE, Issue #399 fix |
| #355 | feat(google): Gemini inline image output | tizerluo | draft, CONFLICTING, 7/23 이후 업데이트 없음 |

**판단 근거:** draft + 충돌 + 무응답. 2주 이상 무응답 시 stale 클로즈 후보.

---

## 2. Issue 트리아지 (22건 open)

### TIER 1 — 즉시 클로즈 (fix PR 이미 머지)

| Issue | 제목 | fix PR | 근거 |
|-------|------|--------|------|
| #331 | [UX] Background helper Sonnet fallback 안내 없음 | #358 (merged 7/24) | PR 본문에 #331 명시 |
| #320 | [Bug] native auth 만료 시 로그인창 | #356 (merged 7/24) | PR 본문에 #320 명시 |
| #398 | [Bug] Web Search/Vision Sidecar 499/502 | #416 (merged 7/24) | PR 본문에 #398 명시 |

**판단 근거:** fix PR이 dev에 머지 완료. 릴리즈 포함 여부와 무관하게 이슈는 resolved로 클로즈 가능.

### TIER 2 — 연결 PR 진행 중

| Issue | 제목 | 연결 PR | PR 상태 |
|-------|------|---------|---------|
| #386 | feat: macOS menu bar companion | #387 | open, 리뷰 대기 |
| #374 | Subagent model fallback chain | #391 | open, CHANGES_REQUESTED |
| #399 | Cursor adapter false shell blocked | #402 | draft |
| #373 | Cursor restart context output-only | #376 | open, CHANGES_REQUESTED |

### TIER 3 — 본인 트래킹/기획 이슈

| Issue | 제목 | 성격 |
|-------|------|------|
| #417 | Korean realtime voice U+FFFD | upstream-tracking (본인 생성) |
| #415 | search-API sidecar investigation | 기획 (본인 생성) |
| #414 | Exa search sidecar backends | 기획 (본인 생성) |

### TIER 4 — 로드맵 (장기, roadmap 라벨)

| Issue | 제목 | 라벨 |
|-------|------|------|
| #294 | Claude account pool parity | roadmap |
| #201 | TRAE International provider | roadmap |
| #178 | Factory provider | roadmap |
| #177 | Warp provider | roadmap |
| #95 | Multi-user hosting + LiteLLM | roadmap |
| #42 | Storage page for session usage | roadmap |

### TIER 5 — 활성 버그/기능 요청 (조사 필요)

| Issue | 제목 | 라벨 | 비고 |
|-------|------|------|------|
| #418 | V2 custom-parent delegation fails 2.7.39 | — | 최신 버전 버그, 재현 확인 필요 |
| #401 | Change voice chat to different model | enhancement | voice 모델 선택 기능 |
| #357 | External aggregated model API | enhancement | 서드파티 에이전트 연동 |
| #330 | 채팅/세션 토큰·비용 합계 | enhancement | 로그 기능 |
| #241 | Desktop model picker missing routed models | bug, upstream-tracking | 업스트림 의존 |
| #92 | V2 cross-provider sub-agent NEW_TASK body | bug, upstream-tracking | 업스트림 의존 |

---

## 3. 우선순위 매트릭스

### 즉시 실행 (판단 불필요)

1. **PR #419, #365, #339 클로즈** — wrong branch, CI failure
2. **Issue #331, #320, #398 클로즈** — fix PR 머지 완료

### 이번 주 리뷰

3. **PR #403** — 본인 PR, 셀프 리뷰 후 머지
4. **PR #408** — Wibias Windows UAC fix, CI 확인
5. **PR #387 + Issue #386** — macOS menu bar, CI 전체 확인
6. **PR #385** — BizRouter preset, CI 확인
7. **PR #405** — free provider directory (HaydernCenterpoint 배치 중 유일하게 MERGEABLE)

### 작성자 응답 대기

8. **PR #389, #376, #370, #337** — CHANGES_REQUESTED 응답 대기
9. **PR #392, #391** — Wibias draft, 응답 대기

### 리베이스 필요 (배치)

10. **PR #406~#413 (7건)** — HaydernCenterpoint 배치, dev 리베이스 후 일괄 재검토
11. **PR #388** — dev-shinyu, 충돌 + 변경 요청

### 장기 대기

12. **PR #355** — draft, stale 클로즈 후보
13. **Issue 로드맵 6건** — 별도 프로젝트 사이클 필요
14. **Issue upstream-tracking 2건** (#241, #92) — 업스트림 수정 대기

---

## 4. HaydernCenterpoint 배치 분석

7/24 11:06~11:18 UTC에 8개 PR 동시 제출 (#405~#413, #376 제외).
모두 `dev` 타겟, CI는 green이지만 dev 브랜치와 충돌.

- #405 (free provider directory)만 MERGEABLE — 나머지 7건은 CONFLICTING
- 기능 간 의존성 추정: #406 (safe discovery) → #407 (model loader) → #405 (free directory) → #413 (OpenRouter free)
- #410 (scroll fix), #411 (logo), #412 (workspace redesign)은 GUI 독립 변경
- #409 (smart routing)은 라우팅 코어 변경 — 충돌 해결 난이도 높음

**권장:** #405 먼저 리뷰/머지 → 나머지 리베이스 후 순차 검토.

---

## 5. 최근 머지 PR (7/23~7/24, 참고)

| PR | 제목 | 작성자 |
|----|------|--------|
| #416 | web-search sidecar deadline 60s (#398) | lidge-jun |
| #397 | openai-chat system messages first | jonathanli12 |
| #394 | anthropic premature no-tool guard | duansy123 |
| #393 | GUI portal select dropdowns (#340) | Wibias |
| #390 | stale weekly quota refresh (#382) | Wibias |
| #383 | Claude WebSearch domain sanitize | Wibias |
| #380 | Claude sidebar controls unify | lidge-jun |
| #379 | POST /v1/live voice relay | Wibias |
| #377 | apply_patch envelope guidance | HaydernCenterpoint |
| #369 | kiro progress nonterminal | mushikingh |
| #366 | cursor store:false continuity | Wibias |
| #364 | release notes full changelog | Wibias |
| #363 | tool call arguments once | snowyukitty |
| #362 | Windows mgmt test timeouts | Wibias |
| #360 | oversized call ID repair | alexanderxcmo |
| #359 | stable Codex runtime selection (#297) | Wibias |
| #358 | discovery-failure badge (#329, #331) | lidge-jun |
| #356 | codex shim auto-restore (#320) | lidge-jun |
| #353 | issue quality soft-validate | Wibias |
| #352 | bounded pool retry (#335) | lidge-jun |

---

*Generated: 2026-07-25 KST, session 019f94cd*
