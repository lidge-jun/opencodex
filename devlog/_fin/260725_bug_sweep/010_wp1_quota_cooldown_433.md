# WP1 — #433 먼 미래 resetAt로 인한 quota cooldown 고착

> 개정 이력: r1 초안은 A-gate에서 FAIL. blocker 1·2·3(카나리 도달 불가, 무조건 delete로
> 인한 기존 테스트 2건 회귀, transient 경로에서 probe 상태 소실)을 반영해 r2에서
> **probe lease** 설계로 전면 교체했다. 외부 근거는 `001_external_evidence.md` 참조.
>
> r3: r2도 FAIL. lease를 요청에 귀속시키지 않아 경쟁 조건이 남았고(전역 플래그),
> lease 누수 경로와 `Retry-After` 우회를 다루지 않았으며, 문서가 존재하지 않는
> `buildCodexAuthContext()`를 참조했다. 아래 불변식으로 재정의한다.
>
> **이 문서의 코드 블록은 설계 스케치다.** 정확한 diff는 이 phase의 P에서 대상 파일을
> 열어 현재 시그니처를 확인한 뒤 작성하고 B에서 컴파일러로 검증한다 (000의 계획 정밀도 정책).

## 증상

상위 ChatGPT/Codex 계정이 `usage_limit_exceeded`와 함께 며칠 뒤의 reset 타임스탬프를
돌려주면, 프록시가 그 값에서 로컬 cooldown을 파생해 24h 상한까지 계정을 묶는다.
이후 모든 요청이 `durationMs: 5`로 로컬에서 429 차단된다. 제보자의 계정은 약 2.5시간 만에
실제로 회복했지만 프록시는 24h 동안 계속 막았을 것이다. 해제 수단은 프록시 재시작뿐이다.

## 근본 원인

두 개의 결함이 겹친다.

### 1. weekly reset을 rate-limit 힌트처럼 취급한다

`src/codex/routing.ts:151` `parseResetCooldownMs()`는 resetAt까지 남은 시간을 그대로
cooldown으로 쓰고 `clampCooldownMs()`로 24h까지만 자른다.

`Retry-After`는 "이만큼 뒤에 다시 오라"는 지시지만, weekly/monthly quota의 `resetAt`은
"이때 창이 갱신된다"는 정보일 뿐 그 전까지 사용 불가라는 뜻이 아니다.

### 2. 하드 cooldown을 해제할 경로가 재시작밖에 없다

`src/codex/routing.ts:474`의 주석이 현재 의도를 명시한다.

```ts
    // Level 1 clears immediately; escalated accounts need two consecutive healthy terminals.
    // Hard quota cooldown intentionally survives either recovery path.
    if (cooldownUntil) upstreamHealth.set(accountId, { consecutiveFailures: 0, cooldownUntil });
```

cooldown이 걸린 계정은 `src/codex/auth-context.ts:132`에서 선차단되어 요청이 나가지
않으므로 성공 응답이 발생할 기회 자체가 없다. 자기 완결적 교착이다.

## 설계 제약 (A-gate에서 코드로 확인된 사실)

구현은 이 제약을 반드시 만족해야 한다. 각 항목은 실제 코드 대조로 확인됐다.

**C1. `getCodexAccountCooldownUntil()`은 한 요청에서 여러 번 호출된다.**
`resolveCodexAccountForThreadDetailed()`(routing.ts:443)와
**`resolveCodexAuthContext()`**(auth-context.ts:100, 조회는 132행),
`assertCodexAuthContextNotCooled()`(auth-context.ts:159)가 각각 조회한다.
r2 문서가 적은 `buildCodexAuthContext()`는 **존재하지 않는다**. 실제 함수명은
`resolveCodexAuthContext()`이며 호출자는 다섯 곳이다.

```
src/server/responses/core.ts:825
src/server/responses/compact.ts:215
src/server/responses/collaboration.ts
src/server/responses/encrypted-payload.ts
src/providers/openai-sidecar.ts:91
```

따라서 조회는 무상태여야 하고, lease 획득은 auth 단계에서 딱 한 번 일어나야 한다.
`assertCodexAuthContextNotCooled()`는 현재 production 호출자가 없으므로 수정 대상에서
제외해도 되는지 B에서 재확인한다.

