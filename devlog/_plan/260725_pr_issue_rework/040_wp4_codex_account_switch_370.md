# WP4 — PR #370 Codex main-account identity 전환 통합 및 transient auth 보존 수정

## A-gate 반영 — 수정 설계 확정 (호환형 접근 A)

독립 감사 결과 기존 리뷰 지적 6건 중 5건은 PR 후속 커밋으로 해결됐고, 미해결 1건이 우리 수정
대상이다. `VERDICT: GO-WITH-FIXES (blockers=2)`.

| 기존 리뷰 지적 | 판정 |
|---|---|
| startup quota priming 전 identity 미-seed | 해결 (`primeCodexPoolQuotas()`가 reconcile 선행) |
| transient null을 account switch로 처리 | 해결 (`account-lifecycle.ts:27-44`, null이면 purge 안 함) |
| main info cache 미무효화 | 해결 (전용 모듈 분리 + main purge에서만 clear) |
| in-flight A 응답이 B 상태 덮어씀 | 해결 (fetch 시작 identity fence + 1회 재요청) |
| retry 중 null identity를 switch로 처리 | 해결 (`currentAccountId === null` guard) |
| **fetch 시작 전 token read null이 cache 파괴** | **미해결 → 우리가 고친다** |

### 채택: 호환형 접근 A — 상세 결과 API 추가, 기존 시그니처 유지

감사가 두 접근을 비교해 A를 권고했다. 근거:

- 접근 B(`existsSync()`로 존재를 따로 확인)는 **TOCTOU**가 있다. 확인과 실제 read 사이에 파일이
  바뀔 수 있고, non-atomic rewrite의 순간적 부재를 로그아웃으로 오판한다.
- 접근 A는 단일 read 결과에서 `missing / invalid / unreadable`을 분류하므로 경합이 없다.
- **시그니처를 직접 바꾸면 8개 호출부를 모두 고쳐야 한다**: `auth-api.ts:107,257,373,409`,
  `auth-collision.ts:26`, `main-account.ts:30,41`, `cli/doctor.ts:304`.
  호환 wrapper를 남기면 파급이 `fetchMainAccountInfo()` 한 곳으로 제한된다.

#### `src/codex/auth-collision.ts` — 상세 reader 신설, 기존 함수는 wrapper로

```
+export interface CodexTokens {
+  access_token: string;
+  account_id: string;
+  id_token?: string;
+}
+
+export type CodexTokenReadResult =
+  | { status: "ok"; tokens: CodexTokens }
+  | { status: "missing" | "invalid" | "unreadable" };
+
+function hasErrnoCode(error: unknown, code: string): boolean {
+  return typeof error === "object" && error !== null && "code" in error
+    && (error as { code?: unknown }).code === code;
+}
+
+/**
+ * Distinguishes a real sign-out from a transient read failure. The old catch-all collapsed
+ * "file absent", "malformed JSON", and "read error" into one null, so callers could not tell a
+ * logged-out account from a half-written file and destroyed healthy cached state.
+ * Never returns or logs the raw error or any token material.
+ */
+export function readCodexTokensResult(): CodexTokenReadResult {
+  let raw: string;
+  try {
+    raw = readFileSync(join(resolveCodexHomeDir(), "auth.json"), "utf-8");
+  } catch (error) {
+    return { status: hasErrnoCode(error, "ENOENT") ? "missing" : "unreadable" };
+  }
+  try {
+    const parsed = JSON.parse(raw) as {
+      tokens?: { access_token?: string; account_id?: string; id_token?: string };
+    };
+    if (!parsed.tokens?.access_token) return { status: "invalid" };
+    return {
+      status: "ok",
+      tokens: {
+        access_token: parsed.tokens.access_token,
+        account_id: parsed.tokens.account_id ?? "",
+        id_token: parsed.tokens.id_token,
+      },
+    };
+  } catch {
+    return { status: "invalid" };
+  }
+}

 export function readCodexTokens(): CodexTokens | null {
-  // 기존 exists/read/parse catch-all
+  const result = readCodexTokensResult();
+  return result.status === "ok" ? result.tokens : null;
 }
```

#### `src/codex/auth-api.ts` — local read 실패에서 캐시·reauth를 건드리지 않는다

