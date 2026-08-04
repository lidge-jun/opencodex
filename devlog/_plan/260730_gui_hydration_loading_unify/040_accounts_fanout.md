# 040 — WP5 `/api/codex-auth/accounts` fan-out 완화

작성 2026-07-30. WP2~WP4와 병렬이다. GUI가 [Providers.tsx:92](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/Providers.tsx:92)의 pool controller와 Codex Auth page가 렌더하는 별도 pool([CodexAuth.tsx:166](/Users/jun/Developer/new/700_projects/opencodex/gui/src/pages/CodexAuth.tsx:166))을 동시에 둘 수 있으므로, concurrent `/accounts`는 실제 사용자 경로다. 서버는 현재 GET route에서 곧바로 `listCodexAuthAccounts()`를 await한다([auth-api.ts:641-644](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:641)); request-level coalescing은 없다.

## 현재 비용 모델

| 경로 | 현재 실제 작업 | 비용 상한 |
|---|---|---|
| warm cache, `refresh` 없음 | main info와 pool quota가 각각 5분 미만이면 WHAM 없이 DTO 생성. TTL은 [auth-api.ts:252-254](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:252), pool cache hit은 [443-446](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:443). | quota network 0, 다만 현재 `list`가 account마다 credential store를 읽고([541-550](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:541)) `getValidCodexToken()`도 다시 store를 읽는다([account-store.ts:319-324](/Users/jun/Developer/new/700_projects/opencodex/src/codex/account-store.ts:319)). |
| stale cache, `refresh` 없음 | main 1회와 stale pool 계정별 WHAM을 concurrency 4로 보낸다([auth-api.ts:545-550](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:545), [277-291](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:277)). 각 WHAM timeout은 8s([368-371](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:368), [450-453](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:450)). | 대략 `8s × ceil(pool accounts / 4)` + main path. |
| forced `?refresh=1` | route가 `forceRefresh=true`를 넘긴다([641-643](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:641)); 5분 cache를 무시하고 모두 fan-out. | 위와 같은 fan-out. |
| expired credential | pool WHAM 전 `getValidCodexToken()`가 refresh-grant 단일 비행을 공유한다([330-353](/Users/jun/Developer/new/700_projects/opencodex/src/codex/account-store.ts:330)). OAuth refresh network timeout 30s([390-399](/Users/jun/Developer/new/700_projects/opencodex/src/codex/account-store.ts:390), cross-process file lock wait 65s([11-14](/Users/jun/Developer/new/700_projects/opencodex/src/codex/account-store.ts:11)). | 30s refresh 또는 최대 65s lock wait가 8s quota bound에 더해질 수 있음. |

quota disk snapshot은 이메일·token 없이 quota percent만 저장하고([quota.ts:14-18](/Users/jun/Developer/new/700_projects/opencodex/src/codex/quota.ts:14)), 6시간까지 hydrate한다([quota.ts:261-275](/Users/jun/Developer/new/700_projects/opencodex/src/codex/quota.ts:261)). 저장은 250ms debounce다([quota.ts:281-295](/Users/jun/Developer/new/700_projects/opencodex/src/codex/quota.ts:281)). 그러나 list freshness 판단은 5분이므로, 5분~6시간 snapshot은 표시에는 쓸 수 있지만 기존 route는 upstream을 기다린다.

## 요청 병합

coalescing key는 `normal`과 `force` 두 개다. 같은 mode의 N concurrent GET은 같은 promise를 await한다. `?refresh=1`을 normal request에 합치면 명시 refresh의 보장을 잃으므로 서로 합치지 않는다. config object identity나 account id를 key에 넣지 않는다. route가 같은 runtime config를 전달하며 mutation route가 완료된 뒤에만 UI가 새 GET을 보낸다.

```diff
diff --git a/src/codex/auth-api.ts b/src/codex/auth-api.ts
@@
 export interface CodexAuthAccountDto {
@@
 }
+export type CodexAuthAccountsRead = {
+  accounts: CodexAuthAccountDto[];
+  /** `true` means quotas came from a last-known snapshot while a refresh is running. */
+  revalidating: boolean;
+};
+
+const accountListInFlight = new Map<"normal" | "force", Promise<CodexAuthAccountsRead>>();
+
+function joinAccountListRead(
+  mode: "normal" | "force",
+  run: () => Promise<CodexAuthAccountsRead>,
+): Promise<CodexAuthAccountsRead> {
+  const existing = accountListInFlight.get(mode);
+  if (existing) return existing;
+  const pending = run().finally(() => { accountListInFlight.delete(mode); });
+  accountListInFlight.set(mode, pending);
+  return pending;
+}
+
+export function clearCodexAuthAccountListInFlightForTests(): void {
+  accountListInFlight.clear();
+}
@@
-export async function listCodexAuthAccounts(config: OcxConfig, forceRefresh = false): Promise<CodexAuthAccountDto[]> {
+async function listCodexAuthAccountsFresh(config: OcxConfig, forceRefresh = false): Promise<CodexAuthAccountsRead> {
   const runtimeConfig = getRuntimeConfig(config);
   const poolAccounts = (runtimeConfig.codexAccounts ?? []).filter(isSelectableCodexPoolAccount);
+  const credentialRecords = readCodexAccountCredentialRecords(poolAccounts.map(account => account.id));
   const mainInfo = await fetchMainAccountInfo(forceRefresh);
   const withQuota = await mapWithConcurrency(poolAccounts, POOL_QUOTA_REFRESH_CONCURRENCY, async a => {
-    const cred = getCodexAccountCredential(a.id);
+    const credentialRecord = credentialRecords.get(a.id);
-    const quotaResult = cred
-      ? await fetchPoolAccountQuota(a.id, forceRefresh, a.plan)
+    const quotaResult = credentialRecord
+      ? await fetchPoolAccountQuota(a.id, forceRefresh, a.plan, credentialRecord)
       : { quota: null, needsReauth: true };
-    return poolAccountDto(a, quotaResult, !!cred, isCodexAccountPaused(runtimeConfig, a.id));
+    return poolAccountDto(a, quotaResult, !!credentialRecord, isCodexAccountPaused(runtimeConfig, a.id));
   });
@@
-  return [main, ...withQuota];
+  return { accounts: [main, ...withQuota], revalidating: false };
 }
+
+export async function listCodexAuthAccounts(config: OcxConfig, forceRefresh = false): Promise<CodexAuthAccountsRead> {
+  const mode = forceRefresh ? "force" : "normal";
+  if (!forceRefresh) {
+    const cached = listCodexAuthAccountsFromSnapshots(config);
+    if (cached) {
+      void joinAccountListRead("normal", () => listCodexAuthAccountsFresh(config))
+        .catch(() => { /* snapshot remains the fallback */ });
+      return { accounts: cached, revalidating: true };
+    }
+  }
+  return joinAccountListRead(mode, () => listCodexAuthAccountsFresh(config, forceRefresh));
+}
@@
   if (url.pathname === "/api/codex-auth/accounts" && req.method === "GET") {
     const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
-    return jsonResponse({ accounts: await listCodexAuthAccounts(config, forceRefresh) });
+    const startedAt = performance.now();
+    const sharedBefore = accountListInFlight.has(forceRefresh ? "force" : "normal");
+    const result = await listCodexAuthAccounts(config, forceRefresh);
+    logCodexAuthAccountsRead({
+      durationMs: Math.round(performance.now() - startedAt), forceRefresh, sharedBefore,
+      revalidating: result.revalidating, accountCount: result.accounts.length,
+    });
+    return jsonResponse(result);
   }
```

`listCodexAuthAccountsFromSnapshots()`은 main cache와 모든 selectable pool account의 `getAccountQuota()` 및 한 번 읽은 credential record로 DTO를 투영한다. quota snapshot이 하나도 없는 cold request에는 `null`을 반환해 기존 blocking fresh path를 사용한다. 그래서 "빈/unknown을 stale이라고 표시"하지 않는다.

## stale-while-revalidate

5분이 지난 quota도 disk max age 6시간 이내면 즉시 반환한다. 응답 body의 additive `revalidating: true`가 GUI signal이다. header만 쓰지 않는 이유는 현재 pool hook이 [useCodexAccountPool.ts:150-157](/Users/jun/Developer/new/700_projects/opencodex/gui/src/hooks/useCodexAccountPool.ts:150)에서 JSON body만 읽기 때문이다.

```diff
diff --git a/gui/src/hooks/useCodexAccountPool.ts b/gui/src/hooks/useCodexAccountPool.ts
@@
 export type CodexAccountLoadState = "loading" | "ready" | "error";
@@
   activeNeedsReauth: boolean;
+  revalidating: boolean;
@@
+  const [revalidating, setRevalidating] = useState(false);
@@
-        const payload = await response.json();
+        const payload = await response.json() as { accounts?: CodexAccountEntry[]; revalidating?: boolean };
@@
           setAccounts(nextAccounts);
+          setRevalidating(payload.revalidating === true);
@@
-  return { accounts, activeId, loadState, switchingId, pauseUpdatingId, pausingExhausted, activeNeedsReauth,
+  return { accounts, activeId, loadState, switchingId, pauseUpdatingId, pausingExhausted, activeNeedsReauth, revalidating,
```

`CodexAccountPool`은 `revalidating`이면 기존 rows 위 status slot에 이미 번역된 `t("codexAuth.refreshingQuota")`를 표시한다([codex-account-pool-main-card.tsx:168-190](/Users/jun/Developer/new/700_projects/opencodex/gui/src/components/codex-account-pool-main-card.tsx:168)). 값이 `false`면 표시하지 않는다. 서버의 background fresh call이 성공해도 browser에 push하지 않으므로 기존 30초 poll 또는 사용자의 다음 read에서 최신 DTO가 온다. 이는 stale을 최신처럼 조용히 보이는 것보다 정직하고, SSE/새 polling은 이 WP 범위가 아니다.

상류 WHAM 실패는 `fetchPoolAccountQuota()`가 이미 `existing ?? null`을 반환한다([auth-api.ts:454,472-475](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:454)). background promise의 failure는 catch해 snapshot을 보존한다. 즉 stale response는 200 + `revalidating:true`, quota field는 마지막 성공 값이다.

## 자격증명 저장소 반복 읽기

확인 결과 반복 읽기는 실제다. `getCodexAccountCredential()`은 [account-store.ts:115-118](/Users/jun/Developer/new/700_projects/opencodex/src/codex/account-store.ts:115)에서 `readCodexAccountRecord()`를 부르고, record read는 store file을 load한다([account-store.ts:79-95](/Users/jun/Developer/new/700_projects/opencodex/src/codex/account-store.ts:79)). list loop는 이것을 각 account마다 수행한다([auth-api.ts:545-548](/Users/jun/Developer/new/700_projects/opencodex/src/codex/auth-api.ts:545)). 아래 diff로 한 request에서 store를 한 번만 parse한다. 만료 credential은 refresh 직전 `getValidCodexToken()`이 다시 live record를 읽는다. freshness/generation 안전성을 snapshot으로 대체하지 않는다.

```diff
diff --git a/src/codex/account-store.ts b/src/codex/account-store.ts
@@
+export type CodexAccountCredentialRecordSnapshot = {
+  credential: CodexAccountCredentials;
+  generation: number;
+};
+
+export function readCodexAccountCredentialRecords(ids: readonly string[]): Map<string, CodexAccountCredentialRecordSnapshot> {
+  const store = loadCodexAccountRecordStore();
+  const result = new Map<string, CodexAccountCredentialRecordSnapshot>();
+  for (const id of ids) {
+    const record = store[id];
+    if (record?.deletedAt == null && record.credential) {
+      result.set(id, { credential: record.credential, generation: record.generation });
+    }
+  }
+  return result;
+}
diff --git a/src/codex/auth-api.ts b/src/codex/auth-api.ts
@@
 import {
   getCodexAccountCredential,
+  readCodexAccountCredentialRecords,
+  type CodexAccountCredentialRecordSnapshot,
@@
-async function fetchPoolAccountQuota(accountId: string, forceRefresh = false, configuredPlan?: string): Promise<PoolQuotaResult> {
+async function fetchPoolAccountQuota(
+  accountId: string, forceRefresh = false, configuredPlan?: string,
+  record?: CodexAccountCredentialRecordSnapshot,
+): Promise<PoolQuotaResult> {
@@
-    const { accessToken, chatgptAccountId, generation } = await getValidCodexToken(accountId);
+    const token = record && record.credential.expiresAt > Date.now() + 60_000
+      ? { accessToken: record.credential.accessToken, chatgptAccountId: record.credential.chatgptAccountId, generation: record.generation }
+      : await getValidCodexToken(accountId);
+    const { accessToken, chatgptAccountId, generation } = token;
```

`60_000`을 새 literal로 두지 않고 account-store에서 `isCodexAccountCredentialFresh(record)`를 export해 동일 skew rule을 공유하는 것이 최종 구현이다. 위 diff의 literal은 호출 shape를 보이기 위한 자리이며, PR에는 helper를 사용한다.

## 관측성

`logCodexAuthAccountsRead()`는 `OPENCODEX_DEBUG_QUOTA=1`일 때만 한 줄을 낸다. 정확히 다음 필드만 로그한다.

```ts
console.warn(
  `[codex-auth-accounts] ms=${durationMs} mode=${forceRefresh ? "force" : "normal"}` +
  ` shared=${sharedBefore} revalidating=${revalidating} accounts=${accountCount}`,
);
```

email, account id, log label, token, request URL query 값, request/response body, upstream error text는 기록하지 않는다. `accounts`는 식별자가 아닌 정수 개수다. timeout은 기존 8s/30s/65s에 맡기고 새 timer를 만들지 않는다. privacy scan이 이 line과 test fixture의 금칙 식별자를 검사하도록 CI에서 `bun run privacy:scan`을 함께 실행한다.

## 테스트

새 파일은 flat Bun test다. 실제 WHAM URL은 count만 세고 body/header를 보지 않는다. isolated home은 기존 helper를 쓴다. 구현에서 exported `clearCodexAuthAccountListInFlightForTests()`를 before/after에 호출한다.

```ts
// tests/codex-auth-accounts-swr.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCodexAuthAccountListInFlightForTests, handleCodexAuthAPI, updateAccountQuota,
} from "../src/codex/auth-api";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import type { OcxConfig } from "../src/types";

let home = ""; let previousHome: string | undefined; let previousFetch: typeof fetch;
const config = (): OcxConfig => ({ port: 0, defaultProvider: "openai", providers: {}, codexAccounts: [{ id: "pool-a", email: "masked@example.test", isMain: false }] });
const request = (suffix = "") => new Request(`http://localhost/api/codex-auth/accounts${suffix}`);
function seed(c: OcxConfig) {
  saveCodexAccountCredential("pool-a", { accessToken: "access", refreshToken: "refresh", chatgptAccountId: "chatgpt", expiresAt: Date.now() + 3_600_000 });
  return c;
}
beforeEach(() => { previousHome = process.env.OPENCODEX_HOME; previousFetch = globalThis.fetch; home = mkdtempSync(join(tmpdir(), "ocx-accounts-swr-")); process.env.OPENCODEX_HOME = home; clearCodexAuthAccountListInFlightForTests(); });
afterEach(() => { globalThis.fetch = previousFetch; clearCodexAuthAccountListInFlightForTests(); if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome; rmSync(home, { recursive: true, force: true }); });

test("concurrent cold reads share one upstream fan-out", async () => {
  const c = seed(config()); let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async () => { calls += 1; await gate; return new Response(JSON.stringify({ plan_type: "pro", rate_limit: {} })); }) as typeof fetch;
  const first = handleCodexAuthAPI(request(), new URL(request().url), c);
  const second = handleCodexAuthAPI(request(), new URL(request().url), c);
  await Promise.resolve(); expect(calls).toBe(1);
  release();
  expect((await first)!.status).toBe(200); expect((await second)!.status).toBe(200);
});

