# 010 — probe lease 구현 계약

근거와 활성화 경로는 `000_plan.md` 참조. 이 문서는 구현 계약만 담는다.

## 불변식

1. 계정당 동시 lease 최대 1개.
2. **success에 의한 조기 해제**는 lease를 소지하고 세대가 일치하는 outcome만 할 수 있다.
   (credential quarantine은 아래 예외를 참조 — 그건 해제가 아니라 상태 대체다.)
3. `Retry-After` 유래 cooldown은 probe 대상이 아니다.
4. **lease는 자신이 발급된 cooldown 세대에만 유효하다.** lease 취득 후 cooldown이
   갱신되면 그 lease의 success는 새 cooldown을 해제하지 못한다.
5. lease 없는 2xx는 cooldown을 보존한다 (기존 테스트 `:312`, `:806`).
6. **소유한 probe의 모든 terminal outcome은 lease를 반납한다.** 세대가 낡았더라도
   probe가 끝났다는 사실은 변하지 않는다.

### 예외: credential quarantine

401/403은 계정을 쓸 수 없다는 뜻이므로 quota 상태를 유지할 이유가 없다. 현재
`routing.ts:483`이 health를 reauth 상태로 통째로 덮어쓰며, 그 결과 lease와 cooldown이
함께 사라진다. 이는 불변식 2의 "해제"가 아니라 **상태 대체**이며 의도된 동작이다.
lease 일치 여부와 무관하게 적용된다.

## 두 개의 판정을 분리한다

A-gate에서 발견된 논리 오류. `L`을 "id 일치 && 세대 일치" 단일 조건으로 두면, 다른
요청이 세대를 올린 뒤 원래 probe가 끝났을 때 `L=아니오`가 되어 **자기 lease를 반납하지
못한다.** 완료된 probe의 lease가 영구히 남는다.

따라서 두 판정을 나눈다. `meta`에는 lease id만 실리고 세대는 없으므로, 세대 비교는
저장된 `probeLeaseGeneration`과 현재 `cooldownGeneration`을 대조한다. `meta`의 세대를
읽으려 하면 구현 불가능하다.

```ts
// meta.probeLeaseId 존재 조건이 선행되어야 한다. 없으면 undefined === undefined 로
// lease 없는 outcome이 소유자로 오판된다.
const ownsLease =
  meta.probeLeaseId !== undefined &&
  meta.probeLeaseId === health.probeLeaseId;

// 세대는 lease 발급 시 저장해 둔 값과 현재 cooldown 세대를 비교한다.
const mayClearCooldown =
  ownsLease &&
  health.probeLeaseGeneration === health.cooldownGeneration;
```

- `ownsLease`가 참이면 **항상 lease를 반납**한다 (불변식 6).
- `mayClearCooldown`이 참일 때만 success가 cooldown을 지운다 (불변식 2·4).

## 하드 cooldown 메타데이터 보존 규칙 (STRICT)

현재 success/transient 분기는 health 객체를 **재구성**한다(`routing.ts:476`, `:526`).
그대로 확장하면 늦게 도착한 비소유 2xx/503 하나로 `cooldownSource`·`cooldownSince`·
`cooldownGeneration`·진행 중 lease가 통째로 날아간다. Retry-After 출처가 사라지면
불변식 3이 깨지고, 세대가 사라지면 불변식 4가 깨진다.

**규칙: 다음 세 경우를 제외한 모든 전이는 하드 cooldown 메타데이터와 비소유 lease를
그대로 보존한다.**

1. `quota` 갱신 — cooldown/source/세대를 새 값으로 쓴다 (세대 증가).
2. `credential` 대체 — health 전체를 reauth 상태로 덮어쓴다 (의도된 예외).
3. `mayClearCooldown`인 success — `upstreamHealth.delete()`.

