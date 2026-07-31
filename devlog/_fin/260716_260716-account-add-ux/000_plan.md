# 000 — 계정 추가 UX 수정: Plan

## Objective
Codex 인앱 브라우저에서 계정 추가 시 window.open이 "링크 가기" 프롬프트로 중재되는 문제 해결.
Providers 페이지 IconExternal 오버사이즈 수정. 근거: devlog/260716_account_add_ux/01_investigation.md

## Loop-spec
- Loop archetype: spec-satisfaction (pass/fail)
- Write scope: gui/src/components/AddCodexAccountModal.tsx, AddProviderModal.tsx,
  gui/src/pages/Providers.tsx, gui/src/styles.css, gui/src/i18n/{en,ko}.ts,
  src/codex/auth-api.ts (openUrl 추가만)
- Out-of-scope: OAuth 토큰/콜백/리프레시 로직, 다른 페이지
- Budget: 단일 PABCD 사이클 (C2)

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010 | 전체 패치 (클라이언트+서버+CSS+i18n) | 없음 |

## Accept criteria
- c1: AddCodexAccountModal에서 window.open 제거
- c2: IconExternal에 명시적 크기 지정
- c3: .link-btn svg CSS 규칙 존재
- c4: bun run build:gui 성공
