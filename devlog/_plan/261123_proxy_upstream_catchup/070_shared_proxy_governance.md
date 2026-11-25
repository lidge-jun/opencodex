# 070 — 공유 프록시 거버넌스: 발급 키 단위 동시 상한, 키 예산, 키 만료, 관리 감사

**Gaps:** G-025, G-026, G-027, G-028
**Depends on:** 040
**Size:** L

> 줄 번호와 줄 수는 OpenCodex `origin/dev` `9e0e298ef9` 기준이며, 줄 수는 ratchet의 `countLines`(`ocx:scripts/file-size-ratchet.ts:109`)로 센 값이다. 구현 단위를 열 때 현재 `dev`에서 다시 확인한다.

## Goal

proxy 하나를 여러 사람이 쓰는 팀이 발급 키마다 동시 실행 상한, request/token 예산, 만료 시각을 정하고, 키와 설정 변경을 감사 기록으로 본다. 정책이 없는 설치의 동작은 바뀌지 않는다.

## Why

- **G-025** — sub2api는 인증 사용자 기준 slot을 HTTP와 WS turn에 집행한다(`s2a:backend/internal/handler/openai_gateway_handler.go:614`) (`004` L4-03). OpenCodex admission 주체는 secret에서 파생된 키 단위다(`ocx:src/server/auth-cors.ts:483`). 070은 키 단위 상한을 만들고 키 간 집계는 G-057로 보류한다 (감사 r1 #3).
- **G-026** — sub2api는 키별 누적 비용과 5h/1d/7d window를 검사한다 (`005` L5-1). OpenCodex의 spend reservation ledger는 physical send 단위로 token을 예약하고(`ocx:src/lib/spend-reservation-ledger.ts:158`), 그 identity 범위는 upstream credential이다(`ocx:src/server/responses/request-spend.ts:174`). 발급 키 window와 request 수는 이 ledger로 표현되지 않는다 (감사 r3 #2). 그래서 별도 차원을 만들되 ledger의 durable 예약·unresolved 규칙을 그대로 따른다.
- **G-027** — sub2api는 키 만료를 인증 middleware에서 검사한다(`s2a:backend/internal/service/api_key_service.go:590`). OpenCodex 만료는 rotation 대기 secret에만 있다(`ocx:src/types/config.ts:365`) (`005` L5-2).
- **G-028** — sub2api는 관리 이벤트를 기록한다 (`005` L5-4). OpenCodex에는 구조화된 관리 감사 저장이 없다(`ocx:src/server/management/route-registry.ts:352`).

## Changes

| 경로 | 의도 | 내용 |
|---|---|---|
| `src/types/api-key-policy.ts` | NEW | `{maxConcurrentTurns?, budget?: {window: "5h" \| "1d" \| "7d"; requests?; tokens?}, expiresAt?}` |
| `src/types/config.ts` | MODIFY | `OcxApiKeyEntry`(`ocx:src/types/config.ts:336`)에 `policy?: ApiKeyPolicy` 한 필드 |
| `src/server/auth-cors.ts` | MODIFY | 1540줄. 키 principal 결정 지점(`ocx:src/server/auth-cors.ts:483`)에서 정책을 admission 결과에 첨부 |
| `src/server/key-admission.ts` | NEW | 만료·동시 상한 판정, 예산은 ledger reservation 호출. 동시 상한은 040 `account-lease.ts`를 `{ns: "caller", keyId}` 키로 재사용 |
| `src/lib/key-window-budget.ts` | NEW | 발급 키 window 차원 `{keyId, window, requests, tokens}`. 같은 state-directory SQLite lease 아래 durable 예약, settle, unresolved residue |
| `src/server/responses/request-spend.ts` | MODIFY | 물리 send 직전의 blocking 예약 지점 세 곳 — `bookedLedger.reserve`(`ocx:src/server/responses/request-spend.ts:342`, `ocx:src/server/responses/request-spend.ts:590`)와 이미 enforce 중인 정책의 seed 경로 `ensureSeed` → `reserveSeed`(`ocx:src/server/responses/request-spend.ts:555`, `ocx:src/server/responses/request-spend.ts:407`) — 에서 같은 send의 token ceiling을 key-window에도 예약하고 terminal usage로 정산. 사후 보고 경로 `reportFromSeed`(`ocx:src/server/responses/request-spend.ts:493`)에서는 예약할 수 없으므로 아래 규칙을 따른다 |
| `src/server/index/serve-options.ts` | MODIFY | standalone Realtime·dictation WS는 자체 인증 뒤 `tryAdmitTurn`을 직접 부른다(`ocx:src/server/index/serve-options.ts:1690`). 그 직후, upstream socket 결정(`ocx:src/server/index/serve-options.ts:1706`) 전에 `admitKeyTurn` 호출 (만료·상한, 090의 wire 거절) |
| `src/server/admitted-http-turn.ts` | MODIFY | `createAdmittedHttpTurn`(`ocx:src/server/admitted-http-turn.ts:15`) 시작 시 `admitKeyTurn`, 종료·취소 시 정산·해제 |
| `src/server/index/websocket-handler.ts` | MODIFY | 프레임별 turn 시작(`ocx:src/server/index/websocket-handler.ts:320`)에서 handshake admission을 재사용하지 않고 매 turn `admitKeyTurn`을 다시 호출 (만료·예산·상한) |
| `src/storage/admin-audit.ts` | NEW | `{at, actorKind, action, targetKind, targetId, result}` allowlist 필드만, retention |
| `src/server/management/route-registry.ts` | MODIFY | `mutates: true` 항목(예: `ocx:src/server/management/route-registry.ts:167`) 실행 뒤 audit hook |
| `gui/src/pages/ApiKeys.tsx` | MODIFY | 컴포넌트(`ocx:gui/src/pages/ApiKeys.tsx:131`)에서 sibling `ApiKeyPolicyEditor.tsx` 렌더 |

예산 계약 (감사 r2 #2, r3 #2):

- **request 단위:** turn admission에서 1건을 원자적으로 예약한다. retry·failover로 physical send가 늘어도 turn당 1건이다. turn이 업스트림에 한 번도 가지 않고 끝나면 해제한다.
- **token 단위:** request preparation이 `inputTokens + outputCeilingTokens`를 정한 뒤(기존 send 예약과 같은 시점) send마다 예약하고, terminal usage로 정산한다. usage frame을 잃은 send는 unresolved로 남아 한도에서 빠지지 않는다.
- **seed 재사용·재결합:** key-window 예약은 ledger와 같은 `sendId`에 묶는다. seed가 재사용되면 새 예약을 만들지 않고, retire·rebind(`ocx:src/server/responses/request-spend.ts:400`)되면 예약도 함께 옮겨 정확히 한 번만 계산한다 (감사 r5 #1).
- **사후 보고 send:** transport가 dispatch 뒤에야 보고하는 retry(`reportFromSeed`)는 hard ceiling으로 막을 수 없다. token 예산이 있는 키에서는 그런 transport-owned retry를 끄고(예약 없는 추가 send 0회), 끌 수 없는 경로는 admission에서 거절한다 (감사 r4 #2).
- **window:** 예약은 admission 시각의 window에 속한다. window는 고정 경계(5h는 UTC 0시 기준 5시간 단위, 1d·7d는 UTC 0시)로 굴러가며, 경계를 넘은 진행 중 turn의 정산은 원래 window에 반영된다.

```ts
export async function admitKeyTurn(key: AuthenticatedKey | undefined, now: number): Promise<
  | { ok: true; lease: AttachableLease }   // turn lease에 attach. 정산은 request spend tracker가 terminal usage로, 미사용 예약 반환은 lease 종료 시
  | { ok: false; status: 401 | 429; reason: "key_expired" | "budget_exhausted" | "caller_concurrency" }>;
// 거절은 refusal log에 reason을 남기고, Claude Code 요청이면 Messages 형식 오류로 돌려준다.
// 정책 없는 키와 무인증 loopback 요청은 즉시 ok (기존 동작)
```

### Before / After

`ocx:src/server/admitted-http-turn.ts:41` — turn lease에는 workflow lease만 붙고, 응답이 다른 소유자에게 넘어가면(`isTransferred`) 여기서 해제하지 않는다.

```ts
// before
if (workflow?.admitted) lease.attach(workflow.lease);
try {
  const response = await runAdmittedBodyWork(req, policy, configuredLimit(), () => work(lease), /* … */);
  if (!lease.isTransferred()) lease.release();
  return response;
} catch (error) { lease.release(); throw error; }
```

```ts
// after (sketch)
if (workflow?.admitted) lease.attach(workflow.lease);
const keyTurn = await admitKeyTurn(admittedKeyOf(req), Date.now());   // 040 lease 획득이 async이므로 await. 정책 없는 키는 no-op lease
if (!keyTurn.ok) {
  lease.release();
  // workflow 거절(admitted-http-turn.ts:39)과 같은 경로: Messages 형식 정규화와 refusal log
  return withCors(await normalizeMessagesProxyRefusal(req, map(keyRefusalResponse(keyTurn, refusalLog))), req, policy);
}
lease.attach(keyTurn.lease);
bindKeyTurnToSpendTracker(keyTurn.lease, req);   // AdmissionLease.release()는 usage를 받지 않으므로 정산은 request spend tracker가 맡는다
// keyTurn.lease는 turn lease가 끝날 때(전송이 넘겨진 경우 그 소유자가 끝낼 때) 함께 끝난다:
// physical send가 있었으면 terminal usage로 settle, 하나도 없었으면 request 예약을 반환한다.
try { /* runAdmittedBodyWork … 기존 그대로 */ } catch (error) { lease.release(); throw error; }
```

## Dependencies

040. 040은 lease 구현(용량 계산)만 제공한다. 호출자 신원은 발급 키다.

## Acceptance

- 정책이 없는 설치에서 요청 경로 동작이 바뀌지 않는다 (기존 admission 테스트 통과).
- request 예산이 1 남은 키로 동시에 두 turn을 시작하면 정확히 하나만 통과하고 다른 하나는 429 `budget_exhausted`다.
- token 예산이 한 turn의 ceiling만큼만 남은 키로 동시에 두 turn을 시작하면 하나만 token 예약에 성공한다. retry가 일어나도 request 수는 1로 남는다.
- fixture: workflow spend ceiling과 발급 키 token cap이 동시에 걸린 상태에서 seed 경로로 들어온 send가 두 한도 모두에 한 번씩만 예약되고, seed가 재사용되어도 key-window 사용량이 늘지 않는다.
- fixture: 첫 send가 마지막 token 허용량을 쓴 뒤 transport-owned retry가 필요해지면 추가 send는 0회이고 429 `budget_exhausted`로 끝난다.
- Realtime·dictation WS도 만료된 키에서 upstream socket을 열지 않는다.
- 재시작 뒤에도 window 사용량이 ledger 기준으로 유지되고, window가 지나면 다시 허용된다.
- 열린 WS 세션에서 키 만료 시각이 지나면 그 뒤 프레임의 새 turn은 401 `key_expired`이고, 이미 진행 중인 turn은 끝까지 간다.
- `maxConcurrentTurns: 1` 키의 동시 두 번째 turn은 429 `caller_concurrency`다.
- Claude Code(Messages) 요청이 키 정책으로 거절되면 Messages 형식 오류를 받고, request log에 거절 reason이 남는다.
- 키 발급·폐기와 설정 변경이 감사 목록에 나오며 요청 원문·credential·계정 식별자가 없다.

## Verification

- 신규 `tests/server/key-admission.test.ts`, `tests/server/key-admission-websocket.test.ts`, `tests/lib/key-window-budget.test.ts`, `tests/storage/admin-audit.test.ts`
- 기존 회귀: `tests/server/` auth·admission·API key 테스트, spend reservation ledger 테스트
- `bun run typecheck`, `bun run test:changed`, `bun run structure:check`, `bun run privacy:scan`, `bun run lint:gui`

## Risks

- **File-size ratchet:** 캡에 없는 파일은 2000줄 이상이면 실패하고(`NEW_OVERSIZED`), 캡 파일은 캡을 넘으면 실패한다(`tests/fixtures/file-size-baseline.json`). `auth-cors.ts` 1540, `types/config.ts` 1939 — 로직은 sibling. `spend-reservation-ledger.ts`는 수정하지 않는다.
- **Lab 경계:** `tests/lab/core-lab-boundary.test.ts`의 보호 목록(`ocx:tests/lab/core-lab-boundary.test.ts:23`: `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`, `src/server/management-api.ts`)에서 `src/lab/`으로 가는 import가 직접이든 간접이든 생기면 안 된다. admission은 요청 경로다.
- **잘못된 귀속:** 무인증 loopback이나 익명 키를 사용자로 묶지 않는다.
- **USD 예산:** 가격 근거와 정산 규칙이 없으므로 1차는 request/token만.

## Non-goals

- 키 간 owner 집계 (G-057 보류), 사용자 계정·RBAC·결제 (G-049 비채택), IP 제한 (G-041 보류).