**C2. cooldown 계정의 2xx가 반드시 카나리인 것은 아니다.**
요청 A가 진행 중일 때 요청 B의 429가 cooldown을 설정하고, 그 뒤 A가 200으로 끝날 수 있다.
기존 테스트 두 개가 이 의미를 명시적으로 고정하고 있다.

- `tests/codex-routing.test.ts:312` `2xx responses clear transient failures without clearing an unexpired cooldown`
- `tests/codex-routing.test.ts:806` `2xx clears soft-avoid but preserves hard quota cooldown`

따라서 **무조건 `delete()`는 회귀다.** lease를 소지한 요청의 성공만 cooldown을 지워야 한다.

**C3. transient 경로가 probe 상태를 버린다.**
`routing.ts:526`의 transient 기록은 `cooldownUntil`만 보존한다. 카나리가 503/timeout이면
`cooldownSince`/`lastProbeAt`이 사라져 다음 probe가 불가능해진다.

**C4. lease는 요청에 귀속되어야 한다 (r3 추가).**
전역 boolean 플래그로는 C2를 못 막는다. 요청 A가 진행 중일 때 B의 429가 cooldown을 걸고
C가 lease를 얻으면, C보다 A가 먼저 200으로 끝나 A가 C의 probe 성공으로 오인된다.
`CodexUpstreamOutcomeMeta`에는 현재 `accountId`밖에 없어 구분이 불가능하다.
→ 고유 `probeLeaseId`를 발급해 `CodexAuthContext`와 outcome meta로 전달하고,
`current.probeLeaseId === meta.probeLeaseId`일 때만 소비·해제한다.

**C5. lease는 누수될 수 있다 (r3 추가).**
lease 획득 후 outcome을 기록하지 않고 끝나는 경로가 실재한다: 토큰 refresh 실패
(auth-context.ts:142의 catch), adapter build 실패, caller 4xx, 클라이언트 취소.
누수되면 이후 모든 probe가 cooldown 만료까지 차단되어 **원래의 24h 고착이 그대로 재현된다.**
→ lease에 만료시각(예: 요청 상한과 동일한 수준)을 부여하고, `tryAcquire`가 만료된 lease를
회수하도록 한다. 명시적 release/abandon 계약도 함께 정의한다.

**C6. probe는 명시적 `Retry-After`를 우회해서는 안 된다 (r3 추가).**
모든 hard cooldown에 일률적으로 lease를 발급하면 `Retry-After: 7200`을 저장해놓고도
5분 뒤 요청을 내보내게 된다. 이는 "명시 지시는 리터럴로 존중한다"는 이 문서의 자체
기준과 모순된다.
→ cooldown에 출처(`retry-after` / `reset-derived` / `default`)를 기록하고,
probe는 `reset-derived`와 `default`에만 허용한다. `retry-after` cooldown은 만료까지 존중한다.

## 수정 방향

이슈 제안 1·2번을 채택한다. 3·4번(CLI escape hatch, 상태 가시화)은 CLI/GUI 표면이라 범위 밖.

- **파생 상한 분리**: `Retry-After`는 24h까지 존중하되 `resetAt` 파생 cooldown은 낮게 자른다.
- **probe lease**: 상한을 넘긴 cooldown은 주기적으로 요청 하나에 lease를 발급한다.
  lease를 소지한 요청만 upstream까지 나가고, 그 요청의 성공만 cooldown을 해제한다.

### 보안 검토 필요 (MAINTAINERS.md)

이 변경은 계정 선택·차단 의미를 바꾸지만 크리덴셜 저장·전송 경로는 건드리지 않는다.
그래도 quota 우회로 오용될 여지가 있으므로, 구현 후 다음을 명시적으로 확인한다:
lease는 계정당 동시 1개이며, lease 발급 간격이 상한보다 짧아질 수 없고,
lease 실패 시 cooldown이 반드시 연장된다.

## Diff-level 변경안

### `src/codex/routing.ts`

**(1) 상수** — 42-44행 뒤에 추가:

