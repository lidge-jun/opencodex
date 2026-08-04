# 040 — WP4 GUI-blocked / 장기 항목 정리 계획

## GUI-touch로 병합 보류 (사용자 허락 전 병합 절대 금지)

실측 근거: `gh pr view --json files` (020 문서 참조).

| PR | GUI 파일 수 | 상태 처리 |
|---|---|---|
| #254 | 1 (claude-manual-env.ts) | 영어 코멘트: 리뷰 결과 공유 + GUI 검토 후 병합 예정 언급 없이 대기 |
| #231 | 1 (Providers.tsx) | 코멘트 불필요 시 보류만 기록 |
| #255 | 1 (Providers.tsx) | draft — 보류 |
| #247 | 13 | 대형 UI 방향 결정 필요 — 보류 |
| #238 | 9 | draft — 보류 |
| #249 | 8 (+보안) | 영어 트리아지 코멘트 (보안/운영 리뷰 필요) |
| #244 | docs-site 대량 + README | i18n QA 별도 사이클 — 영어 트리아지 코멘트 |
| #260 | 1 (Providers.tsx) | WP1에서 retarget 코멘트 처리 |

주: #229는 GUI 아님(.github/ 전용)이지만 `provider-compatibility` 라벨 선결 + 정책 변경이라 병합 보류, 트리아지 코멘트만.

## 장기 이슈 영어 트리아지 코멘트

| 이슈 | 골자 |
|---|---|
| #240 | 계정 별칭 — roadmap 인정, 계정 데이터모델 작업 필요 |
| #201 | TRAE — 공식 auth/transport 계약 확보 전 블록 |
| #178 | Factory — agent-backend급, 스코프 설명 |
| #177 | Warp — inference API 부재 설명 |
| #95 | 멀티유저 proxy — 프로젝트급, 설계 필요 |
| #42 | Storage Phase 2+ — 진행 상태 업데이트 |

## 최종 검증

- GUI PR 병합 0건 확인 (`gh pr list` 오픈 상태 유지 확인)
- `cxc loop validate --slug star-surge-triage-reply-only-small-safe-non-gui` 통과
- 결과 요약 본 문서 하단 기입

## 영어 트리아지 코멘트 드래프트 (WP4 B-phase 발사)

### 이슈 #240 (계정 별칭 — roadmap 인정)

> Thanks — this is a reasonable request and it's now on the roadmap as an enhancement. Custom aliases need a small cross-provider account data-model change (aliases must survive re-auth and multi-account switching) plus GUI surface updates, so it's scheduled as its own work item rather than a quick patch. Keeping this open to track it.

### 이슈 #201 (TRAE)

> Update on scoping: adding TRAE International needs an officially supported authentication and transport contract (how tokens are issued/refreshed, and which inference endpoint shape is exposed). Right now there is no documented official API surface we can build against without relying on reverse-engineered internals, which we avoid for providers that can break silently. Keeping this open as a provider request; if you can point to official API docs or a sanctioned developer program, that unblocks the work.

### 이슈 #178 (Factory)

> Scoping update: as you clarified, Factory's official surface is the Droid Exec/SDK agent backend rather than a plain model inference API. That means integrating it is a separate execution-backend feature — a substantially bigger work item than a normal provider adapter — so this stays open as a long-term request with that scope. Droid Exec/SDK is the documented surface we would evaluate for that scope.

### 이슈 #177 (Warp)

> Scoping update: Warp's public surface is the Oz agent API (\`POST /api/v1/agent/run\`) — an agent-execution backend rather than a plain model inference API. Supporting it would mean building a separate agent-backend integration, not a standard provider adapter, which is a much larger scope. Keeping this open as a long-term request with that framing; a plain inference API from Warp would make the standard-adapter path viable.

### 이슈 #95 (멀티유저 proxy)

> Status: this remains on the long-term roadmap. Admission auth and catalog refresh already work today (as covered earlier in this thread); the remaining gap is the genuinely hard part — tenant identity/isolation, per-user authorization and policy, trustworthy user attribution, and concurrency/load validation. That's project-scale design work rather than a patch, and the single-user assumptions run deep enough that we'd rather design it properly than ship a mode that leaks state across users. Keeping open as the tracking issue.

### 이슈 #42 (Storage Phase 2+)

> Status update: Phase 1 (storage diagnostics page) has landed. The remaining phases — cleanup actions and auto-cleanup policy — touch session lifecycle and are deliberately gated behind more careful design, since a bad cleanup pass can destroy user threads. Still planned, keeping this open to track Phase 2+.

### PR #249 (Cloudflare Tunnel)

> Thanks for the substantial work here — including the careful credential handling (clearing the API token after setup and keeping only the runner token in a 0600 file). Before this can be reviewed for merge it still needs a security/operations pass as its own project: it changes the default public ingress path and includes provisioning/rollback flows that haven't been exercised against a real Cloudflare account in CI. It also includes GUI changes, which are pending a separate approval in this triage round. Leaving open — expect a dedicated review cycle rather than a quick merge decision.

### PR #244 (일본어 로컬라이제이션)

> Thank you for the comprehensive localization — this is wanted. A 4.7k-line cross-surface addition (GUI locale, docs-site, READMEs) needs its own dedicated review/QA cycle: docs-site build across locales, README cross-links, and GUI locale parity with en.ts. It's queued for that cycle rather than this batch. (For reference, the RU localization went through the same kind of dedicated pass.)

