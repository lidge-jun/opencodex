import { loadConfig, saveConfig } from "./config";
import {
  getCodexAccountCredential,
  getValidCodexToken,
  saveCodexAccountCredential,
  CodexCredentialGenerationConflictError,
  TokenRefreshError,
} from "./codex-account-store";
import { deleteCodexAccount } from "./codex-account-lifecycle";
import { checkAccountIdCollision, readCodexTokens } from "./codex-auth-collision";
export { checkAccountIdCollision, getMainChatgptAccountId } from "./codex-auth-collision";
export { clearAccountNeedsReauth, isAccountNeedsReauth, markAccountNeedsReauth } from "./codex-account-runtime-state";
import { clearAccountNeedsReauth, isAccountNeedsReauth } from "./codex-account-runtime-state";
import {
  clearAccountQuota,
  getAccountQuota,
  listAccountQuotas,
  parseUsageQuota,
  updateAccountQuota,
  type StoredAccountQuota,
  type WhamUsageResponse,
} from "./codex-quota";
export { clearAccountQuota, getAccountQuota, parseUsageQuota, updateAccountQuota } from "./codex-quota";
import { extractAccountId, decodeJwtPayload } from "./oauth/chatgpt";
import type { OcxConfig } from "./types";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ACCOUNT_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

const codexAuthLoginState = new Map<string, { status: string; accountId?: string; email?: string; error?: string; doneAt?: number }>();

function expireCodexAuthFlow(flowId: string | null, error = "Login cancelled"): void {
  if (!flowId) return;
  codexAuthLoginState.set(flowId, { status: "error", error, doneAt: Date.now() });
  setTimeout(() => codexAuthLoginState.delete(flowId), 30_000);
}

let mainAccountCache: { email: string | null; plan: string | null; quota: { weeklyPercent: number; fiveHourPercent: number } | null; ts: number } | null = null;
const MAIN_CACHE_TTL = 5 * 60_000;
const POOL_CACHE_TTL = 5 * 60_000;
const POOL_QUOTA_REFRESH_CONCURRENCY = 4;

function isRuntimeConfig(config: OcxConfig): boolean {
  return !!config && typeof config === "object" && !!config.providers;
}

function getRuntimeConfig(config: OcxConfig): OcxConfig {
  return isRuntimeConfig(config) ? config : loadConfig();
}