```ts
 const CODEX_DEFAULT_QUOTA_COOLDOWN_MS = 60_000;
 const CODEX_MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60_000;
+/**
+ * A weekly/monthly `resetAt` announces a window refresh; it is not a retry
+ * directive like Retry-After. Plan quota often frees up long before the
+ * advertised reset, so cap reset-derived cooldowns far below the 24h ceiling (#433).
+ */
+const CODEX_MAX_RESET_DERIVED_COOLDOWN_MS = 15 * 60_000;
+/** Minimum gap between probe leases for one cooled-down account. */
+export const CODEX_QUOTA_PROBE_INTERVAL_MS = 5 * 60_000;
```

**(2) 상태 필드** — `CodexUpstreamHealth`(33행 부근). r2 diff는 `cooldownSince`를 선언하지
않고 세 곳에서 사용해 컴파일되지 않았다. 필요한 필드 전체는 다음과 같다.

```ts
   /** Hard cooldown (quota 429). Survives a later 2xx; blocks auth + selection. */
   cooldownUntil?: number;
+  /** When the current cooldown began — origin of the probe interval clock. */
+  cooldownSince?: number;
+  /** What produced the cooldown; only non-retry-after sources may be probed (C6). */
+  cooldownSource?: "retry-after" | "reset-derived" | "default";
+  /**
+   * Identity of the in-flight probe. A cooled-down account sends no traffic, so no
+   * organic 2xx can prove recovery; only the outcome carrying THIS id may clear the
+   * cooldown (C4). Absent when no probe is in flight.
+   */
+  probeLeaseId?: string;
+  /** Lease expiry — reclaims a leaked lease so a lost request cannot pin the account (C5). */
+  probeLeaseExpiresAt?: number;
+  /** Last probe attempt (granted or concluded) — the interval clock. */
+  lastProbeAt?: number;
```

`computeQuotaCooldownUntil()`도 출처를 함께 돌려주도록 반환 형태를 바꿔야 한다.
현재는 `number`만 반환한다. 정확한 시그니처 변경은 P에서 확정한다.

**(3) 파생 상한 분리** — `parseResetCooldownMs()` 내부 (161행):

```ts
-    const clamped = clampCooldownMs(delay);
+    const clamped = Math.min(clampCooldownMs(delay), CODEX_MAX_RESET_DERIVED_COOLDOWN_MS);
```

**(4) 조회는 무상태 유지** — `getCodexAccountCooldownUntil()`(175-178행)은 **변경하지 않는다.**
C1 때문이다. 대신 lease 획득/조회 helper를 추가한다.

```ts
+/** Grant at most one probe lease per interval; returns the lease id or null. */
+export function tryAcquireCodexQuotaProbeLease(accountId: string, now = Date.now()): string | null {
+  // Guards, in order:
+  //   1. cooldown must be active
+  //   2. cooldownSource must be probeable (C6 — never bypass an explicit Retry-After)
+  //   3. any existing lease must have expired (C5 — reclaim leaks)
+  //   4. interval since lastProbeAt/cooldownSince must have elapsed
+  // On success: store a fresh probeLeaseId + expiry, set lastProbeAt, return the id.
+}
+
+/** True when the given lease id is the account's current in-flight probe. */
+export function isCodexQuotaProbeLease(accountId: string, leaseId: string | undefined, now = Date.now()): boolean
```

lease id는 `crypto.randomUUID()`로 충분하다. 정확한 본문은 P에서 작성한다.

**(5) quota 기록** — 493-500행:

```ts
   if (outcomeClass === "quota") {
+    // A failed probe concludes its lease and restarts the interval clock, so the
+    // next probe waits a full interval instead of retrying immediately.
+    const prior = upstreamHealth.get(accountId);
     upstreamHealth.set(accountId, {
       consecutiveFailures: 0,
       lastFailureStatus,
       lastFailureAt: now,
       cooldownUntil: computeQuotaCooldownUntil(meta),
+      cooldownSince: prior?.cooldownSince ?? now,
+      lastProbeAt: now,
+      // probeLeaseAt intentionally dropped — the lease is consumed.
     });
```

**(6) success 경로** — 460-478행. C2·C4를 지켜 **일치하는 lease id를 가진 성공만** 해제한다:

```ts
   if (outcomeClass === "success") {
     const current = upstreamHealth.get(accountId);
     const cooldownUntil = getCodexAccountCooldownUntil(accountId, now);
+    // Only the request holding THIS lease proves recovery. A plain 2xx may be an
+    // in-flight request that started before the 429 landed, and a concurrent
+    // request must not be mistaken for the probe (C4).
+    // tests/codex-routing.test.ts:312 and :806 pin the preserve-on-plain-2xx rule.
+    if (cooldownUntil && isCodexQuotaProbeLease(accountId, meta.probeLeaseId, now)) {
+      upstreamHealth.delete(accountId);
+      return;
+    }
     const failoverEnabled = ...
```

`CodexUpstreamOutcomeMeta`에 `probeLeaseId?: string`를 추가하고, `CodexAuthContext`가
lease id를 실어 outcome 기록 지점까지 전달해야 한다. 전달 경로는 P에서 확정한다.

이후 기존 escalation 로직과 `if (cooldownUntil) upstreamHealth.set(...)` 보존 분기는
**그대로 둔다**. 단 보존 시 `probeLeaseAt`/`lastProbeAt`/`cooldownSince`를 함께 유지한다.

**(7) transient 경로** — 526행. C3를 지켜 probe 상태를 보존한다:

```ts
   upstreamHealth.set(accountId, {
     consecutiveFailures,
     lastFailureStatus,
     lastFailureAt: now,
     ...(hardCooldownUntil ? { cooldownUntil: hardCooldownUntil } : {}),
+    // Preserve probe bookkeeping: a 503/timeout probe must still conclude its
+    // lease and restart the interval, not lose the clock entirely (#433 C3).
+    ...(current?.cooldownSince !== undefined ? { cooldownSince: current.cooldownSince } : {}),
+    ...(hardCooldownUntil && current?.probeLeaseAt !== undefined ? { lastProbeAt: now } : {}),
     ...(softAvoidUntil !== undefined ? { softAvoidUntil } : {}),
   });
```

`probeLeaseAt`은 여기서도 전달하지 않는다 — 실패한 probe는 lease를 소비한다.

### `src/codex/auth-context.ts`

lease 획득은 `resolveCodexAuthContext()`(100행) 안, cooldown 검사 지점(132행) 한 곳이다.
획득한 lease id는 반환되는 `CodexAuthContext`에 실어 outcome 기록까지 전달한다.

```ts
   const cooldownUntil = getCodexAccountCooldownUntil(accountId);
-  if (cooldownUntil) throw new CodexAccountCooldownError(accountId, cooldownUntil);
+  let probeLeaseId: string | undefined;
+  if (cooldownUntil) {
+    probeLeaseId = tryAcquireCodexQuotaProbeLease(accountId) ?? undefined;
+    if (!probeLeaseId) throw new CodexAccountCooldownError(accountId, cooldownUntil);
+  }
```

`CodexAuthContext`의 `pool`/`main-pool` variant에 `probeLeaseId?: string`를 추가한다.

**누수 경로 처리 (C5)**: 132행 이후 실패 지점이 존재한다.

- 142행 `getMainAccountToken()`이 null → `CodexPoolAuthenticationError`
- 146행 `getValidCodexToken()` catch → `CodexAuthContextError`

lease 만료시각이 안전망이지만, 이 두 경로에서 명시적으로 lease를 반납하는 편이 낫다.
P에서 `releaseCodexQuotaProbeLease(accountId, leaseId)` 추가 여부를 결정한다.

**호출자 전수 확인 (C5)**: `resolveCodexAuthContext()`는 다섯 곳에서 호출된다. core와
compact 외에 collaboration, encrypted-payload, openai-sidecar도 포함된다. 각 호출자가
outcome을 기록하는지 P에서 확인하고, 기록하지 않는 경로는 lease를 받지 않도록
옵션으로 제어할지 판단한다.

선택 로직(`isCodexAccountSelectable`, `resolveCodexAccountForThreadDetailed`)은 **변경하지
않는다.** cooldown 계정은 pool 선택에서 계속 회피되고, 단일 계정이라 fallback이 없을 때만
`hasConfiguredPoolAccount` 경로로 auth까지 도달해 lease를 시도한다. 이게 #433의 실제
시나리오(단일 `__main__` 계정)다.

