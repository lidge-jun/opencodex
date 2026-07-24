import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogModel } from "../../codex/catalog";
import { catalogModelSlug, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  multiAgentGuidanceEnabled,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfig,
} from "../../config";
import {
  clearLoginState,
  getLoginStatus,
  isPublicOAuthProvider,
  listOAuthProviders,
  startLoginFlow,
  submitManualLoginCode,
  upsertOAuthProvider,
} from "../../oauth";
import { removeCredential } from "../../oauth/store";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../../oauth/key-providers";
import { deriveProviderPresets } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
import { resolveCodexHomeDir } from "../../codex/home";
import { scanStorage } from "../../storage/scanner";
import { readUsageEntries } from "../../usage/log";
import { getUsageDebugLogEntries } from "../../usage/debug";
import { parseRange, parseUsageSurface, summarizeUsage } from "../../usage/summary";
import { stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import { getProviderRegistryEntry } from "../../providers/registry";
import { getDebugLogEntries } from "../../lib/debug-log-buffer";
import { getInjectionDebugLogEntries } from "../../lib/injection-debug-log";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  setDebugSettings,
  type DebugFlag,
} from "../../lib/debug-settings";
import type { OcxClaudeCodeConfig, OcxConfig, OcxCustomModel, OcxProviderConfig } from "../../types";
import { drainAndShutdown } from "../lifecycle";
import { filterRequestLogs, getRequestLogEntries, type RequestLogEntry } from "../request-log";
import { estimateComboCost, estimateRequestCost, normalizeCostTokens, tokensPerSecond } from "../../usage/cost";
import type { PersistedUsageAttempt } from "../../usage/log";
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "../auth-cors";
import { applySystemEnvToggle } from "../system-env";
import { buildApiAccessEndpoints } from "./api-access";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import type { ManagementContext } from "./context";

