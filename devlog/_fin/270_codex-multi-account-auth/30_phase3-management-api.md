# Phase 3: Management API (30-39)

> Superseded security note (2026-06-25): This document predates the 280 security patch plan and Phase 10-60 hardening. Treat release-readiness, full-email UI, ordinal request-log labels, unauthenticated management API, fail-open fallback, and earlier account-boundary claims here as historical only. Current merge/deploy evidence is tracked under `devlog/280_codex-multi-auth-security-patch-plan/` and `devlog/_plan/260624_codex-multi-auth-security-implementation/`.

PABCD 3턴: REST API endpoints for account CRUD + quota tracking + auto-switch

## Scope

- src/codex-auth-api.ts — NEW: 분리된 management API 모듈
- src/server.ts — delegation import (5줄)

## Depends on

Phase 1 (types + store), Phase 2 (session affinity)

## Why separate file

server.ts는 이미 876줄. 500줄 규칙 위반 상태. 새 엔드포인트를 server.ts에 넣으면 960줄+.
codex-auth-api.ts로 분리하고, server.ts는 delegation만.

## Files

### MODIFY src/server.ts (+5 lines)

handleManagementAPI 안, 기존 라우트들 뒤에 추가:

```ts
// after existing /api/stop, /api/oauth/* routes:
if (url.pathname.startsWith("/api/codex-auth/")) {
  const { handleCodexAuthAPI } = await import("./codex-auth-api");
  return handleCodexAuthAPI(req, url, config);
}
```

### NEW src/codex-auth-api.ts (~100 lines)

```ts
import { loadConfig, saveConfig } from "./config";
import {
  loadCodexAccountStore,
  getCodexAccountCredential,
  saveCodexAccountCredential,
  removeCodexAccountCredential,
  listCodexAccountIds,
} from "./codex-account-store";
import type { OcxConfig, CodexAccount } from "./types";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// In-memory quota cache, populated from x-codex-*-used-percent response headers.
const accountQuota = new Map<string, {
  weeklyPercent: number;
  fiveHourPercent: number;
  updatedAt: number;
}>();

export function updateAccountQuota(accountId: string, weekly: number, fiveHour: number): void {
  accountQuota.set(accountId, { weeklyPercent: weekly, fiveHourPercent: fiveHour, updatedAt: Date.now() });
}

export function getAccountQuota(accountId: string) {
  return accountQuota.get(accountId) ?? null;
}

export async function handleCodexAuthAPI(
  req: Request,
  url: URL,
  config: OcxConfig,
): Promise<Response | null> {

  // GET /api/codex-auth/accounts — list all
  if (url.pathname === "/api/codex-auth/accounts" && req.method === "GET") {
    const accounts = config.codexAccounts ?? [];
    const withQuota = accounts.map(a => ({
      ...a,
      quota: getAccountQuota(a.id),
      hasCredential: !!getCodexAccountCredential(a.id),
    }));
    return jsonResponse({ accounts: withQuota });
  }

  // POST /api/codex-auth/accounts — add account
  if (url.pathname === "/api/codex-auth/accounts" && req.method === "POST") {
    const body = await req.json() as {
      id: string;
      email: string;
      plan?: string;
      accessToken: string;
      refreshToken: string;
      chatgptAccountId: string;
    };
    if (!body.id || !body.email || !body.accessToken || !body.refreshToken || !body.chatgptAccountId) {
      return jsonResponse({ error: "Missing required fields" }, 400);
    }
    // Save credential
    saveCodexAccountCredential(body.id, {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: Date.now() + 3600_000, // assume 1h, refresh will fix
      chatgptAccountId: body.chatgptAccountId,
    });
    // Add to config
    const updated = loadConfig();
    const accounts = updated.codexAccounts ?? [];
    if (!accounts.find(a => a.id === body.id)) {
      accounts.push({ id: body.id, email: body.email, plan: body.plan, isMain: false });
      updated.codexAccounts = accounts;
      saveConfig(updated);
    }
    return jsonResponse({ ok: true });
  }

  // DELETE /api/codex-auth/accounts?id=xxx — remove pool account
  if (url.pathname === "/api/codex-auth/accounts" && req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Missing id" }, 400);
    removeCodexAccountCredential(id);
    const updated = loadConfig();
    updated.codexAccounts = (updated.codexAccounts ?? []).filter(a => a.id !== id);
    if (updated.activeCodexAccountId === id) updated.activeCodexAccountId = undefined;
    saveConfig(updated);
    return jsonResponse({ ok: true });
  }

  // PUT /api/codex-auth/active — set active account for next session
  if (url.pathname === "/api/codex-auth/active" && req.method === "PUT") {
    const body = await req.json() as { accountId: string | null };
    const updated = loadConfig();
    updated.activeCodexAccountId = body.accountId ?? undefined;
    saveConfig(updated);
    return jsonResponse({ ok: true, activeCodexAccountId: body.accountId });
  }

  // GET /api/codex-auth/active — get current active
  if (url.pathname === "/api/codex-auth/active" && req.method === "GET") {
    return jsonResponse({
      activeCodexAccountId: config.activeCodexAccountId ?? null,
      autoSwitchThreshold: config.autoSwitchThreshold ?? 80,
    });
  }

  // PUT /api/codex-auth/auto-switch — set threshold
  if (url.pathname === "/api/codex-auth/auto-switch" && req.method === "PUT") {
    const body = await req.json() as { threshold: number };
    const updated = loadConfig();
    updated.autoSwitchThreshold = body.threshold;
    saveConfig(updated);
    return jsonResponse({ ok: true });
  }

  // GET /api/codex-auth/quota — all account quotas
  if (url.pathname === "/api/codex-auth/quota" && req.method === "GET") {
    const quotas: Record<string, unknown> = {};
    for (const [id, q] of accountQuota) quotas[id] = q;
    return jsonResponse({ quotas });
  }

  return null; // not handled
}
```