```
-  const tokens = readCodexTokens();
-  if (!tokens) {
-    clearMainAccountInfoCache();
-    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
-    return EMPTY_MAIN_ACCOUNT_INFO;
-  }
+  const tokenRead = readCodexTokensResult();
+  if (tokenRead.status !== "ok") {
+    // A local read failure is not proof of sign-out. Preserve cached email/plan/quota and the
+    // reauth flag; routing stays fail-closed because getMainAccountToken() re-reads the file.
+    return getMainAccountInfoCache() ?? EMPTY_MAIN_ACCOUNT_INFO;
+  }
+  const tokens = tokenRead.tokens;
```

### 정책 분리 (확정)

| 상황 | cache | persistent reauth |
|---|---|---|
| local `missing`/`invalid`/`unreadable` | **보존** | **변경 안 함** |
| 실제 request routing | — | fail-closed (wrapper가 null 반환) |
| account DTO 표시 | — | `hasCredential=false`, 동적 `needsReauth=true` |
| terminal upstream 401 / 인정된 403 | clear | 설정 |
| 성공 fetch | 갱신 | 해제 |

### 활성화 증거 계약 (blocker 2 반영)

`missing`만 테스트하면 구현이 ENOENT만 보존하고 JSON parse 실패에서는 기존 destructive 분기를
유지해도 통과한다. **두 원인을 모두 테스트한다.**

1. 정상 auth로 `fetchMainAccountInfo(true)`를 호출해 email/plan/quota 캐시와 shared quota를 채운다.
2. 다음을 각각 적용한다.
   - `rmSync(auth.json)` — 파일 부재 / non-atomic rewrite gap
   - `writeFileSync(auth.json, "{")` — 결정적 malformed JSON
3. 다시 `fetchMainAccountInfo(true)`를 호출한다.
4. 관찰 대상:
   - WHAM fetch 호출 수가 증가하지 않음
   - 캐시된 email/plan/quota가 정확히 보존됨
   - shared `getAccountQuota(MAIN_CODEX_ACCOUNT_ID)`도 보존됨
   - `isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID) === false`
   - 파일이 손상된 동안 실제 사용 가능성 판정은 **fail-closed**
   - 정상 auth 복구 후 같은 identity가 다시 usable하고 불필요한 purge/reauth가 없음

`chmod(0)`은 root 실행과 Windows에서 신뢰할 수 없으므로 필수 회귀로 쓰지 않는다.

### 보안 조건 검증 결과 (감사 확인)

- 새 production logging 없음. 추가된 token/email 문자열은 테스트 fixture 또는 기존 필드 접근뿐.
- `main-account-cache.ts`는 email/plan/quota/timestamp만 저장하며 token/credential을 저장하지 않음.
- 상태 purge는 `MAIN_CODEX_ACCOUNT_ID`에 한정되며 다른 pool 계정의 전역 purge는 없음.
- 새 credential 파일·write 경로·OAuth 흐름·권한·dependency·workflow 변경 없음.
- 3-way 합성 안전: `74795ad6`(Google), `4cc7f692`(parser), `fc517004`(Kiro/bridge/types)와
  auth 파일 교집합 없음. 단 현재 `setAccountQuotaFromParsed()`와 `auth-context.ts` quota-probe
  lease 흐름이 PR의 구형 context로 덮이지 않는지 적용 후 반드시 확인한다.

## 루프 계약

- **Archetype:** C4 auth/security integration + correctness repair.
- **Trigger:** PR #370 head `7432203703e4578a28f2d0dd7860d7ef78e43854`가 `__main__` 뒤의 물리 ChatGPT 계정 변경을 감지해 runtime state를 purge하지만, fetch 시작 전 `auth.json`을 잠깐 읽지 못한 경우에는 같은 null identity를 terminal reauth로 오판한다.
- **Goal:** PR #370의 account-identity reconciliation을 현재 `dev`에 통합하고, fetch 시작 전 null identity도 reconcile 경로와 동일한 **unknown**으로 취급해 기존 email/plan/quota cache와 usable state를 보존한다.
- **Non-goals:** pool account credential format 변경, OAuth/refresh-token 흐름 변경, 계정 선택 정책 변경, 로그/telemetry 추가, GUI 변경, `auth.json` 쓰기 방식 변경.
- **Verifier:** 구현자와 독립 보안 리뷰어. `MAINTAINERS.md:22-24` 및 `AGENTS.md:65-70`에 따라 auth/credential/account identity 변경은 explicit security review 대상이다.
- **Stop condition:** 아래 diff 계약과 회귀 테스트가 현재 `origin/dev` 위에서 적용되고, focused/full/typecheck/privacy gate가 모두 0으로 끝나며 독립 보안 리뷰가 PASS일 때.
- **Terminal outcomes:** `DONE`(수용 기준 전부 충족), `REBASE_REQUIRED`(base가 이동해 계약 재산정 필요), `SECURITY_REVIEW_REQUIRED`(코드는 준비됐으나 명시적 보안 승인 미완료), `BLOCKED`(credential 노출·cross-account state leak·회귀 실패).

