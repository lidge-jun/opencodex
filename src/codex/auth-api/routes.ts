import { CODEX_ACCOUNT_LOG_LABEL_RE, codexAccountLogLabel } from "../account-label";
import { poolQuotaHistoryIdentity, readCodexAccountRecord } from "../account-store";
import { estimateCodexQuotaCapacity, insufficientCodexCapacity } from "../quota-capacity";
import type { CodexCapacityResult } from "../quota-capacity";
import { readUsageSnapshotForManagement } from "../../usage/log";
import { getAccountQuotaHistory, listAccountQuotas } from "../quota";
import { deleteCodexAccount } from "../account-lifecycle";
import { isCodexAccountPaused, setCodexAccountPaused } from "../account-pause";
import { clearCodexAccountPin, isCodexAccountPriorityKey, pinnedCodexAccountId, setCodexAccountPin, setCodexAccountPriority } from "../account-priority";
import { codexAccountPinDrainReason, codexQuotaScopeForModel, clearCodexAccountCooldown, clearThreadAccountMapForAccount, getEffectiveActiveCodexAccountId, isEffectiveCodexAccountPinned, resetCodexRoutingForManualSelection } from "../routing";
import { DEFAULT_ACCOUNT_PRIORITY, MAX_ACCOUNT_PRIORITY, MIN_ACCOUNT_PRIORITY, normalizeAccountPoolStickyLimit, normalizeCodexAccountPoolStrategy, parseAccountPoolStickyLimit, parseCodexAccountPoolStrategy, parseAccountPriority } from "../pool-rotation";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import type { OcxConfig } from "../../types";
import { CODEX_ACCOUNT_ID_RE, hasLegacyMainCodexPoolAccount, isSelectableCodexPoolAccount, isValidCodexAccountId } from "../account-id";
import { isCodexResetCreditOperationId } from "../reset-credit-recovery";
import { listCodexAuthAccounts, selectFallbackAfterPause, pauseExhaustedCodexAccounts } from "./account-list";
import { jsonResponse, manualImportDisabledResponse } from "./http";
import { convergeAccountNamespaceCatalog, handleCodexAuthLoginStart, handleCodexAuthLoginCode, handleCodexAuthLoginCancel, handleCodexAuthLoginStatus } from "./login-flow";
import type { CodexAuthCatalogConvergence } from "./login-flow";
import { PoolQuotaProbeBusyError } from "./pool-quota-probe";
import { inspectResetCredits, consumeResetCredits } from "./reset-credit-service";
import { getRuntimeConfig, saveRuntimeConfig, configuredPoolAccount } from "./runtime-config";
import { captureConfigTopLevelRollback } from "../../config/rebase-provenance";
import { getEffectiveCodexAutoSwitchThreshold, isCodexAccountAutoSwitchThresholdKey, parseCodexAutoSwitchThreshold, setCodexAccountAutoSwitchThresholdOverride } from "../account-auto-switch";