보존 대상 필드: `cooldownUntil`, `cooldownSince`, `cooldownSource`, `cooldownGeneration`,
`lastProbeAt`, 그리고 자신이 소유하지 않은 `probeLeaseId`/`probeLeaseGeneration`.

구현 시 health를 새로 만들지 말고 기존 객체를 spread한 뒤 바뀌는 필드만 덮는다.

### 불변식 4가 필요한 이유

A-gate에서 발견된 우회 경로다. reset-derived cooldown에서 probe lease가 나간 뒤,
다른 비-lease 요청이 `429 Retry-After: 7200`을 받아 cooldown을 retry-after 출처로
갱신한다. 그 후 원래 probe의 2xx가 도착하면 lease가 일치하므로 상태 전체가 삭제되어
**새로 받은 명시적 Retry-After가 우회된다.** 불변식 3과 정면 충돌하는 quota 우회다.

해결: cooldown이 새로 기록될 때마다 세대 번호를 올리고, lease에 발급 시점의 세대를
박아 둔다. success 시 `leaseId` 일치뿐 아니라 `generation` 일치도 요구한다.

## lease 생명주기: TTL 대신 명시적 반납

TTL 회수는 불변식 1을 깨뜨린다. 요청 총 실행시간에 상한이 없어(`connectTimeoutMs`는
응답 헤더 대기 시간일 뿐) 스트리밍 중 TTL이 만료되면 두 번째 probe가 동시에 나간다.

**결정: TTL을 쓰지 않는다.** lease는 outcome 기록 또는 명시적 반납으로만 종료된다.
누수 시 최악은 cooldown 만료까지 probe가 없는 것인데, 이는 현재 동작과 동일하므로
회귀가 아니다. 안전한 실패 방향이다.

### 반납 책임 (upstream 전송 전에 끝나는 경로)

| 위치 | 상황 |
|---|---|
| `auth-context.ts:138` | `getMainAccountToken()` null → `CodexPoolAuthenticationError` |
| `auth-context.ts:146` catch | `getValidCodexToken()` 실패 → `CodexAuthContextError` |
| `core.ts:854` | `isCodexAuthContextUsable()` false → 401 반환 |
| `openai-sidecar.ts:92` | sidecar가 auth 후 요청을 보내지 않고 끝나는 경로 |

앞의 두 곳은 `resolveCodexAuthContext()` 내부라 lease id를 알고 있으므로 그 자리에서
반납한다. 뒤의 두 곳은 반환된 `authCtx.probeLeaseId`로 반납한다.

## 상태 전이표

| outcomeClass | ownsLease | 세대 일치 | 동작 |
|---|---|---|---|
| `success` | 예 | 예 | `upstreamHealth.delete()` — probe 성공, cooldown 해제 |
| `success` | 예 | 아니오 | **lease만 반납**, cooldown/source/세대 전부 보존. 그 사이 다른 요청이 새 제한을 받았으므로 해제하지 않는다 |
| `success` | 아니오 | — | soft-avoid 정리 등 기존 동작 + **하드 cooldown 메타데이터와 진행 중 lease 보존** |
| `quota` | 예 | — | cooldown 갱신 + 세대 증가, lease 반납, `lastProbeAt=now` |
| `quota` | 아니오 | — | cooldown 갱신 + 세대 증가, 기존 lease/probe 상태 보존 |
| `transient` | 예 | — | cooldown 유지, lease 반납, `lastProbeAt=now` |
| `transient` | 아니오 | — | 기존 soft-avoid escalation + **하드 cooldown 메타데이터와 진행 중 lease 보존** |
| `caller` | 예 | — | lease 반납 + `lastProbeAt=now` (현재는 early return이므로 이 처리를 추가) |
| `caller` | 아니오 | — | 기존 동작 (early return, 상태 변화 없음) |
| `credential` | — | — | reauth 상태로 health 대체. lease와 cooldown이 함께 사라진다 (위 예외 참조) |
| `unknown` | — | — | 현재 코드가 transient 분기로 내려가므로 transient 행과 동일 |

