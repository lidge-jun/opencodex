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
  saveConfigPreservingClaudeCode,
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
import { executeArchivedCleanup, listTrashEntries, pickWireCleanupTestHooks, previewArchivedCleanup, type CleanupMode, type RestoreErrorCode } from "../../storage/cleanup";
import { runArchivedCleanupJob } from "../../storage/cleanup-job";
import { getRestoreTrashTestStreamResponse, runRestoreTrashEntryJob } from "../../storage/restore-job";
import {
  normalizeStorageCleanupPolicy,
  parseStorageCleanupPolicyInput,
  writeStorageCleanupPolicyToConfig,
} from "../../storage/policy";
import {
  getStorageCleanupPolicyJobState,
  getStorageCleanupPolicyTestStreamResponse,
  requestStorageCleanupPolicyRun,
} from "../../storage/policy-job";
import {
  currentUsageLogRevision,
  readUsageSnapshotForManagement,
  usageLogIdentityKey,
  usageLogRevisionKey,
  type PersistedUsageEntry,
} from "../../usage/log";
import { getUsageDebugLogEntries } from "../../usage/debug";
import { parseRange, parseUsageSurface, rangeWindow, summarizeUsage, type UsageRange, type UsageSummary, type UsageSurface } from "../../usage/summary";
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
import { filterRequestLogs, filteredRequestLogCount, getRequestLogEntries, type RequestLogEntry } from "../request-log";
import { estimateComboCost, estimateRequestCost, normalizeCostTokens, tokensPerSecond } from "../../usage/cost";
import { userCostOverlayVersion } from "../../usage/user-cost-overlays";
import type { PersistedUsageAttempt } from "../../usage/log";
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "../auth-cors";
import { applySystemEnvToggle } from "../system-env";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import type { ManagementContext } from "./context";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import {
  discardUsageSummaryCacheEntry,
  getUsageSummaryCacheEntry,
  setUsageSummaryCacheEntry,
} from "./usage-summary-cache";
import { cacheApiKeyUsageFromSnapshot } from "./api-key-usage";

function nextLocalMidnight(now: number): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

function usageSummaryExpiresAt(
  _entries: PersistedUsageEntry[],
  _range: UsageRange,
  _surface: UsageSurface,
  now: number,
): number {
  return nextLocalMidnight(now);
}

function refreshedUsageSummary<T extends UsageSummary & { historyTruncated: boolean }>(summary: T, range: UsageRange, now: number): T {
  const { since } = rangeWindow(range, now);
  return { ...summary, since, generatedAt: now };
}

/**
 * Timestamp bounds of the rows the bounded reader actually loaded.
 *
 * Deliberately computed over the whole snapshot, BEFORE `summarizeUsage` applies the range
 * and surface predicates: truncation is a property of the read, not of the query, so the
 * window that matters to a client is the one the reader could see. It is not a completeness
 * claim and must never be presented as one. `usage.jsonl` is appended when a request
 * COMPLETES while each row carries the request START time, so a long-running request can be
 * appended after shorter ones that started later — meaning the oldest loaded timestamp does
 * not bound what the dropped prefix contains (#1497).
 */
function snapshotWindow(entries: PersistedUsageEntry[]): { start: number | null; end: number | null } {
  let start: number | null = null;
  let end: number | null = null;
  for (const entry of entries) {
    const at = entry.timestamp;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (start === null || at < start) start = at;
    if (end === null || at > end) end = at;
  }
  return { start, end };
}

