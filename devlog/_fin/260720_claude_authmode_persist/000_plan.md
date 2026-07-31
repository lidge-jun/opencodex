# 260720 — Claude Code authMode(proxy) 대시보드 토글 미persist RCA + 수리

## Objective

대시보드 Claude Code 페이지에서 인증 모드를 Proxy(계정 불필요)로 바꿔 저장해도,
새로고침하면 Subscription으로 되돌아가는 결함의 원인 규명 + 수리 + devlog 문서화.
사용자 보고(디시 갤러리): "대시보드에서 변경해도 새로 고치면 구독 모드로 다시 됨".

## RCA

증거 전문은 `001_research.md` 참조. 요약: `/api/claude-code` PUT 파서에
`authMode` 분기가 없어 저장이 드랍되고, GET 응답에도 키가 없어 GUI가 항상
subscription으로 표시한다. 감사에서 추가 확인: systemEnv=true일 때 proxy →
subscription 전환 시 launchctl에 주입된 더미 `ANTHROPIC_AUTH_TOKEN`이 잔류하는
2차 결함(001 §감사 블로커) — 본 유닛 수리 범위에 포함.

## Scope

IN: `src/server/management-api.ts` GET/PUT authMode 왕복 + authMode 변경 시
live-apply 트리거, `src/server/system-env.ts` 재주입 시 stale 더미 토큰 정리,
`tests/claude-management-api.test.ts`/`tests/system-env.test.ts` 회귀 테스트,
본 devlog.
OUT: GUI 변경(현행 GUI는 서버가 왕복만 해주면 그대로 동작), subscription 모드
의미 변경, launchctl 이외 플랫폼의 env 반영.

## Work-phase map (v2 — LOOP-UNIT-CHAIN-01 append, 2026-07-20)

- 010: management-api authMode 왕복 + live-apply + stale 토큰 정리 + 회귀
  테스트. (완료 — f1d2b19b, D 기록 090_done.md)
- 020: settings.env 라우팅 납치 방어 — `ocx claude` spawn env에
  `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` (cc-switch 잔재가
  `~/.claude/settings.json` env로 BASE_URL/TOKEN을 덮어쓰는 것 차단).
  launchctl 주입은 감사 R1 #2로 철회. D 기록은 091_done_phase2.md.

## Accept criteria

- GET `/api/claude-code` 응답에 `authMode: "subscription" | "proxy"` 포함
  (config 미설정 시 "subscription").
- PUT `{authMode:"proxy"}` → config에 `authMode:"proxy"` 저장;
  PUT `{authMode:"subscription"}` → config에서 키 삭제(타입이 `"proxy"`만 허용).
- PUT에 잘못된 값 → 400. 활성 시나리오: 잘못된 문자열(`"x"`)과 비문자열(`42`)
  둘 다 테이블 테스트로 400 관찰.
- authMode 변경 PUT은 `applySystemEnvToggle` 재조정을 트리거한다
  (`body.systemEnv !== undefined || body.authMode !== undefined`). 활성 시나리오:
  단위 테스트로 authMode 단독 PUT이 재조정 경로에 도달함을 관찰(비-darwin에선
  no-op 반환이므로 반환값/호출 여부로 관찰).
- systemEnv 재주입은 proxy가 아닐 때, 이전에 opencodex가 주입한(tracking에 있는)
  `ANTHROPIC_AUTH_TOKEN`이 더미(`opencodex-proxy`)로 남아 있으면 제거한다.
  사용자 소유(주입 목록에 없는) 토큰은 건드리지 않는다. 활성 시나리오:
  `tests/system-env.test.ts` 전환 테스트(proxy 주입 상태 → subscription 재적용
  → 더미 토큰 unset 관찰).
- 활성 시나리오(C-ACTIVATION-GROUNDING-01, 왕복): PUT proxy → GET "proxy" +
  `loadConfig()` 디스크 재파싱으로 config 키 존재 단언(캐시 없음 —
  `src/config.ts:507`).
- `bun test tests/claude-management-api.test.ts tests/system-env.test.ts` green,
  `tsc --noEmit` green.

## SoT sync target

`src/types.ts`의 authMode 주석은 이미 정확 — 코드가 계약을 못 따라간 케이스.
D에서 devlog `_fin` 아카이브로 마감.