### PR #229 (issue intake 개편)

> Review note: the automation direction is good, but merging this before the `provider-compatibility` label exists in the repo would break label application on the new issue form. Sequencing: (1) create the label, (2) then land this in a staged review since it changes intake policy for all future issues. Holding until that's set up.


## 결과 (2026-07-22 06:40Z 실행)

### 트리아지 코멘트 발사 (sol 2회 감사 후 PASS 드래프트)

| 대상 | URL |
|---|---|
| #240 | issues/240#issuecomment-5042693202 |
| #201 | issues/201#issuecomment-5042693335 |
| #178 | issues/178#issuecomment-5042693481 |
| #177 | issues/177#issuecomment-5042694641 |
| #95 | issues/95#issuecomment-5042694805 |
| #42 | issues/42#issuecomment-5042694998 |
| PR #249 | pull/249#issuecomment-5042696562 |
| PR #244 | pull/244#issuecomment-5042696702 |
| PR #229 | pull/229#issuecomment-5042696839 |

### GUI 병합 금지 검증

이번 라운드 병합 6건(#248 #250 #232 #262 #251 #235) 전부 gui=0 (gh files 실측).
GUI-touch PR 전부 오픈 유지: #260 #255 #254 #247 #244 #238 #249 #231.

## 전체 루프 최종 요약 (goalplan: star-surge-triage-*)

- **병합 (6)**: #248 #250 #232 #262 #251 #235 — 전부 non-GUI, sol 리뷰 통과, one-at-a-time
- **이슈 클로즈 (2)**: #234(→#248), #228(→#250) — 영어 근거 코멘트 포함
- **PR 클로즈 (1)**: #237 — #256 채택 사유 영어 코멘트
- **changes-requested (3)**: #256(2 blockers), #230(false-confidence test), #258(e2e 계약)
- **REPLY-ONLY 코멘트 (4)**: #252 #241 #208 #92 — sol 감사로 클로즈 0건(전건 오픈 유지 결정)
- **장기 트리아지 코멘트 (9)**: 위 표
- **CI run 승인**: #251 #230 #235 first-time contributor 게이트 해제
- dev CI: 04dfc7fc success + 최종 tip 897bdcca run 29897229704 **completed success** — 병합 6건 전체 반영 green


## 2차 라운드 (2026-07-22 19:40 KST, dev pull 9736afba 이후)

메인테이너 병합 반영: #256 #258 #230 #272 #274 #276 MERGED, #254 #260 CLOSED (모두 외부 처리).
이슈: #234 #228 #242 #245 #246 #253 #257 CLOSED 확인. 신규 이슈 #280 #281 #282.

신규/잔여 오픈 PR sol 리뷰 (Raman/Arendt 2기 priority 병렬):

| PR | 판정 | 액션 |
|---|---|---|
| #277 (workflow crash fix) | MERGE — dev에서 SyntaxError 실증, 긴급 | **MERGED** 10:42:22Z |
| #273 (cursor context) | BLOCK — #274에 의미 충돌+CONFLICTING | 영어 superseded 코멘트 + **CLOSED** (pull/273#issuecomment-5044839354) |
| #283 (v2 fail-fast, draft) | FEEDBACK-ONLY | 영어 리뷰 코멘트 (pull/283#issuecomment-5044842298) |
| #279 (chat/completions, +1270) | BLOCK — 4 blockers(병렬 tool delta 파손, direct auth, response_format drop, request log 미종결) | 영어 changes-requested (pull/279#issuecomment-5044842463) |
| #266 (Tencent/SiliconFlow, draft, GUI-touch) | FEEDBACK-ONLY | 영어 리뷰 코멘트 + GUI 승인 절차 고지 (pull/266) |
| #255 #247 #249 | GUI-touch — 보류 유지 | 무액션 |


## 3차 라운드 마감 (2026-07-22 ~21:35 KST) — claudedesktop 통합 + 원격 동기화

- claudedesktop 워크트리(0666) → dev `--no-ff` 병합 (418d29b1). 충돌 3파일(styles.css/config.ts/management-api.ts) 양측 보존으로 해소.
- 브랜치에 커밋돼 있던 stray `|||||||` 마커 4파일(en/ko/zh/de) 제거, ja/ru에 Claude Desktop 키 56개씩 번역 추가 (CI TS2740 해소).
- prepush 게이트 풀통과(3528 tests) 후 push: 79e5067a..6da54a89. 워크트리 0666 제거 + claudedesktop 브랜치 삭제.
- dev CI: Cross-platform 6da54a89 **success**, Service lifecycle success(Windows leg는 러너 bun 인프라 문제로 rerun 후 green).
- PR #279 재리뷰(sol): 기존 4 blocker 전부 해소 확인, 신규 2 blocker(200-masked failures, output_item.done args drop) 영어 코멘트.
- 이슈 라벨 체계 신설: upstream-tracking / roadmap / needs-info + 오픈 이슈 전건 라벨링. #208은 #279 추적 코멘트.
- 잔여 오픈: 이슈 10건(장기/추적/문의), PR 5건(#283 #279 draft·blocked, #255 #249 #247 GUI 대기).
