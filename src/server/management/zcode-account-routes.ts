import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { accountProfile, accountRoot, allocateAccount, listAccounts, readAccount, reconcileAccountDrafts, removeAccountFiles, writeAccount } from "../../adapters/zcode/accounts";
import { accountRuntimeBusy, invalidateAccountRefresh } from "../../adapters/zcode/account-runtime";
import { connectDesktop, defaultDesktopWorkspace, desktopStatus, disconnectDesktop, isDefaultDesktopWorkspace, resolveDesktopRuntime, validateDesktopWorkspace } from "../../adapters/zcode/desktop";
import { runNativeOAuth } from "../../adapters/zcode/native-oauth";
import { saveConfigPreservingClaudeCode, withConfigMutationLockSync } from "../../config";
import { clearModelCache } from "../../codex/model-cache";
import { clearGatherRoutedModelsInflight } from "../../codex/catalog/provider-fetch";
import { reconcileLiveStateStores } from "../../lib/state-store-registrations";
import { jsonResponse } from "../auth-cors";
import { readBoundedJsonRequestBody } from "../request-decompress";
import { activateDesktopProvider, desktopActivation, readDesktopCatalogSlugs } from "./zcode-desktop-activation";
import type { ManagementContext } from "./context";
import type { OcxConfig } from "../../types/config";

type Job = { id: string; accountId: string; replaceId?: string; runtime: string; workspace: string;
  phase: "waiting" | "authenticated" | "completing" | "finished" | "failed";
  url?: string; task?: Promise<void>; identity?: string; error?: string; controller: AbortController; timer: ReturnType<typeof setTimeout> };
const jobs = new Map<string, Job>();
// A failed OAuth job still owns its hidden profile and account reservation until the user
// explicitly cancels it (or the bounded expiry removes it). This makes reconnect failure
// idempotent instead of allowing an unbounded stack of hidden drafts for the same account.
const pendingFor = (id: string) => [...jobs.values()].some(j => (j.accountId === id || j.replaceId === id) && j.phase !== "finished");
const safeJob = (job: Job) => ({ jobId: job.id, accountId: job.replaceId ?? job.accountId,
  phase: job.phase, ...(job.url ? { url: job.url } : {}), ...(job.error ? { error: job.error } : {}) });
const fail = (code: string): never => { throw new Error(code); };
function selectorUsesNamespace(value: string, providerNamespaces: ReadonlySet<string>, modelAliases: ReadonlySet<string>): boolean {
  const normalized = value.trim().toLowerCase();
  if (providerNamespaces.has(normalized) || modelAliases.has(normalized)) return true;
  const slash = normalized.indexOf("/");
  return slash > 0 && providerNamespaces.has(normalized.slice(0, slash));
}
function configReferencesNamespaces(config: OcxConfig, providerNamespaces: ReadonlySet<string>, modelAliases: ReadonlySet<string>): boolean {
  const uses = (value: unknown) => typeof value === "string"
    && selectorUsesNamespace(value, providerNamespaces, modelAliases);
  const usesProvider = (value: unknown) => typeof value === "string"
    && providerNamespaces.has(value.trim().toLowerCase());
  const usesAny = (values: readonly unknown[] | undefined) => values?.some(uses) === true;
  const claude = config.claudeCode;
  if (usesAny([
    config.injectionModel, config.shadowCallIntercept?.model,
    config.agentTaskRecovery?.model, config.tokenGuardian?.codexWarmupModel,
    config.webSearchSidecar?.model, config.visionSidecar?.model,
    claude?.model, claude?.smallFastModel, claude?.classifierModel,
    claude?.webSearchSidecar?.model, claude?.visionSidecar?.model,
  ])) return true;
  if (usesProvider(config.defaultProvider) || usesProvider(config.images?.provider)) return true;
  if ([config.disabledModels, config.subagentModels, config.modelPickerOrder,
    config.subagentModelFallback, claude?.classifierFallbacks, config.shadowCallIntercept?.sourceModels]
    .some(usesAny)) return true;
  if ([claude?.modelMap, claude?.tierModels]
    .some(record => usesAny(Object.values(record ?? {})))) return true;
  if (Object.entries(config.subagentModelFallbackByModel ?? {})
    .some(([model, fallbacks]) => uses(model) || usesAny(fallbacks))) return true;
  if (Object.entries(config.blockedModelRedirects ?? {})
    .some(([model, replacement]) => uses(model) || uses(replacement))) return true;
  if (Object.keys(config.modelPinnedEfforts ?? {}).some(uses)) return true;
  const desktopProfile = claude?.desktopProfile;
  if (usesAny(Object.keys(desktopProfile?.assignments ?? {}))
    || usesAny(Object.values(desktopProfile?.defaults ?? {}))) return true;
  if ((config.customModels ?? []).some(model => usesProvider(model.provider))) return true;
  if (Object.values(config.combos ?? {}).some(combo => combo.targets.some(target => usesProvider(target.provider)))) return true;
  if (Object.values(config.routingProfiles ?? {}).some(profile => profile.candidates.some(candidate => usesProvider(candidate.provider)))) return true;
  return Object.values(config.providers).some(provider => uses(provider.autoReviewModel)
    || usesAny(Object.values(provider.autoReviewModelOverrides ?? {})));
}
const safeErrors = new Set(["account_invalid", "account_limit", "account_busy", "account_referenced",
  "account_duplicate", "account_identity_mismatch", "account_login_required", "job_invalid", "native_oauth_failed",
  "desktop_missing", "workspace_invalid", "node_missing", "node_incompatible", "sandbox_missing", "sandbox_unavailable",
  "account_removal_partial", "catalog_update_failed", "provider_registration_failed", "runtime_failed", "models_missing",
  "platform_unsupported", "profile_missing", "connection_invalid", "busy"]);

