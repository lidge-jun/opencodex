# 040 — 릴리즈 트레인 실행 (승인됨)

## 현재 상태

- dev: 29763560 (CI success, sol PASS, readiness READY)
- preview: 26fd5ea9 "release: v2.7.32-preview.20260722" — **미배포 범프**
  (release.yml run은 success지만 dry-run: npm versions에 2.7.32-preview 없음,
  npm preview 태그 = 2.7.29-preview.20260721)
- main: 304a1eab (v2.7.31) — preview의 조상
- npm: latest=2.7.31, preview=2.7.29-preview.20260721

## 버전 결정

preview package.json이 이미 2.7.32-preview.20260722라 같은 버전으로 `npm version` 불가
(no-change 에러). 미배포 버전이므로 2.7.33 라인으로 진행:

- preview: **2.7.33-preview.20260722**
- main: **2.7.33** (2.7.32 stable은 스킵 — 어디에도 배포된 적 없음)

## 실행 순서 (scripts/release.ts 규약)

1. preview 체크아웃 + dev 머지 (base 이후 dev는 version 미변경 → package.json 충돌 없음 예상).
2. `bun scripts/release.ts 2.7.33-preview.20260722 --publish` on preview
   (preflight → bump commit → push → ci.yml+service-lifecycle.yml 대기 → release.yml dispatch → watch).
3. main을 preview tip으로 ff 후 `bun scripts/release.ts 2.7.33 --publish` on main.
4. dev를 main tip으로 ff + push, 로컬 HEAD=dev로 복귀.
5. `npm view @bitkyc08/opencodex dist-tags --json` 검증 + 브랜치 tip 수렴 확인.

## 결과

- preview: dev(29763560) 머지(9a140a20) → `release.ts 2.7.33-preview.20260722 --publish`
  → bump 6c112450 → ci.yml+service-lifecycle.yml success → Release run 29904313855 success
  → npm preview=2.7.33-preview.20260722, GitHub Release v2.7.33-preview.20260722.
- main: preview tip으로 ff(6c112450) → `release.ts 2.7.33 --publish` → bump 6d6bef8b
  → 양 게이트 success → Release success → npm latest=2.7.33, tag v2.7.33.
- 수렴: dev를 main tip(6d6bef8b)으로 ff+push, preview도 6d6bef8b로 push.
  원격 dev/preview/main 모두 6d6bef8b 동일 SHA. 로컬 HEAD=dev, 워킹트리 클린.
- npm dist-tags 최종: latest=2.7.33, preview=2.7.33-preview.20260722.
- dev push 후 CI: 6d6bef8b dev-branch run 결과는 아래 검증 로그 참조 (동일 SHA가
  main에서 이미 그린이나 규약대로 dev run도 확인).
