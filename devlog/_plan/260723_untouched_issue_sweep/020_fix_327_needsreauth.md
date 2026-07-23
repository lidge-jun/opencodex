# 020 — Fix #327: __main__ needsReauth Exposure

## Summary

The `__main__` (native Codex auth) account DTO omits `needsReauth`, while pool
accounts expose it. When main credential dies (401/403 from WHAM), the management
API and dashboard show no warning. Pool rotation picks the invalid main account,
causing upstream 403s with no diagnostic signal.

## File Change Map

### src/codex/auth-api.ts — MODIFY

**Change 1: Import markAccountNeedsReauth (line ~1-10)**

```diff
-import { clearAccountNeedsReauth, isAccountNeedsReauth } from "./account-runtime-state";
+import {
+  clearAccountNeedsReauth,
+  isAccountNeedsReauth,
+  markAccountNeedsReauth,
+} from "./account-runtime-state";
```

**Change 2: fetchMainAccountInfo() — mark reauth on 401/403 (line ~233)**

```diff
     const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
       headers: { Authorization: `Bearer ${tokens.access_token}`, ... },
       signal: AbortSignal.timeout(8000),
     });
-    if (!resp.ok) return { email: null, plan: null, quota: null };
+    if (!resp.ok) {
+      if (resp.status === 401 || resp.status === 403) {
+        markAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
+      }
+      return { email: null, plan: null, quota: null };
+    }
+    clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
     const data = (await resp.json()) as WhamUsageResponse;
```

Rationale: 401/403 = credential dead. 429/5xx/timeout = transient, don't mark.
Clear on success so CLI re-login recovery works without process restart.

**Change 3: CodexAuthAccountDto — make needsReauth required (line ~264)**

```diff
 export interface CodexAuthAccountDto {
   ...
-  needsReauth?: boolean;
+  needsReauth: boolean;
   hasCredential: boolean;
 }
```

**Change 4: listCodexAuthAccounts() — add needsReauth to main DTO (line ~378)**

```diff
   const main: CodexAuthAccountDto = {
     id: MAIN_CODEX_ACCOUNT_ID,
     email: maskEmail(mainInfo.email) ?? "Codex App login",
     plan: mainInfo.plan,
     isMain: true,
     hasCredential: true,
+    needsReauth: isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID),
     quota: mainInfo.quota ? { ...quotaForPlan(...) } : null,
   };
```

### tests/codex-auth-api.test.ts — MODIFY

Add regression test:
1. Write auth.json with main tokens
2. Mock WHAM fetch returning 401, then 403
3. Call listCodexAuthAccounts with forceRefresh
4. Assert __main__ DTO has needsReauth === true
5. Mock WHAM 200, refresh again
6. Assert needsReauth === false (clear on success)
7. Cleanup: clearAccountNeedsReauth in beforeEach/afterEach

## Scope Boundary

- IN: auth-api.ts changes, regression test
- OUT: GUI CodexAccountPool.tsx mainSwitchEntry (gui/ change needs approval)
- OUT: hasCredential semantics (separate contract)

## Edge Cases

- 429/5xx/timeout: NOT reauth (transient)
- auth.json missing: current synthetic-main contract unchanged
- Cache hit: DTO reads runtime marker directly, so marked state shows immediately
- Recovery: clearAccountNeedsReauth on 200 ensures re-login recovery works