## 착수 시점 사실

- 작업 시각 기준 checkout HEAD와 `origin/dev`: `037e8f5e4fa32a82e4149acc509554f157656dad`.
- 이 Codex worktree는 실제로 detached HEAD이지만 정확히 `origin/dev` tip을 가리킨다. 브랜치 checkout은 하지 않았다.
- PR: `#370 fix(codex): reset main runtime state after account switch`, base `dev`, head `7432203703e4578a28f2d0dd7860d7ef78e43854`, `reviewDecision=CHANGES_REQUESTED`, 5 files, `+302/-13`.
- PR patch 전량 확인: `gh pr diff 370 --repo lidge-jun/opencodex` = **464 lines**.
- 필수 direct apply 검사:

```text
$ gh pr diff 370 --repo lidge-jun/opencodex | git apply --check -
error: patch failed: src/codex/auth-api.ts:26
error: src/codex/auth-api.ts: patch does not apply
exit 1
```

- 진단용 3-way dry check는 5개 파일을 conflict 없이 합성 가능했다. 따라서 PR을 버리는 것이 아니라 최신 dev 위에 rebase/3-way 통합해야 한다.
- 현재 dev의 충돌 원인은 quota API가 진전된 상태이기 때문이다. `src/codex/auth-api.ts:17-34`의 `setAccountQuotaFromParsed` import/export와 `src/codex/auth-api.ts:290-292`의 호출을 **반드시 보존**한다. PR head가 가진 구형 `updateAccountQuota(...)` 다중 인자 호출로 되돌리지 않는다.
- PR head의 결함 위치는 `src/codex/auth-api.ts:272-280`; 문제 블록은 정확히 `275-279`이다.

### 대상 파일

| 파일 | 종류 | 계약 |
|---|---|---|
| `src/codex/account-lifecycle.ts` | MODIFY | 물리 main identity 관찰/reconcile 및 `__main__` runtime purge |
| `src/codex/auth-api.ts` | MODIFY | cache 모듈화, identity-aware WHAM retry, transient null 수정 |
| `src/codex/auth-context.ts` | MODIFY | pool auth resolution 직전 reconcile |
| `src/codex/main-account-cache.ts` | NEW | main email/plan/quota cache owner |
| `tests/codex-main-rotation.test.ts` | MODIFY | switch/cache/in-flight/null identity 회귀 + 우리 추가 회귀 |

## 변경 계약

### 적용 원칙과 patch 권위

PR의 464-line patch가 incoming 변경의 원본 권위다. 구현자는 아래 명령으로 그 시점의 patch를 고정하고, head SHA가 위 값과 다르면 즉시 `REBASE_REQUIRED`로 멈춘다.

```bash
test "$(gh pr view 370 --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid)" = \
  "7432203703e4578a28f2d0dd7860d7ef78e43854"
gh pr diff 370 --repo lidge-jun/opencodex > /tmp/pr-370.patch
test "$(wc -l < /tmp/pr-370.patch | tr -d ' ')" = "464"
git apply --3way /tmp/pr-370.patch
```

`git apply --3way` 이후 아래 파일별 계약과 정확히 일치하도록 정리한다. 이 문서의 추가 repair diff는 PR patch 적용 **후** 상태를 before로 한다.

### `src/codex/account-lifecycle.ts` — MODIFY

`purgeCodexAccountRuntimeState()`는 기존 account-scoped clear를 유지하고 main cache만 조건부로 지운다. reconcile 경로가 purge에 넘기는 id는 상수가 유일하다.