export async function handleLogsUsageRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, syncClaudeAgentDefsBestEffort } = ctx;

  if (url.pathname === "/api/logs" && req.method === "GET") {
    const all = getRequestLogEntries();
    const total = filteredRequestLogCount(all, url.searchParams);
    const logs = filterRequestLogs(all, url.searchParams);
    return jsonResponse({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      total,
      logs: logs.map(requestLogDto),
    });
  }

  if (url.pathname === "/api/debug" && req.method === "GET") {
    return jsonResponse(getDebugSettings());
  }

  if (url.pathname === "/api/debug/logs" && req.method === "GET") {
    const { after, limit } = parseDebugLogQuery(url);
    return jsonResponse(getDebugLogEntries({ after, limit }));
  }

  if (url.pathname === "/api/debug/usage-logs" && req.method === "GET") {
    const { after, limit } = parseDebugLogQuery(url);
    return jsonResponse(getUsageDebugLogEntries({ after, limit }));
  }

  if (url.pathname === "/api/claude/inbound-debug" && req.method === "GET") {
    const { getClaudeInboundDebugEntries } = await import("../../claude/inbound-debug");
    const { isClaudeDebugEnabled } = await import("../../lib/debug-settings");
    return jsonResponse({ enabled: isClaudeDebugEnabled(), entries: getClaudeInboundDebugEntries() });
  }

  if (url.pathname === "/api/debug/injection-logs" && req.method === "GET") {
    const { after, limit } = parseDebugLogQuery(url);
    return jsonResponse(getInjectionDebugLogEntries({ after, limit }));
  }

  if (url.pathname === "/api/debug" && req.method === "PUT") {
    let body: { debug?: unknown; usage?: unknown; injection?: unknown; claude?: unknown; reset?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (body.reset === true) return jsonResponse(clearDebugSettings());
    if (body.reset === "debug" || body.reset === "provider") return jsonResponse(clearDebugSetting("debug"));
    if (body.reset === "usage") return jsonResponse(clearDebugSetting("usage"));
    if (body.reset === "injection") return jsonResponse(clearDebugSetting("injection"));
    if (body.reset === "claude") return jsonResponse(clearDebugSetting("claude"));
    const partial: Partial<Record<DebugFlag, boolean>> = {};
    for (const key of ["debug", "usage", "injection", "claude"] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== "boolean") return jsonResponse({ error: `${key} must be a boolean` }, 400);
      partial[key] = body[key];
    }
    if (Object.keys(partial).length === 0) {
      return jsonResponse({ error: "provide debug/usage/injection/claude booleans or reset:true" }, 400);
    }
    // Turning capture off should also flush already-captured entries (privacy contract).
    if (partial.claude === false) {
      const { clearClaudeInboundDebug } = await import("../../claude/inbound-debug");
      clearClaudeInboundDebug();
    }
    return jsonResponse(setDebugSettings(partial));
  }

  if (url.pathname === "/api/usage" && req.method === "GET") {
    const range = parseRange(url.searchParams.get("range"));
    const surface = parseUsageSurface(url.searchParams.get("surface"));
    const now = Date.now();
    try {
      const cacheKey = `${range}:${surface}`;
      const effectiveReadLimit = config.managementUsageMaxReadBytes ?? 64 * 1024 * 1024;
      const observed = currentUsageLogRevision();
      const identityKey = `${usageLogIdentityKey(observed)}\0${effectiveReadLimit}`;
      const observedSize = observed?.size ?? 0;
      const cached = getUsageSummaryCacheEntry(cacheKey);
      if (cached
        && cached.identityKey === identityKey
        && cached.maxReadBytes === effectiveReadLimit
        && cached.overlayVersion === userCostOverlayVersion()
        && now < cached.freshUntil
        && now < cached.expiresAt
        && observedSize >= cached.lastSeenSize) {
        return jsonResponse(refreshedUsageSummary(cached.summary, range, now));
      }
      if (cached) discardUsageSummaryCacheEntry(cacheKey);
      // Capture the overlay version BEFORE reading/computing: the cache entry
      // must be stamped with the version the summary was priced under. Reading
      // it again at stamp time could cache an old-price summary as current,
      // and the next request would then accept stale pricing for the whole
      // cache lifetime.
      const overlayVersion = userCostOverlayVersion();
      const snapshot = await readUsageSnapshotForManagement(effectiveReadLimit);
      const revisionReadAt = Date.now();
      const window = snapshotWindow(snapshot.entries);
      const summary = {
        ...summarizeUsage(snapshot.entries, range, now, surface),
        historyTruncated: snapshot.truncatedPrefixBytes > 0 || snapshot.entriesTruncated,
        truncatedPrefixBytes: snapshot.truncatedPrefixBytes,
        entriesTruncated: snapshot.entriesTruncated,
        entriesDropped: snapshot.entriesDropped,
        snapshotWindowStart: window.start,
        snapshotWindowEnd: window.end,
      };
      if (userCostOverlayVersion() !== overlayVersion) {
        // The overlay changed while the summary was being computed, so this
        // summary may mix old and new prices. Serve it uncached: the next
        // request recomputes against the settled overlay instead of caching a
        // mixed-price entry under either version.
        return jsonResponse(summary);
      }
      const freshUntil = now + 60_000;
      const snapshotIdentity = `${usageLogIdentityKey(snapshot.revision)}\0${effectiveReadLimit}`;
      const revisionKey = `${usageLogRevisionKey(snapshot.revision)}\0${effectiveReadLimit}`;
      const lastSeenSize = snapshot.revision?.size ?? 0;
      const ranges: UsageRange[] = ["7d", "30d", "all"];
      const surfaces: UsageSurface[] = ["all", "codex", "claude", "grok"];
      for (const nextRange of ranges) {
        for (const nextSurface of surfaces) {
          const nextSummary = nextRange === range && nextSurface === surface ? summary : {
            ...summarizeUsage(snapshot.entries, nextRange, now, nextSurface),
            historyTruncated: summary.historyTruncated,
            truncatedPrefixBytes: summary.truncatedPrefixBytes,
            entriesTruncated: summary.entriesTruncated,
            entriesDropped: summary.entriesDropped,
            snapshotWindowStart: summary.snapshotWindowStart,
            snapshotWindowEnd: summary.snapshotWindowEnd,
          };
          setUsageSummaryCacheEntry(`${nextRange}:${nextSurface}`, {
            revisionKey,
            identityKey: snapshotIdentity,
            maxReadBytes: effectiveReadLimit,
            overlayVersion,
            expiresAt: usageSummaryExpiresAt(snapshot.entries, nextRange, nextSurface, now),
            freshUntil,
            lastSeenSize,
            revisionReadAt,
            summary: nextSummary,
          });
        }
      }
      cacheApiKeyUsageFromSnapshot(
        snapshot.entries,
        (config.apiKeys ?? []).map(key => key.id),
        usageLogIdentityKey(snapshot.revision),
        snapshot.revision?.size ?? 0,
        snapshot.truncatedPrefixBytes > 0 || snapshot.entriesTruncated,
        effectiveReadLimit,
        now,
      );
      return jsonResponse(summary);
    } catch {
      return jsonResponse({
        range,
        surface,
        since: null,
        generatedAt: now,
        summary: {
          requests: 0,
          attemptCount: 0,
          measuredRequests: 0,
          reportedRequests: 0,
          unreportedRequests: 0,
          unsupportedRequests: 0,
          estimatedRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          coverageRatio: 0,
          estimatedCostUsd: 0,
          pricedRequests: 0,
          unpricedRequests: 0,
          unmeteredRequests: 0,
        },
        days: [],
        models: [],
        providers: [],
        accounts: [],
        historyTruncated: false,
        truncatedPrefixBytes: 0,
        entriesTruncated: false,
        entriesDropped: 0,
        snapshotWindowStart: null,
        snapshotWindowEnd: null,
        error: "read_failed",
      });
    }
  }

  if (url.pathname === "/api/storage" && req.method === "GET") {
    try {
      return jsonResponse(scanStorage());
    } catch {
      return jsonResponse({
        codexHome: resolveCodexHomeDir(),
        generatedAt: Date.now(),
        total: { bytes: 0, fileCount: 0 },
        buckets: [],
        error: "scan_failed",
      });
    }
  }

  if (url.pathname === "/api/storage/cleanup/preview" && req.method === "POST") {
    let body: { percent?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid_json" }, 400); }
    const percent = typeof body?.percent === "number" ? body.percent : Number.NaN;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return jsonResponse({ error: "invalid_percent" }, 400);
    }
    const preview = previewArchivedCleanup(percent);
    // Omit absolute host paths (codexHome / absPath) from the wire response.
    return jsonResponse({
      percent: preview.percent,
      count: preview.count,
      bytes: preview.bytes,
      digest: preview.digest,
      // Dashboard only lists a handful; count/bytes/digest already bind the full set.
      candidates: preview.candidates.slice(0, 50).map(({ relPath, bytes, mtimeMs, physicalRelPaths }) => ({
        relPath,
        bytes,
        mtimeMs,
        physicalRelPaths,
      })),
    });
  }

  if (url.pathname === "/api/storage/cleanup" && req.method === "POST") {
    let body: { percent?: unknown; mode?: unknown; digest?: unknown; _test?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid_json" }, 400); }
    const percent = typeof body?.percent === "number" ? body.percent : Number.NaN;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return jsonResponse({ error: "invalid_percent" }, 400);
    }
    const mode = body?.mode;
    if (mode !== "quarantine" && mode !== "permanent") {
      return jsonResponse({ error: "invalid_mode" }, 400);
    }
    const digest = typeof body?.digest === "string" ? body.digest : "";
    const testHooks =
      process.env.OPENCODEX_CLEANUP_TEST_HOOKS === "1" &&
      body &&
      typeof body === "object" &&
      "_test" in body
        ? pickWireCleanupTestHooks(body._test)
        : undefined;
    try {
      const result = await runArchivedCleanupJob({
        percent,
        mode: mode as CleanupMode,
        digest,
        ...(testHooks ? { _test: testHooks } : {}),
      });
      if (!result.ok) {
        const status =
          result.error === "codex_busy"
            || result.error === "stale_preview"
            || result.error === "referenced_history"
            || result.error === "pinned_thread"
            || result.error === "storage_mutation_busy"
            || result.error === "restore_pending_overlap"
            ? 409
            : result.error === "invalid_mode" || result.error === "invalid_digest"
              ? 400
              : 500;
        const messages: Record<string, string> = {
          codex_busy: "Codex is using state.sqlite — try again after quitting Codex.",
          storage_mutation_busy: "Another storage cleanup or restore is in progress — try again shortly.",
          stale_preview: "Archived files changed since preview — run Preview again.",
          restore_pending_overlap: "Selected archives overlap an incomplete trash restore — finish or retry restore first.",
          referenced_history: "Selected archives are still referenced by forked or paginated history.",
          pinned_thread: "Selected archives include a pinned thread — unpin it in Codex before cleanup.",
          invalid_digest: "Preview digest is missing or invalid.",
          invalid_mode: "mode must be quarantine or permanent.",
          fs_failed: "Filesystem cleanup failed. Some changes may already be applied — check CODEX_HOME/.trash and any recovery path in the response.",
          db_reconcile_failed: "Could not update Codex state database.",
          cleanup_failed: "Cleanup failed.",
        };
        return jsonResponse({
          ok: false,
          error: result.error ?? "cleanup_failed",
          message: messages[result.error ?? ""] ?? messages.cleanup_failed,
          ...(result.trashDir ? { trashDir: result.trashDir } : {}),
        }, status);
      }
      return jsonResponse({
        ok: true,
        mode: result.mode,
        percent: result.percent,
        count: result.count,
        bytes: result.bytes,
        ...(result.trashDir ? { trashDir: result.trashDir } : {}),
        removedPaths: result.removedPaths,
      });
    } catch {
      return jsonResponse({
        ok: false,
        error: "cleanup_failed",
        message: "Cleanup failed.",
      }, 500);
    }
  }

  if (url.pathname === "/api/storage/trash" && req.method === "GET") {
    try {
      const entries = listTrashEntries();
      return jsonResponse({
        entries: entries.map(({ id, epoch, fileCount, bytes, quarantinedAt, mode }) => ({
          id,
          epoch,
          fileCount,
          bytes,
          ...(quarantinedAt !== undefined ? { quarantinedAt } : {}),
          ...(mode ? { mode } : {}),
        })),
      });
    } catch {
      return jsonResponse({ error: "trash_list_failed", entries: [] }, 500);
    }
  }

  if (url.pathname === "/api/storage/trash/restore/test-stream" && req.method === "GET") {
    if (process.env.OPENCODEX_CLEANUP_TEST_HOOKS === "1") {
      const stream = getRestoreTrashTestStreamResponse();
      if (stream) return stream;
    }
    // Always answer this test-only path — never fall through to the GUI SPA (200 HTML).
    return jsonResponse({ error: "not_available" }, 404);
  }

  if (url.pathname === "/api/storage/trash/restore" && req.method === "POST") {
    let body: { id?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid_json" }, 400); }
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id.trim()) {
      return jsonResponse({ error: "invalid_trash", message: "Trash entry id is required." }, 400);
    }
    try {
      const result = await runRestoreTrashEntryJob(id);
      if (!result.ok) {
        const status =
          result.error === "codex_busy"
            || result.error === "dest_exists"
            || result.error === "storage_mutation_busy"
            ? 409
            : result.error === "missing_trash"
              ? 404
              : result.error === "invalid_trash"
                ? 400
                : 500;
        const messages: Record<RestoreErrorCode, string> = {
          invalid_trash: "Trash entry id is missing or invalid.",
          missing_trash: "Trash entry was not found.",
          codex_busy: "Codex is using state.sqlite — try again after quitting Codex.",
          storage_mutation_busy: "Another storage cleanup or restore is in progress — try again shortly.",
          dest_exists: "Restore destination already exists — remove or rename the archived file and retry.",
          fs_failed: "Filesystem restore failed. Some files may already be restored — check archived_sessions and .trash.",
          db_reconcile_failed: "Could not restore Codex state database rows.",
          restore_failed: "Restore failed.",
          restore_worker_timeout: "Restore took too long (over 10 minutes) and was stopped.",
          restore_worker_aborted: "Restore was cancelled during shutdown.",
          restore_worker_failed: "Restore worker crashed or failed unexpectedly.",
        };
        const errorCode = result.error ?? "restore_failed";
        const baseMessage = messages[errorCode] ?? messages.restore_failed;
        const message =
          result.message && errorCode === "restore_worker_failed"
            ? `${baseMessage} (${result.message})`
            : baseMessage;
        return jsonResponse({
          ok: false,
          error: errorCode,
          message,
          count: result.count,
          bytes: result.bytes,
          restoredPaths: result.restoredPaths,
          ...(result.trashDir ? { trashDir: result.trashDir } : {}),
        }, status);
      }
      return jsonResponse({
        ok: true,
        trashDir: result.trashDir,
        count: result.count,
        bytes: result.bytes,
        restoredPaths: result.restoredPaths,
      });
    } catch {
      return jsonResponse({
        ok: false,
        error: "restore_failed",
        message: "Restore failed.",
      }, 500);
    }
  }

  if (url.pathname === "/api/storage/cleanup-policy/test-stream" && req.method === "GET") {
    const stream = getStorageCleanupPolicyTestStreamResponse();
    if (stream) return stream;
    // Production: hook is off. Return an explicit JSON 404 — do not fall through to the GUI.
    return jsonResponse({ error: "not_found" }, 404);
  }

  if (url.pathname === "/api/storage/cleanup-policy" && req.method === "GET") {
    const policy = normalizeStorageCleanupPolicy(config.storageCleanupPolicy);
    return jsonResponse({
      ...policy,
      job: getStorageCleanupPolicyJobState(),
    });
  }

  if (url.pathname === "/api/storage/cleanup-policy" && req.method === "PUT") {
    let raw: unknown;
    try { raw = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid_json" }, 400); }
    const previous = normalizeStorageCleanupPolicy(config.storageCleanupPolicy);
    const parsed = parseStorageCleanupPolicyInput(raw, previous);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);
    // Never enable implicitly: if client omitted enabled, keep previous (default false).
    const body = raw as Record<string, unknown>;
    if (body.enabled === undefined) parsed.policy.enabled = previous.enabled;
    const saved = writeStorageCleanupPolicyToConfig(parsed.policy);
    config.storageCleanupPolicy = saved;
    return jsonResponse({ ok: true, policy: saved, job: getStorageCleanupPolicyJobState() });
  }

  if (url.pathname === "/api/storage/cleanup-policy/run" && req.method === "POST") {
    try {
      const accepted = requestStorageCleanupPolicyRun({ reason: "manual", force: true });
      if (!accepted.accepted) {
        return jsonResponse({
          ok: false,
          started: false,
          error: "already_running",
          message: "A cleanup policy run is already in progress.",
          job: accepted.state,
          policy: normalizeStorageCleanupPolicy(config.storageCleanupPolicy),
        }, 409);
      }
      // Return promptly — clients poll GET for skip/defer/success/error outcomes.
      return jsonResponse({
        ok: true,
        started: true,
        job: accepted.state,
        policy: normalizeStorageCleanupPolicy(config.storageCleanupPolicy),
      });
    } catch {
      return jsonResponse({ ok: false, error: "cleanup_failed" }, 500);
    }
  }

  return null;
}
