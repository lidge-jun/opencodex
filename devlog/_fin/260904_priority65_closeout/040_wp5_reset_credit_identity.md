# wp5 — #3375 축 D: reset-credit 안정 operation identity

상태: **READY** (BLOCKED 아님. 반증 검증 결과는 아래 0장 참조)
대상 브랜치: `codex/priority65-closeout` (base `origin/dev` = 2421e44ce, package 2.43.0)
작성 시점 확인 커밋: 2421e44ce

---

## 0. 반증 먼저 — 원장은 "의도적 미배선"인가?

결론: **의도적 미배선이라는 증거는 없다.** 미완성 배선이다. 근거는 넷이다.

**(1) 원장은 단일 커밋으로 들어왔고, 배선 유보를 언급하지 않는다.**

```
$ git log --oneline -S openManualResetCreditOperation -- src/
7c68768ca feat(codex): add durable reset-credit operation ledger (#1829)
```

7c68768ca 본문 전문:

```
feat(codex): add durable reset-credit operation ledger
fix(codex): snapshot reset-credit ledger generations
fix(codex): bound reset-credit ledger recovery validation
test(codex): harden reset-credit ledger invariants
fix(codex): reject partial reset-credit ledger loss
test(codex): prove reset-credit ledger rollback boundaries
```

전부 원장 자체의 내구성/불변식 문구다. "배선은 후속", "호출자 없음 의도" 같은
유보 문장이 없다. 되돌림 커밋도 없다 — `git log -- src/codex/reset-credit-operation-ledger.ts`
는 7c68768ca 한 건뿐이다.

**(2) manual 경로만 죽은 게 아니라 recovery 경로도 같이 죽어 있다.**

```
$ rg -n 'openResetCreditOperation|settleResetCreditOperation|markResetCreditOperationAmbiguous' -g '!node_modules' src/ | grep -v 'reset-credit-operation-ledger.ts'
(출력 없음)

$ rg -n 'reset-credit-operation-ledger' -g '!node_modules' .
devlog/_plan/260902_nonbug_adoption_backlog/130_wp13_reset_credit_auto_redeem.md:6
tests/codex-reset-credit-operation-ledger.test.ts:24
```

"manual만 일부러 안 붙였다"면 recovery는 붙어 있어야 한다. 파일 전체가
테스트에서만 import된다. 이건 특정 분기의 정책적 유보가 아니라 파일 단위 미배선이다.

**(3) `setResetCreditOperationMigrationFaultForTests`(:485)의 존재 의미는 반대 방향 증거다.**

이 함수는 `migrateLegacyTable`(:500) — legacy `recovery` 전용 스키마를
`operation_kind IN ('recovery','manual')` 스키마로 올리는 마이그레이션 — 의
첫 쓰기 직후에 합성 실패를 주입한다(:479 `failMigrationAfterFirstWriteForTests`).
즉 **디스크에 이미 legacy 원장 행이 존재하는 배포본**을 전제로, 그 행을 manual
지원 스키마로 승격하는 경로의 롤백을 증명한다. 배선할 생각이 없는 코드에
legacy 행 승격 + 부분 실패 롤백을 넣지 않는다. 이건 "언젠가 켠다"가 아니라
"켜진 상태의 데이터가 이미 있을 수 있다"를 방어하는 코드다.
또한 `process.env.OCX_TEST_HOME_GUARD !== "1"`이면 throw하므로(:487) 프로덕션
오염 위험도 차단되어 있다.

**(4) 별도 devlog가 이 원장을 "unused"로 명시하고 재사용을 계획한다.**

`devlog/_plan/260902_nonbug_adoption_backlog/130_wp13_reset_credit_auto_redeem.md:6`:

> An unused #657 ledger (`reset-credit-operation-ledger.ts`, kinds `recovery|manual`) exists.

같은 문서가 slice 1에서 `"auto-redeem"` kind 추가를 계획한다. 즉 이 원장은
폐기 대상이 아니라 확장 대상으로 취급되고 있다.

**wp13과의 충돌 경계**: wp13은 새 kind `"auto-redeem"`을 추가하려 하고, 이
wp5는 기존 `"manual"` kind를 배선한다. 두 작업은 스키마의 `operation_kind`
CHECK 제약을 공유한다. **wp5는 스키마를 건드리지 않는다**(3장 OUT 참조).
wp13이 먼저 착지하면 CHECK 문자열만 확장되고 wp5 diff는 그대로 적용된다.

### 현재 결함 (배선 부재의 실제 관측 가능한 증상)

`src/codex/auth-api.ts:2177`:

```ts
const idempotencyKey = crypto.randomUUID();
```

이 값이 :2187에서 업스트림으로 나간다:

```ts
body: JSON.stringify({ redeem_request_id: idempotencyKey }),
```

**매 HTTP 요청마다 새 UUID가 생성된다.** 따라서 동일한 논리적 사용자 의도(버튼
한 번 누름)가 네트워크 타임아웃으로 재시도되면 업스트림은 서로 다른
`redeem_request_id` 두 개를 보고 **크레딧 2개를 소비한다.** 크레딧은 되돌릴 수
없는 외부 상태이므로 이 결함의 비용은 비가역이다.

대조군: `src/codex/reset-credit-auto-redeem.ts:163`은 같은 문제를 이미
해결했다 — `redeemRequestId`를 저널에 먼저 쓰고 재시작 후 재사용한다.
manual 경로에만 그 보호가 없다.

---

## 1. 스코프 경계

### IN

