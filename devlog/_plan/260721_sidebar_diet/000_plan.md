# 000 — 사이드바 다이어트: 콤보 통합 + 로그&디버그 통합

- 날짜: 2026-07-21
- 세션: 019f848c-a993-7ad2-91df-5a983b108525
- goalplan: `.codexclaw/goalplans/opencodex-gui-12-10-1-0-combos-1-combos-combos-2/`
- 클래스: C3 (GUI 내비게이션 구조 변경, 크로스 페이지, 5로케일 i18n — 서버 계약 변경 없음)

## 목표

사이드바 항목 12개 → 10개.

1. **콤보 통합**: 사이드바 "콤보" 제거. 모델 페이지(#models) 최상단에 콤보 섹션 추가.
   - 콤보 0개: 드롭다운 없이 한 줄(소개 문구 + "설정하기" 버튼) → 클릭 시 #combos 이동.
   - 콤보 1개+: 프로바이더 그룹과 같은 시각 언어의 접이식 드롭다운으로 콤보 목록 표시,
     드롭다운 하단 "+ 추가하기" 행 → 클릭 시 #combos 이동.
   - #combos 해시 라우트와 Combos 페이지는 유지 (딥링크 보존).
2. **로그&디버그 통합**: 사이드바 "디버그" 제거, "로그" → "로그&디버그" 개칭.
   - 로그 페이지 기본 = 기존 로그 UI 그대로.
   - 페이지 내 탭/세그먼트로 디버그 화면 전환.
   - #debug 직접 진입 → 로그&디버그 페이지의 디버그 탭 (하위 호환).

## 디자인 판단 (cxc-dev-uiux-design)

- 표면: 개발자 도구 대시보드 (D8 developer console). VARIANCE 2-3 / MOTION 1-2 / 밀도 D5-D8.
  기존 디자인 시스템(styles.css 토큰, segmented, 프로바이더 그룹 collapsible)을 그대로 재사용.
  새 시각 언어 도입 없음 — Design System Detection 우선.
- UX-LAZY-01 근거: 콤보는 마이너 기능 → 최상위 내비 포크에서 제거(Demote),
  사용자 멘탈모델상 콤보는 "가상 모델"이므로 모델 페이지가 집.
  디버그는 로그의 인접 관찰(observability) 표면 → 탭으로 흡수.
- 콤보 빈 상태(UX-STATE-01): 상태 존재 이유(아직 콤보 없음) + 다음 행동("설정하기") 명시.

## 제약 / 스코프

- IN: `gui/src/` (App.tsx, pages/Models.tsx, pages/Logs.tsx, pages/Debug.tsx, i18n 5로케일, styles).
- OUT: 서버/CLI 코드, combos 백엔드 API, 릴리스, `git push`(로컬 커밋만 — DEV-GIT-PUSH-01).
- 딥링크 보존: #combos, #debug 진입이 절대 깨지지 않는다.

## Work-phase 맵 (의존 순서, PHASE-SPLIT-01)

| WP | 내용 | 문서 | 의존 |
|----|------|------|------|
| WP0 | docs-only 로드맵 (이 사이클) | 000, 001, 010, 020 | — |
| WP1 | 콤보 통합: NAV 제거 + Models 콤보 섹션 + i18n | 010 | WP0 |
| WP2 | 로그&디버그 통합: NAV 제거/개칭 + 탭 + #debug 매핑 + i18n | 020 | WP0 (WP1과 파일 겹침: App.tsx, i18n — 순차 실행) |

WP1/WP2는 App.tsx NAV 배열과 i18n 파일을 공유하므로 병렬 아닌 순차 사이클로 돈다.

## Loop-spec (C2+ 헤더)

- Archetype: spec-satisfaction repair (verifier가 done을 정의).
- Trigger: 사용자 명시 요청 (HOTL, "완성해놔").
- Goal: 위 두 통합이 실브라우저에서 스펙대로 렌더/동작.
- Non-goals: 콤보 워크스페이스 UI 개편, 로그/디버그 기능 추가, 다른 사이드바 항목 정리.
- Verifier(확정 명령 — 감사 반영): `bun run typecheck` + `cd gui && bun run build` +
  `cd gui && bun run lint:i18n` + `bun run test`, 그리고 localhost:10100 브라우저 스크린샷
  (콤보 0개/1개+ 두 상태, 로그/디버그 탭 전환, #combos·#debug 딥링크).
- Stop: goalplan criteria 6개 전부 met → DONE. 외부 의존 실패 → BLOCKED.
- Memory artifact: 이 devlog 유닛 + goalplan ledger.
- 자원 경계: 로컬 리포 읽기/쓰기(gui/src, devlog, .codexclaw), localhost:10100 브라우저 접근,
  Sol 서브에이전트 파견. 원격 쓰기 없음. 예상 wall-clock ≤ 2h.
- Escalation: 라우팅 하위호환이 기존 사용자 북마크를 깨는 트레이드오프 발견 시 NEEDS_HUMAN.

## SoT 동기화 대상 (SOT-SYNC-01)

- `structure/05_gui-and-management-api.md`: Debug 독립 페이지(`/#debug`) 서술을
  Logs 탭 통합 + 레거시 리다이렉트로 갱신 (WP2 C에서 패치).
