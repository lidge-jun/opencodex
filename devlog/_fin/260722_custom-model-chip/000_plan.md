# 커스텀 모델 칩 — 전체 계획

> 2026-07-22 · 세션 019f86f8-f5d9-72a3-b968-e0d69b180c4f

## 목표

OpenCodex 대시보드 모델 페이지에 커스텀 모델 추가/편집/삭제 UI + 백엔드 CRUD 구현.
사용자가 프로바이더 업데이트를 기다리지 않고 직접 모델을 등록할 수 있게 한다.

## 설계 문서

- [001-design-investigation.md](../../custom-model-chip/001-design-investigation.md) — 전체 설계 조사
- [002-hover-popup.md](../../custom-model-chip/002-hover-popup.md) — 호버 팝업 상세 설계

## Work Phases

| WP | 범위 | 파일 |
|----|------|------|
| WP1 | 백엔드: types + CRUD API + catalog merge | src/types.ts, src/server/management-api.ts, src/codex/catalog.ts |
| WP2 | 프론트엔드: 헤더+버튼 + 모달 + 행 + 호버팝업 + CSS | gui/src/pages/Models.tsx, gui/src/styles.css |
| WP3 | i18n + 최종 검증 | gui/src/i18n/*.ts |

## 제외

push, npm publish, preview 배포, main merge. dev 브랜치 로컬 커밋까지만.