function saveRuntimeConfig(sourceConfig: OcxConfig, nextConfig: OcxConfig): void {
  saveConfig(nextConfig);
  if (sourceConfig === nextConfig || !isRuntimeConfig(sourceConfig)) return;
  for (const key of Object.keys(sourceConfig) as Array<keyof OcxConfig>) {
    delete sourceConfig[key];
  }
  Object.assign(sourceConfig, nextConfig);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchMainAccountInfo(forceRefresh = false): Promise<{ email: string | null; plan: string | null; quota: { weeklyPercent: number; fiveHourPercent: number } | null }> {
  if (!forceRefresh && mainAccountCache && Date.now() - mainAccountCache.ts < MAIN_CACHE_TTL) {
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
    const data = (await resp.json()) as WhamUsageResponse;
    const result = {
      email: data.email ?? null,
      plan: data.plan_type ?? null,
      quota: parseUsageQuota(data),
      ts: Date.now(),
    };
    mainAccountCache = result;
    return result;
  } catch {
    return { email: null, plan: null, quota: null };
  }
}

interface PoolQuotaResult {
  quota: StoredAccountQuota | null;
  needsReauth: boolean;
}

async function fetchPoolAccountQuota(accountId: string, forceRefresh = false): Promise<PoolQuotaResult> {
  const existing = getAccountQuota(accountId);
  if (!forceRefresh && existing && Date.now() - existing.updatedAt < POOL_CACHE_TTL) {
    return { quota: existing, needsReauth: false };
  }
  try {
    const { accessToken, chatgptAccountId } = await getValidCodexToken(accountId);
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": chatgptAccountId },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { quota: existing ?? null, needsReauth: resp.status === 401 };
    const data = (await resp.json()) as WhamUsageResponse;
    const quota = parseUsageQuota(data);
    if (!quota) return { quota: existing ?? null, needsReauth: false };
    updateAccountQuota(
      accountId,
      quota.weeklyPercent,
      quota.fiveHourPercent,
      quota.weeklyResetAt,
      quota.fiveHourResetAt,
      quota.monthlyPercent,
      quota.monthlyResetAt,
    );
    return { quota: getAccountQuota(accountId), needsReauth: false };
  } catch (e) {
    if (e instanceof CodexCredentialGenerationConflictError) return { quota: existing ?? null, needsReauth: false };
    if (e instanceof TokenRefreshError) return { quota: existing ?? null, needsReauth: true };
    return { quota: existing ?? null, needsReauth: false };
  }
}

export async function handleCodexAuthAPI(
  req: Request,
  url: URL,
  config: OcxConfig,
): Promise<Response | null> {

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    const runtimeConfig = getRuntimeConfig(config);
    const poolAccounts = (runtimeConfig.codexAccounts ?? []).filter(a => !a.isMain);
    const mainInfo = await fetchMainAccountInfo(forceRefresh);
    const withQuota = await mapWithConcurrency(poolAccounts, POOL_QUOTA_REFRESH_CONCURRENCY, async a => {
      const cred = getCodexAccountCredential(a.id);
      const quotaResult = cred
        ? await fetchPoolAccountQuota(a.id, forceRefresh)
        : { quota: null, needsReauth: true };
      return {
        ...a,
        quota: quotaResult.quota ? { ...quotaResult.quota } : null,
        needsReauth: !cred || quotaResult.needsReauth || isAccountNeedsReauth(a.id),
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
    const collision = checkAccountIdCollision(derivedAccountId, body.email);
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
    const runtimeConfig = getRuntimeConfig(config);
    const accounts = runtimeConfig.codexAccounts ?? [];
    if (!accounts.find(a => a.id === body.id)) {
      accounts.push({ id: body.id, email: body.email, plan: body.plan, isMain: false });
      runtimeConfig.codexAccounts = accounts;
      saveRuntimeConfig(config, runtimeConfig);
    }
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Missing id" }, 400);
    const runtimeConfig = getRuntimeConfig(config);
    deleteCodexAccount(runtimeConfig, id);
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "PUT") {
    let body: { accountId: string | null };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    const runtimeConfig = getRuntimeConfig(config);
    if (body.accountId != null) {
      const exists = (runtimeConfig.codexAccounts ?? []).some(a => a.id === body.accountId);
      if (!exists) return jsonResponse({ error: "Account not found" }, 400);
    }
    runtimeConfig.activeCodexAccountId = body.accountId ?? undefined;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true, activeCodexAccountId: body.accountId });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "GET") {
    const runtimeConfig = getRuntimeConfig(config);
    return jsonResponse({
      activeCodexAccountId: runtimeConfig.activeCodexAccountId ?? null,
      autoSwitchThreshold: runtimeConfig.autoSwitchThreshold ?? 80,
      upstreamFailoverThreshold: runtimeConfig.upstreamFailoverThreshold ?? 3,
    });
  }

  if (url.pathname === "/api/codex-auth/auto-switch" && req.method === "PUT") {
    let body: { threshold: number };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof body.threshold !== "number" || !Number.isInteger(body.threshold) || body.threshold < 0 || body.threshold > 100) {
      return jsonResponse({ error: "Threshold must be an integer 0-100" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    runtimeConfig.autoSwitchThreshold = body.threshold;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/failover" && req.method === "PUT") {
    let body: { threshold: number };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof body.threshold !== "number" || !Number.isInteger(body.threshold) || body.threshold < 0 || body.threshold > 20) {
      return jsonResponse({ error: "Threshold must be an integer 0-20" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    runtimeConfig.upstreamFailoverThreshold = body.threshold;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/codex-auth/quota" && req.method === "GET") {
    const quotas: Record<string, unknown> = {};
    for (const [id, q] of listAccountQuotas()) quotas[id] = q;
    return jsonResponse({ quotas });
  }

  if (url.pathname === "/api/codex-auth/login" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    const requestedAccountId = body.id?.trim();
    if (requestedAccountId && !ACCOUNT_ID_RE.test(requestedAccountId)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    const accountId = requestedAccountId || `chatgpt-${Date.now()}`;
    const runtimeConfig = getRuntimeConfig(config);
    if ((runtimeConfig.codexAccounts ?? []).some(a => a.id === accountId) || getCodexAccountCredential(accountId)) {
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
              const collision = checkAccountIdCollision(oauthAccountId, cred.email);
              if (collision.collision) {
                codexAuthLoginState.set(flowId, {
                  status: "error", error: collision.reason, doneAt: Date.now(),
                });
                completed = true;
                break;
              }

              let email = cred.email || accountId;
              let plan: string | undefined;
              let quota: Omit<StoredAccountQuota, "updatedAt"> | null = null;
              try {
                const tokens = { access_token: cred.access, account_id: oauthAccountId };
                const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
                  headers: { Authorization: `Bearer ${tokens.access_token}`, "ChatGPT-Account-Id": tokens.account_id },
                  signal: AbortSignal.timeout(8000),
                });
                if (resp.ok) {
                  const data = (await resp.json()) as WhamUsageResponse;
                  email = data.email ?? email;
                  plan = data.plan_type ?? undefined;
                  quota = parseUsageQuota(data);
                }
              } catch { /* wham fetch is non-blocking */ }

              saveCodexAccountCredential(accountId, {
                accessToken: cred.access,
                refreshToken: cred.refresh,
                expiresAt: cred.expires,
                chatgptAccountId: oauthAccountId,
              });
              clearAccountNeedsReauth(accountId);
              if (quota) {
                updateAccountQuota(
                  accountId,
                  quota.weeklyPercent,
                  quota.fiveHourPercent,
                  quota.weeklyResetAt,
                  quota.fiveHourResetAt,
                  quota.monthlyPercent,
                  quota.monthlyResetAt,
                );
              }

              const latestConfig = getRuntimeConfig(config);
              const accounts = latestConfig.codexAccounts ?? [];
              if (!accounts.find(a => a.id === accountId)) {
                accounts.push({ id: accountId, email, plan, isMain: false });
                latestConfig.codexAccounts = accounts;
                saveRuntimeConfig(config, latestConfig);
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

  if (url.pathname === "/api/codex-auth/login/cancel" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { flowId?: string };
    const { cancelLoginFlow } = await import("./oauth/index");
    const cancelled = cancelLoginFlow("chatgpt");
    expireCodexAuthFlow(body.flowId ?? null);
    return jsonResponse({ ok: true, cancelled });
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