## Quota Capture (server.ts)

upstream 응답 헤더에서 quota 추출. /v1/responses POST 응답 후:

```ts
// server.ts, after upstream response received (passthrough path):
// Extract x-codex-*-used-percent from response headers
const weeklyHeader = upstreamRes.headers.get("x-codex-primary-used-percent");
const fiveHourHeader = upstreamRes.headers.get("x-codex-secondary-used-percent");
if (accountId && (weeklyHeader || fiveHourHeader)) {
  const { updateAccountQuota } = await import("./codex-auth-api");
  updateAccountQuota(accountId, parseFloat(weeklyHeader ?? "0"), parseFloat(fiveHourHeader ?? "0"));
}
```

## Auto-switch Logic

resolveCodexAccountForThread에 추가 (Phase 2의 server.ts 함수):

```ts
// step 2 전에: auto-switch check
if (active) {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold > 0) {
    const { getAccountQuota } = await import("./codex-auth-api");
    const quota = getAccountQuota(active);
    if (quota && quota.weeklyPercent >= threshold) {
      // Find lowest-usage pool account
      const pool = (config.codexAccounts ?? []).filter(a => !a.isMain && a.id !== active);
      let best = active;
      let bestUsage = quota.weeklyPercent;
      for (const p of pool) {
        const pq = getAccountQuota(p.id);
        const usage = pq?.weeklyPercent ?? 0;
        if (usage < bestUsage) { best = p.id; bestUsage = usage; }
      }
      if (best !== active) {
        // Persist the switch
        const updated = loadConfig();
        updated.activeCodexAccountId = best;
        saveConfig(updated);
        if (threadId) threadAccountMap.set(threadId, best);
        return best;
      }
    }
  }
}
```

## Verification

- bun run typecheck
- API endpoint smoke test (curl)
- quota capture from real response headers
- auto-switch trigger at threshold

## Commits

```
feat: add codex-auth management API endpoints
feat: capture quota from upstream response headers
feat: auto-switch account at usage threshold
```