```diff
 import { clearAccountNeedsReauth } from "./account-runtime-state";
+import { getMainChatgptAccountId } from "./auth-collision";
+import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "./main-account";
 import { clearAccountQuota } from "./quota";
 import { clearCodexUpstreamHealthForAccount, clearThreadAccountMapForAccount } from "./routing";
 import { invalidateCodexWebSocketsForAccount } from "./websocket-registry";
+import { clearMainAccountInfoCache } from "./main-account-cache";

+let observedMainChatgptAccountId: string | undefined;

 export function purgeCodexAccountRuntimeState(accountId: string): void {
   clearAccountNeedsReauth(accountId);
   clearAccountQuota(accountId);
   clearThreadAccountMapForAccount(accountId);
   clearCodexUpstreamHealthForAccount(accountId);
+  if (accountId === MAIN_CODEX_ACCOUNT_ID) clearMainAccountInfoCache();
 }
+
+export function reconcileMainCodexAccountRuntimeState(): boolean {
+  const currentAccountId = getMainChatgptAccountId();
+  // Missing/malformed auth.json is unknown, not proof of an account switch.
+  if (currentAccountId === null) return false;
+  const previousAccountId = observedMainChatgptAccountId;
+  observedMainChatgptAccountId = currentAccountId;
+  if (previousAccountId === undefined || previousAccountId === currentAccountId) return false;
+
+  purgeCodexAccountRuntimeState(MAIN_CODEX_ACCOUNT_ID);
+  setMainAccountPlan(null);
+  invalidateCodexWebSocketsForAccount(MAIN_CODEX_ACCOUNT_ID);
+  return true;
+}
+
+export function resetMainCodexAccountIdentityTrackingForTests(): void {
+  observedMainChatgptAccountId = undefined;
+}
```

**보안 경계 확인:** identity-switch 경로의 purge, plan reset, websocket invalidation은 모두 `MAIN_CODEX_ACCOUNT_ID`만 인자로 받는다. pool 삭제 경로는 기존 `deleteCodexAccount(..., accountId)`의 명시적 대상 하나만 purge한다. 전역 quota/thread/health clear는 추가하지 않는다.

### `src/codex/main-account-cache.ts` — NEW

전체 파일 계약:

```ts
import type { StoredAccountQuota } from "./quota";

export interface MainAccountInfo {
  email: string | null;
  plan: string | null;
  quota: Omit<StoredAccountQuota, "updatedAt"> | null;
}

export interface CachedMainAccountInfo extends MainAccountInfo {
  ts: number;
}

let cachedMainAccountInfo: CachedMainAccountInfo | null = null;

export function getMainAccountInfoCache(): CachedMainAccountInfo | null {
  return cachedMainAccountInfo;
}

export function setMainAccountInfoCache(value: CachedMainAccountInfo): void {
  cachedMainAccountInfo = value;
}

export function clearMainAccountInfoCache(): void {
  cachedMainAccountInfo = null;
}
```

이 모듈은 credential/token을 저장하지 않는다. email/plan/quota와 timestamp만 보유한다.

### `src/codex/auth-api.ts` — MODIFY + 우리 결함 수정

PR incoming 계약:

```diff
-import { deleteCodexAccount } from "./account-lifecycle";
-import { checkAccountIdCollision, readCodexTokens } from "./auth-collision";
+import { deleteCodexAccount, reconcileMainCodexAccountRuntimeState } from "./account-lifecycle";
+import { checkAccountIdCollision, getMainChatgptAccountId, readCodexTokens } from "./auth-collision";
 ...
+import {
+  clearMainAccountInfoCache,
+  getMainAccountInfoCache,
+  setMainAccountInfoCache,
+  type MainAccountInfo,
+} from "./main-account-cache";
+export { clearMainAccountInfoCache } from "./main-account-cache";
 ...
-let mainAccountCache: { email: string | null; plan: string | null; quota: Omit<StoredAccountQuota, "updatedAt"> | null; ts: number } | null = null;
 const MAIN_CACHE_TTL = 5 * 60_000;
```

현재 dev의 다음 quota diff는 rebase 중 보존한다.

```diff
 import {
   clearAccountQuota,
   getAccountQuota,
   listAccountQuotas,
   parseUsageQuota,
+  setAccountQuotaFromParsed,
   updateAccountQuota,
   type StoredAccountQuota,
   type WhamUsageResponse,
 } from "./quota";
 export {
+  applyAccountQuotaFromUpstreamHeaders,
   clearAccountQuota,
   getAccountQuota,
   parseUsageQuota,
+  setAccountQuotaFromParsed,
   updateAccountQuota,
 } from "./quota";
```

identity-aware fetch 함수는 PR의 retry 계약을 그대로 넣되 quota mirror는 현재 dev owner를 사용한다.

