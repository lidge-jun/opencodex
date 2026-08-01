# src 구조 재편 + 대형 파일 분할 (260707)

Goal: HOTL PABCD 루프, 3 work-phases. Session 019f34f2-3c06-7250-a2ee-dd3707f8130d.
Baseline: bun test 1555 pass / 0 fail (159 files), tsc --noEmit exit 0. (2026-07-07 실측)

## WP1 — 워킹트리 커밋 정리 (DONE)

dirty tree 53항목을 논리 단위 atomic 커밋으로 분리. 커밋 그룹:

1. `feat(anthropic)`: image guard (2000px many-image 400 방지) + assistant-tail "(continue)" nudge
   - src/adapters/anthropic.ts, src/adapters/anthropic-image-guard.ts(신규), tests/anthropic-image-guard.test.ts, tests/anthropic-tail-guard.test.ts
2. `feat(responses)`: remote compaction v1+v2
   - src/responses/compaction.ts(신규), src/bridge.ts, src/responses/parser.ts·schema.ts·state.ts(일부), src/types.ts(_compactionRequest), src/server.ts(handleResponsesCompact + compact route + routedCompaction), src/adapters/openai-responses.ts(일부), tests/responses-compaction.test.ts 외
3. `feat(oauth)`: multiauth 계정 스토어 + 관리 API + addAccount forceLogin
   - src/oauth/store.ts·index.ts·types.ts·token-guardian.ts·google-antigravity.ts, src/server.ts(/api/oauth/accounts*), tests/oauth-store-multi.test.ts, tests/oauth-accounts-api.test.ts, tests/token-guardian.test.ts
4. `feat(providers)`: API-key pool (multiauth twin)
   - src/provider-api-keys.ts(신규), src/server.ts(/api/providers/keys*), src/types.ts(apiKeyPool), tests/provider-api-keys.test.ts
5. `feat(providers)`: thinkingToggleModels (mimo/glm 토글 사다리)
   - src/providers/registry.ts·derive.ts, src/adapters/openai-chat.ts, src/router.ts, src/types.ts(thinkingToggleModels), src/reasoning-effort 관련 tests
