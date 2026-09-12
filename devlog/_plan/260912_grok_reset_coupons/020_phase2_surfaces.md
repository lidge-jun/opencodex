# PRD: Grok Reset Coupons — Phase 2 Management API & CLI Surfaces

This diff-level PRD specifies Phase 2 of the Grok reset coupon support within OpenCodex. It covers the management API routes (`GET /api/grok/reset-coupons` and `POST /api/grok/reset-coupons/consume`), lazy dispatch mounting in `src/server/management-api.ts`, route table registration in `src/server/management/route-registry.ts`, CLI subcommands in `src/cli/account-auth.ts`, `src/cli/account.ts`, and `src/cli/registry.ts`, and the test suite registration in `tests/providers/xai/grok-reset-coupons.test.ts` across `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.

---

## 010 Context & Architectural Decisions

### Accepted Decisions Summary
- **D1 (Domain Implementation):** Client encapsulated in `src/grok/grpc-web.ts`, coupon inspection/redemption in `src/grok/reset-coupons.ts`, and durable operation journaling in `src/grok/reset-coupon-ledger.ts`.
- **D3 (Management Endpoints & Routing):** Endpoints mounted under `/api/grok/reset-coupons` (GET) and `/api/grok/reset-coupons/consume` (POST) in `src/server/management/grok-coupon-routes.ts`. Handled via on-demand lazy import `handleGrokCouponRoutesOnDemand` in `src/server/management-api.ts` to preserve startup latency and maintain the core-lab boundary invariant.
- **D4 (CLI Interface):** Subcommand `grok-reset-coupons` in `src/cli/account-auth.ts`, routed through `src/cli/account.ts` and registered in `src/cli/registry.ts`. Mirroring `resetCredits()`: `--consume` strictly mandates `--yes`; `--operation-id` validates against UUIDv4 via `isCodexResetCreditOperationId`; supports `--token-id` selection.
- **D5 (Testing & Layout Verification):** Test suite in `tests/providers/xai/grok-reset-coupons.test.ts` mapped to category `"providers/xai"` in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.

### Verified Upstream & Codebase Seams
- **Bearer Token Resolution:** `src/oauth/index.ts:613` (`getValidAccessSnapshotForAccount("xai", accountId)`) with token refresh through `src/oauth/xai.ts:369` (`refreshXaiToken`).
- **Header Constants:** `src/providers/xai-transport.ts:28-56` (`tokenAuth` header `"x-xai-token-auth": "xai-grok-cli"`).
- **Operation Journaling & Deduplication:** UUIDv4 validation using `isCodexResetCreditOperationId` from `src/codex/reset-credit-recovery.ts:40`. Durable journaling in `src/grok/reset-coupon-ledger.ts` writes intent prior to upstream fetch and replays cached settlement when the same `operationId` is presented.

---

## 020 File Modifications & Exact Diffs

### 1. NEW File: `src/server/management/grok-coupon-routes.ts`

```typescript
/**
 * Management API handlers for Grok quota reset coupons.
 *
 * Exposes inspection and consumption of Grok billing reset coupons via gRPC-Web
 * to Grok ConsumerUiSvc upstream endpoints.
 *
 * Inherits management authentication from requireManagementAuth in management-api.ts.
 * Lazy-loaded by handleGrokCouponRoutesOnDemand to keep startup fast and honor the
 * core-lab boundary contract.
 */

import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { isCodexResetCreditOperationId } from "../../codex/reset-credit-recovery";
import { getValidAccessSnapshotForAccount } from "../../oauth";
import { listAccounts, captureOAuthAccountSelection } from "../../oauth/store";
import {
  getGrokRemainingResets,
  redeemGrokResetCoupon,
  type GrokResetCoupon,
} from "../../grok/reset-coupons";
import {
  openGrokResetCouponOperation,
  recordGrokResetCouponSettlement,
  type GrokResetCouponOperationRecord,
} from "../../grok/reset-coupon-ledger";

export interface GrokResetCouponsResponse {
  accountId: string;
  tokens: Array<{
    tokenId: string;
    validityStart: string;
    validityEnd: string;
  }>;
  remaining: number;
}

export interface GrokConsumeCouponRequestBody {
  accountId?: string;
  tokenId?: string;
  operationId?: string;
}

