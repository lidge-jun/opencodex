# 210-20 — PR #8 코드 적용 + 리뷰 수정 계획

## 전략

1. PR #8의 2개 커밋을 dev에 squash cherry-pick (기여자 Co-Authored-By 유지)
2. 리뷰 지적 4건 수정을 별도 커밋으로 적용

## 수정 사항

### Fix 1: server.ts — 불필요한 dynamic import 제거
- `/api/settings` PUT 핸들러에서 `await import("./config")` 제거
- 이미 static import된 `saveConfig` 직접 사용

### Fix 2: cli.ts — handleEnsure sync 실패 로깅
- `.catch(() => {})` → `.catch(e => console.error(...))`
- 2곳 모두 적용

### Fix 3: Dashboard.tsx — 토글 실패 시 에러 표시
- catch 블록에 `setError(true)` 또는 console.error 추가

### Fix 4: (optional) uninstall.test.ts — 문자열 매칭 테스트 개선 메모
- 현재 단계에서는 메모만 (기능 테스트로 전환은 후속 작업)

## 커밋 계획

1. `feat: squash PR #8 — Codex autostart ensure fallback` (Co-Authored-By: 이완우)
2. `fix: address PR #8 review — dynamic import, sync logging, toggle error`