1. `POST /api/codex-auth/reset-credits/consume` 가 body의 **선택적** `operationId`를 수용.
2. 그 id로 `openManualResetCreditOperation`을 호출해 원장 예약.
3. 예약된 id를 업스트림 `redeem_request_id`로 사용(랜덤 UUID 대체).
4. 업스트림 결과에 따라 `settleManualResetCreditOperation` / 실패 시 `markManualResetCreditOperationAmbiguous`.
5. 원장 분기(`terminal`/`capacity`/`identity-mismatch`/`unavailable`)별 HTTP 응답 확정.
6. CLI `ocx account reset-credits <id> --consume --yes --operation-id <uuid>`.
7. 회귀 테스트를 **red 우선**으로 추가.
8. **docs-site 관리 API 레퍼런스 8개 로케일 갱신** (감사 지적으로 IN 승격). 근거는
   AGENTS.md 리뷰 규정 "user-facing behavior changes should update `docs-site/`".
   이 유닛은 consume 엔드포인트에 **새 400 사유 + 신규 409 + 신규 503 2종**을
   추가하므로 명백한 user-facing 계약 변경이다. 대상 줄은 4c 표에 정확히 열거했다.

### OUT (이번 유닛에서 건드리지 않음)

- **원장 SQL 스키마 / `CREATE_TABLE` / `operation_kind` CHECK** — wp13과 충돌.
- **recovery 경로 배선** (`openResetCreditOperation` 등). 별도 유닛.
- **GUI 자동 operationId 생성.** 3장 D-4 참조: GUI는 이번에 변경하지 않는다.
- `reset-credit-auto-redeem.ts` 저널을 원장으로 통합하는 작업.
- `GET /api/codex-auth/reset-credits` (inspect 경로).
- 업스트림 재시도 로직 자체 추가. 이 유닛은 **재시도가 안전해지도록** 만들 뿐,
  재시도를 구현하지 않는다.

### 하위호환 계약 (필수)

`operationId`가 **없으면 현재 동작과 바이트 단위로 동일해야 한다** —
원장을 열지 않고, `crypto.randomUUID()`로 `redeem_request_id`를 만든다.
기존 GUI/CLI/테스트가 그대로 통과해야 한다. 이것이 회귀 위험을 0으로 만드는 장치다.

---

## 2. 원장 반환 타입 → HTTP 응답 결정표

`OpenManualResetCreditOperationResult` (`src/codex/reset-credit-operation-ledger.ts:98`):

```ts
export type OpenManualResetCreditOperationResult =
  | Readonly<{ kind: "execute"; operationId: CodexReservedOperationId; resumed: boolean }>
  | Readonly<{ kind: "terminal"; operationId: CodexReservedOperationId; code: CodexResetCreditConsumeCode }>
  | Readonly<{ kind: "capacity" | "identity-mismatch" | "unavailable" }>;
```

| kind | 의미 | HTTP | 응답 body | 업스트림 호출 |
|---|---|---|---|---|
| `execute` (`resumed:false`) | 신규 예약 성공 | — (계속 진행) | 정상 consume 결과 | **한다** |
| `execute` (`resumed:true`) | 같은 id 재시도, 미정산 | — (계속 진행) | 정상 consume 결과 | **한다** (같은 `redeem_request_id`이므로 업스트림이 멱등 처리) |
| `terminal` | 이미 정산된 id | **200** | `{ code: <저장된 code>, replayed: true }` | **안 한다** |
| `identity-mismatch` | 다른 계정이 소유한 id | **409** | `{ error: "operation_id_owned_by_another_account", code: "identity_mismatch" }` | **안 한다** |
| `capacity` | 원장 용량 초과 | **503** + `Retry-After: 1` | `{ error: "reset_credit_ledger_capacity", code: "capacity" }` | **안 한다** |
| `unavailable` | 원장 IO 실패 | **503** + `Retry-After: 1` | `{ error: "reset_credit_ledger_unavailable", code: "unavailable" }` | **안 한다** |

### `unavailable`을 503으로 fail-closed 하는 이유 (설계 결정)

대안은 "원장이 죽으면 랜덤 UUID로 폴백해서 서비스 지속"이다. **채택하지 않는다.**
호출자가 `operationId`를 명시했다는 것은 멱등성을 요구했다는 뜻이고, 폴백은 그
요구를 조용히 무시하면서 정확히 이 유닛이 막으려는 이중소비를 재현한다.
크레딧은 비가역이므로 가용성보다 정확성이 우선이다. `operationId`를 안 보낸
호출자는 애초에 이 경로에 들어오지 않으므로 영향받지 않는다.

### `terminal`에서 업스트림을 재호출하지 않는 이유

`terminal`은 원장이 "이 id는 이미 끝났고 결과는 X"를 내구성 있게 아는 상태다.
재호출하면 업스트림 멱등성에만 의존하게 되는데, 그 보장은 우리 것이 아니다.
저장된 code를 그대로 재생하는 편이 강하다.

**`remaining` 필드 주의**: `terminal` 재생 응답에는 `remaining`을 넣지 않는다.
현재 코드(:2199~2211)는 신선하게 파싱된 `available_count`가 있을 때만 `remaining`을
넣는 규약이고(:2196-2198 주석), 재생 시점에는 그 신선한 값이 없다. `replayed: true`로
구분만 준다.

`UpdateResetCreditOperationResult` (:88) — `settle`/`ambiguous`의 반환:

```ts
export type UpdateResetCreditOperationResult =
  | Readonly<{ kind: "updated" }>
  | Readonly<{ kind: "mismatch" | "unavailable" }>;
```

정산은 **업스트림 호출이 이미 끝난 뒤**에 일어난다. 즉 크레딧은 이미 쓰였다.
따라서 `mismatch`/`unavailable`이 와도 **사용자 응답을 실패로 바꾸지 않는다** —
실제로 성공한 소비를 실패로 보고하면 사용자가 다시 누르고, 그게 이중소비다.
정산 실패는 서버 로그로만 남긴다. 이 비대칭(열기는 fail-closed, 닫기는 fail-open)이
이 설계의 핵심이다.

---

## 3. 파일 변경 맵

### D-1. `src/codex/auth-api.ts` — MODIFY

#### D-1a. import 추가 (파일 상단 import 블록)

**AFTER (추가할 줄):**

```ts
import {
  markManualResetCreditOperationAmbiguous,
  openManualResetCreditOperation,
  settleManualResetCreditOperation,
} from "./reset-credit-operation-ledger";
import { isCodexResetCreditOperationId } from "./reset-credit-recovery";
```

