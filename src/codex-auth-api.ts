import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { loadConfig, saveConfig } from "./config";
import {
  getCodexAccountCredential,
  getValidCodexToken,
  saveCodexAccountCredential,
  removeCodexAccountCredential,
  listCodexAccountIds,
  TokenRefreshError,
} from "./codex-account-store";
import { extractAccountId, decodeJwtPayload } from "./oauth/chatgpt";
import type { OcxConfig } from "./types";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const accountQuota = new Map<string, {
  weeklyPercent: number;
  fiveHourPercent: number;
  updatedAt: number;
}>();

const ACCOUNT_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export function updateAccountQuota(accountId: string, weekly: number, fiveHour: number): void {
  accountQuota.set(accountId, { weeklyPercent: weekly, fiveHourPercent: fiveHour, updatedAt: Date.now() });
}

export function getAccountQuota(accountId: string) {
  return accountQuota.get(accountId) ?? null;
}

export function clearAccountQuota(): void { accountQuota.clear(); }

const codexAuthLoginState = new Map<string, { status: string; accountId?: string; email?: string; error?: string; doneAt?: number }>();

// H3: in-memory set of accounts needing re-auth (marked on refresh failure, cleared on successful save)
const reauthAccounts = new Set<string>();
export function markAccountNeedsReauth(id: string): void { reauthAccounts.add(id); }
export function isAccountNeedsReauth(id: string): boolean { return reauthAccounts.has(id); }
export function clearAccountNeedsReauth(id: string): void { reauthAccounts.delete(id); }

// H1: read main Codex tokens including id_token for reliable account ID extraction
function readCodexTokens(): { access_token: string; account_id: string; id_token?: string } | null {
  try {
    const codexHome = process.env["CODEX_HOME"] || join(os.homedir(), ".codex");
    const authPath = join(codexHome, "auth.json");
    if (!existsSync(authPath)) return null;
    const j = JSON.parse(readFileSync(authPath, "utf-8")) as {
      tokens?: { access_token?: string; account_id?: string; id_token?: string };
    };
    if (j?.tokens?.access_token) {
      return {
        access_token: j.tokens.access_token,
        account_id: j.tokens.account_id ?? "",
        id_token: j.tokens.id_token,
      };
    }
  } catch { /* best effort */ }
  return null;
}

export function getMainChatgptAccountId(): string | null {
  const tokens = readCodexTokens();
  if (!tokens) return null;
  return extractAccountId(tokens.id_token, tokens.access_token) ?? (tokens.account_id || null);
}

// H2: shared collision check for import and OAuth paths
export function checkAccountIdCollision(chatgptAccountId: string): { collision: true; reason: string } | { collision: false } {
  const mainId = getMainChatgptAccountId();
  if (mainId && mainId === chatgptAccountId) {
    return { collision: true, reason: "This account is your main Codex login. Use a different account for the pool." };
  }
  for (const poolId of listCodexAccountIds()) {
    const cred = getCodexAccountCredential(poolId);
    if (cred && cred.chatgptAccountId === chatgptAccountId) {
      return { collision: true, reason: `Account is already in the pool (${poolId}).` };
    }
  }
  return { collision: false };
}

let mainAccountCache: { email: string | null; plan: string | null; quota: { weeklyPercent: number; fiveHourPercent: number } | null; ts: number } | null = null;
const MAIN_CACHE_TTL = 5 * 60_000;
const POOL_CACHE_TTL = 5 * 60_000;

async function fetchMainAccountInfo(): Promise<{ email: string | null; plan: string | null; quota: { weeklyPercent: number; fiveHourPercent: number } | null }> {
  if (mainAccountCache && Date.now() - mainAccountCache.ts < MAIN_CACHE_TTL) {
    return mainAccountCache;
  }
  const tokens = readCodexTokens();
  if (!tokens) return { email: null, plan: null, quota: null };
  try {
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { email: null, plan: null, quota: null };
    const data = (await resp.json()) as {
      email?: string | null;
      plan_type?: string | null;
      rate_limit?: {
        primary_window?: { used_percent?: number };
        secondary_window?: { used_percent?: number };
      };
    };
    const result = {
      email: data.email ?? null,
      plan: data.plan_type ?? null,
      quota: data.rate_limit ? {
        weeklyPercent: data.rate_limit.secondary_window?.used_percent ?? 0,
        fiveHourPercent: data.rate_limit.primary_window?.used_percent ?? 0,
      } : null,
      ts: Date.now(),
    };
    mainAccountCache = result;
    return result;
  } catch {
    return { email: null, plan: null, quota: null };
  }
}

interface PoolQuotaResult {
  quota: { weeklyPercent: number; fiveHourPercent: number } | null;
  needsReauth: boolean;
}