6. `fix(server)`: WS 426 gate + /v1/* JSON 404 guard + 로그 terminal 메타 + ws-bridge onSsePayload
   - src/server.ts(잔여), src/ws-bridge.ts, tests/ws-endpoint.test.ts, tests/server-auth.test.ts
7. `feat(responses)`: reasoning envelope 스캐폴드 (ocxr1, 아직 미배선 — parked WIP 명시)
   - src/responses/reasoning-envelope.ts, src/types.ts(thinking_signature/redacted)
8. `feat(gui)`: multiauth 드롭다운, 토큰 만/억/조 표기 전역화, Logs/Usage/Dashboard 반응형
   - gui/* 전부 (format-tokens.ts, status-codes.ts 신규 포함)
9. `fix(tests)`: cli-provider CODEX_HOME 격리 (+src/cli-provider.ts) / docs: structure/*.md

공유 파일(server.ts, types.ts)은 hunk 단위 staging(git apply --cached)으로 분리.
tests/.tmp-server-auth-test/ 는 .gitignore 추가.
각 커밋 시점 검증: tsc + 관련 테스트, 마지막에 전량 bun test.

## WP2 — 폴더 재편 (DONE)

최종 이동 맵 (61 move, 루트 7 유지). 접두사는 폴더가 대신하므로 strip:
- src/codex/ (24): codex-*.ts 22개 → 접두사 제거 (codex-catalog→codex/catalog 등),
  + history-migration-guardian.ts, model-cache.ts (catalog와 상호참조 — colocate로 순환 경계화 방지)
- src/cli/ (8): cli.ts→cli/index.ts, cli-help→cli/help, cli-models→cli/models,
  cli-provider→cli/provider, cli-status→cli/status, + doctor.ts, init.ts, star-prompt.ts
- src/usage/ (4): usage-{debug,log,summary,totals} → 접두사 제거
- src/update/ (3): update.ts→update/index.ts, update-job→update/job, update-notify→update/notify
- src/providers/ (4): provider-{api-keys,context-cap,label,quota} → 접두사 제거
- src/server/ (5): server.ts→server/index.ts, ws-bridge.ts, ports.ts, proxy-liveness.ts, request-decompress.ts
- src/lib/ (13): abort, bun-runtime, crash-guard, debug, errors, open-url, privacy,
  process-control, redact, service-secrets, sidecar-tracker, upstream-retry, win-paths
- 루트 유지 (7): index.ts, types.ts, config.ts, router.ts, bridge.ts, service.ts, reasoning-effort.ts

실행: python 코드모드 — git mv 후 src/tests/scripts 전체의 상대 import/동적 import
문자열을 (구위치 기준 resolve → 이동맵 적용 → 신위치 기준 re-relativize)로 결정적 재작성.
index.ts 목적지는 폴더 축약형("./server") 사용. 수동 갱신: package.json scripts,
bin/ocx.mjs·package-main.mjs, scripts/ocx-restart.sh, src/config.ts:475 entrypoint 체크
(구경로 "src/cli.ts"도 계속 인식 — 설치본 ocx 프로세스 감지용), 테스트의 join("src","cli.ts")류
문자열 경로, structure/*.md.

## WP3 — 파일 분할 (DONE)

server/index.ts(≈3000 post-WP1) → 책임 단위 ≤800줄 조각. Franklin 경계안:
lifecycle(턴 추적/드레인), responses(handleResponses+compact), request-log,
relay(SSE/헤더), auth-cors, management-api, models, http-router, ws-router,
index.ts는 startServer + 파사드(re-export로 기존 "../src/server" import 유지).
동작 변화 없는 순수 리팩터. 테스트가 import하는 export 전수 유지
(startServer, consumeForInspection, sanitizePassthroughHeaders, relay*, request-log 계열,
registerTurn/unregisterTurn/isDraining/..., resolveAdapter, corsHeaders, safeConfigDTO 등).

## Evidence ledger

- 260707 WP1 P: baseline green 실측 (1555/0, tsc 0)
- 260707 WP1 A: gpt-5.5 감사 PASS-WITH-FIXES — provider-quota orphan→oauth 커밋, cli-provider→pool 커밋, parity test→toggle 커밋, continuation cache 별도 라벨, 커밋 순서 교정, tmp dir gitignore 안전
- 260707 WP1 B: 8 atomic 커밋 (30d1752 anthropic guard → 38d1fea responses compat/continuation/compaction → 12aff01 oauth multiauth+key pool → d102a12 thinking toggle → a8675ce WS426/404/log-meta → 316147b envelope scaffold → 616a443 gui → 9fb90e2 tests/docs). 공유 파일(server.ts/types.ts)은 hunk 필터 스크립트로 분리 staging.
- 260707 WP1 C: 각 커밋 detached worktree(/tmp/ocx-verify) checkout 검증 — tsc 0 + 해당 테스트 그린. 최종 HEAD 9fb90e2: bun test 1555 pass/0 fail, tsc exit 0 (실측).
- 260707 WP2 B: e322f40 — 61 git mv + 결정적 import 코드모드(/tmp/ocx-restructure.py), src 최상위 raw ts 68→7. 런타임 경로 산술 수정(service cliEntry, codex/shim, update HERE, cli/help·server package.json), config isOcxStartCommandLine 신구 엔트리포인트 겸용, 테스트/스크립트/구조문서 문자열 경로 갱신.
- 260707 WP2 C: gpt-5.5 C-gate 감사 verdict FAIL 1건 — update/job.ts packageLauncherPath가 src/bin/ocx.mjs로 해석(테스트는 명시 인자라 미포착) → 3ce0a83 수정. 재검증: 1555/0, tsc 0, cli --version 정상.
- 260707 WP3 B: Darwin(gpt-5.5 worker) 분할 실행 — server/index.ts 2811→523 + lifecycle 73 / request-log 310 / relay 534 / auth-cors 231 / responses 692 / management-api 612. 상태 단일 소유(activeTurns·draining→lifecycle, 로그 배열→request-log, corsOrigin→auth-cors). evidence: .codexclaw/evidence/20260706T200615Z-server-split-verification.md
- 260707 WP3 C/D: 메인 세션 독립 감사 — export 심볼 diff 손실 0(추가분만: VERSION, getRequestLogEntries, setDraining, setServerRef). 1555/0 + tsc 0 실측, 87e1d00 커밋. codex/catalog(1085)·service.ts(737) 분할은 후속 선택 항목으로 유보.

## 종결

3 work-phases 완료. 커밋 체인: 30d1752 … 9fb90e2 (WP1, 8개) → e322f40+3ce0a83 (WP2) → 87e1d00 (WP3).
src 최상위 raw ts 68→7 (index, types, config, router, bridge, service, reasoning-effort).
NEEDS_HUMAN: 실행 중 ocx 프로세스는 재시작하지 않음 — 새 코드 반영은 사용자 승인 후 restart 필요.
