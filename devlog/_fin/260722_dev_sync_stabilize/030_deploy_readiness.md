# 030 — WP3 배포 readiness 판정

## 계획

1. 원격 dev CI(Cross-platform CI) @29763560 완주 확인.
2. preview/main 대비 diff 요약.
3. readiness 판정 + 보고.

## 브랜치 상태 (2026-07-22)

- dev HEAD: 29763560 (로컬==origin, ahead/behind 0)
- preview: dev에 없는 커밋은 릴리즈 커밋 1개뿐(26fd5ea9 v2.7.32-preview.20260722) — 정상.
  preview..dev 44커밋, 140 files, +9657/-385.
- main: dev에 완전 포함(dev..main 0커밋). main..dev 51커밋.
- npm 현재: package.json 2.7.31, preview 태그 2.7.32-preview.20260722.

## sol 적대 리뷰 요약 (Meitner, 3라운드)

- R1 FAIL: init.ts 무조건 unlink → 유효 v1 롤백 백업 삭제 (BLOCKER) → a41170c9로 수정.
- R2 FAIL: Date.now rename 충돌로 스냅샷 덮어쓰기 (BLOCKER) → 29763560 (COPYFILE_EXCL) 수정.
- R3 PASS: "For the complete 897bdcca..29763560 range, no remaining deploy blocker."
- Deferred MAJOR: flowId 없는 login/cancel이 provider-global OAuth flow 취소
  (auth-api.ts:808 + AddCodexAccountModal 409 핸들러). 로컬 단일 사용자 프록시 특성상
  실사용 빈도 낮음 — 별도 이슈로 추적 권장.
- Deferred MINOR: ja.ts custom-model/cost-breakdown 영어 폴백(992, 1019행) — 번역 PR 대상.

## 게이트 증거

- bun test --isolate ./tests/ @29763560: 3431 pass / 0 fail (287 files).
- tsc --noEmit exit 0. lint:gui, privacy-scan, locale sync 그린.
- sol R3 독립 재검증: tsc + 28 focused tests + GUI/docs 빌드 그린.
- 원격 CI: fdacd146 success, 29763560 결과는 아래 판정에 기록.

## 판정

**READY.** Cross-platform CI @29763560 completed success (Ubuntu/Windows 포함 전 잡 그린).
로컬·원격·리뷰 3계층 모두 그린:

- 로컬 게이트: isolate 테스트 3431/0, tsc 0, lint/privacy/locale 그린.
- 원격 게이트: Cross-platform CI success @29763560 (dev), Issue quality tests success.
- 적대 리뷰: sol 3라운드, 최종 PASS — 잔여 deploy blocker 없음.

preview 머지(→ v2.7.32-preview 갱신) 및 main 머지+release는 즉시 실행 가능한 수준.
실행은 이 goal 범위 외 — 사용자 지시 대기. 릴리즈 시 scripts/release.ts 경유,
release SHA에 ci.yml + service-lifecycle.yml 그린 확인 후 npm dist-tags 검증
(skills/opencodex-release-train 규약).

Deferred 항목(머지 전 필수 아님): MAJOR OAuth cancel race — 별도 이슈 권장,
MINOR ja 부분 번역.