주의: `auth-api.ts`가 이미 `./reset-credit-recovery`에서 import하는 게 있으면
기존 절에 병합할 것.

#### D-1b. consume 핸들러 — `src/codex/auth-api.ts:2168` 부터

**BEFORE (현재 :2168-2171):**

```ts
  if (url.pathname === "/api/codex-auth/reset-credits/consume" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { accountId?: string };
    if (!body.accountId) return jsonResponse({ error: "accountId required" }, 400);
    const accountId = body.accountId;
```

**AFTER:**

```ts
  if (url.pathname === "/api/codex-auth/reset-credits/consume" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      accountId?: string;
      operationId?: unknown;
    };
    if (!body.accountId) return jsonResponse({ error: "accountId required" }, 400);
    const accountId = body.accountId;
    // Optional caller-owned idempotency identity (#3375 axis D). Absent => legacy
    // behavior: a fresh random redeem_request_id and no durable ledger row.
    const hasOperationId = body.operationId !== undefined;
    if (hasOperationId && !isCodexResetCreditOperationId(body.operationId)) {
      return jsonResponse({ error: "Invalid operationId format" }, 400);
    }
    const requestedOperationId = hasOperationId ? body.operationId as string : undefined;
```

**중요 — 검증 순서**: `isCodexResetCreditOperationId`는 UUIDv4 형식만 통과시킨다
(`src/codex/reset-credit-recovery.ts:36` `CODEX_RESET_CREDIT_OPERATION_ID_PATTERN`).
원장의 `snapshotManualIdentity`(:1154)는 형식 위반 시 **`TypeError`를 throw**하지
result를 반환하지 않는다. 그러므로 반드시 원장 호출 **전에** 400으로 걷어내야 한다.
이걸 빠뜨리면 500 + 스택트레이스가 난다.

#### D-1c. 업스트림 호출부 — `src/codex/auth-api.ts:2174-2194`

**BEFORE (현재 :2174-2194):**

```ts
      const operation = await withResetCreditAuth(getRuntimeConfig(config), accountId, async auth => {
        const idempotencyKey = crypto.randomUUID();
        const resp = await fetch(
          "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${auth.accessToken}`,
              "ChatGPT-Account-Id": auth.chatgptAccountId,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ redeem_request_id: idempotencyKey }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!resp.ok) {
          await resp.body?.cancel().catch(() => {});
          return jsonResponse({ error: `Upstream error ${resp.status}` }, resp.status);
        }
        const result = safeResetCreditConsumeDto(await resp.json());