test("stale quota returns immediately with revalidating while one background read runs", async () => {
  const c = seed(config()); updateAccountQuota("pool-a", 25);
  const realNow = Date.now; Date.now = () => realNow() + 5 * 60_000 + 1;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  globalThis.fetch = (async () => { calls += 1; await gate; return new Response(JSON.stringify({ plan_type: "pro", rate_limit: {} })); }) as typeof fetch;
  try {
    const response = await handleCodexAuthAPI(request(), new URL(request().url), c);
    const body = await response!.json() as { revalidating: boolean; accounts: Array<{ quota: { weeklyPercent?: number } | null }> };
    expect(body.revalidating).toBe(true); expect(body.accounts.find(a => a.quota)?.quota?.weeklyPercent).toBe(25); expect(calls).toBe(1);
  } finally { release(); Date.now = realNow; }
});

test("upstream failure keeps stale quota as a 200 fallback", async () => {
  const c = seed(config()); updateAccountQuota("pool-a", 42);
  const realNow = Date.now; Date.now = () => realNow() + 5 * 60_000 + 1;
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  try {
    const response = await handleCodexAuthAPI(request(), new URL(request().url), c);
    const body = await response!.json() as { revalidating: boolean; accounts: Array<{ quota: { weeklyPercent?: number } | null }> };
    expect(response!.status).toBe(200); expect(body.revalidating).toBe(true); expect(body.accounts.find(a => a.quota)?.quota?.weeklyPercent).toBe(42);
  } finally { Date.now = realNow; }
});
```

## 활성화 시나리오와 범위

| 분기 | 발화 | 증거 |
|---|---|---|
| concurrent coalescing | cold cache에서 `Promise.all(GET, GET)` | WHAM count 1, HTTP 200 둘 |
| stale-while-revalidate | 5분 지난 quota, 6시간 이내 snapshot | 즉시 200 + `revalidating:true`, background 1 |
| upstream failure fallback | 위 background WHAM 503 | 200, stale quota 유지, 식별자 없는 timing log |
| forced refresh | `GET ?refresh=1` 둘 | force bucket 안에서 1 fan-out; normal stale와 합치지 않음 |

IN: list request single-flight, cached DTO SWR, one-per-request credential snapshot read, additive `revalidating` field, opt-in aggregate timing, 위 tests. OUT: account mutation semantics, quota TTL 값 변경, fan-out concurrency 변경, GUI polling/revalidation(WP4), response에서 `revalidating` 외 API 계약 변경, request body/identifier logging.