async function fetchPoolAccountQuota(accountId: string): Promise<PoolQuotaResult> {
  const existing = accountQuota.get(accountId);
  if (existing && Date.now() - existing.updatedAt < POOL_CACHE_TTL) {
    return { quota: existing, needsReauth: false };
  }
  try {
    const { accessToken, chatgptAccountId } = await getValidCodexToken(accountId);
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": chatgptAccountId },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { quota: existing ?? null, needsReauth: resp.status === 401 };
    const data = (await resp.json()) as {
      rate_limit?: {
        primary_window?: { used_percent?: number };
        secondary_window?: { used_percent?: number };
      };
    };
    if (!data.rate_limit) return { quota: existing ?? null, needsReauth: false };
    const weekly = data.rate_limit.secondary_window?.used_percent ?? 0;
    const fiveHour = data.rate_limit.primary_window?.used_percent ?? 0;
    updateAccountQuota(accountId, weekly, fiveHour);
    return { quota: { weeklyPercent: weekly, fiveHourPercent: fiveHour }, needsReauth: false };
  } catch (e) {
    if (e instanceof TokenRefreshError) return { quota: existing ?? null, needsReauth: true };
    return { quota: existing ?? null, needsReauth: false };
  }
}

export async function handleCodexAuthAPI(
  req: Request,
  url: URL,
  _config: OcxConfig,
): Promise<Response | null> {

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "GET") {
    const config = loadConfig();
    const poolAccounts = (config.codexAccounts ?? []).filter(a => !a.isMain);
    const mainInfo = await fetchMainAccountInfo();
    const withQuota = poolAccounts.map(a => {
      const cred = getCodexAccountCredential(a.id);
      const cached = accountQuota.get(a.id);
      const expired = !cred || cred.expiresAt < Date.now();
      return {
        ...a,
        quota: cached ? { ...cached } : null,
        needsReauth: expired || isAccountNeedsReauth(a.id),
        hasCredential: !!cred,
      };
    });
    const main = {
      id: "__main__",
      email: mainInfo.email ?? "Codex App login",
      plan: mainInfo.plan,
      isMain: true,
      hasCredential: true,
      quota: mainInfo.quota ? { ...mainInfo.quota, updatedAt: Date.now() } : null,
    };
    return jsonResponse({ accounts: [main, ...withQuota] });
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "POST") {
    let body: { id: string; email: string; plan?: string; accessToken: string; refreshToken: string; chatgptAccountId: string };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (!body.id || !body.email || !body.accessToken || !body.refreshToken || !body.chatgptAccountId) {
      return jsonResponse({ error: "Missing required fields" }, 400);
    }
    if (!ACCOUNT_ID_RE.test(body.id)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    if (body.accessToken.length > 10_000 || body.refreshToken.length > 10_000) {
      return jsonResponse({ error: "Input too large" }, 400);
    }
    // 1.1: JWT-derived account ID is authoritative; collision check
    const derivedAccountId = extractAccountId(undefined, body.accessToken) ?? body.chatgptAccountId;
    const collision = checkAccountIdCollision(derivedAccountId);
    if (collision.collision) {
      return jsonResponse({ error: collision.reason }, 400);
    }
    // 4.2: use JWT exp for expiresAt instead of hardcoded 1 hour
    const payload = decodeJwtPayload(body.accessToken);
    const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : Date.now() + 3600_000;
    saveCodexAccountCredential(body.id, {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: exp,
      chatgptAccountId: derivedAccountId,
    });
    clearAccountNeedsReauth(body.id);
    const config = loadConfig();
    const accounts = config.codexAccounts ?? [];
    if (!accounts.find(a => a.id === body.id)) {
      accounts.push({ id: body.id, email: body.email, plan: body.plan, isMain: false });
      config.codexAccounts = accounts;
      saveConfig(config);
    }
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Missing id" }, 400);
    removeCodexAccountCredential(id);
    const config = loadConfig();
    config.codexAccounts = (config.codexAccounts ?? []).filter(a => a.id !== id);
    if (config.activeCodexAccountId === id) config.activeCodexAccountId = undefined;
    saveConfig(config);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "PUT") {
    let body: { accountId: string | null };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    const config = loadConfig();
    if (body.accountId != null) {
      const exists = (config.codexAccounts ?? []).some(a => a.id === body.accountId);
      if (!exists) return jsonResponse({ error: "Account not found" }, 400);
    }
    config.activeCodexAccountId = body.accountId ?? undefined;
    saveConfig(config);
    return jsonResponse({ ok: true, activeCodexAccountId: body.accountId });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "GET") {
    const config = loadConfig();
    return jsonResponse({
      activeCodexAccountId: config.activeCodexAccountId ?? null,
      autoSwitchThreshold: config.autoSwitchThreshold ?? 80,
    });
  }

  if (url.pathname === "/api/codex-auth/auto-switch" && req.method === "PUT") {
    let body: { threshold: number };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof body.threshold !== "number" || !Number.isInteger(body.threshold) || body.threshold < 0 || body.threshold > 100) {
      return jsonResponse({ error: "Threshold must be an integer 0-100" }, 400);
    }
    const config = loadConfig();
    config.autoSwitchThreshold = body.threshold;
    saveConfig(config);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/quota" && req.method === "GET") {
    const quotas: Record<string, unknown> = {};
    for (const [id, q] of accountQuota) quotas[id] = q;
    return jsonResponse({ quotas });
  }

  if (url.pathname === "/api/codex-auth/login" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    const requestedAccountId = body.id?.trim();
    if (requestedAccountId && !ACCOUNT_ID_RE.test(requestedAccountId)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    const accountId = requestedAccountId || `chatgpt-${Date.now()}`;
    const config = loadConfig();
    if ((config.codexAccounts ?? []).some(a => a.id === accountId) || getCodexAccountCredential(accountId)) {
      return jsonResponse({ error: `Account id already exists: ${accountId}` }, 400);
    }
    const flowId = `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { startLoginFlow, getLoginStatus } = await import("./oauth/index");
      const result = await startLoginFlow("chatgpt", { forceLogin: true });

      (async () => {
        let completed = false;
        for (let i = 0; i < 150; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const st = getLoginStatus("chatgpt");
          if (st.done && st.loggedIn) {
            const { getCredential } = await import("./oauth/store");
            const cred = getCredential("chatgpt");
            if (cred) {
              // 1.2: account-ID-based collision check (JWT-derived, not email)
              const oauthAccountId = cred.accountId;
              if (!oauthAccountId) {
                codexAuthLoginState.set(flowId, {
                  status: "error",
                  error: "Could not determine account identity from OAuth tokens. Try importing manually.",
                  doneAt: Date.now(),
                });
                completed = true;
                break;
              }
              const collision = checkAccountIdCollision(oauthAccountId);
              if (collision.collision) {
                codexAuthLoginState.set(flowId, {
                  status: "error", error: collision.reason, doneAt: Date.now(),
                });
                completed = true;
                break;
              }

              let email = cred.email || accountId;
              let plan: string | undefined;
              try {
                const tokens = { access_token: cred.access, account_id: oauthAccountId };
                const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
                  headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
                  signal: AbortSignal.timeout(8000),
                });
                if (resp.ok) {
                  const data = (await resp.json()) as { email?: string; plan_type?: string };
                  email = data.email ?? email;
                  plan = data.plan_type ?? undefined;
                }
              } catch { /* wham fetch is non-blocking */ }

              saveCodexAccountCredential(accountId, {
                accessToken: cred.access,
                refreshToken: cred.refresh,
                expiresAt: cred.expires,
                chatgptAccountId: oauthAccountId,
              });
              clearAccountNeedsReauth(accountId);

              const latestConfig = loadConfig();
              const accounts = latestConfig.codexAccounts ?? [];
              if (!accounts.find(a => a.id === accountId)) {
                accounts.push({ id: accountId, email, plan, isMain: false });
                latestConfig.codexAccounts = accounts;
                saveConfig(latestConfig);
              }
              codexAuthLoginState.set(flowId, { status: "done", accountId, email, doneAt: Date.now() });
              completed = true;
            }
            break;
          }
          if (st.done && st.error) {
            codexAuthLoginState.set(flowId, { status: "error", error: st.error, doneAt: Date.now() });
            completed = true;
            break;
          }
        }
        if (!completed) {
          codexAuthLoginState.set(flowId, {
            status: "error",
            error: "Login timed out before OAuth completed.",
            doneAt: Date.now(),
          });
        }
        // TTL: keep completed flow state available for clients that miss a short polling window.
        setTimeout(() => codexAuthLoginState.delete(flowId), 300_000);
      })();

      codexAuthLoginState.set(flowId, { status: "pending" });
      return jsonResponse({ ok: true, flowId, url: result.url, instructions: result.instructions });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("already in progress")) {
        return jsonResponse({ error: msg, status: "pending" }, 409);
      }
      return jsonResponse({ error: msg }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/login-status" && req.method === "GET") {
    const flowId = url.searchParams.get("flowId");
    const accountId = url.searchParams.get("accountId")?.trim();
    if (flowId) {
      const st = codexAuthLoginState.get(flowId);
      if (!st && accountId && getCodexAccountCredential(accountId)) {
        return jsonResponse({ status: "done", accountId });
      }
      return jsonResponse(st ?? { status: "expired" });
    }
    // Legacy fallback: return latest pending flow
    for (const [, st] of codexAuthLoginState) {
      if (st.status === "pending") return jsonResponse(st);
    }
    return jsonResponse({ status: "idle" });
  }

  return null;
}
