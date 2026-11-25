# 040 — 계정 풀 스케줄링과 egress

**Gaps:** G-012, G-013, G-014, G-015, G-016, G-017
**Depends on:** none
**Size:** XL (구현 단위 둘: 040a = G-012, G-013, G-016 · 040b = G-014 → G-015, G-017)

> 줄 번호와 줄 수는 OpenCodex `origin/dev` `9e0e298ef9` 기준이며, 줄 수는 ratchet의 `countLines`(`ocx:scripts/file-size-ratchet.ts:109`)로 센 값이다. 구현 단위를 열 때 현재 `dev`에서 다시 확인한다.

## Goal

같은 provider pool 안에서 계정마다 다른 upstream proxy를 쓴다. 확인된 quota cooldown이 재시작 뒤에도 유지된다. Codex·Claude OAuth 계정에 동시 실행 상한과 짧은 대기열이 생기고, 기존 priority tier 안에서 정적 weight와 실시간 부하로 계정을 고른다. 계정별 eligibility·refresh·cooldown 진단과 최근 fallback 결정의 후보·제외 사유를 본다.

## Why

- **G-012** — CPA는 credential에 `proxy_url`을 저장해 로그인·refresh·실행에 쓴다(`cpa:sdk/auth/manager.go:54–71`, `cpa:internal/runtime/executor/helps/proxy_helpers.go:36–69`). sub2api도 계정별 proxy를 고른다 (`004` L4-04). OpenCodex egress는 provider 단위다(`ocx:src/lib/provider-egress.ts:160`) (`002` L2-1).
- **G-013** — CPA는 cooldown을 선택적으로 복원한다(`cpa:sdk/cliproxy/service_lifecycle.go:86–99`). OpenCodex는 process-local map이다(`ocx:src/providers/api-key-cooldowns.ts:2`) (`002` L2-2).
- **G-014** — sub2api는 계정 lease와 WaitPlan으로 동시 실행을 집행한다(`s2a:backend/internal/service/gateway_scheduling.go:708,754`). OpenCodex는 Kiro에만 계정 lease가 있다(`ocx:src/oauth/kiro-account-load.ts:84`, `ocx:src/server/responses/request-transport.ts:214`) (`004` L4-01). sub2api issue #8552(2026-11-06)는 동시 실행 수와 TTFT가 함께 오른 보고다.
- **G-015** — sub2api priority → load → LRU(`s2a:backend/internal/service/gateway_scheduling.go:652,738`), CPA weighted RR(`cpa:sdk/cliproxy/auth/scheduler_weighted.go:7–30`). OpenCodex에는 operator priority가 이미 있다(`ocx:src/codex/auth-api/routes.ts:204`, `selectPriorityTier` `ocx:src/codex/routing/selection.ts:249`). 빠진 것은 tier 안 weight와 부하다 (감사 r1 #8).
- **G-016** — CPA `/credentials`는 models/status/refresh/verify를 준다(`cpa:internal/api/handlers/management/auth_files_v8.go:546,612`). OpenCodex `/api/oauth/accounts`에는 eligibility·refresh 결과 DTO가 없다 (`002` L2-3).
- **G-017** — cc-switch는 앱별 큐와 circuit breaker 상태를 보여 준다(`ccs:src-tauri/src/proxy/provider_router.rs:73–188`). OpenCodex fallback 정책(`ocx:src/routing/fallback-policy.ts:211`)은 결정 근거를 화면에 내지 않는다 (`003` L3-9).

## Changes

| 경로 | 의도 | 내용 |
|---|---|---|
| `src/types/pool-account.ts` | NEW | `{egress?: {proxy?: string; noProxy?: string[]}; weight?: number; maxConcurrent?: number}` |
| `src/types/config.ts` | MODIFY | 1939줄(여유 60). 계정/키 레코드에 위 타입 참조 한 필드씩 (`OcxApiKeyEntry` 근처 `ocx:src/types/config.ts:336` 패턴) |
| `src/lib/provider-egress.ts` | MODIFY | `resolveProviderEgress`(`ocx:src/lib/provider-egress.ts:160`)의 context에 `account?: {id, egress?}` 추가: request override → account → provider → env |
| `src/server/responses/fetch-helpers.ts` | MODIFY | `egressFor`(`ocx:src/server/responses/fetch-helpers.ts:362`)가 선택된 계정의 `{id, egress}`를 넘긴다 |
| `src/lib/provider-outbound.ts` | MODIFY | refresh·quota 조회 등 비요청 outbound(`ocx:src/lib/provider-outbound.ts:301`, `ocx:src/providers/quota/vendor-probes-key.ts:23`)도 계정 egress를 쓴다 |
| `src/providers/api-key-cooldowns.ts` | MODIFY | map(`ocx:src/providers/api-key-cooldowns.ts:2`)에 store 주입. 새 `api-key-cooldown-store.ts`가 `{provider, keyId, generation, cooldownUntil}`만 저장, 만료 sweep은 `ocx:src/lib/state-store-registrations.ts:129` 재사용 |
| `src/oauth/account-lease.ts` | NEW | `acquireAccountLease`(`ocx:src/oauth/kiro-account-load.ts:84`)를 namespace 키 `{ns: "account", provider, accountId} \| {ns: "caller", keyId}`로 일반화하고 in-flight 수를 노출 (070이 caller 키를 쓴다) |
| `src/server/responses/request-transport.ts` | MODIFY | 1879줄(여유 120). Kiro 분기(`ocx:src/server/responses/request-transport.ts:214`, `:1508`)를 공용 lease 호출로 교체, 줄 수 증가 없음 |
| `src/server/messages-native-oauth.ts` | MODIFY | `resolveNativeOAuthBinding`(`ocx:src/server/messages-native-oauth.ts:120`) 결과 계정에 lease 획득, 종료·취소 시 해제 |
| `src/codex/routing/selection-weighted.ts` | NEW | `selectPriorityTier`(`ocx:src/codex/routing/selection.ts:249`)가 고른 tier 안에서만 smooth weighted round-robin, 동률은 in-flight 적은 쪽 |
| `src/server/management/account-diagnostics-routes.ts` | NEW | 계정별 `{eligibleModels, lastRefresh:{at, ok, reason}, cooldownUntil, inFlight}` |
| `src/server/management/fallback-routes.ts` | MODIFY | `GET /api/fallback`(`ocx:src/server/management/fallback-routes.ts:33`) 옆에 최근 결정 projection `GET /api/fallback/decisions` |

선택 snapshot 계약 (감사 r2 #7): 040은 선택 결과로 `{provider, accountId, generation}`만 내보낸다. 호출자·세션 신원은 040이 정하지 않는다 (050·070 참조).

### Before / After

`ocx:src/lib/provider-egress.ts:160` — egress는 provider 설정만 본다.

```ts
// before
export function resolveProviderEgress(context: ProviderEgressContext): ProviderEgress {
  const { providerName, provider } = context;
  const raw = provider.proxy;
  /* inherit | direct | proxy URL 판정 */
```

```ts
// after (sketch)
export function resolveProviderEgress(context: ProviderEgressContext): ProviderEgress {
  const { providerName, provider, account } = context;      // account?: { id: string; egress?: PoolAccountEgress }
  const raw = account?.egress?.proxy !== undefined ? account.egress.proxy : provider.proxy;
  /* 같은 판정. noProxy는 account → provider 순으로 합친다 */
```

`ocx:src/oauth/kiro-account-load.ts:84` — lease는 Kiro 전용 모듈에 있다. 새 `src/oauth/account-lease.ts`로 옮기고 Codex·Claude OAuth 경로가 같은 함수를 부른다.

```ts
// before (kiro-account-load.ts)
if (state.waiters.length === 0
  && (opts.maxConcurrentPerAccount === undefined || state.records.size < opts.maxConcurrentPerAccount)) {
  return leaseFor(provider, accountId, key, state, now);
}
```

```ts
// after (account-lease.ts, sketch)
export type LeaseKey = { ns: "account"; provider: string; accountId: string } | { ns: "caller"; keyId: string };
export async function acquireAccountLease(key: LeaseKey,
  opts: { maxConcurrent?: number; waitMs?: number; signal?: AbortSignal }): Promise<AccountLease | null>;
export function leaseInFlight(key: LeaseKey): number; // SWRR 동률 판정(account)과 070 상한(caller)에 사용
```

## Dependencies

없음. 050은 선택 snapshot의 계정·generation을, 060의 G-024와 070은 egress resolver와 lease 구현을 쓴다.

## Acceptance

- 같은 Codex pool의 두 계정에 서로 다른 proxy를 지정하면 각 계정의 요청과 refresh가 지정 proxy로 나간다 (로컬 proxy fixture 두 개).
- quota cooldown 중인 키가 있는 상태로 재시작해도 만료 전까지 선택되지 않는다. 키를 교체(generation 변경)하면 cooldown이 따라가지 않는다.
- busy-account fixture: `maxConcurrent: 1`인 계정 A에 turn이 하나 걸려 있을 때 두 번째 turn은 대기 상한 안에서 기다리거나 B로 간다. 상한을 넘으면 명확한 거절 이유를 돌려준다. 설정이 없으면 동작 변화 없음.
- weight fixture: 같은 tier의 A(2)와 B(1)에 대해 SWRR이 처음 6번을 A, B, A, A, B, A로 고른다. 더 높은 priority tier의 계정과 manual pin이 있으면 그쪽이 먼저다.
- 진단 fixture: refresh 실패 계정은 `lastRefresh.ok=false`와 이유, 모델 미허용 계정은 `eligibleModels`에서 빠짐, cooldown 계정은 `cooldownUntil`이 보인다. email·토큰은 없다.
- fallback decisions는 최근 결정의 후보 순서와 제외 사유(cooldown, scope, 이미 시도함)를 보여 준다.

## Verification

- 신규 `tests/oauth/account-lease.test.ts`, `tests/providers/api-key-cooldown-store.test.ts`, `tests/codex-integration/codex-selection-weighted.test.ts`, `tests/lib/provider-egress-account.test.ts`, `tests/server/account-diagnostics-routes.test.ts`
- 기존 회귀: `tests/providers/kiro/kiro-account-load.test.ts`, `tests/adapters/key-failover.test.ts`, `tests/server/server-key-failover-e2e.test.ts`, `tests/codex-integration/` routing·selection 테스트
- `bun run typecheck`, `bun run test:changed`, `bun run structure:check`, `bun run privacy:scan`; 전송 경로라 `ci:full`

## Risks

- **File-size ratchet:** 캡에 없는 파일은 2000줄 이상이면 실패하고(`NEW_OVERSIZED`), 캡 파일은 캡을 넘으면 실패한다(`tests/fixtures/file-size-baseline.json`). `request-transport.ts` 1879, `anthropic-routing.ts` 1774, `types/config.ts` 1939 — sibling 모듈로 분리.
- **Lab 경계:** `tests/lab/core-lab-boundary.test.ts`의 보호 목록(`ocx:tests/lab/core-lab-boundary.test.ts:23`: `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`, `src/server/management-api.ts`)에서 `src/lab/`으로 가는 import가 직접이든 간접이든 생기면 안 된다. lease와 egress는 요청 경로에 들어간다.
- **재전송 계약:** lease 해제와 failover가 엇갈려도 fail-closed `refused-ambiguous` 게이트(`ocx:src/server/responses/reset-replay.ts:112`)를 완화하지 않는다.
- **Privacy:** proxy URL의 인증 정보는 `sanitizeProxyUrlForLog`(`ocx:src/lib/provider-egress.ts:72`)로 가린다.

## Non-goals

- 투명 rotation, TLS fingerprint (G-048 비채택), TTFT·실패율 점수화(관측 품질 확보 뒤 별도 단위).
