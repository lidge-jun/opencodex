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
  readConfigDiagnostics,
  reconcileLiveConfigFromDisk,
  saveConfigPreservingClaudeCode,
} from "../../config";
import {
  clearLoginState,
  getLoginStatus,
  isPublicOAuthProvider,
  listOAuthProviders,
  startLoginFlow,
  submitManualLoginCode,
} from "../../oauth";
import { removeCredential } from "../../oauth/store";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../../oauth/key-providers";
import { deriveProviderPresets } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderAccountQuotas, fetchProviderQuotaReports, supportsPerAccountQuota } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import {
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimit,
  parseAccountPoolStrategy,
} from "../../codex/pool-rotation";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
import { resolveCodexHomeDir } from "../../codex/home";
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
import { codexAccountNamespaceProviderCollisionError } from "../../codex/account-namespace-match";

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
    const namespaceCollision = codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, provider);
    if (namespaceCollision) return jsonResponse({ error: namespaceCollision }, 409);
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
      // Use persisted state, not the live object, as the merge base: another management
      // request may already have mutated live config and yielded before its save.
      const persistedBaseline = readConfigDiagnostics().config;
      // addAccount / reauth forces a fresh browser identity (skips local-CLI token import).
      const { url: authUrl, instructions, deviceCode } = await startLoginFlow(provider, {
        forceLogin: body.addAccount === true || reauth,
        ...(accountId ? { reauthAccountId: accountId } : {}),
      }, {
        // startLoginFlow returns the authorization URL before background persistence completes.
        // Three-way reconcile settled disk changes so a failed login cannot leave a provider
        // live-only and an in-flight management mutation cannot be erased before it saves.
        onSettled: () => reconcileLiveConfigFromDisk(config, persistedBaseline),
      });
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
    const { clearProviderQuotaCache, clearAccountQuotaCache } = await import("../../providers/quota");
    clearProviderQuotaCache();
    clearAccountQuotaCache(provider);
    return jsonResponse({ success: true });
  }

  // Multiauth account management: list a provider's logged-in accounts, switch the active
  // one, or remove one. Emails are masked; tokens never leave the store.
  if (url.pathname === "/api/oauth/accounts" && req.method === "GET") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    const status = getLoginStatus(provider);
    const { getAccountSet } = await import("../../oauth/store");
    const {
      oauthAccountHealthFields,
      projectOAuthAccountHealth,
      projectStoredOAuthAccountHealth,
    } = await import("../../oauth/health");
    const projectAccounts = () => {
      const set = getAccountSet(provider);
      const current = getLoginStatus(provider);
      return {
        activeAccountId: current.activeAccountId ?? null,
        accounts: (current.accounts ?? []).map(summary => {
          const full = set?.accounts.find(account => account.id === summary.id);
          const health = full
            ? projectStoredOAuthAccountHealth(provider, full)
            : projectOAuthAccountHealth({
              needsReauth: summary.needsReauth === true,
              reauthReason: summary.needsReauth === true ? "refresh_failed" : undefined,
            });
          return { ...summary, ...oauthAccountHealthFields(provider, summary.id, health) };
        }),
      };
    };
    // Per-account rate limits: Anthropic reports usage per credential, so every logged-in
    // account can show its own 5h/weekly bars (not just the active one). Opt-in via ?quota=1
    // so the plain account list stays a cheap local read; ?refresh=1 bypasses the TTL.
    const wantQuota = url.searchParams.get("quota") === "1" && supportsPerAccountQuota(provider);
    if (!wantQuota) return jsonResponse(projectAccounts());
    const forceRefresh = url.searchParams.get("refresh") === "1";
    // Probing may refresh the active credential and mark needsReauth — project health
    // from the post-probe store so the response is not stale.
    const rows = await fetchProviderAccountQuotas(provider, forceRefresh);
    const byId = new Map(rows.map(row => [row.accountId, row]));
    const projected = projectAccounts();
    return jsonResponse({
      activeAccountId: projected.activeAccountId,
      accounts: projected.accounts.map(account => {
        const row = byId.get(account.id);
        if (!row) return account;
        return {
          ...account,
          quota: row.quota,
          ...(row.unavailable ? { quotaUnavailable: true } : {}),
        };
      }),
    });
  }
  if (url.pathname === "/api/oauth/accounts/active" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { provider?: string; accountId?: string };
    const provider = (body.provider ?? "").trim().toLowerCase();
    if (!isPublicOAuthProvider(provider)) return jsonResponse({ error: "unknown oauth provider" }, 400);
    if (!body.accountId) return jsonResponse({ error: "missing accountId" }, 400);
    const { setActiveAccount } = await import("../../oauth/store");
    if (!(await setActiveAccount(provider, body.accountId))) return jsonResponse({ error: "account not found" }, 404);
    if (provider === "anthropic") {
      const { resetAnthropicRoutingForManualSelection } = await import("../../oauth/anthropic-routing");
      resetAnthropicRoutingForManualSelection(body.accountId);
    }
    const { clearProviderQuotaCache } = await import("../../providers/quota");
    clearProviderQuotaCache();
    return jsonResponse({ ok: true, provider, activeAccountId: body.accountId });
  }

  // Opt-in Anthropic OAuth account pool (#294): enable/threshold/strategy + clear cooldown.
  if (url.pathname === "/api/oauth/accounts/pool" && req.method === "GET") {
    const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();
    if (provider !== "anthropic") return jsonResponse({ error: "pool config is only supported for anthropic" }, 400);
    const pool = config.anthropicAccountPool ?? {};
    return jsonResponse({
      provider,
      enabled: pool.enabled === true,
      autoSwitchThreshold: typeof pool.autoSwitchThreshold === "number" ? pool.autoSwitchThreshold : 80,
      strategy: normalizeAccountPoolStrategy(pool.strategy),
      stickyLimit: normalizeAccountPoolStickyLimit(pool.stickyLimit),
      experimental: true,
    });
  }
  if (url.pathname === "/api/oauth/accounts/pool" && (req.method === "PUT" || req.method === "PATCH")) {
    const parsedBody = await req.json().catch(() => ({}));
    if (!isPlainRecord(parsedBody)) {
      return jsonResponse({ error: "body must be an object" }, 400);
    }
    const body = parsedBody as {
      provider?: unknown;
      enabled?: unknown;
      autoSwitchThreshold?: unknown;
      strategy?: unknown;
      stickyLimit?: unknown;
    };
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    if (provider !== "anthropic") return jsonResponse({ error: "pool config is only supported for anthropic" }, 400);
    let enabled = config.anthropicAccountPool?.enabled === true;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return jsonResponse({ error: "enabled must be a boolean" }, 400);
      enabled = body.enabled;
    }
    let threshold = config.anthropicAccountPool?.autoSwitchThreshold ?? 80;
    if (body.autoSwitchThreshold !== undefined) {
      if (
        typeof body.autoSwitchThreshold !== "number"
        || !Number.isInteger(body.autoSwitchThreshold)
        || body.autoSwitchThreshold < 0
        || body.autoSwitchThreshold > 100
      ) {
        return jsonResponse({ error: "autoSwitchThreshold must be an integer 0-100" }, 400);
      }
      threshold = body.autoSwitchThreshold;
    }
    let strategy = config.anthropicAccountPool?.strategy;
    if (body.strategy !== undefined) {
      const parsed = parseAccountPoolStrategy(body.strategy);
      if (parsed === null) {
        return jsonResponse({ error: "strategy must be one of: quota, round-robin, fill-first" }, 400);
      }
      strategy = parsed;
    }
    let stickyLimit = config.anthropicAccountPool?.stickyLimit;
    if (body.stickyLimit !== undefined) {
      const parsed = parseAccountPoolStickyLimit(body.stickyLimit);
      if (parsed === null) {
        return jsonResponse({ error: "stickyLimit must be an integer 1-100" }, 400);
      }
      stickyLimit = parsed;
    }
    config.anthropicAccountPool = {
      enabled,
      autoSwitchThreshold: threshold,
      ...(strategy !== undefined ? { strategy } : {}),
      ...(stickyLimit !== undefined ? { stickyLimit } : {}),
    };
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({
      ok: true,
      provider,
      enabled,
      autoSwitchThreshold: threshold,
      strategy: normalizeAccountPoolStrategy(strategy),
      stickyLimit: normalizeAccountPoolStickyLimit(stickyLimit),
      experimental: true,
    });
  }
  if (url.pathname === "/api/oauth/accounts/clear-cooldown" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { provider?: unknown; accountId?: unknown };
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
    if (provider !== "anthropic") return jsonResponse({ error: "clear-cooldown is only supported for anthropic" }, 400);
    if (!accountId) return jsonResponse({ error: "missing accountId" }, 400);
    const { clearAnthropicAccountCooldown } = await import("../../oauth/anthropic-routing");
    const cleared = clearAnthropicAccountCooldown(accountId);
    return jsonResponse({ ok: true, cleared });
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
    if (provider === "anthropic") {
      const { clearAnthropicAccountCooldown, clearAnthropicSessionAffinityForAccount } = await import("../../oauth/anthropic-routing");
      clearAnthropicAccountCooldown(id);
      clearAnthropicSessionAffinityForAccount(id);
    }
    if (!getAccountSet(provider)) clearLoginState(provider);
    const { clearProviderQuotaCache, clearAccountQuotaCache } = await import("../../providers/quota");
    clearProviderQuotaCache();
    clearAccountQuotaCache(provider);
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
    const endpoints = buildApiAccessEndpoints(config, {
      requestUrl: req.url,
      requestHost: req.headers.get("host"),
      requestOrigin: req.headers.get("origin"),
    });
    return jsonResponse({
      keys: keys.map(k => ({ id: k.id, name: k.name, prefix: k.key.slice(0, 8) + "...", createdAt: k.createdAt })),
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
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({ id: entry.id, name: entry.name, key: entry.key, createdAt: entry.createdAt }, 201, req, config);
  }

  if (url.pathname === "/api/keys" && req.method === "DELETE") {
    const body = await req.json() as { id?: string };
    if (!body.id) return jsonResponse({ error: "id required" }, 400, req, config);
    config.apiKeys = (config.apiKeys ?? []).filter(k => k.id !== body.id);
    saveConfigPreservingClaudeCode(config);
    return jsonResponse({ success: true }, 200, req, config);
  }
  return null;
}
