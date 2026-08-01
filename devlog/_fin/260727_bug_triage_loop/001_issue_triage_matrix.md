# 001 — 열린 이슈 트리아지 매트릭스

조사 시점: 2026-07-27, `dev` = `f327db1e`
대상: `gh issue list --state open` 22건

## 판정 분류

- **CLOSE-READY**: 수정이 `dev`에 있고 근거 SHA를 제시할 수 있다. 코멘트 후 종결.
- **FIX-NOW**: 이번 루프에서 고칠 수 있고 스코프 안에 있다.
- **IN-FLIGHT**: 열린 PR이 담당 중. 이슈는 PR 머지까지 유지.
- **UPSTREAM**: opencodex 코드로 해결 불가. 추적만.
- **AUTO-STALE**: `stale-needs-info.yml`(2026-07-27 머지)이 자동 처리. 수동 개입 불필요.
- **ROADMAP**: 기능 요청. 이번 버그 루프의 대상 아님.

## 매트릭스

| # | 제목 요약 | 라벨 | 판정 | 근거 |
|---|-----------|------|------|------|
| 511 | Grok Build 200k — orphan 엔트리 미채택 | bug | **~~CLOSE-READY~~ → 종결 불가** | WP2 종결 감사에서 뒤집힘. 수정이 fence 인접 orphan(이슈가 보고한 바로 그 레이아웃)에서 마커를 파괴하고 미수렴한다. 재현 증거와 수정 방향은 `004_grok_orphan_adjacency_defect.md` |
| 539 | Desktop 3P가 `Claude-3p/configLibrary`에 씀 | — | **FIX-NOW** | 결함은 실재하나 제보자 진단이 틀림. `003` 문서 참조 |
| 476 | 카탈로그 변경이 실행 중 app-server에 미반영 | enhancement | **IN-FLIGHT** | PR #518은 머지 없이 닫힘(2026-07-27T01:50Z). #526(신호 보고) + #527(stale 경고)이 승계 |
| 418 | V2 custom-parent→custom-child 위임 실패 (2.7.39) | bug | **조사 필요** | 모델 오버라이드는 정상(HTTP 200), child 센티널 미전달. #290의 `missing field message`는 재현 안 됨 |
| 92 | V2 cross-provider sub-agent가 `encrypted_content`에서 NEW_TASK body 유실 | bug, upstream-tracking | **UPSTREAM** | #418과 동일 계열. 업스트림 추적 라벨 유지 |
| 241 | 라우팅 모델이 Desktop 모델 피커에 미표시 | bug, upstream-tracking | **UPSTREAM** | WP2에서 재확인 완료: 무관함. 본문이 `codex debug models`로 13개 라우팅 항목이 모두 읽힌다고 명시하므로 **Codex** Desktop 피커 문제이고, #539의 **Claude** Desktop 3P configLibrary와는 다른 제품·다른 경로다. 겹친다고 본 초기 추정은 철회 |
| 417 | 한국어 음성 트랜스크립트 U+FFFD | bug, upstream-tracking | **UPSTREAM** | 제목이 이미 "not an ocx relay bug"로 확정 |
| 462 | 세션 사용 모델 제거 시 Codex 크래시 | upstream-tracking, needs-info | **AUTO-STALE** | needs-info. 워크플로가 처리 |
| 521 | web-search 중 499 client_closed_request | needs-info | **AUTO-STALE** | 동일 |
| 509 | Windows JS-heap 증가 (heapUsed 5729MB vs RSS 3001MB) | needs-info | **AUTO-STALE** | 동일. 단 RSS-only 워치독이 경고하지 못한다는 지적 자체는 유효한 관측 |
| 538 | per-model `reasoning_summary_delivery` 정규화 | — | ~~ROADMAP~~ → **이미 종결됨** | WP3 감사에서 확인. `e7d144fc`(07:56Z)가 `src/config.ts`의 `reasoningSummaryDeliveryRecordConfigError`와 `src/types.ts`의 모델별 `stream_options.reasoning_summary_delivery`로 구현하며 처리. 이슈 상태 CLOSED |
| 425 | Codex 계정을 모델 네임스페이스로 노출 | enhancement | **IN-FLIGHT** | PR #512가 담당 |
| 42 | Storage 페이지 세션 정리 정책 | enhancement, roadmap | **IN-FLIGHT** | PR #529가 phase 2 담당 |
| 294 | Claude 계정 풀 — ChatGPT/Codex 멀티계정 라우팅 패리티 | enhancement, roadmap | **ROADMAP** | |
| 415 / 414 | 웹서치 사이드카 백엔드 확장 (Gemini / Exa) | enhancement | **ROADMAP** | |
| 401 | 음성 채팅 모델 변경 | enhancement, upstream-tracking | **UPSTREAM** | |
| 386 | macOS 메뉴바 컴패니언 패키징 | enhancement | **ROADMAP** | 별도 워크트리 `opencodex-macos-app`에서 진행 중 |
| 201 / 178 / 177 | TRAE / Factory / Warp 프로바이더 추가 | enhancement, roadmap | **ROADMAP** | |
| 95 | 멀티유저 프록시 + LiteLLM 통합 | enhancement, roadmap | **ROADMAP** | |

## 이번 루프의 행동 대상

1. **#511** — 종결 철회. 신규 결함(fence 파괴 + 미수렴)이 발견되어 WP5에서 수정한다.
   `004` 문서 참조. 재현: ADJACENT 레이아웃에서 `END=2`, `changed=true` 무한 반복,
   `default` 진동.
2. **#539** — FIX-NOW. WP1에서 수정, WP2에서 종결.
3. **#418** — 조사 필요. 스코프 판단은 WP3 이후. 단독으로 크고 재현 환경이 Windows라
   이번 루프에서 완결하기 어렵다. 판정만 기록하고 열어 둔다.

## 방법론 교훈

#511의 초기 판정은 "구현 심볼이 존재함"에 기댔다. 그것은 종결 근거로 부족하다.
종결 전에는 **이슈가 기술한 입력을 그대로 재현**해야 한다. 이슈 본문의
"line 23 / line 196"이라는 서술을 픽스처로 옮겼다면 첫 커밋에서 걸렸을 결함이었다.

## 판정에서 배제한 것과 그 이유

`needs-info` 3건은 손대지 않는다. 방금 머지된 `stale-needs-info.yml`이 비활성 기간 후
자동 종결하도록 설계됐고(`7a80fe2d`가 roadmap 라벨 병기 시에도 닫히도록 보강), 수동으로
먼저 닫으면 그 워크플로의 동작을 검증할 기회를 잃는다.

`upstream-tracking` 4건도 배제한다. 정의상 opencodex 코드 변경으로 해결되지 않는다.
#241을 #539의 하위 증상으로 의심했으나 WP2에서 확인한 결과 무관하다. #241은 Codex
Desktop의 모델 피커이고 #539는 Claude Desktop의 3P 게이트웨이 설정 경로다. 이름이
비슷할 뿐 제품이 다르다.
