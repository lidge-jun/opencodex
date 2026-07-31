# 160 — 2차 Patch 검증 결과

## 검증 일시

2026-06-21 03:30 UTC

## 검증 환경

- bun v1.3.14
- macOS arm64
- tsc --noEmit: clean
- bun test: 116 pass / 0 fail / 379 expect()

## Finding별 검증

### F1: OpenCode Go URL 정규화 (Blocker) — ✅ RESOLVED

**Commit**: `ef389f6`
**변경**: `src/adapters/anthropic.ts:178` — baseUrl 끝 `/v1` 제거 후 URL 구성
**테스트**: `tests/url-normalization.test.ts` — 5 cases (opencode-go, trailing slash, standard anthropic, mid-URL, false positive)

```
Before: https://opencode.ai/zen/go/v1/v1/messages (404)
After:  https://opencode.ai/zen/go/v1/messages (correct)
```

### F2: WS incomplete event type (High) — ✅ RESOLVED

**Commit**: `945f4b2`
**변경**: `src/ws-bridge.ts:226` — template literal `response.${finalStatus}`
**테스트**: `tests/ws-endpoint.test.ts` — 2 cases (incomplete→response.incomplete, failed→response.failed)

```
Before: status "incomplete" → event type "response.completed" (Codex treats as success)
After:  status "incomplete" → event type "response.incomplete" (Codex treats as error)
```

### F3: localhost CSRF (Medium) — ✅ RESOLVED

**Commit**: `8107f2d`
**변경**: `src/server.ts` — `isLocalOrigin()` + handleManagementAPI 상단 POST/PUT/DELETE guard
**테스트**: CSRF 보호는 서버 integration test 필요 (unit test 범위 밖) — Origin 검증 로직은 코드 리뷰로 확인

```
Before: POST /api/stop with any Origin → 200 (proxy stops)
After:  POST /api/stop with foreign Origin → 403 (blocked)
```

### F4: heartbeat stall timeout (Medium) — ✅ RESOLVED

**Commit**: `a66a6c0` + `a490882`
**변경**: `src/bridge.ts`, `src/types.ts`, `src/server.ts` — `stallTimeoutSec` in options object, default 90s, min 1s
**테스트**: `tests/bridge-lifecycle.test.ts` — stallTimeoutSec=1 triggers response.incomplete after deadline

```
Before: hardcoded 150 ticks × 2s = 5 min, no config
After:  configurable stallTimeoutSec (default 90s, min 1s), options object (no call site breakage)
```

### F5: Windows update shim repair (Medium) — ✅ RESOLVED

**Commit**: `63cac58`
**변경**: `src/update.ts` (async), `src/cli.ts` (await) — installCodexShim() 호출
**테스트**: Platform-specific (Windows 필요) — macOS에서 코드 경로 확인, 실행은 win32 조건 분기

```
Before: ocx update → npm/bun install → done (shim may be overwritten)
After:  ocx update → npm/bun install → installCodexShim() on Windows → done
```

## 감사 audit 피드백 반영

| Audit Issue | 조치 |
|---|---|
| Phase 130: handleManagementAPI에 listenPort 없음 | `_corsOrigin` 모듈 변수 활용 |
| Phase 130: POST만 보호, PUT/DELETE 누락 | POST/PUT/DELETE 모두 커버 |
| Phase 140: bridgeToResponsesSSE call site 파손 | positional param 대신 options 객체에 추가 |
| Phase 150: runUpdate 동기함수에 await import | async로 변환, cli.ts await 추가 |
| Phase 150: ensureCodexShim 존재하지 않음 | 실제 export인 installCodexShim 사용 |

## 커밋 목록

| Commit | 내용 |
|---|---|
| `643b668` | docs: v2.1.2 patch plan |
| `ef389f6` | fix: URL normalization |
| `945f4b2` | fix: WS incomplete event |
| `8107f2d` | fix: CSRF protection |
| `a66a6c0` | feat: stall timeout config |
| `63cac58` | fix: update shim repair |
| `a490882` | test: patch-specific tests |

## 남은 항목 (v2.1.2 scope 밖)

- H5: native WebSocket response header 보존 — 실환경 capture 필요
- ANTHROPIC_WIRE_MODELS 모델 목록 drift 모니터링
- structure/ 문서 업데이트 (transport 섹션의 WS incomplete 설명)