function resolveTargetAccountId(requestedAccountId?: string): string {
  if (requestedAccountId && requestedAccountId.trim() !== "") {
    return requestedAccountId.trim();
  }
  const selection = captureOAuthAccountSelection("xai");
  if (selection?.accountId) {
    return selection.accountId;
  }
  const accounts = listAccounts("xai");
  if (accounts.length > 0) {
    return accounts[0].id;
  }
  throw new Error("No xAI account found or active");
}

export async function handleGrokCouponRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config } = ctx;
  const { pathname } = url;

  if (pathname === "/api/grok/reset-coupons") {
    if (req.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, req, config);
    }

    const queryAccountId = url.searchParams.get("accountId") ?? undefined;
    let accountId: string;
    try {
      accountId = resolveTargetAccountId(queryAccountId);
    } catch (err) {
      return jsonResponse(
        { error: { code: "no_account", message: err instanceof Error ? err.message : String(err) } },
        400,
        req,
        config,
      );
    }

    let tokenSnapshot;
    try {
      tokenSnapshot = await getValidAccessSnapshotForAccount("xai", accountId, { requireUsableAccount: true });
    } catch (err) {
      return jsonResponse(
        { error: { code: "auth_failed", message: "Failed to resolve valid xAI credentials for account" } },
        401,
        req,
        config,
      );
    }

    try {
      const remainingResult = await getGrokRemainingResets({
        accessToken: tokenSnapshot.accessToken,
      });

      const payload: GrokResetCouponsResponse = {
        accountId,
        tokens: remainingResult.tokens.map((t) => ({
          tokenId: t.tokenId,
          validityStart: t.validityStart,
          validityEnd: t.validityEnd,
        })),
        remaining: remainingResult.tokens.length,
      };

      return jsonResponse(payload, 200, req, config);
    } catch (err) {
      return jsonResponse(
        { error: { code: "upstream_error", message: err instanceof Error ? err.message : String(err) } },
        502,
        req,
        config,
      );
    }
  }

  if (pathname === "/api/grok/reset-coupons/consume") {
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, req, config);
    }

    let body: GrokConsumeCouponRequestBody;
    try {
      body = (await req.json()) as GrokConsumeCouponRequestBody;
    } catch {
      return jsonResponse({ error: { code: "invalid_json", message: "Invalid JSON body" } }, 400, req, config);
    }

    const { accountId: rawAccountId, tokenId: requestedTokenId, operationId } = body;

    if (operationId !== undefined && !isCodexResetCreditOperationId(operationId)) {
      return jsonResponse(
        { error: { code: "invalid_operation_id", message: "operationId must be a valid UUIDv4" } },
        400,
        req,
        config,
      );
    }

    let accountId: string;
    try {
      accountId = resolveTargetAccountId(rawAccountId);
    } catch (err) {
      return jsonResponse(
        { error: { code: "no_account", message: err instanceof Error ? err.message : String(err) } },
        400,
        req,
        config,
      );
    }

    let tokenSnapshot;
    try {
      tokenSnapshot = await getValidAccessSnapshotForAccount("xai", accountId, { requireUsableAccount: true });
    } catch (err) {
      return jsonResponse(
        { error: { code: "auth_failed", message: "Failed to resolve valid xAI credentials for account" } },
        401,
        req,
        config,
      );
    }

    // Journaling and Idempotency settlement check
    const effectiveOpId = operationId ?? crypto.randomUUID();
    const opRecord = openGrokResetCouponOperation({
      accountId,
      tokenId: requestedTokenId,
      operationId: effectiveOpId,
    });

    if (opRecord.kind === "replay") {
      return jsonResponse(
        {
          code: opRecord.code,
          replayed: true,
          tokenId: opRecord.tokenId,
          settledAt: opRecord.settledAt,
        },
        200,
        req,
        config,
      );
    }

    if (opRecord.kind === "identity-mismatch") {
      return jsonResponse(
        {
          error: {
            code: "operation_id_owned_by_another_account",
            message: "Operation ID was previously registered with a different account or token",
          },
        },
        409,
        req,
        config,
      );
    }

    if (opRecord.kind !== "execute") {
      return jsonResponse(
        {
          error: {
            code: opRecord.kind,
            message: "Coupon ledger capacity or unavailable failure",
          },
        },
        503,
        req,
        config,
      );
    }

    let resolvedTokenId = requestedTokenId;
    if (!resolvedTokenId) {
      try {
        const remaining = await getGrokRemainingResets({ accessToken: tokenSnapshot.accessToken });
        if (!remaining.tokens || remaining.tokens.length === 0) {
          recordGrokResetCouponSettlement({
            operationId: effectiveOpId,
            code: "no_coupons_available",
            status: "failed",
          });
          return jsonResponse(
            { error: { code: "no_coupons_available", message: "No reset coupons available to redeem" } },
            400,
            req,
            config,
          );
        }
        resolvedTokenId = remaining.tokens[0].tokenId;
      } catch (err) {
        return jsonResponse(
          { error: { code: "fetch_resets_failed", message: err instanceof Error ? err.message : String(err) } },
          502,
          req,
          config,
        );
      }
    }

    try {
      const redeemResult = await redeemGrokResetCoupon({
        accessToken: tokenSnapshot.accessToken,
        tokenId: resolvedTokenId,
      });

      recordGrokResetCouponSettlement({
        operationId: effectiveOpId,
        tokenId: resolvedTokenId,
        code: "redeemed",
        status: "success",
      });

      return jsonResponse(
        {
          success: true,
          code: "redeemed",
          replayed: false,
          tokenId: resolvedTokenId,
          accountId,
          operationId: effectiveOpId,
        },
        200,
        req,
        config,
      );
    } catch (err) {
      recordGrokResetCouponSettlement({
        operationId: effectiveOpId,
        tokenId: resolvedTokenId,
        code: "redeem_failed",
        status: "failed",
      });
      return jsonResponse(
        { error: { code: "redeem_failed", message: err instanceof Error ? err.message : String(err) } },
        502,
        req,
        config,
      );
    }
  }

  return null;
}
```

---

### 2. MODIFY File: `src/server/management/route-registry.ts`

**Location:** Insert between line 133 (`POST /api/grok/apply`) and line 134 (`PUT /api/claude-code`).
**Exact Diff:**

```diff
--- a/src/server/management/route-registry.ts
+++ b/src/server/management/route-registry.ts
@@ -131,6 +131,8 @@ export const MANAGEMENT_ROUTES: readonly ManagementRoute[] = [
  { method: "GET", path: "/api/v2", module: "server/management/agent-settings-routes", mutates: false },
  { method: "POST", path: "/api/claude-desktop/apply", module: "server/management/agent-settings-routes", mutates: true },
  { method: "POST", path: "/api/grok/apply", module: "server/management/agent-settings-routes", mutates: true },
+  { method: "GET", path: "/api/grok/reset-coupons", module: "server/management/grok-coupon-routes", mutates: false },
+  { method: "POST", path: "/api/grok/reset-coupons/consume", module: "server/management/grok-coupon-routes", mutates: true },
  { method: "PUT", path: "/api/claude-code", module: "server/management/agent-settings-routes", mutates: true },
  { method: "PUT", path: "/api/claude-desktop", module: "server/management/agent-settings-routes", mutates: true },
  { method: "PUT", path: "/api/codex-auth/features/default-mode-request-user-input", module: "server/management/agent-settings-routes", mutates: true },
```

---

### 3. MODIFY File: `src/server/management-api.ts`

**Location:** Around line 144 (after `handleQuotaResetRoutesOnDemand`) and line 243 (quota handler dispatched at 243, in the route dispatch chain).
**Exact Diff:**

```diff
--- a/src/server/management-api.ts
+++ b/src/server/management-api.ts
@@ -142,6 +142,12 @@ async function handleQuotaResetRoutesOnDemand(ctx: ManagementContext): Promise<R
   const { handleQuotaResetRoutes } = await import("./management/quota-reset-routes");
   return handleQuotaResetRoutes(ctx);
 }
