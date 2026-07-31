# 200 — 2차 Patch Plan: v2.1.2 Release Gate Remediation

v2.1.1 감사 결과 NO-GO. 1차 패치(10~60)에서 해결 안 된 잔여 finding + 1차 패치가 만든 새 결함을 수정한다.

## Finding → Patch Phase 매핑

| # | Finding | Severity | Root Cause | Patch Phase |
|---|---------|----------|------------|-------------|
| F1 | OpenCode Go `/v1/v1/messages` URL 이중화 | **Blocker** | `resolveWireProtocolOverride`가 adapter만 변경, baseUrl 미조정 | 110_ |
| F2 | WS JSON fallback이 `incomplete`를 `completed`로 전송 | **High** | `ws-bridge.ts` event type 분기에 `incomplete` 누락 | 120_ |
| F3 | `/api/stop`, `/api/oauth/logout` localhost CSRF | **Medium** | mutating POST에 Origin 검증 없음 | 130_ |
| F4 | heartbeat가 실패 감지를 5분까지 지연 | **Medium** | `maxStallTicks=150` 하드코딩, 설정 불가 | 140_ |
| F5 | `ocx update` 후 Windows shim repair 미호출 | **Medium** | `runUpdate()`에 shim repair 연동 없음 | 150_ |

## 수정 파일 요약

| 파일 | 변경 유형 | 관련 Phase |
|------|----------|-----------|
| `src/server.ts` | MODIFY | 110_, 130_ |
| `src/adapters/anthropic.ts` | MODIFY | 110_ |
| `src/ws-bridge.ts` | MODIFY | 120_ |
| `src/bridge.ts` | MODIFY | 140_ |
| `src/types.ts` | MODIFY | 140_ |
| `src/update.ts` | MODIFY | 150_ |
| `tests/wire-protocol-override.test.ts` | NEW | 110_ |
| `tests/ws-endpoint.test.ts` | MODIFY | 120_ |
| `tests/csrf-protection.test.ts` | NEW | 130_ |
| `tests/bridge-lifecycle.test.ts` | MODIFY | 140_ |

## 구현 순서

1. **110_ (Blocker)** — URL 정규화. 가장 심각, 먼저 수정
2. **120_ (High)** — WS incomplete event. 코드 변경 최소
3. **130_ (Medium)** — CSRF 보호. server.ts 터치 후 묶어서
4. **140_ (Medium)** — heartbeat timeout 설정화
5. **150_ (Medium)** — Windows update repair hook

## Codex RS 계약 참조

Codex RS SSE 처리 (`codex-rs/codex-api/src/sse/responses.rs`):
- event type `response.completed` → 정상 완료
- event type `response.incomplete` → 즉시 오류 처리
- event type `response.failed` → 즉시 오류 처리
- 알 수 없는 event type → `Ok(None)` (무시)
- idle timeout: ANY SSE frame이 idle timer 재설정

→ proxy가 heartbeat를 보내면 idle timeout이 영원히 리셋되므로, proxy 자체의 stall timeout이 유일한 실패 감지 경로.
→ WS에서 `response.completed` type + `status: "incomplete"` body는 Codex가 정상 완료로 처리함. type이 계약.
