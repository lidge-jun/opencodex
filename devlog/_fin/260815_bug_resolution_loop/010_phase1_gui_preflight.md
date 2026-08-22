# 010 — Fix #1562: GUI V2 mode ENOENT silent failure

## 문제
GUI에서 V2 모드 전환 시 codex executable이 없으면 PUT /api/v2가 502 반환하지만
GUI switchMaMode (use-dashboard-data.ts:539)가 응답을 무시함.

## 코드 경로
1. cli/v2.ts:68 — execFileSync throws ENOENT
2. codex/features.ts:1499 — catch → { ok: false, error: message }  
3. agent-settings-routes.ts:327 — jsonResponse({ error }, 502)
4. use-dashboard-data.ts:539 — if (r.ok) 만 체크, else는 무시

## 수정 계획
### use-dashboard-data.ts
- switchMaMode에서 !r.ok일 때 response body의 error 메시지를 파싱
- maError state 추가하여 에러 메시지 저장
- catch 블록에서도 에러 표시

### dashboard-overview-head.tsx  
- maError가 있을 때 mode radiogroup 아래에 에러 메시지 표시
- role="alert" 또는 aria-live="polite" 사용

## 검증
- bun run typecheck
- bun run build:gui (GUI 빌드 확인)

