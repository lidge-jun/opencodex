# Phase 3: i18n (zh/de/ru) + 최종 검증

## 1. i18n 키 추가

ko.ts와 en.ts는 WP2에서 이미 27개 키 추가 완료.
zh.ts, de.ts, ru.ts에 동일 키를 해당 언어로 번역하여 추가.

키 목록은 020_phase2.md §4.1 참조.

## 2. 최종 검증

- `bun test --isolate tests` — 회귀 없음
- `cd gui && npx vite build` — 빌드 성공
- `bunx tsc --noEmit` — 타입 체크 통과
- i18n 키 grep — 5개 언어 파일 모두 27개 키 존재 확인