```

**AFTER:**

```ts
      const operation = await withResetCreditAuth(getRuntimeConfig(config), accountId, async auth => {
        // The ledger keys manual operations by the *physical* ChatGPT account, which is
        // only known after the auth wrapper resolves credentials. Open here, not earlier.
        const identity = requestedOperationId === undefined
          ? undefined
          : {
            accountId,
            chatgptAccountId: auth.chatgptAccountId,
            operationId: requestedOperationId,
          } as const;
        let idempotencyKey: string;
        if (identity) {
          const opened = openManualResetCreditOperation(identity);
          if (opened.kind === "terminal") {
            // Durably settled already: replay the recorded outcome instead of
            // trusting upstream idempotency for an irreversible spend.
            return jsonResponse({ code: opened.code, replayed: true });
          }
          if (opened.kind === "identity-mismatch") {
            return jsonResponse({
              error: "operation_id_owned_by_another_account",
              code: "identity_mismatch",
            }, 409);
          }
          if (opened.kind !== "execute") {
            // capacity | unavailable -> fail closed. Falling back to a random id
            // would silently reintroduce the double-spend this identity prevents.
            const response = jsonResponse({
              error: opened.kind === "capacity"
                ? "reset_credit_ledger_capacity"
                : "reset_credit_ledger_unavailable",
              code: opened.kind,
            }, 503);
            response.headers.set("Retry-After", "1");
            return response;
          }
          idempotencyKey = opened.operationId;
        } else {
          idempotencyKey = crypto.randomUUID();
        }
        let resp: Response;
        try {
          resp = await fetch(
            "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                "ChatGPT-Account-Id": auth.chatgptAccountId,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ redeem_request_id: idempotencyKey }),
              signal: AbortSignal.timeout(10_000),
            },
          );
        } catch (error) {
          // Dispatch outcome unknown: the credit may or may not have been spent.
          // Mark ambiguous so a replay of this same id is never treated as new.
          if (identity) markManualResetCreditOperationAmbiguous(identity);
          throw error;
        }
        if (!resp.ok) {
          await resp.body?.cancel().catch(() => {});
          if (identity) markManualResetCreditOperationAmbiguous(identity);
          return jsonResponse({ error: `Upstream error ${resp.status}` }, resp.status);
        }
        const result = safeResetCreditConsumeDto(await resp.json());
        if (identity) {
          if (result.code === "reset" || result.code === "already_redeemed"
            || result.code === "nothing_to_reset" || result.code === "no_credit") {
            // Settlement failure never downgrades the user-visible outcome: the
            // spend already happened upstream, and reporting failure would invite
            // a manual retry -- the exact double-spend this unit removes.
            settleManualResetCreditOperation(identity, result.code);
          } else {
            markManualResetCreditOperationAmbiguous(identity);
          }
        }
```

이후 `if (result.code === "reset" || result.code === "already_redeemed") { ... }`
(현재 :2199) 이하는 **변경 없음**.

**`safeResetCreditConsumeDto`의 타입 주의** (:450): 반환은 `{ code: string }`이지
`CodexResetCreditConsumeCode`가 아니다. 알 수 없는 code는 `"unknown"`으로
정규화된다(:452). 그래서 위에서 네 개 리터럴을 명시적으로 좁혀야 `settle`의
`code: CodexResetCreditConsumeCode` 파라미터에 타입이 맞는다. `as` 캐스트로
우회하지 말 것 — `"unknown"`이 원장에 들어가면 `settle`이 `mismatch`를 반환한다.

### D-2. `src/cli/account-auth.ts` — MODIFY

#### D-2a. USAGE 문자열 — `src/cli/account-auth.ts:37`

**BEFORE:**

```
  ocx account reset-credits <account-id|main> [--consume --yes] [--json]
```

**AFTER:**

```
  ocx account reset-credits <account-id|main> [--consume --yes [--operation-id <uuid>]] [--json]
```

#### D-2b. `resetCredits` 함수 — `src/cli/account-auth.ts:249-262`

**BEFORE:**

```ts
async function resetCredits(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const rawId = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const consume = takeFlag(args, "--consume");
  const yes = takeFlag(args, "--yes");
  if (!rawId) throw new CliUsageError("account id is required", USAGE);
  if (consume && !yes) throw new CliUsageError("consuming a reset credit requires --yes", USAGE);
  rejectArgs(args, USAGE);
  const accountId = rawId === "main" ? "__main__" : rawId;
  const result = consume
    ? await runtimeRequest("/api/codex-auth/reset-credits/consume", { method: "POST", body: JSON.stringify({ accountId }) }, deps)
    : await runtimeRequest(`/api/codex-auth/reset-credits?accountId=${encodeURIComponent(accountId)}`, {}, deps);
  printData(result, wantsJson);
}
```

**AFTER:**

```ts
async function resetCredits(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const rawId = args.shift()?.trim();
  const wantsJson = takeFlag(args, "--json");
  const consume = takeFlag(args, "--consume");
  const yes = takeFlag(args, "--yes");
  const operationId = takeOption(args, "--operation-id");
  if (!rawId) throw new CliUsageError("account id is required", USAGE);
  if (consume && !yes) throw new CliUsageError("consuming a reset credit requires --yes", USAGE);
  if (operationId !== undefined && !consume) {
    throw new CliUsageError("--operation-id requires --consume", USAGE);
  }
  if (operationId !== undefined && !isCodexResetCreditOperationId(operationId)) {
    throw new CliUsageError("--operation-id must be a UUIDv4", USAGE);
  }
  rejectArgs(args, USAGE);
  const accountId = rawId === "main" ? "__main__" : rawId;
  const result = consume
    ? await runtimeRequest("/api/codex-auth/reset-credits/consume", {
      method: "POST",
      body: JSON.stringify({ accountId, ...(operationId === undefined ? {} : { operationId }) }),
    }, deps)
    : await runtimeRequest(`/api/codex-auth/reset-credits?accountId=${encodeURIComponent(accountId)}`, {}, deps);
  printData(result, wantsJson);
}
```

import 추가:

```ts
import { isCodexResetCreditOperationId } from "../codex/reset-credit-recovery";
```

**`takeOption` 확정 사실** (감사 지적으로 재확인 — 이전 초안의 ":227" 인용은 오류였다):

- 정의처는 `src/cli/account-auth.ts`가 **아니다**. `src/cli/runtime-api.ts:141`에
  정의되어 있고, `account-auth.ts:11`에서 `takeOptionWithSyntax`(:12)와 함께 import된다.
- 실제 시그니처(`src/cli/runtime-api.ts:141`, 전문):

```ts
export function takeOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliUsageError(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
}
```

- 반환 타입은 `string | undefined`로 **확정**. 미지정 시 `undefined`.
- `account-auth.ts` 내 기존 사용처는 :98(`--id`), :208(`--flow`), :238(`--flow`)이다.
- 부작용 3가지가 설계에 영향을 준다:
  1. `args`를 `splice`로 **변형**한다. 그래서 `rejectArgs` 앞에서 호출해야 남은
     인자가 정확히 계산된다(위 코드가 그 순서다).
  2. 값이 없거나 다음 토큰이 `--`로 시작하면 **`CliUsageError`를 스스로 throw**한다.
     따라서 `ocx account reset-credits main --consume --yes --operation-id` 는
     우리 코드가 아니라 `takeOption`이 `--operation-id requires a value`로 처리한다.
  3. `--flag=value` 형태는 이해하지 못한다(`runtime-api.ts:180-181` 주석). 즉
     `--operation-id=<uuid>`는 `rejectArgs`로 떨어져 usage 에러가 된다. 이는
     기존 `--id`/`--flow`와 동일한 동작이므로 새 예외를 만들지 않는다.
- `takeOptionWithSyntax`(:272)는 `--code` 같은 **비밀값** 전용(값 redaction 목적)이다.
  operationId는 비밀이 아니므로 평범한 `takeOption`이 맞다.

**import 비용 경고**: `src/cli/account-auth.ts`가 `../codex/reset-credit-recovery`를
새로 import한다. 이 파일은 core-lab boundary 대상(`src/router.ts`,
`src/server/lifecycle.ts`, `src/server/responses/core.ts`)이 아니지만,
`tests/core-lab-boundary.test.ts`를 5장 verifier에 포함해 그래프 변화를 확인한다.
`reset-credit-recovery.ts`는 `./quota-rejection`과 `./account-id`만 import하는
얕은 모듈이라 위험은 낮다.

### D-3. `tests/codex-auth-api.test.ts` — MODIFY (테스트 추가)

6장의 red-first 순서 참조. 기존 테스트는 수정하지 않는다 — 하위호환 계약이
지켜지면 전부 그대로 통과해야 하고, 통과하지 않으면 그게 회귀 신호다.

### D-4. `gui/src/components/codex-account-pool-handlers.ts` — **변경 없음 (의도적)**

GUI에 operationId를 붙이려면 "언제 새 id를 만들고 언제 재사용하는가"를 정해야
한다. 재사용 창을 잘못 잡으면 **사용자가 의도한 두 번째 소비가 첫 번째의 재생으로
삼켜진다** — 이중소비의 정반대 방향 버그이고, 크레딧이 안 쓰였는데 쓰였다고
보고한다. 이 정책은 서버 배선이 착지하고 실제 재시도 로그를 본 뒤 별도 유닛에서
정한다. 이번 유닛의 GUI 동작은 현행 유지(=operationId 미전송=legacy 경로)다.

### D-5. `docs-site/**/reference/management-api.md` — MODIFY (8개 로케일)

정확한 파일/줄과 BEFORE/AFTER 전문은 **4c**에 있다. 중복 기재하지 않는다.
구현 순서상 D-1(서버 계약)이 확정된 뒤에 쓴다 — 상태코드가 바뀌면 8곳을 다시
고쳐야 하므로 마지막이다.

### D-6. `src/server/management/route-registry.ts` — **변경 없음 (확인만)**

근거는 4c. 레지스트리는 body 스키마를 기술하지 않고, method/path/module/mutates가
모두 그대로다. V6와 `git diff --exit-code`로 무변경을 증명한다.

---

## 4. 필드 체인 (PLAN-FIELD-CHAIN-01)

### 4a. `operationId` — 요청 body 신규 선택 필드

| 단계 | 위치 | 처리 |
|---|---|---|
| creation (CLI) | `src/cli/account-auth.ts` `resetCredits` | `takeOption(args,"--operation-id")`, 미지정 시 body에서 **키 자체를 생략** |
| creation (GUI) | `gui/src/components/codex-account-pool-handlers.ts:19` | **전송 안 함** (D-4) |
| serialization | `JSON.stringify({ accountId, ...(operationId===undefined?{}:{operationId}) })` | 스프레드로 키 부재 보장. `operationId: undefined`를 넣으면 안 됨 — 직렬화 결과는 같지만 부재/무효 구분이 흐려진다 |
| transport | `POST /api/codex-auth/reset-credits/consume` | — |
| deserialization | `auth-api.ts:2169` `await req.json()` | 타입 `{ accountId?: string; operationId?: unknown }`. `unknown`으로 받아 형식검증을 강제 |
| validation | `isCodexResetCreditOperationId` (`reset-credit-recovery.ts:40`) | 실패 → 400. **원장 호출 전** |
| consumer 1 | `openManualResetCreditOperation(identity)` | `identity.operationId` |
| consumer 2 | 업스트림 `redeem_request_id` | `opened.operationId` (원장이 반환한 canonical id — 요청 id와 **다를 수 있다**, 아래 주의) |
| consumer 3 | `settleManualResetCreditOperation(identity, code)` | `identity` (요청 id) |
| consumer 4 | `markManualResetCreditOperationAmbiguous(identity)` | `identity` (요청 id) |
| persistence | `reset_credit_operations` + manual id 히스토리 테이블 | 스키마 변경 없음 |
| consumer 5 (라우트 표면) | `src/server/management/route-registry.ts:97` | `{ method:"POST", path:"/api/codex-auth/reset-credits/consume", module:"codex/auth-api", mutates:true }` — **변경 불필요**, 근거는 4c |
| consumer 6 (docs, 8 로케일) | `docs-site/.../reference/management-api.md` | **변경 필요**. 4c 표 참조 |
| consumer 7 (CLI 인자 파싱) | `src/cli/runtime-api.ts:141` `takeOption` | `args` 배열을 splice로 변형, 값 누락 시 자체 `CliUsageError`. D-2b 참조 |

### 4c. 라우트 레지스트리 및 docs 표면 (감사 Blocker #3 반영)

**`src/server/management/route-registry.ts:97` — MODIFY 아님, 확인만 (명시적 OUT).**

실제 등재 줄을 읽었다:

```ts
{ method: "POST", path: "/api/codex-auth/reset-credits/consume", module: "codex/auth-api", mutates: true },
```

레지스트리가 고정하는 것은 **method + path + module + mutates** 네 필드뿐이고
**요청 body 스키마는 기술하지 않는다.** 이 유닛은 path/method/module을 바꾸지 않고,
`mutates`는 이미 `true`다(operationId 추가로 부작용 성격이 바뀌지 않는다 — 여전히
크레딧을 소비한다). 따라서 이 파일은 **변경하지 않는다.**
다만 표면이 이 경로를 소유하므로 **회귀 검증자로는 포함한다**:
`bun test tests/management-route-registry.test.ts` (5장 V6). 이 표에 넣는 이유는
"바꿔야 해서"가 아니라 "바뀌지 않았음을 증명해야 해서"다.

**docs-site — MODIFY (8개 로케일).** 감사 지적은 5개 로케일이라 했으나 실제로 세어
보니 **8개**다. `rg -n 'reset-credits/consume' docs-site/src/content/docs` 결과:

| 로케일 | 파일 | 줄 |
|---|---|---|
| en | `docs-site/src/content/docs/reference/management-api.md` | 280 |
| tr | `docs-site/src/content/docs/tr/reference/management-api.md` | 275 |
| fr | `docs-site/src/content/docs/fr/reference/management-api.md` | 261 |
| ru | `docs-site/src/content/docs/ru/reference/management-api.md` | 250 |
| ko | `docs-site/src/content/docs/ko/reference/management-api.md` | 225 |
| zh-cn | `docs-site/src/content/docs/zh-cn/reference/management-api.md` | 224 |
| ja | `docs-site/src/content/docs/ja/reference/management-api.md` | 222 |
| zh-tw | `docs-site/src/content/docs/zh-tw/reference/management-api.md` | 217 |

**BEFORE (en:280, 현재 전문):**

```
| `POST /api/codex-auth/reset-credits/consume` | Consume an eligible reset credit | 400 missing account id; upstream status passthrough; 503 `server_busy`; 500 consume failure |
```

**AFTER (en:280):**

```
| `POST /api/codex-auth/reset-credits/consume` | Consume an eligible reset credit. Optional `operationId` (UUIDv4) makes the redemption idempotent: the same id replays one durable outcome instead of spending a second credit. | 400 missing account id or invalid `operationId`; 409 `identity_mismatch` when the id belongs to another account; upstream status passthrough; 503 `server_busy`, `capacity`, or `unavailable`; 500 consume failure |
```

나머지 7개 로케일은 같은 셀에 **각 언어로** 동일 내용을 반영한다. 영어 원문과
모순되지 않게 하는 것이 AGENTS.md 요구사항("keep translated locales from
contradicting the English source")이다. 번역 시 `operationId`, `identity_mismatch`,
`capacity`, `unavailable`, `server_busy`는 **식별자이므로 번역하지 않는다.**

ko:225 예시:

```
| `POST /api/codex-auth/reset-credits/consume` | 사용할 수 있는 reset credit을 소비합니다. 선택적 `operationId`(UUIDv4)를 보내면 소비가 멱등해집니다 — 같은 id는 크레딧을 다시 쓰지 않고 저장된 결과 하나를 재생합니다. | 400 누락된 account id 또는 잘못된 `operationId`; id가 다른 계정 소유이면 409 `identity_mismatch`; upstream 상태 전달; 503 `server_busy`/`capacity`/`unavailable`; 500 소비 실패 |
```

**canonical id 주의 (놓치기 쉬움)**: `openManualResetCreditOperation`은 같은
계정에 이미 활성 manual 작업이 있으면 요청 id를 **alias로 join**하고
`current.operationId`(원래 id)를 반환한다(:1290-1318, "The upstream request keeps
the original durable id"). 그래서:

- 업스트림에는 반드시 **`opened.operationId`** 를 보낸다 (요청 id 아님).
- `settle`/`ambiguous`에는 반드시 **`identity`(요청 id)** 를 넘긴다.
  `settleManualResetCreditOperation`의 `SETTLE_MANUAL_IDS`가 canonical 기준으로
  히스토리 전체를 정산하도록 설계되어 있다. 원장 테스트 :755-794가 이 join/정산
  동작을 고정한다.

반대로 하면 조용히 `mismatch`가 나고 원장이 pending으로 남는다.

### 4b. `replayed` — 응답 body 신규 선택 필드

| 단계 | 위치 | 처리 |
|---|---|---|
| creation | `auth-api.ts` `terminal` 분기 | `{ code, replayed: true }` |
| 그 외 모든 응답 | 기존 경로 | **키 없음** (`replayed`를 false로 넣지 않는다) |
| consumer (CLI) | `printData(result, wantsJson)` | passthrough. `--json`이면 그대로 노출 |
| consumer (GUI) | `readJsonIfOk<{ code: string; remaining?: number }>` (handlers:23) | 타입에 없으므로 무시됨. **GUI 동작 변화 없음** — `code`가 `reset`/`already_redeemed`면 기존 성공 분기를 탄다 |
| consumer (테스트) | `toEqual` 쓰는 기존 assertion | `terminal`은 operationId 없이는 발생 불가하므로 기존 테스트 영향 없음 |

`enum` / 영속 타입에 새 필드를 추가하지 않는다. `CodexResetCreditConsumeCode`,
`ResetCreditOperationState`, SQL 스키마 전부 불변이다.

---

## 5. Verifier 커맨드 (PLAN-VERIFIER-REAL-01 — 실제 실행 결과)

아래 V1~V3은 **베이스라인(변경 전) 실측치**다. 이 워크트리에서 실행했다.

| # | 커맨드 | 실측 exit | 변경 대상을 실제로 읽는가 |
|---|---|---|---|
| V1 | `bun test tests/codex-reset-credit-operation-ledger.test.ts` | **0** (44 pass / 0 fail, 5.26s) | 예 — `src/codex/reset-credit-operation-ledger.ts`를 :24에서 직접 import하며, 배선이 호출할 세 함수를 모두 실행한다 |
| V2 | `bun test tests/codex-auth-api.test.ts` | **0** (199 pass / 0 fail, 1.12s) | 예 — `handleCodexAuthAPI`를 통해 `src/codex/auth-api.ts`의 consume 라우트를 실제 호출한다(consume 요청 26건, 예: :2453, :2488) |
| V3 | `bun run typecheck` | **0** (`bun x tsc --noEmit`, 0.99s) | 예 — 저장소 전체 strict 타입체크. `auth-api.ts`와 `account-auth.ts`의 신규 타입 좁히기를 커버한다 |
| V4 | `bun test tests/cli-account.test.ts` | **0** (110 pass / 0 fail, 396ms) | 예 — **A8의 실제 검증자**. `run()`(:410)이 `cmdAccount`를 직접 호출해 인자 파싱을 실행하고, `requests`(:76) 배열이 `{method, path, search, body}`(:140)를 기록한다. 즉 `--operation-id`가 body에 실렸는지 **관측 가능하다**. 이미 `reset-credits`를 인자로 실행하는 케이스가 있다(:1580) |
| V5 | `bun test tests/core-lab-boundary.test.ts` | (구현 단계에서 실행) | 예 — 런타임 import 그래프를 실제로 걷는다. D-2의 신규 import 파급을 검출한다 |
| V6 | `bun test tests/management-route-registry.test.ts` | (구현 단계에서 실행) | 예 — `route-registry.ts`를 읽어 등재 목록을 고정한다. 4c의 "레지스트리 무변경" 주장을 증명한다 |
| V7 | `bun test tests/cli-capabilities.test.ts` | (구현 단계에서 실행) | 예 — 단 **A8은 검증하지 못한다**. 아래 경고 참조 |

### V7 경고 — `cli-capabilities.test.ts`는 A8의 검증자가 아니다 (감사 Blocker #3-3)

이전 초안은 V4로 `tests/cli-capabilities.test.ts`를 지목하면서 A8("CLI
`--operation-id`가 body에 실린다")을 검증한다고 적었다. **틀렸다.** 이 파일의
:220/:275는 다음과 같은 **라우트 문자열 목록**을 고정한다:

```
"POST /api/codex-auth/reset-credits/consume",
```

즉 고정 대상은 method+path 문자열이지 CLI 플래그가 아니다. `--operation-id`를
추가해도 이 목록은 한 글자도 바뀌지 않으므로, 이 테스트는 **통과하든 실패하든
A8에 대해 아무것도 말해주지 않는다.** 회귀 감시용으로 실행 목록에는 남기되
(라우트 표면이 실수로 바뀌지 않았음을 확인), A8의 근거로 인용하지 않는다.

V1/V2/V3 실행 로그 요약:

```
$ bun test tests/codex-reset-credit-operation-ledger.test.ts
 44 pass / 0 fail / 201 expect() calls  [5.26s]        -> exit 0

$ bun test tests/codex-auth-api.test.ts
 199 pass / 0 fail / 719 expect() calls  [1120.00ms]   -> exit 0

$ bun run typecheck
 $ bun x tsc --noEmit                                  -> exit 0
```

**금지**: `bun run test`, 인자 없는 `bun test`(전체 스위트). 이 유닛의 변경은
위 focused 집합으로 충분히 덮인다. AGENTS.md의 간접 의존 예외(서브프로세스,
데이터로 읽히는 소스, 골든 파일)에 해당하는 경로를 건드리지 않는다.

---

## 6. 실행 순서 — red 먼저 (비가역 외부 상태이므로 필수)

크레딧 소비는 되돌릴 수 없다. 구현 후 테스트를 쓰면 "구현이 하는 일"을 그대로
베끼게 되고, 멱등성 결함은 정확히 그 방식으로 통과한다. 그래서 **테스트가 먼저
실패하는 것을 눈으로 확인한 뒤** 구현한다.

### 단계 1 — red 테스트 작성 (프로덕션 코드 손대지 않음)

`tests/codex-auth-api.test.ts`에 추가. 기존 테스트 패턴(:2463-2500)을 그대로
따른다: `globalThis.fetch` 스텁 + `handleCodexAuthAPI` 직접 호출 + `finally` 복원.

R1. **같은 operationId 두 번 = 업스트림 소비 1회** (핵심 회귀)

```
let consumeCalls = 0;
const opId = "11111111-1111-4111-8111-111111111111";
// 1회차: {accountId:"pool-x", operationId:opId} -> 200 {code:"reset", remaining:N}
// 2회차: 동일 body                              -> 200 {code:"reset", replayed:true}
expect(consumeCalls).toBe(1);
```

red 근거: 현재 `operationId`는 무시되므로 2회차도 업스트림을 때려
`consumeCalls === 2`가 된다. **이 숫자가 이 유닛의 존재 이유다.**

R2. **동일 operationId면 업스트림 `redeem_request_id`가 동일**

스텁에서 요청 body를 파싱해 `redeem_request_id`를 수집.
red 근거: 현재는 매번 새 UUID → 두 값이 다르다.

R3. **operationId 없으면 legacy 동작 그대로** (하위호환 계약)

`{accountId}`만 보낸 요청이 원장을 만들지 않고 매번 새 `redeem_request_id`를
쓰는지. 이건 처음부터 green이며 **구현 후에도 green이어야 한다** — red로
만들지 않는다. 회귀 감시용이다.

R4. **형식 위반 operationId → 400**, 원장/업스트림 미호출

`{accountId, operationId: "not-a-uuid"}` → 400 `Invalid operationId format`,
`consumeCalls === 0`.

R5. **다른 계정의 operationId → 409**

계정 A로 opId 예약 후 계정 B(다른 `chatgptAccountId`)로 같은 opId → 409
`identity_mismatch`, 업스트림 미호출.

R6. **업스트림 실패 후 재시도가 새 소비를 만들지 않음**

1회차 스텁이 500 반환 → 응답 500, 원장은 ambiguous.
2회차 같은 opId → `resumed` 경로로 **같은** `redeem_request_id` 재전송.
red 근거: 현재는 2회차가 새 UUID를 만들어 이중소비 창을 연다.

R7. **CLI 인자 파싱 — `tests/cli-account.test.ts`에 추가** (A8 전용, 감사 Blocker #3-3)

이 테스트만이 CLI 표면을 실제로 관측한다. 기존 하네스를 그대로 쓴다:
`run()`(:410)이 `cmdAccount`를 호출하고, `requests`(:76)가 `body`(:140)를 기록한다.

```
// R7-a: --operation-id가 consume body에 실린다
const opId = "11111111-1111-4111-8111-111111111111";
requests.length = 0;
const ok = await run(["reset-credits", "main", "--consume", "--yes", "--operation-id", opId]);
const sent = requests.find(r => r.path === "/api/codex-auth/reset-credits/consume");
expect((sent?.body as { operationId?: string })?.operationId).toBe(opId);

// R7-b: --operation-id 없으면 키 자체가 없다 (하위호환)
expect(Object.prototype.hasOwnProperty.call(bodyOf(sent2), "operationId")).toBe(false);

// R7-c: --consume 없이 쓰면 usage 에러 + 요청 0건
const bad = await run(["reset-credits", "main", "--operation-id", opId]);
expect(bad.code).toBe(2);
expect(requests.length).toBe(0);

// R7-d: 형식 위반은 CLI에서 걷힌다 (서버 왕복 없음)
const badId = await run(["reset-credits", "main", "--consume", "--yes", "--operation-id", "nope"]);
expect(badId.code).toBe(2);

// R7-e: 값 누락은 takeOption 자체가 CliUsageError를 던진다 (runtime-api.ts:145)
const noValue = await run(["reset-credits", "main", "--consume", "--yes", "--operation-id"]);
expect(noValue.code).toBe(2);
```

red 근거: 현재 `resetCredits`는 `--operation-id`를 파싱하지 않으므로 R7-a는
`undefined`가 되어 fail하고, R7-c는 `rejectArgs`가 알 수 없는 인자로 걷어내
**우연히** exit 2가 될 수 있다 — 그래서 R7-c는 단독 근거로 쓰지 말고 R7-a와 함께 본다.

### 단계 2 — red 확인 (증거 기록)

```
bun test tests/codex-auth-api.test.ts
bun test tests/cli-account.test.ts
```

R1, R2, R4, R5, R6, R7-a가 **fail**, R3이 **pass**. 이 출력을 유닛 노트에 붙인다.
R1이 fail하지 않으면 테스트가 결함을 못 잡고 있다는 뜻이니 **구현하지 말고**
테스트를 고친다.

### 단계 3 — 구현

D-1 → D-2 → D-5(docs 8 로케일) 순서. 각 파일 후 `bun run typecheck`.

### 단계 4 — green 확인

```
bun test tests/codex-auth-api.test.ts
bun test tests/codex-reset-credit-operation-ledger.test.ts
bun test tests/cli-account.test.ts
bun test tests/management-route-registry.test.ts
bun test tests/cli-capabilities.test.ts
bun test tests/core-lab-boundary.test.ts
bun run typecheck
git diff --exit-code src/server/management/route-registry.ts
```

기대: R1~R7 전부 pass, `codex-auth-api` 기존 199건 유지, 원장 44건 유지,
`cli-account` 기존 110건 유지, 레지스트리 diff 없음(exit 0).

---

## 7. Accept criteria (검증 가능)

| # | 기준 | 검증 방법 |
|---|---|---|
| A1 | 같은 `operationId` 재요청이 업스트림 consume을 1회만 호출 | R1, `consumeCalls === 1` |
| A2 | 같은 `operationId`면 `redeem_request_id`가 동일 | R2, 수집값 비교 |
| A3 | `operationId` 부재 시 기존 동작 동일 | R3 + 기존 199건 무수정 통과 |
| A4 | 형식 위반 → 400, 500 아님 | R4 |
| A5 | 타 계정 id → 409, 업스트림 미호출 | R5 |
| A6 | 원장 unavailable/capacity → 503 + `Retry-After`, 랜덤 폴백 없음 | 원장 IO 실패 주입 후 상태코드 및 `consumeCalls===0` |
| A7 | 정산 실패가 성공 응답을 실패로 바꾸지 않음 | settle이 `mismatch`를 반환하도록 유도한 뒤 200 유지 확인 |
| A8 | CLI `--operation-id`가 body에 실린다 / `--consume` 없이 쓰면 usage 에러 | **`tests/cli-account.test.ts`** (R7). `run(["reset-credits","main","--consume","--yes","--operation-id",opId])` 후 `requests`에서 consume 요청을 찾아 `body.operationId === opId` assert. `cli-capabilities`가 아니다 — V7 경고 참조 |
| A9 | typecheck green | V3 |
| A10 | core-lab import 경계 유지 | V5 |
| A11 | docs-site 8개 로케일이 새 400/409/503 계약을 기술 | 4c 표의 8개 줄 수동 확인. 영어 원문과 모순 없음 |
| A12 | 라우트 레지스트리 무변경 | V6 green + `git diff --exit-code src/server/management/route-registry.ts` |

---

## 8. 조건 분기 activation scenario

분기를 추가하면 "누가 어떻게 발화시키고 무엇이 관측되는가"를 명시한다.

| 분기 | 누가 발화 | 어떻게 | 관측 결과 |
|---|---|---|---|
| `hasOperationId === false` | 현재 GUI 버튼, `--operation-id` 없는 CLI | body에 키 없음 | 원장 행 0개, 매 요청 새 `redeem_request_id`, 응답에 `replayed` 없음 |
| 형식 위반 400 | 손으로 만든 curl, 잘못된 스크립트 | `operationId:"abc"` | 400 `Invalid operationId format`, 업스트림 0회, 원장 미변경 |
| `execute resumed:false` | `--operation-id <새 uuid>` 첫 호출 | 신규 id | 원장 pending 행 1개, 업스트림 1회, 200 |
| `execute resumed:true` | 타임아웃 후 같은 id 재실행 | 동일 id, 미정산 상태 | 업스트림에 **동일** `redeem_request_id` 재전송, 크레딧 추가 소비 없음 |
| `execute resumed:true` (alias join) | 다른 id로 재시도했는데 이전 작업이 아직 pending | 새 id, 같은 계정 | 업스트림에는 **원래** id가 나감. 새 id는 히스토리에 alias로 기록 |
| `terminal` | 정산 완료 후 같은 id 재실행 | 동일 id | **업스트림 0회**, 200 `{code, replayed:true}`, `remaining` 없음 |
| `identity-mismatch` | 계정 A의 id를 계정 B로 사용 | `chatgptAccountId` 상이 | 409, 업스트림 0회 |
| `capacity` | manual id 4096개 또는 계정 128개 초과 | 장기 운용 축적 | 503 + `Retry-After: 1`, 업스트림 0회 |
| `unavailable` | 원장 DB 파일 손상/권한 상실 | sqlite 열기 실패 | 503 + `Retry-After: 1`, 업스트림 0회, `[opencodex] Reset-credit operation ledger is unavailable.` 로그 |
| `ambiguous` (throw) | fetch 예외/타임아웃 | 네트워크 단절 | 원장 state=ambiguous, 500. 같은 id 재시도는 `resumed`로 복귀 |
| `ambiguous` (!resp.ok) | 업스트림 5xx | 스텁 500 | 원장 ambiguous, 상태코드 passthrough |
| `ambiguous` (unknown code) | 업스트림 스키마 변경 | `{code:"weird"}` → `"unknown"` | settle 아님, ambiguous. 200 + `{code:"unknown"}` |

---

## 9. 리스크

1. **alias join의 canonical id 혼동** — 4a 주의 참조. 업스트림엔 `opened.operationId`,
   원장엔 `identity`. 뒤바꾸면 조용한 `mismatch`. R6가 이걸 잡는다.
2. **`snapshotManualIdentity`의 throw** — 형식 사전검증 누락 시 500. R4가 잡는다.
3. **`withResetCreditAuth` 내부에서 원장을 여는 구조** — `chatgptAccountId`가
   auth 해석 이후에만 존재하므로 불가피하다. main 계정 경로는
   `nativeMainLease`를 잡은 상태(:385)이므로 원장 IO가 길어지면 lease 보유가
   길어진다. 원장은 로컬 sqlite 단일 트랜잭션이라 실측 영향은 무시 가능하지만,
   여기에 네트워크 호출을 추가하지 말 것.
4. **wp13과의 스키마 경합** — 3장 OUT으로 회피. 착지 순서 무관.