export async function handleCodexAuthAPI(
  req: Request,
  url: URL,
  config: OcxConfig,
  convergeCodexCatalog?: CodexAuthCatalogConvergence,
  principal?: import("../../server/management-auth").ManagementPrincipal,
): Promise<Response | null> {
  if (url.pathname === "/api/codex-auth/accounts" && req.method === "GET") {
    const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
    return jsonResponse({ accounts: await listCodexAuthAccounts(config, forceRefresh) });
  }

  if (url.pathname === "/api/codex-auth/accounts/refresh" && req.method === "POST") {
    // Inference spends quota: only a dashboard session carries the consent
    // required by AGENTS_INSTALL.md. Raw-admin/CLI refreshes remain observational.
    return jsonResponse({ accounts: await listCodexAuthAccounts(config, true, {
      validatePending: principal === "gui-session",
    }) });
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "POST") {
    return manualImportDisabledResponse();
  }

  if (url.pathname === "/api/codex-auth/accounts" && req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "Missing id" }, 400);
    const runtimeConfig = getRuntimeConfig(config);
    const isLegacyPoolAccount = CODEX_ACCOUNT_ID_RE.test(id)
      && (runtimeConfig.codexAccounts ?? []).some(account => !account.isMain && account.id === id);
    if (!isValidCodexAccountId(id) && !isLegacyPoolAccount) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    const pickerVisibilityChanged = deleteCodexAccount(runtimeConfig, id);
    saveRuntimeConfig(config, runtimeConfig);
    reconcileLiveStateStores();
    const catalogRefresh = await convergeAccountNamespaceCatalog(
      runtimeConfig,
      pickerVisibilityChanged,
      convergeCodexCatalog,
    );
    return jsonResponse({ ok: true, ...catalogRefresh });
  }

  if (url.pathname === "/api/codex-auth/accounts/alias" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { id?: unknown; alias?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const alias = typeof body.alias === "string" ? body.alias.trim() : "";
    if (id === MAIN_CODEX_ACCOUNT_ID) return jsonResponse({ error: "Main Codex account alias is not configurable" }, 400);
    if (!isValidCodexAccountId(id)) return jsonResponse({ error: "Invalid account id format" }, 400);
    if (typeof body.alias !== "string" || alias.length > 80 || /[\x00-\x1f\x7f]/.test(alias)) {
      return jsonResponse({ error: "Alias must be a string of at most 80 printable characters" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    const account = (runtimeConfig.codexAccounts ?? []).find(candidate => candidate.id === id && !candidate.isMain);
    if (!account) return jsonResponse({ error: "Account not found" }, 404);
    if (alias) account.alias = alias;
    else delete account.alias;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true, id, alias: alias || null });
  }

  if (url.pathname === "/api/codex-auth/accounts/pause" && req.method === "PUT") {
    const body = await req.json().catch(() => ({})) as { id?: unknown; paused?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (id !== MAIN_CODEX_ACCOUNT_ID && !isValidCodexAccountId(id)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    if (typeof body.paused !== "boolean") return jsonResponse({ error: "paused must be a boolean" }, 400);

    const runtimeConfig = getRuntimeConfig(config);
    const exists = id === MAIN_CODEX_ACCOUNT_ID
      || (runtimeConfig.codexAccounts ?? []).some(account => isSelectableCodexPoolAccount(account) && account.id === id);
    if (!exists) return jsonResponse({ error: "Account not found" }, 404);

    setCodexAccountPaused(runtimeConfig, id, body.paused);
    if (body.paused) {
      clearThreadAccountMapForAccount(id);
      selectFallbackAfterPause(runtimeConfig, id);
    }
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({
      ok: true,
      id,
      paused: body.paused,
      activeCodexAccountId: getEffectiveActiveCodexAccountId(runtimeConfig) ?? null,
      appliesImmediately: true,
    });
  }

  // Deliberately a route of its own rather than a field on the alias PATCH: aliases
  // are display-only and reject __main__, while selection order is routing metadata
  // that the Desktop account must be able to carry. Re-ordering never kicks a live
  // thread, so there is no affinity clearing and no appliesImmediately here.
  if (url.pathname === "/api/codex-auth/accounts/priority" && req.method === "PUT") {
    let parsedBody: unknown;
    try { parsedBody = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
      return jsonResponse({ error: "body must be an object" }, 400);
    }
    const body = parsedBody as { id?: unknown; priority?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!isCodexAccountPriorityKey(id)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }

    let priority = DEFAULT_ACCOUNT_PRIORITY;
    if (body.priority !== null) {
      const parsed = parseAccountPriority(body.priority);
      if (parsed === null) {
        return jsonResponse({
          error: `priority must be null or an integer ${MIN_ACCOUNT_PRIORITY}-${MAX_ACCOUNT_PRIORITY}`,
        }, 400);
      }
      priority = parsed;
    }

    const runtimeConfig = getRuntimeConfig(config);
    const exists = id === MAIN_CODEX_ACCOUNT_ID
      || (runtimeConfig.codexAccounts ?? []).some(account => isSelectableCodexPoolAccount(account) && account.id === id);
    if (!exists) return jsonResponse({ error: "Account not found" }, 404);

    setCodexAccountPriority(runtimeConfig, id, priority);
    // Both a pin and an order are the operator saying which account to use, so the newer
    // statement wins. Without this a pin made before any order existed — an ordinary
    // account switch — would outrank the order forever: it blocks preemption and caps
    // every eligibility list at its own tier until that account drains or is paused.
    clearCodexAccountPin(runtimeConfig);
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({
      ok: true,
      id,
      priority,
      activeCodexAccountId: getEffectiveActiveCodexAccountId(runtimeConfig) ?? null,
    });
  }

  if (url.pathname === "/api/codex-auth/accounts/pause-exhausted" && req.method === "PUT") {
    const runtimeConfig = getRuntimeConfig(config);
    const result = await pauseExhaustedCodexAccounts(
      runtimeConfig,
      () => saveRuntimeConfig(config, runtimeConfig),
    );
    const { pausedAccountIds, checkedAccountCount, failedAccountCount } = result;
    if (checkedAccountCount === 0 && failedAccountCount > 0) {
      return jsonResponse({
        ok: false,
        error: "Failed to refresh any Codex account quota",
        checkedAccountCount,
        failedAccountCount,
      }, 502);
    }
    return jsonResponse({
      ok: true,
      pausedAccountIds,
      pausedCount: pausedAccountIds.length,
      checkedAccountCount,
      failedAccountCount,
      complete: failedAccountCount === 0,
      activeCodexAccountId: getEffectiveActiveCodexAccountId(runtimeConfig) ?? null,
      appliesImmediately: true,
    });
  }

  // Manual escape from a quota cooldown. Injected Codex routing makes this proxy the only
  // model path for Codex Desktop, so a cooldown that outlives the real upstream limit
  // otherwise leaves editing config.toml as the user's only recovery.
  //
  // Existence is deliberately NOT disclosed: an unknown id returns 200 with cleared:false
  // exactly like an account that simply had no live cooldown, so this route cannot be used
  // to enumerate configured accounts. Cooldown state is runtime-only and independent of the
  // account list, so 404 would carry no useful meaning anyway.
  if (url.pathname === "/api/codex-auth/accounts/clear-cooldown" && req.method === "POST") {
    const body = await req.json().catch(() => ({})) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (id !== MAIN_CODEX_ACCOUNT_ID && !isValidCodexAccountId(id)) {
      return jsonResponse({ error: "Invalid account id format" }, 400);
    }
    return jsonResponse({ ok: true, id, cleared: clearCodexAccountCooldown(id) });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "PUT") {
    let body: { accountId: string | null };
    try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    const runtimeConfig = getRuntimeConfig(config);
    const targetAccountId = body.accountId ?? MAIN_CODEX_ACCOUNT_ID;
    if (body.accountId === MAIN_CODEX_ACCOUNT_ID && hasLegacyMainCodexPoolAccount(runtimeConfig.codexAccounts)) {
      return jsonResponse({ error: "Remove the legacy __main__ pool row before selecting the Desktop account" }, 409);
    }
    if (isCodexAccountPaused(runtimeConfig, targetAccountId)) {
      return jsonResponse({ error: "Account is paused" }, 409);
    }
    if (body.accountId != null && body.accountId !== MAIN_CODEX_ACCOUNT_ID) {
      if (!isValidCodexAccountId(body.accountId)) return jsonResponse({ error: "Invalid account id format" }, 400);
      const exists = (runtimeConfig.codexAccounts ?? [])
        .some(account => isSelectableCodexPoolAccount(account) && account.id === body.accountId);
      if (!exists) return jsonResponse({ error: "Account not found" }, 400);
      if (readCodexAccountRecord(body.accountId)?.codexValidationPending) {
        return jsonResponse({ error: "Account validation is pending. Refresh quota after recovery to validate it." }, 409);
      }
    }
    runtimeConfig.activeCodexAccountId = body.accountId ?? undefined;
    // "Use this account now" outranks selection order until the account is spent:
    // persisted here rather than in resetCodexRoutingForManualSelection, which is
    // runtime state only. A null id clears the selection instead of making one, so it
    // must release the pin rather than record one: pinning the `targetAccountId`
    // fallback would leave a pin that no effective active account matches, which
    // `isEffectiveCodexAccountPinned` reports as unpinned while the tier filter still
    // honours it as a ceiling — invisibly capping the pool at the main account's tier.
    if (body.accountId == null) clearCodexAccountPin(runtimeConfig);
    else setCodexAccountPin(runtimeConfig, targetAccountId);
    resetCodexRoutingForManualSelection(targetAccountId);
    saveRuntimeConfig(config, runtimeConfig);
    // A pin this route accepts can still be dropped by the very next resolve, and saying
    // nothing about that is what made the setting look ignored (#4521). The checks above
    // refuse an account that cannot be selected at all; this reports the one remaining
    // outcome they do not cover, from the same predicate routing releases on, so the two
    // cannot drift. Absent means the pin survives — additive for existing clients.
    // `appliesImmediately` is unchanged: it answers whether thread affinity was cleared,
    // not whether the pin is durable.
    const pinDrainReason = body.accountId == null
      ? undefined
      : codexAccountPinDrainReason(runtimeConfig, targetAccountId);
    return jsonResponse({
      ok: true,
      activeCodexAccountId: body.accountId,
      appliesImmediately: true,
      ...(pinDrainReason !== undefined ? { pinDrained: true, pinDrainReason } : {}),
    });
  }

  if (url.pathname === "/api/codex-auth/active" && req.method === "GET") {
    const runtimeConfig = getRuntimeConfig(config);
    return jsonResponse({
      activeCodexAccountId: getEffectiveActiveCodexAccountId(runtimeConfig) ?? null,
      pinned: isEffectiveCodexAccountPinned(runtimeConfig),
      // Which account carries the pin, not just whether the active one does. Under
      // round-robin or fill-first the pin caps the tier ceiling at its own tier while the
      // strategy cursor moves freely inside that tier, so `pinned` alone goes false on a
      // sibling's turn even though the pin is still suppressing every higher tier. The id
      // lets a surface mark the account the operator actually chose.
      pinnedAccountId: pinnedCodexAccountId(runtimeConfig) ?? null,
      autoSwitchThreshold: runtimeConfig.autoSwitchThreshold ?? 80,
      upstreamFailoverThreshold: runtimeConfig.upstreamFailoverThreshold ?? 3,
      accountPoolStrategy: normalizeCodexAccountPoolStrategy(runtimeConfig.accountPoolStrategy),
      accountPoolStickyLimit: normalizeAccountPoolStickyLimit(runtimeConfig.accountPoolStickyLimit),
    });
  }

  if (url.pathname === "/api/codex-auth/auto-switch" && req.method === "PUT") {
    let parsedBody: unknown;
    try { parsedBody = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
      return jsonResponse({ error: "body must be an object" }, 400);
    }
    const body = parsedBody as { id?: unknown; threshold?: unknown };
    const runtimeConfig = getRuntimeConfig(config);
    if (Object.hasOwn(body, "id")) {
      if (!isCodexAccountAutoSwitchThresholdKey(body.id)) {
        return jsonResponse({ error: "id must be a Codex account id" }, 400);
      }
      const threshold = body.threshold === null ? null : parseCodexAutoSwitchThreshold(body.threshold);
      if (body.threshold !== null && threshold === null) {
        return jsonResponse({ error: "threshold must be null or an integer 0-100" }, 400);
      }
      if (body.id !== MAIN_CODEX_ACCOUNT_ID && !configuredPoolAccount(runtimeConfig, body.id)) {
        return jsonResponse({ error: "Codex account not found" }, 404);
      }
      const rollback = captureConfigTopLevelRollback(runtimeConfig, ["codexAccountAutoSwitchThresholds"]);
      try {
        // Inheritance resets delete children in place; keep the previous map intact for rollback.
        if (runtimeConfig.codexAccountAutoSwitchThresholds) {
          runtimeConfig.codexAccountAutoSwitchThresholds = { ...runtimeConfig.codexAccountAutoSwitchThresholds };
        }
        setCodexAccountAutoSwitchThresholdOverride(runtimeConfig, body.id, threshold);
        saveRuntimeConfig(config, runtimeConfig);
      } catch (error) {
        rollback();
        throw error;
      }
      return jsonResponse({
        ok: true,
        id: body.id,
        autoSwitchThresholdOverride: threshold,
        autoSwitchThreshold: getEffectiveCodexAutoSwitchThreshold(runtimeConfig, body.id),
      });
    }
    if (typeof body.threshold !== "number" || !Number.isInteger(body.threshold) || body.threshold < 0 || body.threshold > 100) {
      return jsonResponse({ error: "Threshold must be an integer 0-100" }, 400);
    }
    runtimeConfig.autoSwitchThreshold = body.threshold;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({ ok: true });
  }

  if (
    url.pathname === "/api/codex-auth/pool-strategy"
    && (req.method === "PUT" || req.method === "PATCH")
  ) {
    let parsedBody: unknown;
    try { parsedBody = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }
    if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
      return jsonResponse({ error: "body must be an object" }, 400);
    }
    const body = parsedBody as { strategy?: unknown; stickyLimit?: unknown };
    if (body.strategy === undefined && body.stickyLimit === undefined) {
      return jsonResponse({ error: "strategy or stickyLimit required" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    let nextStrategy: NonNullable<ReturnType<typeof parseCodexAccountPoolStrategy>> | undefined;
    let nextSticky: NonNullable<ReturnType<typeof parseAccountPoolStickyLimit>> | undefined;
    if (body.strategy !== undefined) {
      const parsed = parseCodexAccountPoolStrategy(body.strategy);
      if (parsed === null) {
        return jsonResponse({ error: 'strategy must be one of: quota, round-robin, fill-first, reset-first' }, 400);
      }
      nextStrategy = parsed;
    }
    if (body.stickyLimit !== undefined) {
      const parsed = parseAccountPoolStickyLimit(body.stickyLimit);
      if (parsed === null) {
        return jsonResponse({ error: "stickyLimit must be an integer 1-100" }, 400);
      }
      nextSticky = parsed;
    }
    if (nextStrategy !== undefined) runtimeConfig.accountPoolStrategy = nextStrategy;
    if (nextSticky !== undefined) runtimeConfig.accountPoolStickyLimit = nextSticky;
    saveRuntimeConfig(config, runtimeConfig);
    return jsonResponse({
      ok: true,
      accountPoolStrategy: normalizeCodexAccountPoolStrategy(runtimeConfig.accountPoolStrategy),
      accountPoolStickyLimit: normalizeAccountPoolStickyLimit(runtimeConfig.accountPoolStickyLimit),
    });
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

  if (url.pathname === "/api/codex-auth/quota/history" && req.method === "GET") {
    const accountId = url.searchParams.get("accountId");
    const rawLimit = url.searchParams.get("limit");
    if (url.searchParams.getAll("accountId").length !== 1 || !isValidCodexAccountId(accountId)
      || url.searchParams.getAll("limit").length > 1
      || [...url.searchParams.keys()].some(key => key !== "accountId" && key !== "limit")
      || (rawLimit !== null && !/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(rawLimit))) {
      return jsonResponse({ error: "A stored pool accountId and optional limit from 1 to 200 are required" }, 400);
    }
    const runtimeConfig = getRuntimeConfig(config);
    const account = configuredPoolAccount(runtimeConfig, accountId);
    if (!account) return jsonResponse({ error: "Unknown pool account" }, 404);
    const identity = poolQuotaHistoryIdentity(accountId);
    const allHistory = getAccountQuotaHistory(accountId);
    const limit = rawLimit === null ? 200 : Number(rawLimit);
    const history = { ...allHistory, observations: allHistory.observations.slice(-limit), truncated: allHistory.observations.length > limit };
    const label = account.logLabel;
    const labelStillUnique = () => {
      const current = getRuntimeConfig(config);
      return configuredPoolAccount(current, accountId)?.logLabel === label
        && current.codexAccounts?.filter(row => codexAccountLogLabel(row) === label).length === 1;
    };
    let capacity: CodexCapacityResult = insufficientCodexCapacity("identity_unavailable");
    if (identity && identity === poolQuotaHistoryIdentity(accountId) && label && CODEX_ACCOUNT_LOG_LABEL_RE.test(label) && labelStillUnique()) {
      try {
        const usage = await readUsageSnapshotForManagement();
        if (poolQuotaHistoryIdentity(accountId) !== identity || !labelStillUnique()) capacity = insufficientCodexCapacity("identity_changed");
        else if (!usage.revision) capacity = insufficientCodexCapacity("ledger_unavailable");
        else if (usage.truncatedPrefixBytes > 0 || usage.entriesTruncated || usage.entriesDropped > 0) capacity = insufficientCodexCapacity("ledger_truncated");
        else capacity = estimateCodexQuotaCapacity(allHistory.observations, usage.entries, label,
          model => codexQuotaScopeForModel(model) === "shared");
      } catch { capacity = insufficientCodexCapacity("ledger_unavailable"); }
    }
    if (!configuredPoolAccount(getRuntimeConfig(config), accountId)) return jsonResponse({ error: "Unknown pool account" }, 404);
    if (identity !== poolQuotaHistoryIdentity(accountId) || (identity && label && !labelStillUnique())) {
      return jsonResponse({ accountId, ...getAccountQuotaHistory(accountId, limit), capacity: insufficientCodexCapacity("identity_changed") });
    }
    return jsonResponse({ accountId, ...history, capacity });
  }

  if (url.pathname === "/api/codex-auth/quota" && req.method === "GET") {
    const quotas: Record<string, unknown> = {};
    for (const [id, q] of listAccountQuotas()) quotas[id] = q;
    return jsonResponse({ quotas });
  }

  if (url.pathname === "/api/codex-auth/reset-credits" && req.method === "GET") {
    const accountId = url.searchParams.get("accountId");
    if (!accountId) return jsonResponse({ error: "accountId required" }, 400);

    try {
      return await inspectResetCredits(config, accountId, req.signal);
    } catch (e) {
      return jsonResponse({ error: e instanceof Error ? e.message : "Reset credit lookup failed" }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/reset-credits/consume" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      accountId?: string;
      operationId?: unknown;
    };
    if (!body.accountId) return jsonResponse({ error: "accountId required" }, 400);
    const accountId = body.accountId;
    // Optional caller-owned idempotency identity (#3375 axis D). Absent => legacy
    // behavior: a fresh random redeem_request_id and no durable ledger row.
    // The ledger throws TypeError on a malformed id, so the format check has to
    // happen here rather than at the call site, or it surfaces as a 500.
    const hasOperationId = body.operationId !== undefined;
    if (hasOperationId && !isCodexResetCreditOperationId(body.operationId)) {
      return jsonResponse({ error: "Invalid operationId format" }, 400);
    }
    const requestedOperationId = hasOperationId ? body.operationId as string : undefined;
    try {
      return await consumeResetCredits(config, accountId, requestedOperationId);
    } catch (e) {
      if (e instanceof PoolQuotaProbeBusyError) {
        const response = jsonResponse({ error: "server_busy", code: "server_busy" }, 503);
        response.headers.set("Retry-After", "1");
        return response;
      }
      return jsonResponse({ error: e instanceof Error ? e.message : "Reset credit consume failed" }, 500);
    }
  }

  if (url.pathname === "/api/codex-auth/login" && req.method === "POST") {
    return handleCodexAuthLoginStart(req, config, convergeCodexCatalog);
  }

  if (url.pathname === "/api/codex-auth/login/code" && req.method === "POST") {
    return handleCodexAuthLoginCode(req);
  }

  if (url.pathname === "/api/codex-auth/login/cancel" && req.method === "POST") {
    return handleCodexAuthLoginCancel(req);
  }

  if (url.pathname === "/api/codex-auth/login-status" && req.method === "GET") {
    return handleCodexAuthLoginStatus(req, url, config);
  }

  return null;
}