```diff
-export async function fetchMainAccountInfo(forceRefresh = false): Promise<{ email: string | null; plan: string | null; quota: Omit<StoredAccountQuota, "updatedAt"> | null }> {
+export async function fetchMainAccountInfo(forceRefresh = false): Promise<MainAccountInfo> {
+  return fetchMainAccountInfoAttempt(forceRefresh, 1);
+}
+
+const EMPTY_MAIN_ACCOUNT_INFO: MainAccountInfo = { email: null, plan: null, quota: null };
+
+async function retryMainAccountInfoIfIdentityChanged(
+  requestAccountId: string | null,
+  retriesRemaining: number,
+): Promise<MainAccountInfo | null> {
+  const currentAccountId = getMainChatgptAccountId();
+  if (currentAccountId === null || currentAccountId === requestAccountId) return null;
+  reconcileMainCodexAccountRuntimeState();
+  return retriesRemaining > 0
+    ? fetchMainAccountInfoAttempt(true, retriesRemaining - 1)
+    : EMPTY_MAIN_ACCOUNT_INFO;
+}
+
+async function fetchMainAccountInfoAttempt(forceRefresh: boolean, retriesRemaining: number): Promise<MainAccountInfo> {
+  reconcileMainCodexAccountRuntimeState();
```

PR 적용 직후 남는 결함의 정확한 before/after는 다음과 같다. `tokens === null`에서 cache를 clear하거나 reauth를 표시하지 않고, 이미 알고 있는 cache를 그대로 반환한다. cache가 없을 때만 empty DTO를 반환한다.

```diff
 async function fetchMainAccountInfoAttempt(forceRefresh: boolean, retriesRemaining: number): Promise<MainAccountInfo> {
   reconcileMainCodexAccountRuntimeState();
   const tokens = readCodexTokens();
+  const cached = getMainAccountInfoCache();
   if (!tokens) {
-    clearMainAccountInfoCache();
-    markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
-    return EMPTY_MAIN_ACCOUNT_INFO;
+    // A missing/malformed auth.json is an unknown identity, matching reconcile semantics.
+    // Preserve the last known account info and usable state until identity is readable again.
+    return cached ?? EMPTY_MAIN_ACCOUNT_INFO;
   }
   const requestAccountId = extractAccountId(tokens.id_token, tokens.access_token) ?? (tokens.account_id || null);
-  const cached = getMainAccountInfoCache();
   if (!forceRefresh && cached && Date.now() - cached.ts < MAIN_CACHE_TTL) {
     return cached;
   }
```

fetch 성공 이후 quota mirror의 최종 형태:

```diff
     setMainAccountPlan(result.plan);
     if (result.quota) {
-      updateAccountQuota(
-        MAIN_CODEX_ACCOUNT_ID,
-        result.quota.weeklyPercent,
-        result.quota.weeklyResetAt,
-        result.quota.monthlyPercent,
-        result.quota.monthlyResetAt,
-        result.quota.resetCredits,
-      );
+      setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, result.quota);
     }
```

terminal upstream 401 또는 인정된 terminal 403만 cache clear + reauth를 수행한다. network/parse catch와 identity-unknown은 reauth로 승격하지 않는다. 새 로그는 추가하지 않는다.

### `src/codex/auth-context.ts` — MODIFY

현재 dev의 quota probe lease 타입/흐름을 전부 보존하고, direct mode 반환 뒤 pool resolution 시작점에 한 줄만 추가한다.

```diff
 import { isCodexAccountUsable } from "./account-usability";
+import { reconcileMainCodexAccountRuntimeState } from "./account-lifecycle";
 import { MAIN_CODEX_ACCOUNT_ID, getMainAccountToken } from "./main-account";
 ...
   if (mode === "direct") {
     if (!hasCallerCodexBearer(headers)) throw new CodexDirectAuthenticationError();
     return { kind: "main", accountId: null };
   }
+  reconcileMainCodexAccountRuntimeState();
   const threadId = headers.get("x-codex-parent-thread-id");
```

### `tests/codex-main-rotation.test.ts` — MODIFY

PR의 6개 regression을 verbatim 유지한다.

1. physical main identity switch가 cooldown/reauth/quota를 purge.
2. startup priming이 최초 identity를 seed.
3. reconcile 중 transient missing file은 switch가 아니며 기존 runtime state 보존.
4. identity switch 시 cached main account info invalidation.
5. in-flight old-identity WHAM response discard 후 1회 retry.
6. in-flight 완료 시 current identity가 unknown이면 retry하지 않고 정상 response를 채택.