const services = { connectDesktop, desktopStatus, disconnectDesktop, runNativeOAuth, resolveDesktopRuntime,
  validateDesktopWorkspace, accountRuntimeBusy, readDesktopCatalogSlugs };
export function resetZcodeAccountJobsForTests(): void {
  for (const job of jobs.values()) { job.controller.abort(); clearTimeout(job.timer); }
  jobs.clear();
}
export async function handleZcodeAccountRoutes(ctx: ManagementContext, deps = services): Promise<Response | null> {
  const { connectDesktop, desktopStatus, disconnectDesktop, runNativeOAuth, resolveDesktopRuntime,
    validateDesktopWorkspace, accountRuntimeBusy, readDesktopCatalogSlugs } = deps;
  const path = ctx.url.pathname;
  if (!path.startsWith("/api/zcode-accounts")) return null;
  // URLs and account operations belong to a real GUI principal, not data/admin-token callers.
  if (ctx.principal !== "gui-session") return jsonResponse({ error: "dashboard_required" }, 403);
  try {
    // Reconnect drafts are intentionally hidden and owned by in-memory jobs. A restart drops those
    // jobs, so reconcile before every authenticated account operation without touching active jobs.
    reconcileAccountDrafts(new Set([...jobs.values()].map(job => job.accountId)));
    if (path === "/api/zcode-accounts" && ctx.req.method === "GET") {
      const accounts = listAccounts();
      let sharedRuntimes: string[] | undefined;
      let catalogSlugs: string[] | undefined;
      let catalogReadable = true;
      try { catalogSlugs = readDesktopCatalogSlugs(); } catch { catalogReadable = false; }
      const readSharedCatalogSlugs = () => {
        if (!catalogReadable) throw new Error("catalog unavailable");
        return catalogSlugs ?? [];
      };
      return jsonResponse({ accounts: accounts.map(({ id, label }) => {
        const desktop = desktopStatus(id, sharedRuntimes);
        sharedRuntimes ??= desktop.runtimes;
        const status = desktopActivation(ctx, desktop, readSharedCatalogSlugs);
        return { id, label, connected: status.connected, activation: status.activation, providerName: status.providerName,
          busy: accountRuntimeBusy(id) || pendingFor(id) };
      }) });
    }
    if (path === "/api/zcode-accounts/login" && ctx.req.method === "GET") {
      const job = jobs.get(ctx.url.searchParams.get("jobId") ?? "");
      if (!job) return jsonResponse({ error: "job_invalid" }, 404);
      return jsonResponse(safeJob(job));
    }
    if (ctx.req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    const raw = await readBoundedJsonRequestBody(ctx.req, 12_000, undefined, { signal: AbortSignal.any([ctx.req.signal, AbortSignal.timeout(5000)]) });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return jsonResponse({ error: "invalid_request" }, 400);
    const body = raw as Record<string, unknown>;
    if (body.consent !== true) return jsonResponse({ error: "consent_required" }, 400);

    if (path === "/api/zcode-accounts/login") {
      if ([...jobs.values()].filter(job => job.phase !== "finished").length >= 8) return jsonResponse({ error: "account_busy" }, 409);
      if (typeof body.label !== "string" || typeof body.runtime !== "string" || typeof body.workspace !== "string") return fail("account_invalid");
      if (body.accountId !== undefined && typeof body.accountId !== "string") return fail("account_invalid");
      const replaceId = typeof body.accountId === "string" ? readAccount(body.accountId).id : undefined;
      const runtime = resolveDesktopRuntime(body.runtime);
      if (replaceId && (accountRuntimeBusy(replaceId) || pendingFor(replaceId))) return fail("account_busy");
      const account = allocateAccount(body.label, replaceId);
      const targetId = replaceId ?? account.id;
      let workspace: string;
      try {
        const requested = isDefaultDesktopWorkspace(body.workspace)
          ? defaultDesktopWorkspace(targetId) : body.workspace;
        // Validate against the account that connectDesktop will eventually use. In optional
        // sandbox mode the global managed workspace is not an account workspace.
        workspace = validateDesktopWorkspace(requested, targetId);
      } catch (error) {
        removeAccountFiles(account.id);
        throw error;
      }
      const job: Job = { id: randomUUID(), accountId: account.id, replaceId, runtime, workspace,
        phase: "waiting", controller: new AbortController(), timer: undefined! };
      job.timer = setTimeout(() => {
        if (job.phase === "completing") return;
        job.controller.abort(); jobs.delete(job.id);
        void job.task?.then(() => {
          if (!desktopStatus(job.accountId).connected && !readAccount(job.accountId).subjectHash) removeAccountFiles(job.accountId);
        }).catch(() => {});
      }, 10 * 60_000);
      job.timer.unref?.(); jobs.set(job.id, job);
      job.task = runNativeOAuth({ runtime, profileHome: accountProfile(account.id), mode: "login", signal: job.controller.signal,
        onEvent: event => {
          if (event.type === "authorization") job.url = event.url;
          if (event.type === "authenticated") job.identity = event.subjectHash;
          if (event.type === "error") job.error = event.code;
        } }).then(() => {
          delete job.url;
          if (!job.identity || job.controller.signal.aborted) throw new Error();
          job.phase = "authenticated";
        }).catch(() => { delete job.url; job.phase = "failed"; job.error ??= "native_oauth_failed"; });
      return jsonResponse(safeJob(job));
    }
    if (path === "/api/zcode-accounts/cancel") {
      const job = jobs.get(String(body.jobId));
      if (!job || job.phase === "completing") return fail("job_invalid");
      job.controller.abort(); await job.task; clearTimeout(job.timer); jobs.delete(job.id);
      if (!desktopStatus(job.accountId).connected) removeAccountFiles(job.accountId);
      return jsonResponse({ ok: true });
    }
    if (path === "/api/zcode-accounts/complete") {
      const job = jobs.get(String(body.jobId));
      if (!job || !job.identity || job.controller.signal.aborted || !["authenticated", "finished"].includes(job.phase)) return fail("job_invalid");
      if (job.phase === "finished") return jsonResponse(await activateDesktopProvider(ctx, desktopStatus(job.replaceId ?? job.accountId), readDesktopCatalogSlugs));
      if ([...jobs.values()].some(other => other.id !== job.id && other.phase === "completing" && other.identity === job.identity)) return fail("account_busy");
      const duplicate = listAccounts().find(a => a.subjectHash === job.identity && a.id !== job.accountId && a.id !== job.replaceId);
      if (duplicate) return jsonResponse({ error: "account_duplicate", accountId: duplicate.id }, 409);
      const id = job.replaceId ?? job.accountId;
      if (accountRuntimeBusy(id)) return fail("account_busy");
      if (job.replaceId && readAccount(id).subjectHash !== job.identity) return fail("account_identity_mismatch");
      job.phase = "completing";
      let backup: string | undefined;
      try {
        if (job.replaceId) {
          backup = join(accountRoot(id), "profile-previous-" + randomUUID());
          renameSync(accountProfile(id), backup);
          renameSync(accountProfile(job.accountId), accountProfile(id));
        }
        const status = await connectDesktop(job.runtime, job.workspace, id);
        const saved = readAccount(id);
        writeAccount({ id: saved.id, label: saved.label, subjectHash: job.identity });
        invalidateAccountRefresh(id);
        if (backup) { rmSync(backup, { recursive: true, force: true }); backup = undefined; removeAccountFiles(job.accountId); }
        job.phase = "finished"; clearGatherRoutedModelsInflight();
        return jsonResponse(await activateDesktopProvider(ctx, status, readDesktopCatalogSlugs));
      } catch (error) {
        if (backup && existsSync(backup)) {
          renameSync(accountProfile(id), accountProfile(job.accountId)); renameSync(backup, accountProfile(id));
        }
        job.phase = "authenticated"; throw error;
      }
    }
    const id = typeof body.accountId === "string" ? readAccount(body.accountId).id : fail("account_invalid");
    if (accountRuntimeBusy(id) || pendingFor(id)) return fail("account_busy");
    if (path === "/api/zcode-accounts/activate") return jsonResponse(await activateDesktopProvider(ctx, desktopStatus(id), readDesktopCatalogSlugs));
    if (path === "/api/zcode-accounts/rename") {
      if (typeof body.label !== "string") return fail("account_invalid");
      const previous = readAccount(id), next = { ...previous, label: body.label.trim() };
      const status = desktopStatus(id);
      withConfigMutationLockSync(() => {
        const providers = ctx.config.providers;
        try {
          writeAccount(next);
          ctx.config.providers = Object.fromEntries(Object.entries(providers).map(([name, provider]) => {
            if (provider.zcodeAccountId !== id) return [name, provider];
            const modelDisplayNames = { ...provider.modelDisplayNames };
            for (const model of status.models) {
              if (modelDisplayNames[model.id] === `${previous.label} / ${model.label}`) {
                modelDisplayNames[model.id] = `${next.label} / ${model.label}`;
              }
            }
            return [name, { ...provider, modelDisplayNames }];
          }));
          (ctx.deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(ctx.config);
        } catch {
          ctx.config.providers = providers; writeAccount(previous);
          return fail("provider_registration_failed");
        }
      });
      clearGatherRoutedModelsInflight();
      return jsonResponse(await activateDesktopProvider(ctx, status, readDesktopCatalogSlugs));
    }
    if (path === "/api/zcode-accounts/remove") {
      const names = Object.keys(ctx.config.providers).filter(name => ctx.config.providers[name]?.zcodeAccountId === id);
      const remainingProviders = Object.fromEntries(
        Object.entries(ctx.config.providers).filter(([name]) => !names.includes(name)),
      );
      const providerNamespaces = new Set(names.flatMap(name => {
        const provider = ctx.config.providers[name];
        const alias = provider?.alias?.trim();
        return [name, ...(alias ? [alias] : [])];
      }).map(name => name.toLowerCase()));
      const modelAliases = new Set(names.flatMap(name => Object.values(ctx.config.providers[name]?.modelAliases ?? {}))
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map(value => value.trim().toLowerCase()));
      if (configReferencesNamespaces({ ...ctx.config, providers: remainingProviders }, providerNamespaces, modelAliases)) return fail("account_referenced");
      // Revoke first. A failed config/catalog save is explicit and cannot silently use another account.
      await disconnectDesktop(id);
      try {
        withConfigMutationLockSync(() => {
          const previous = { ...ctx.config.providers };
          try {
            for (const name of names) delete ctx.config.providers[name];
            (ctx.deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode)(ctx.config);
          } catch (error) { ctx.config.providers = previous; throw error; }
        });
        for (const name of names) clearModelCache(name);
        reconcileLiveStateStores(); clearGatherRoutedModelsInflight();
      } catch {
        // Revocation already persisted. Keep the account visible and require an explicit,
        // idempotent retry instead of reporting a generic OAuth failure or reconnecting it.
        return fail("account_removal_partial");
      }
      let result: Awaited<ReturnType<typeof ctx.convergeCodexCatalog>>;
      try { result = await ctx.convergeCodexCatalog(); }
      catch { return fail("catalog_update_failed"); }
      if (result.status !== "committed") return fail("catalog_update_failed");
      try { removeAccountFiles(id); invalidateAccountRefresh(id); }
      catch { return fail("account_removal_partial"); }
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: "not_found" }, 404);
  } catch (error) {
    const code = error instanceof Error && safeErrors.has(error.message) ? error.message : "native_oauth_failed";
    return jsonResponse({ error: code }, 400);
  }
}
