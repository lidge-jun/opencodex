# 001 — RCA 증거 (research, 2026-07-20 tree)

사용자 보고(디시): 대시보드 Claude Code 페이지에서 인증 모드를 Proxy로 바꿔
저장해도 새로고침하면 Subscription으로 복귀.

## 데이터 흐름과 결함 지점

GUI `gui/src/pages/ClaudeCode.tsx` ↔ `src/server/management-api.ts`
`/api/claude-code` GET/PUT ↔ `config.claudeCode.authMode`
(`src/types.ts:291`, 타입 `authMode?: "proxy"` — 미설정 = subscription).

1. **PUT이 authMode를 버림.** GUI save는 `authMode: state.authMode`를 body에
   포함(`ClaudeCode.tsx:130`)하지만 PUT 파서(`management-api.ts:1035~1174`)에
   `authMode` 분기가 없다 → config에 저장되지 않음.
2. **GET이 authMode를 반환하지 않음.** GET 응답(`management-api.ts:993~1018`)에
   `authMode` 키가 없고, GUI 로더는 `r.authMode === "proxy" ? "proxy" :
   "subscription"`(`ClaudeCode.tsx:83`) → undefined는 항상 subscription 표시.

리뷰어(sol) 교차 확인: 다른 persist 경로(다른 엔드포인트/워처/CLI 쓰기)는
존재하지 않음 — 수기 config 편집만 가능. GET에 "subscription" 기본값을 넣어도
다른 소비자는 안전(`gui/src/App.tsx:164-179`는 enabled만, `src/cli/claude.ts:113-119`는
contextWindows만 읽음).

## 영향 사슬

`claudeCode.authMode === "proxy"`가 구동하는 것:

- `src/cli/claude.ts:58` — `ocx claude` 실행 시 `ANTHROPIC_AUTH_TOKEN=opencodex-proxy` 주입
- `src/server/system-env.ts:34,241-245` — launchctl 시스템 env 주입 (systemEnv=true)
- `gui/src/pages/ClaudeCode.tsx:53` — 수동 env 안내 블록

## 감사에서 발견된 추가 결함 (블로커 #1/#2, High/Medium)

systemEnv=true 상태에서 proxy가 이미 launchctl에 주입된 뒤 Subscription으로
되돌리면: 재주입 경로(`system-env.ts:241-245`)는 proxy 모드일 때만 토큰을
세팅하고, 이미 주입된 `ANTHROPIC_AUTH_TOKEN`을 제거하는 로직이 없다 →
`opencodex-proxy` 더미 토큰이 잔류해 Claude 구독 로그인/커넥터를 계속 무력화.
또한 live-apply(`applySystemEnvToggle`)는 `body.systemEnv !== undefined`일 때만
실행(`management-api.ts:1177-1183`)되므로 authMode 단독 PUT은 반영이 지연된다.
→ 수리 범위에 포함 (010 참조).

## 테스트 기반 사실

- `loadConfig()`는 호출마다 디스크를 동기 재파싱(`src/config.ts:507-520`) —
  캐시 없음. persisted-config 단언은 기존 관례(`tests/claude-management-api.test.ts:80-96`)
  그대로 사용 가능.