export async function handleOauthAccountRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, refreshCodexCatalogBestEffort, syncClaudeAgentDefsBestEffort } = ctx;

  // Which providers support real OAuth login (drives the GUI's "Log in with …" buttons).
  if (url.pathname === "/api/oauth/providers" && req.method === "GET") {
    return jsonResponse({ providers: listOAuthProviders() });
  }

  // API-key "login" providers (open dashboard → paste key). Drives the GUI's key-provider picker.
  if (url.pathname === "/api/key-providers" && req.method === "GET") {
    return jsonResponse({ providers: listKeyLoginProviders() });
  }

  // OAuth login (xai now; anthropic/kimi in cycle 2). Starts the flow and returns the auth URL;
  // the provider's loopback callback server (inside this process) captures the redirect in the
  // background, then the credential is persisted. The GUI opens the URL and polls /api/oauth/status.
  if (url.pathname === "/api/oauth/login" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { provider?: string; addAccount?: boolean; accountId?: string; reauth?: boolean };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    const accountId = body.accountId?.trim();
    const reauth = body.reauth === true || Boolean(accountId);
    try {
      if (accountId) {
        const { getAccountSet } = await import("../../oauth/store");
        const set = getAccountSet(provider);
        if (!set?.accounts.some(a => a.id === accountId)) {
          return jsonResponse({ error: "Unknown account for reauth" }, 404);
        }
      }
      // addAccount / reauth forces a fresh browser identity (skips local-CLI token import).
      const { url: authUrl, instructions, deviceCode } = await startLoginFlow(provider, {
        forceLogin: body.addAccount === true || reauth,
        ...(accountId ? { reauthAccountId: accountId } : {}),
      });
      upsertOAuthProvider(config, provider); // mutate LIVE config — routing sees it without restart
      if (authUrl && !deviceCode) {
        // Open the browser server-side (the proxy runs on the user's machine) — the GUI's
        // window.open is popup-blocked because it runs after an await, not a direct click.
        const { openUrl } = await import("../../lib/open-url");
        openUrl(authUrl);
      }
      return jsonResponse({ url: authUrl, instructions, deviceCode });
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  }

  // Cancel an in-progress browser/device OAuth login (GUI "Cancel" / modal close). Guarded by
  // the same public predicate as /api/oauth/login — only publicly startable flows are cancellable.
  if (url.pathname === "/api/oauth/login/cancel" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { provider?: string };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    const { cancelLoginFlow } = await import("../../oauth");
    const cancelled = cancelLoginFlow(provider);
    return jsonResponse({ ok: true, cancelled });
  }

  // Manual fallback for browser OAuth: paste the final redirect URL (or authorization code)
  // when the browser cannot reach the loopback callback (remote/SSH/blocked localhost).
  if (url.pathname === "/api/oauth/login/code" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { provider?: string; input?: string; code?: string };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    const input = typeof body.input === "string" ? body.input : typeof body.code === "string" ? body.code : "";
    // Authorization responses are measured in hundreds of bytes; never accept the
    // generic management-body allowance here.
    if (input.length > 4096) return jsonResponse({ error: "input too long" }, 400);
    const result = submitManualLoginCode(provider, input);
    if (!result.ok) return jsonResponse({ error: result.error }, 409);
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/oauth/status" && req.method === "GET") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    return jsonResponse(getLoginStatus(provider));
  }

  if (url.pathname === "/api/oauth/logout" && req.method === "POST") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    await removeCredential(provider);
    clearLoginState(provider);
    // Drop cached/last-good quota rows tied to the removed credential.
    const { clearProviderQuotaCache } = await import("../../providers/quota");
    clearProviderQuotaCache();
    return jsonResponse({ success: true });
  }

  // Multiauth account management: list a provider's logged-in accounts, switch the active
  // one, or remove one. Emails are masked; tokens never leave the store.
  if (url.pathname === "/api/oauth/accounts" && req.method === "GET") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    const status = getLoginStatus(provider);
    return jsonResponse({ activeAccountId: status.activeAccountId ?? null, accounts: status.accounts ?? [] });
  }
  if (url.pathname === "/api/oauth/accounts/active" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { provider?: string; accountId?: string };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    if (!body.accountId) return jsonResponse({ error: "missing accountId" }, 400);
    const { setActiveAccount } = await import("../../oauth/store");
    if (!(await setActiveAccount(provider, body.accountId))) return jsonResponse({ error: "account not found" }, 404);
    const { clearProviderQuotaCache } = await import("../../providers/quota");
    clearProviderQuotaCache();
    return jsonResponse({ ok: true, provider, activeAccountId: body.accountId });
  }
  if (url.pathname === "/api/oauth/accounts/alias" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { provider?: unknown; accountId?: unknown; alias?: unknown };
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
    const alias = typeof body.alias === "string" ? body.alias.trim() : "";
    if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    if (!accountId) return jsonResponse({ error: "missing accountId" }, 400);
    if (typeof body.alias !== "string" || alias.length > 80 || /[\x00-\x1f\x7f]/.test(alias)) {
      return jsonResponse({ error: "alias must be at most 80 printable characters" }, 400);
    }
    const { setAccountAlias } = await import("../../oauth/store");
    if (!(await setAccountAlias(provider, accountId, alias || undefined))) return jsonResponse({ error: "account not found" }, 404);
    return jsonResponse({ ok: true, provider, accountId, alias: alias || null });
  }
  if (url.pathname === "/api/oauth/accounts" && req.method === "DELETE") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    const id = url.searchParams.get("id") ?? "";
    if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    if (!id) return jsonResponse({ error: "missing id" }, 400);
    const { removeAccount, getAccountSet } = await import("../../oauth/store");
    if (!(await removeAccount(provider, id))) return jsonResponse({ error: "account not found" }, 404);
    if (!getAccountSet(provider)) clearLoginState(provider);
    const { clearProviderQuotaCache } = await import("../../providers/quota");
    clearProviderQuotaCache();
    return jsonResponse({ ok: true });
  }

  // Multi-key pool for API-key providers (same GUI dropdown as OAuth multiauth): list masked
  // keys, add one (upserts + activates), switch the active key, or remove one. `apiKey` always
  // mirrors the active entry so routing is untouched.
  if (url.pathname === "/api/providers/keys" && req.method === "GET") {
    const name = (url.searchParams.get("name") ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    const { listProviderApiKeys } = await import("../../providers/api-keys");
    return jsonResponse(listProviderApiKeys(config, name));
  }
  if (url.pathname === "/api/providers/keys" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { name?: string; key?: string; label?: string };
    const name = (body.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (typeof body.key !== "string" || !body.key.trim()) return jsonResponse({ error: "key is required" }, 400);
    const { addProviderApiKey } = await import("../../providers/api-keys");
    const result = addProviderApiKey(config, name, body.key, body.label);
    if ("error" in result) return jsonResponse({ error: result.error }, 400);
    const { clearModelCache } = await import("../../codex/model-cache");
    clearModelCache(name);
    const { clearProviderQuotaCache } = await import("../../providers/quota");
    clearProviderQuotaCache();
    const { clearKeyCooldowns } = await import("../../providers/key-failover");
    clearKeyCooldowns(name); // manual key management resets 429 cooldown state
    return jsonResponse({ ok: true, id: result.id }, 201);
  }
  if (url.pathname === "/api/providers/keys/active" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { name?: string; id?: string };
    const name = (body.name ?? "").trim();
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (!body.id) return jsonResponse({ error: "missing id" }, 400);
    const { setActiveProviderApiKey } = await import("../../providers/api-keys");
    if (!setActiveProviderApiKey(config, name, body.id)) return jsonResponse({ error: "key not found" }, 404);
    const { clearModelCache } = await import("../../codex/model-cache");
    clearModelCache(name);
    const { clearProviderQuotaCache } = await import("../../providers/quota");
    clearProviderQuotaCache();
    const { clearKeyCooldowns } = await import("../../providers/key-failover");
    clearKeyCooldowns(name); // manual key management resets 429 cooldown state
    return jsonResponse({ ok: true, name, activeId: body.id });
  }
  if (url.pathname === "/api/providers/keys/alias" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { name?: unknown; id?: unknown; alias?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const alias = typeof body.alias === "string" ? body.alias.trim() : "";
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (!id) return jsonResponse({ error: "missing id" }, 400);
    if (typeof body.alias !== "string" || alias.length > 80 || /[\x00-\x1f\x7f]/.test(alias)) {
      return jsonResponse({ error: "alias must be at most 80 printable characters" }, 400);
    }
    const { setProviderApiKeyLabel } = await import("../../providers/api-keys");
    if (!setProviderApiKeyLabel(config, name, id, alias || undefined)) return jsonResponse({ error: "key not found" }, 404);
    return jsonResponse({ ok: true, name, id, alias: alias || null });
  }
  if (url.pathname === "/api/providers/keys" && req.method === "DELETE") {
    const name = (url.searchParams.get("name") ?? "").trim();
    const id = url.searchParams.get("id") ?? "";
    if (!name || !isValidProviderName(name) || !hasOwnProvider(config.providers, name)) return jsonResponse({ error: "unknown provider" }, 404);
    if (!id) return jsonResponse({ error: "missing id" }, 400);
    const { removeProviderApiKey } = await import("../../providers/api-keys");
    if (!removeProviderApiKey(config, name, id)) return jsonResponse({ error: "key not found" }, 404);
    const { clearModelCache } = await import("../../codex/model-cache");
    clearModelCache(name);
    const { clearProviderQuotaCache } = await import("../../providers/quota");
    clearProviderQuotaCache();
    const { clearKeyCooldowns } = await import("../../providers/key-failover");
    clearKeyCooldowns(name); // manual key management resets 429 cooldown state
    return jsonResponse({ ok: true });
  }

  // ---------------------------------------------------------------------------
  // API Keys management
  // ---------------------------------------------------------------------------
  if (url.pathname === "/api/keys" && req.method === "GET") {
    const keys = config.apiKeys ?? [];
    const endpoints = buildApiAccessEndpoints(config);
    return jsonResponse({
      keys: keys.map(k => ({ id: k.id, name: k.name, prefix: k.key.slice(0, 8) + "...", createdAt: k.createdAt })),
      endpoint: endpoints.responsesEndpoint,
      ...endpoints,
    }, 200, req, config);
  }

  if (url.pathname === "/api/keys" && req.method === "POST") {
    const body = await req.json() as { name?: string };
    const name = (body.name ?? "").trim() || "default";
    // Generate key from provider keys hash + random salt
    const providerKeys = Object.values(config.providers).map(p => p.apiKey ?? "").filter(Boolean).join("|");
    const salt = crypto.randomUUID();
    const hashInput = `${providerKeys}|${salt}|${Date.now()}`;
    const hashBuf = new Bun.CryptoHasher("sha256").update(hashInput).digest();
    const key = "ocx_" + Buffer.from(hashBuf).toString("hex").slice(0, 40);
    const entry = { id: crypto.randomUUID(), name, key, createdAt: new Date().toISOString() };
    config.apiKeys = [...(config.apiKeys ?? []), entry];
    saveConfig(config);
    return jsonResponse({ id: entry.id, name: entry.name, key: entry.key, createdAt: entry.createdAt }, 201, req, config);
  }

  if (url.pathname === "/api/keys" && req.method === "DELETE") {
    const body = await req.json() as { id?: string };
    if (!body.id) return jsonResponse({ error: "id required" }, 400, req, config);
    config.apiKeys = (config.apiKeys ?? []).filter(k => k.id !== body.id);
    saveConfig(config);
    return jsonResponse({ success: true }, 200, req, config);
  }
  return null;
}