핵심 두 가지:

- 소유하지 않은 outcome은 lease를 건드리지 않는다 — 다른 요청의 503이 진행 중 probe를
  죽이지 못한다.
- 소유한 outcome은 세대와 무관하게 lease를 반납한다 — 완료된 probe가 lease를 남기지 않는다.

## 변경 파일

| 파일 | 종류 |
|---|---|
| `src/codex/routing.ts` | MODIFY |
| `src/codex/auth-context.ts` | MODIFY |
| `src/server/responses/core.ts` | MODIFY (meta 추가 + 반납) |
| `src/server/responses/compact.ts` | MODIFY (meta 추가) |
| `src/providers/openai-sidecar.ts` | MODIFY (meta 추가 + 반납) |
| `tests/codex-routing.test.ts` | MODIFY |
| `tests/codex-quota-probe.test.ts` | NEW (통합 회귀) |

### `src/codex/routing.ts`

상수 (43행 뒤):

```ts
const CODEX_MAX_RESET_DERIVED_COOLDOWN_MS = 15 * 60_000;
export const CODEX_QUOTA_PROBE_INTERVAL_MS = 5 * 60_000;
```

`CodexUpstreamHealth` 추가 필드:

```ts
  cooldownSince?: number;
  cooldownSource?: "retry-after" | "reset-derived" | "default";
  /** Bumped on every cooldown write; binds a lease to the cooldown it was issued for. */
  cooldownGeneration?: number;
  probeLeaseId?: string;
  probeLeaseGeneration?: number;
  lastProbeAt?: number;
```

`computeQuotaCooldownUntil()`(168행)은 현재 `number`를 반환하고 소비자는 499행 한 곳뿐이며
테스트 import도 없다(확인 완료). `{ until, source }`로 바꾼다.

`parseResetCooldownMs()`(161행): `Math.min(clampCooldownMs(delay), CODEX_MAX_RESET_DERIVED_COOLDOWN_MS)`.

신규 export:

```ts
export function tryAcquireCodexQuotaProbeLease(accountId: string, now?: number): string | null
export function releaseCodexQuotaProbeLease(accountId: string, leaseId: string): void
```

`tryAcquire` 가드 순서: cooldown 활성 → `cooldownSource !== "retry-after"` →
`probeLeaseId === undefined` → `now - (lastProbeAt ?? cooldownSince) >= INTERVAL`.
성공 시 새 `probeLeaseId`와 현재 `cooldownGeneration`을 함께 저장한다.

`CodexUpstreamOutcomeMeta`에 `probeLeaseId?: string` 추가.

### `src/codex/auth-context.ts`

`CodexAuthContext`의 `pool`/`main-pool` variant에 `probeLeaseId?: string` 추가.
132행에서 lease 획득, 138·146행 실패 경로에서 반납.

### outcome 기록 지점 (8곳 — 전수)

| 위치 | 컨텍스트 변수 |
|---|---|
| `core.ts:123` `sidecarOutcomeRecorder` | `authCtx` (이미 pool로 좁혀짐) |
| `core.ts:210` terminal recorder — incomplete | `authCtx` (좁혀짐) |
| `core.ts:225` terminal recorder — completed/failed | `authCtx` (좁혀짐) |
| `core.ts:1027` transport 실패 | `authCtx` |
| `core.ts:1081` **모델 400 계정 재시도** | `firstAuthCtx` |
| `core.ts:1160` HTTP 상태 | `authCtx` |
| `compact.ts:255` `recordCompactPoolOutcome` | `authCtx` (클로저) |
| `openai-sidecar.ts:98` | `authContext` (`recordOutcome` 클로저) |

`core.ts:1081`이 중요하다. 첫 계정의 caller outcome을 기록한 뒤 다른 계정으로 전환하므로,
`firstAuthCtx.probeLeaseId`를 넘기지 않으면 첫 계정의 lease가 소비되지 않고 고착된다.