+
+async function handleGrokCouponRoutesOnDemand(ctx: ManagementContext): Promise<Response | null> {
+  if (!pathInManagementNamespace(ctx.url.pathname, "/api/grok/reset-coupons", true)) return null;
+  const { handleGrokCouponRoutes } = await import("./management/grok-coupon-routes");
+  return handleGrokCouponRoutes(ctx);
+}
 
 export async function handleManagementAPI(
   req: Request,
@@ -242,4 +248,5 @@ export async function handleManagementAPI(
    ??     (await handleRequestHistoryRoutes(ctx))
    ??     (await handleQuotaResetRoutesOnDemand(ctx))
+    ??     (await handleGrokCouponRoutesOnDemand(ctx))
    ??     (await handleRoutingAnalyticsRoutes(ctx))
    ??     (await handleRoutingProfileRoutesOnDemand(ctx))
```

---

### 4. MODIFY File: `src/cli/account-auth.ts`

**Location:** Line 39 in `USAGE`, function `grokResetCoupons()` after line 302, and line 309 in `handleAccountAuthCommand()`.
**Exact Diff:**

```diff
--- a/src/cli/account-auth.ts
+++ b/src/cli/account-auth.ts
@@ -38,6 +38,7 @@ const USAGE = `Usage:
   ocx account code <provider> [--flow <flow-id>] [--json]   (reads the code from stdin)
   ocx account cancel <provider> [--flow <flow-id>] [--json]
   ocx account reset-credits <account-id|main> [--consume --yes [--operation-id <uuid>]] [--json]
+  ocx account grok-reset-coupons [<account-id>] [--consume --yes [--token-id <token-id>] [--operation-id <uuid>]] [--json]
 
 --device runs the OpenAI device-code login instead of the browser callback: use
 it when the proxy has no browser or nothing can reach localhost:1455, such as a
@@ -301,6 +302,37 @@ async function resetCredits(argv: string[], deps: RuntimeApiDeps): Promise<void>
   printData(result, wantsJson);
 }
 
+async function grokResetCoupons(argv: string[], deps: RuntimeApiDeps): Promise<void> {
+  const args = [...argv];
+  const rawId = args.shift()?.trim();
+  const wantsJson = takeFlag(args, "--json");
+  const consume = takeFlag(args, "--consume");
+  const yes = takeFlag(args, "--yes");
+  const tokenId = takeOption(args, "--token-id");
+  const operationId = takeOption(args, "--operation-id");
+
+  if (consume && !yes) throw new CliUsageError("consuming a Grok reset coupon requires --yes", USAGE);
+  if (operationId !== undefined && !consume) {
+    throw new CliUsageError("--operation-id requires --consume", USAGE);
+  }
+  if (tokenId !== undefined && !consume) {
+    throw new CliUsageError("--token-id requires --consume", USAGE);
+  }
+  if (operationId !== undefined && !isCodexResetCreditOperationId(operationId)) {
+    throw new CliUsageError("--operation-id must be a UUIDv4", USAGE);
+  }
+  rejectArgs(args, USAGE);
+
+  const accountId = rawId ? (rawId === "main" ? "__main__" : rawId) : undefined;
+  const result = consume
+    ? await runtimeRequest("/api/grok/reset-coupons/consume", {
+      method: "POST",
+      body: JSON.stringify({ accountId, tokenId, ...(operationId === undefined ? {} : { operationId }) }),
+    }, deps)
+    : await runtimeRequest(`/api/grok/reset-coupons${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`, {}, deps);
+  printData(result, wantsJson);
+}
+
 export async function handleAccountAuthCommand(sub: string, argv: string[], deps: RuntimeApiDeps = {}): Promise<number | null> {
   let action: (() => Promise<void>) | undefined;
   if (sub === "login" || sub === "reauth") action = () => login(sub === "reauth" ? [...argv, "--reauth"] : argv, deps);
   else if (sub === "code") action = () => code(argv, deps);
   else if (sub === "cancel") action = () => cancel(argv, deps);
   else if (sub === "reset-credits") action = () => resetCredits(argv, deps);
+  else if (sub === "grok-reset-coupons") action = () => grokResetCoupons(argv, deps);
   if (!action) return null;
   return runCliAction(action);
 }
```

---

### 5. MODIFY File: `src/cli/account.ts`

**Location:** Line 62 in `ACCOUNT_USAGE` and line 358 in subcommands list.
**Exact Diff:**

```diff
--- a/src/cli/account.ts
+++ b/src/cli/account.ts
@@ -60,6 +60,7 @@ Usage:
   ocx account code <provider> [--flow <flow-id>] [--json]   (reads the code from stdin)
   ocx account cancel <provider> [--flow <flow-id>] [--json]
   ocx account reset-credits <account-id|main> [--consume --yes] [--json]
+  ocx account grok-reset-coupons [<account-id>] [--consume --yes] [--token-id <token-id>] [--json]
   ocx account main <doctor|list|register|add|switch|recover> ...
 
 List and switch provider accounts and API-key pools (masked output only).
@@ -355,7 +356,7 @@ export async function handleAccountCommand(argv: string[], deps: RuntimeApiDeps
       const { cmdNativeMainAccount } = await import("./account-main");
       return await cmdNativeMainAccount(rest, deps);
     }
-    if (["login", "reauth", "code", "cancel", "reset-credits"].includes(sub ?? "")) {
+    if (["login", "reauth", "code", "cancel", "reset-credits", "grok-reset-coupons"].includes(sub ?? "")) {
       const { handleAccountAuthCommand } = await import("./account-auth");
       return await handleAccountAuthCommand(sub!, rest, deps) ?? 1;
     }
```

---

### 6. MODIFY File: `src/cli/registry.ts`

**Location:** Line 224 (`usage`) and line 236 (`details`).
**Exact Diff:**

```diff
--- a/src/cli/registry.ts
+++ b/src/cli/registry.ts
@@ -221,7 +221,7 @@ export const ROOT_COMMANDS: readonly CommandSpec[] = [
   },
   {
     name: "account",
-    usage: "ocx account <list|current|use|refresh|auto-switch|priority|login|reauth|code|cancel|remove|add-key|reset-credits|main> ...",
+    usage: "ocx account <list|current|use|refresh|auto-switch|priority|login|reauth|code|cancel|remove|add-key|reset-credits|grok-reset-coupons|main> ...",
     summary: "List and switch provider accounts and API-key pools (GUI parity).",
     details: [
       "list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).",
@@ -234,6 +234,7 @@ export const ROOT_COMMANDS: readonly CommandSpec[] = [
       "add-key <provider> [--label <label>]  Add a key read only from piped stdin.",
       "login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.",
       "reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.",
+      "grok-reset-coupons [<id>] [--consume --yes] Inspect or redeem Grok reset coupons.",
       "main <subcommand>     Manage the physical native Codex login separately from Pool routing.",
       "Switching the active account takes effect immediately; running threads move on their next request, and in-flight requests keep the account they captured.",
       "A selection-order change applies from the next unbound request and never moves a bound thread.",
```

---

### 7. NEW File & Test Layout Registration

#### File: `tests/providers/xai/grok-reset-coupons.test.ts`
Tests management routes and CLI operations:
- Mocking upstream `GetRemainingResets` (empty request body -> returns repeated tokens).
- Mocking upstream `RedeemReset` (proto message with `tokenId` string field 1).
- Validating UUIDv4 rejection on invalid `--operation-id`.
- Validating `--yes` requirement when `--consume` is set.
- Replay test: verifying identical `operationId` yields `{ replayed: true }` without second upstream fetch.

#### MODIFY File: `scripts/test-layout/layout.json`
Insert into the explicit map around line 701:

```diff
--- a/scripts/test-layout/layout.json
+++ b/scripts/test-layout/layout.json
@@ -699,6 +699,7 @@
     "grok-models-effort-list.test.ts": "providers/xai",
     "grok-orphan-adoption.test.ts": "providers/xai",
+    "grok-reset-coupons.test.ts": "providers/xai",
     "grok-selection.test.ts": "providers/xai",
     "grok-status.test.ts": "providers/xai",
```

#### MODIFY File: `tests/fixtures/test-layout-expected.json`
Insert alphabetically:

```diff
--- a/tests/fixtures/test-layout-expected.json
+++ b/tests/fixtures/test-layout-expected.json
@@ -532,6 +532,7 @@
   "grok-management-api.test.ts": "providers/xai",
   "grok-models-effort-list.test.ts": "providers/xai",
   "grok-orphan-adoption.test.ts": "providers/xai",
+  "grok-reset-coupons.test.ts": "providers/xai",
   "grok-selection.test.ts": "providers/xai",
   "grok-status.test.ts": "providers/xai",
   "grok-sync.test.ts": "providers/xai",
```

---

## 030 Acceptance Criteria & Verifier Commands

1. **Route Dispatch Invariant:**
   - Command: `bun test tests/lab/core-lab-boundary.test.ts`
   - Verification: Confirming `src/server/management-api.ts` does not statically import `grok-coupon-routes.ts`.
2. **Test Layout Integrity:**
   - Command: `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts`
   - Verification: Validates `scripts/test-layout/layout.json` matches test directories and `test-layout-expected.json`.
3. **CLI Usage & Flag Enforcements:**
   - Command: `ocx account grok-reset-coupons --consume` (without `--yes`) exits with code 1 and error message `consuming a Grok reset coupon requires --yes`.
   - Command: `ocx account grok-reset-coupons --operation-id invalid-uuid --consume --yes` exits with code 1 and error message `--operation-id must be a UUIDv4`.
4. **Idempotency & Journaling Execution:**
   - Test: `bun test tests/providers/xai/grok-reset-coupons.test.ts` passes all read, consume, validation, and replay assertions.