> 구현 시 확인 필요: pool에 건강한 대체 계정이 있으면 cooled 계정은 선택되지 않으므로
> lease 기회가 오지 않는다. 이는 의도된 동작이다 — 건강한 계정이 있는데 굳이 cooled
> 계정을 시험할 이유가 없다. 다만 모든 계정이 cooled인 경우도 같은 경로로 도달하는지
> B 단계에서 `resolveCodexAccountForThreadDetailed`를 재확인한다.

## 회귀 테스트

`tests/codex-routing.test.ts`에 추가한다.

1. `far-future resetAt is capped well below the 24h ceiling`
   - `resetAt` 4일 뒤 + quota 429 → `cooldownUntil - now <= CODEX_MAX_RESET_DERIVED_COOLDOWN_MS`
   - 수정 전 실패: 24h로 clamp

2. `Retry-After keeps honoring long explicit delays`
   - `Retry-After: 7200` → cooldown 2시간 유지 (reset 상한이 명시 지시를 깎지 않음)

3. `probe lease is granted at most once per interval`
   - quota 429 직후 `tryAcquireCodexQuotaProbeLease()` → `false`
   - `+CODEX_QUOTA_PROBE_INTERVAL_MS` → `true`
   - 곧바로 재호출 → `false` (동시 lease 1개)

4. `selection and auth checks stay consistent within one request` — **C1 회귀**
   - lease 획득 후 `getCodexAccountCooldownUntil()`이 여전히 값을 반환하지만
     같은 lease id를 가진 검사는 통과

5. `leased probe success clears the hard cooldown`
   - quota 429 → lease 획득 → 그 lease id로 200 → `getCodexUpstreamHealth()`가 `null`

6. `unleased 2xx preserves the hard cooldown` — **C2 회귀, 기존 :312/:806과 동일 의미**
   - quota 429 → lease 없이 200 → cooldown 유지

6b. `concurrent 2xx from a different request does not consume the probe` — **C4 회귀**
   - lease 획득(id=X) → `probeLeaseId` 없는 200 기록 → cooldown 유지
   - 이어서 id=X를 가진 200 → 해제
   - r2 설계는 여기서 실패한다

6c. `expired lease is reclaimed` — **C5 회귀**
   - lease 획득 후 outcome 기록 없이 만료시각 경과 → 재획득 성공
   - 만료 전에는 재획득 실패

6d. `retry-after cooldown is never probed` — **C6 회귀**
   - `Retry-After: 7200` → interval 경과 후에도 `tryAcquire`가 `null`
   - `resetAt` 파생 cooldown은 같은 시점에 lease 발급 성공

7. `failed probe restarts the interval and drops the lease`
   - lease 획득 → 429 → `hasCodexQuotaProbeLease()`가 `false`이고
     즉시 재획득 시도가 `false`

8. `transient probe failure keeps probe bookkeeping` — **C3 회귀**
   - lease 획득 → 503 → cooldown 유지, `lastProbeAt`이 갱신되어
     `+interval` 후 재획득이 `true`
   - timeout과 connect_error에 대해서도 같은 단언

9. 기존 `2xx responses clear transient failures without clearing an unexpired cooldown`
   (:312)과 `2xx clears soft-avoid but preserves hard quota cooldown`(:806)이
   **수정 없이 계속 통과**해야 한다. 이 둘이 깨지면 설계가 틀린 것이다.

### 통합 테스트

단위 테스트만으로는 C1을 완전히 증명하지 못한다. `tests/server-auth.test.ts` 또는 신규
`tests/codex-quota-probe-e2e.test.ts`에서 `handleResponses()`를 통해
429 → interval 경과 → probe가 실제 upstream fetch까지 도달 → 200 → 다음 요청이 정상
통과하는 흐름을 mock fetch로 검증한다.

## 유지해야 할 동작

- `Retry-After`의 24h 상한과 리터럴 존중.
- credential(401/403) 및 transient(5xx/timeout) 분류 경로는 무변경.
- pool에서 cooldown 계정을 회피하는 선택 로직(`isCodexAccountSelectable`)의 의미.
- `clearCodexUpstreamHealthForAccount()` 기반 계정 생명주기 훅.

## 검증 명령

```bash
bun test tests/codex-routing.test.ts tests/codex-auth-context.test.ts tests/server-auth.test.ts
bun run typecheck
```