setup/teardown에는 다음이 둘 다 들어가야 한다.

```diff
     clearCodexUpstreamHealth();
     clearAccountQuota();
+    clearMainAccountInfoCache();
+    resetMainCodexAccountIdentityTrackingForTests();
     setMainAccountPlan(null);
```

우리 결함을 직접 잠그는 **추가** 테스트는 기존 `invalidates cached main account info...` 뒤에 넣는다.

```diff
+  test("preserves cached main account info when token identity is transiently unreadable before fetch", async () => {
+    const originalFetch = globalThis.fetch;
+    let usageCalls = 0;
+    globalThis.fetch = (async (input, init) => {
+      if (!String(input).includes("/backend-api/wham/usage")) return originalFetch(input, init);
+      usageCalls++;
+      expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("main_acct");
+      return new Response(JSON.stringify({
+        email: "cached@example.test",
+        plan_type: "plus",
+        rate_limit: { primary_window: { used_percent: 17, reset_at: 1_788_000_000 } },
+      }), { status: 200 });
+    }) as typeof fetch;
+    try {
+      expect((await fetchMainAccountInfo(true)).email).toBe("cached@example.test");
+      expect(usageCalls).toBe(1);
+      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
+
+      rmSync(join(CODEX_DIR, "auth.json"));
+      await expect(fetchMainAccountInfo(true)).resolves.toMatchObject({
+        email: "cached@example.test",
+        plan: "plus",
+        quota: { weeklyPercent: 17 },
+      });
+      expect(usageCalls).toBe(1);
+      expect(isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
+    } finally {
+      globalThis.fetch = originalFetch;
+    }
+  });
```

이 테스트는 `forceRefresh=true`에서도 시작 전 token read가 null이면 network fetch를 시도하지 않고 cached info와 usable state를 보존함을 증명한다. PR 기존의 in-flight unknown 테스트와 다른 분기다.

## 검증

순서대로 실행한다.

```bash
bun test tests/codex-main-rotation.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

보안 리뷰 체크:

```bash
git diff --check
git diff -- src/codex/account-lifecycle.ts src/codex/auth-api.ts src/codex/auth-context.ts src/codex/main-account-cache.ts tests/codex-main-rotation.test.ts
rg -n "console\.(log|warn|error)|Authorization|access_token|refresh_token|id_token" \
  src/codex/account-lifecycle.ts src/codex/auth-api.ts src/codex/auth-context.ts src/codex/main-account-cache.ts
```

- `rg` 결과는 기존 Authorization header 조립/필드 읽기만 설명 가능해야 하며 새 credential logging이 0건이어야 한다.
- `bun run privacy:scan`이 email/token/account identity의 신규 로그·직렬화 노출을 차단해야 한다.
- `reconcileMainCodexAccountRuntimeState()`의 purge/invalidate 호출 인자가 오직 `MAIN_CODEX_ACCOUNT_ID`인지 diff에서 재확인한다.
- 실제 terminal 401/recognized 403은 여전히 cache clear + needsReauth여야 한다. transient missing/malformed file만 unknown이다.

## 수용 기준

- [ ] PR head가 `7432203703e4578a28f2d0dd7860d7ef78e43854`인지 재확인했다.
- [ ] 464-line PR patch의 5개 파일 변경이 누락 없이 통합됐다.
- [ ] 현재 dev의 `setAccountQuotaFromParsed` import/export/호출과 quota-probe 변경이 보존됐다.
- [ ] physical main identity 변경 시 `__main__`의 cooldown, quota, reauth, thread affinity, upstream health, plan, info cache, websocket만 purge된다.
- [ ] null identity는 switch로 간주되지 않으며 fetch 시작 전에도 cache와 usable state를 파괴하지 않는다.
- [ ] 추가 회귀가 cached email/plan/quota, fetch call count 1, `needsReauth=false`를 모두 단언한다.
- [ ] token/credential/auth body를 새로 로깅하거나 cache DTO에 저장하지 않는다.
- [ ] focused test, typecheck, full test, privacy scan이 모두 exit 0이다.
- [ ] auth/credential/account identity 변경에 대한 explicit security review가 완료됐다.

## 실행 영수증

_(C/D 단계에서 작성)_