각 호출의 meta에 해당 컨텍스트의 `probeLeaseId`를 추가한다. 시그니처 변경은 없다.

`collaboration.ts`/`encrypted-payload.ts`는 import만 있고 `resolveCodexAuthContext()` 호출은
없다(확인 완료).

## 회귀 테스트

### `tests/codex-routing.test.ts`

1. `far-future resetAt is capped below the 24h ceiling`
2. `Retry-After keeps honoring long explicit delays`
3. `retry-after cooldown is never probed` — interval 경과 후에도 `tryAcquire`가 null
4. `probe lease is granted at most once per interval`
5. `leased probe success clears the hard cooldown`
6. `unleased 2xx preserves the hard cooldown`
7. `mismatched lease id does not consume the probe`
8. `failed probe releases the lease and restarts the interval`
9. `stale-generation lease cannot clear a newer cooldown` — **불변식 4·6 회귀**
   - reset-derived cooldown → lease 취득(id=X, gen=1)
   - 비-lease 429 `Retry-After: 7200` → cooldown 갱신, gen=2
   - id=X를 가진 200 기록 → 다음을 **모두** 단언한다
     - cooldown이 유지된다 (불변식 4, Retry-After 우회 차단)
     - `cooldownSource === "retry-after"`가 보존된다 (상태 재구성으로 유실되지 않음)
     - `probeLeaseId`가 사라진다 (불변식 6, 완료된 probe가 lease를 남기지 않음)
     - 활성 cooldown이 retry-after 출처이므로 `tryAcquire`가 계속 null
10. `credential failure ends the probe` — 401 기록 후 reauth 상태, lease 없음
11. `unowned outcome preserves retry-after source` — **보존 규칙 회귀**
    - `Retry-After` cooldown → lease 없는 200 기록 → `cooldownSource === "retry-after"` 유지,
      `tryAcquire`가 계속 null
    - 503으로도 동일 단언
12. `unowned outcome keeps a reset-derived cooldown probeable`
    - reset-derived cooldown → lease 없는 200/503 기록 → interval 경과 후 `tryAcquire` 성공
    - 늦은 응답 하나가 probe 경로를 막지 않음을 고정
13. `in-flight lease survives an unowned outcome`
    - lease 취득(id=X) → lease 없는 200/503 기록 → `probeLeaseId`가 여전히 X
    - 진행 중 probe가 남의 응답으로 사라지지 않음
14. 기존 `:312`, `:806`이 **무수정 통과**

### 통합 테스트 (`tests/codex-quota-probe.test.ts`, NEW)

단위 테스트만으로는 선택기 → auth-context 배선을 검증하지 못한다. 구현 실수로 auth의
기존 cooldown throw가 lease 취득보다 먼저 남아 있어도 위 테스트는 모두 통과한다.

신규 파일로 두는 이유: `tests/server-auth.test.ts`(54 tests)는 이미 크고 관심사가 다르다.

15. `main account probe reaches auth and recovers`
    - 활성 `__main__`에 reset-derived cooldown 설정
    - interval 전: 요청이 429
    - interval 후: `resolveCodexAuthContext()`가 `main-pool` 컨텍스트와 lease id 반환
    - 그 lease로 200 기록 → 다음 요청이 정상 통과

## 보안 검토 (MAINTAINERS.md:22)

구현 후 확인:

- lease가 계정당 동시 1개인가.
- `Retry-After` cooldown에서 lease가 절대 발급되지 않는가.
- 세대 불일치 lease가 새 cooldown을 해제하지 못하는가 (테스트 9).
- 실패한 probe가 반드시 interval을 재시작하는가.

## 검증

```bash
bun run typecheck
bun test tests/codex-routing.test.ts tests/codex-auth-context.test.ts \
         tests/codex-quota-probe.test.ts tests/server-auth.test.ts
```
