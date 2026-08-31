import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Codex parses a catalog entry's `input_modalities` as a closed enum, and one out-of-enum
 * value makes it reject the ENTIRE catalog file — plugins, apps and MCP servers all stop
 * loading over one model's metadata (#759).
 *
 * The catalog writer normalizes on the way out, but a rejected value stored here would still
 * be handed back to the GUI and CLI as if it were real, and the offline `ocx models add` path
 * already refuses it. Validate at ingress so all three paths agree.
 */
const ALLOWED_INPUT_MODALITIES = new Set(["text", "image", "audio"]);

function readInputModalities(raw: unknown): { values?: string[]; error?: string } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) return { error: "inputModalities must be an array" };
  // Reject non-strings rather than filtering them out. Dropping them silently accepted a
  // malformed POST and, worse, let a PUT of `[42]` clear the stored modalities while
  // answering 200 — the opposite of the contract this validator exists to state. An empty
  // array stays valid: that is how `ocx models edit --modalities -` clears the field.
  const rejected: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") return { error: "inputModalities must contain only strings" };
    if (!ALLOWED_INPUT_MODALITIES.has(value)) rejected.push(value);
  }
  if (rejected.length > 0) {
    return { error: `unsupported input modality: ${rejected.join(", ")} (allowed: text, image, audio)` };
  }
  return { values: raw as string[] };
}

/**
 * Custom-row reasoning ladder. Labels are validated against the Codex ladder (low..ultra)
 * exactly like provider `modelReasoningEfforts` values; unknown labels would otherwise
 * surface in a catalog the upstream never accepts. An empty array is meaningful (explicit
 * "no reasoning" hides the effort control) and must be preserved, not cleared.
 */
function readReasoningEfforts(raw: unknown): { values?: string[]; error?: string } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) return { error: "reasoningEfforts must be an array" };
  const rejected: string[] = [];
  const values: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") return { error: "reasoningEfforts must contain only strings" };
    if (!isDeclaredReasoningEffort(value)) { rejected.push(value); continue; }
    if (!values.includes(value)) values.push(value);
  }
  if (rejected.length > 0) {
    return { error: `unsupported reasoning effort: ${rejected.join(", ")} (allowed: none, minimal, low, medium, high, xhigh, max, ultra)` };
  }
  // Canonical order: the catalog writes supported_reasoning_levels in input order and the
  // fallback default picks the first entry, so a caller-chosen order must not leak through.
  return { values: canonicalizeReasoningEfforts(values) };
}

/** Default effort must be a ladder member that the declared ladder actually includes. */
function readDefaultReasoningEffort(raw: unknown, efforts: string[] | undefined): { value?: string; error?: string } {
  if (raw === undefined) return {};
  if (raw === null) return { value: undefined };
  if (typeof raw !== "string" || !isDeclaredReasoningEffort(raw)) {
    return { error: "defaultReasoningEffort must be one of: none, minimal, low, medium, high, xhigh, max, ultra" };
  }
  if (efforts === undefined || efforts.length === 0) {
    return { error: "defaultReasoningEffort requires a non-empty reasoningEfforts ladder" };
  }
  if (!efforts.includes(raw)) {
    return { error: `defaultReasoningEffort "${raw}" is not in the declared reasoningEfforts ladder` };
  }
  return { value: raw };
}
import type { CatalogModel } from "../../codex/catalog";
import { accountBoundNativeOpenAiSlugsBySelector, catalogModelSlug, configuredNativeAliasSlugs, disabledNativeSlugs, invalidateCodexModelsCache, nativeModelRows, shouldIncludeAccountBoundNativeOpenAi, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import { CatalogGatherBusyError } from "../../codex/catalog/provider-fetch";
import { clearModelCache, getProviderLiveModelCount } from "../../codex/model-cache";
import { NATIVE_OPENAI_MODELS } from "../../codex/catalog/native-models";

import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  modelDisplayNamesConfigError,
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
import { encodedModelIdCollides, routedSlug, slugEquals } from "../../providers/slug-codec";
import { knownModelIdsForProvider } from "../../router";
import { effectiveModelAliases, MODEL_ALIAS_PATTERN } from "../../providers/default-aliases";
import { isValidModelDiscoveryModelId } from "../../providers/model-discovery-limits";
import { comboPublicModelId } from "../../combos/types";
import { COMBO_NAMESPACE, comboDisabledModelSelectors, comboModelId, preservesPhysicalComboProvider } from "../../combos";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
import { resolveCodexHomeDir } from "../../codex/home";
import { readUsageEntries } from "../../usage/log";
import { getUsageDebugLogEntries } from "../../usage/debug";
import { parseRange, parseUsageSurface, summarizeUsage } from "../../usage/summary";
import { stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import { getProviderRegistryEntry } from "../../providers/registry";
import { getDebugLogEntries } from "../../lib/debug-log-buffer";
import { canonicalizeReasoningEfforts, isDeclaredReasoningEffort } from "../../reasoning-effort";
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
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO, corsHeaders } from "../auth-cors";
import { applySystemEnvToggle } from "../system-env";
import {
  ClientPathError,
  EXPORT_CLIENTS,
  EXPORT_CLIENT_IDS,
  OPENCODE_PROVIDER_ID,
  buildClientConfigText,
  isExportClientId,
  opencodeProxyBaseUrl,
} from "../../clients/config-export";
import type {
  ExportClientId,
  ExportModel,
  OpencodeGeneratedConfig,
  PiGeneratedConfig,
} from "../../clients/config-export";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import type { ManagementContext } from "./context";
import { listManagementModelRows, loadExportModels } from "./model-rows";
import { readManagementJsonBody, rethrowManagementBodyTooLarge } from "./body";
import {
  hasModelPreset,
  markModelPresetDiverged,
  materializeModelPreset,
  modelPresetFor,
} from "../../providers/model-presets";

/**
 * Counts read back off the SERIALIZED document rather than recomputed from the input rows.
 * `modelsWithoutLimits` drives a GUI line claiming "these models ship without limits", so it
 * has to describe the bytes the user actually receives — a parallel reimplementation of the
 * core's "authoritative context window" rule would be free to drift from it silently.
 */
function summarizeExportedModels(client: ExportClientId, document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  // Each client counts its own document shape. The previous branch assumed
  // "anything that is not OpenCode must be Pi", which silently misread the
  // moment a third client existed.
  return EXPORT_CLIENTS[client].summarize(document);
}

export async function handleModelRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, convergeCodexCatalog, syncClaudeAgentDefsBestEffort } = ctx;
  // A handler persists the exact config object passed in. Production defaults to
  // the real store; tests that pass an in-memory fixture inject a no-op/spy. Do not
  // bypass this seam with a dynamic config import — doing so replaced a user's
  // ~/.opencodex/config.json with the `existing-uuid` test fixture.
  const persistConfig = deps.saveConfigPreservingClaudeCode ?? saveConfigPreservingClaudeCode;

  if (url.pathname === "/api/model-discovery" && req.method === "GET") {
    const providers = Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [
      name, provider.newModelPolicy ?? "inherit",
    ]));
    const recentArrivals = Object.fromEntries(Object.entries(config.modelDiscovery?.recentArrivals ?? {}).map(([name, rows]) => [
      name,
      rows.map(row => ({
        ...row,
        state: (config.disabledModels ?? []).some(slug => slugEquals(slug, name, row.id))
          ? "auto-disabled" : "enabled",
      })),
    ]));
    const baselineCounts = Object.fromEntries(Object.entries(config.modelDiscovery?.knownModels ?? {}).map(([name, baseline]) => [
      name, baseline.ids.length,
    ]));
    return jsonResponse({
      policy: config.modelDiscovery?.newModelPolicy ?? "on", providers, recentArrivals, baselineCounts,
    });
  }

  if (url.pathname === "/api/model-discovery" && req.method === "PUT") {
    let body: { policy?: unknown; provider?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (body.policy !== "on" && body.policy !== "off") return jsonResponse({ error: "policy must be on or off" }, 400);
    const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : null;
    let baselineBootstrapped = false;
    if (provider) {
      if (!hasOwnProvider(config.providers, provider)) return jsonResponse({ error: "unknown provider" }, 404);
      config.providers[provider].newModelPolicy = body.policy;
    } else {
      const wasAbsent = config.modelDiscovery?.newModelPolicy === undefined;
      config.modelDiscovery ??= {};
      config.modelDiscovery.newModelPolicy = body.policy;
      if (body.policy === "off" && wasAbsent) {
        const models = await fetchAllModels(config);
        const known = config.modelDiscovery.knownModels ??= {};
        const at = new Date().toISOString();
        for (const name of Object.keys(config.providers)) {
          known[name] ??= { ids: [...new Set(models.filter(m => m.provider === name).map(m => m.id))].sort(), removed: [], updatedAt: at };
        }
        baselineBootstrapped = true;
      }
    }
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, policy: body.policy, provider, ...(baselineBootstrapped ? { baselineBootstrapped } : {}), catalogRefresh });
  }

  if (url.pathname === "/api/model-discovery/acknowledge" && req.method === "POST") {
    let body: { provider?: unknown; ids?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    if (!provider || !Array.isArray(body.ids) || body.ids.some(id => typeof id !== "string")) {
      return jsonResponse({ error: "provider and string ids are required" }, 400);
    }
    const acknowledged = new Set(body.ids as string[]);
    const recent = config.modelDiscovery?.recentArrivals;
    if (recent?.[provider]) recent[provider] = recent[provider].filter(row => !acknowledged.has(row.id));
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, provider, acknowledged: [...acknowledged], catalogRefresh });
  }

  if (url.pathname === "/api/aliases" && req.method === "GET") {
    const providers: Record<string, string> = {};
    const models: Record<string, Record<string, { alias: string; source: "user" | "builtin"; stale?: boolean }>> = {};
    for (const [name, provider] of Object.entries(config.providers)) {
      if (provider.alias) providers[name] = provider.alias;
      const known = knownModelIdsForProvider(name, provider, config);
      const knownSet = new Set(known);
      const rows: Record<string, { alias: string; source: "user" | "builtin"; stale?: boolean }> = {};
      for (const [id, value] of effectiveModelAliases(config, provider, new Set([...known, ...Object.keys(provider.modelAliases ?? {})]))) {
        rows[id] = { ...value, ...(!knownSet.has(id) ? { stale: true } : {}) };
      }
      if (Object.keys(rows).length) models[name] = rows;
    }
    return jsonResponse({ providers, models, defaults: {
      global: config.defaultModelAliases ?? false,
      providers: Object.fromEntries(Object.entries(config.providers).filter(([, p]) => p.defaultAliases !== undefined).map(([n, p]) => [n, p.defaultAliases])),
    } });
  }

  const providerAliasMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/alias$/);
  if (providerAliasMatch && req.method === "PUT") {
    const name = decodeURIComponent(providerAliasMatch[1]!);
    // `keys` is not a provider name: `/api/providers/keys/alias` is the API-KEY POOL's rename
    // endpoint (oauth-account-routes.ts), and model routes are dispatched BEFORE it. Without
    // this guard the alias route matched `name = "keys"`, found no such provider, and returned
    // 404 for every key-pool rename.
    if (name === "keys") return null;
    const provider = config.providers[name];
    if (!provider) return jsonResponse({ error: `provider '${name}' not found` }, 404, req, config);
    let raw: unknown;
    try { raw = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(raw) || (raw.alias !== null && typeof raw.alias !== "string")) return jsonResponse({ error: "alias must be a string or null" }, 400, req, config);
    const alias = typeof raw.alias === "string" ? raw.alias.trim() : null;
    if (alias && !isValidProviderName(alias)) return jsonResponse({ error: "invalid provider alias" }, 400, req, config);
    const lower = alias?.toLowerCase();
    const collision = lower && Object.entries(config.providers).find(([other, p]) =>
      other !== name && (other.toLowerCase() === lower || p.alias?.toLowerCase() === lower));
    const comboCollision = lower && Object.entries(config.combos ?? {}).find(([, combo]) => comboPublicModelId("", combo).toLowerCase() === lower);
    const accountCollision = lower && Object.keys(config.codexAccountNamespaces ?? {}).find(value => value.toLowerCase() === lower);
    if (collision || comboCollision || accountCollision) return jsonResponse({ error: `alias conflicts with '${collision?.[0] ?? comboCollision?.[0] ?? accountCollision}'` }, 409, req, config);
    if (alias) provider.alias = alias; else delete provider.alias;
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, provider: name, alias, catalogRefresh });
  }

  const modelAliasMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/model-aliases$/);
  if (modelAliasMatch && req.method === "PUT") {
    const name = decodeURIComponent(modelAliasMatch[1]!);
    if (name === "keys") return null;
    const provider = config.providers[name];
    if (!provider) return jsonResponse({ error: `provider '${name}' not found` }, 404, req, config);
    let raw: unknown;
    try { raw = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(raw) || (raw.set !== undefined && !isPlainRecord(raw.set)) || (raw.remove !== undefined && !Array.isArray(raw.remove))) return jsonResponse({ error: "invalid model alias update" }, 400, req, config);
    const next = { ...(provider.modelAliases ?? {}) };
    for (const id of (raw.remove ?? []) as unknown[]) if (typeof id === "string") delete next[id];
    const conflicts: Array<{ alias: string; heldBy: string }> = [];
    const known = knownModelIdsForProvider(name, provider, config);
    for (const [id, value] of Object.entries((raw.set ?? {}) as Record<string, unknown>)) {
      if (typeof value !== "string" || !MODEL_ALIAS_PATTERN.test(value)) return jsonResponse({ error: `invalid model alias for '${id}'` }, 400, req, config);
      const lower = value.toLowerCase();
      const heldBy = Object.entries(next).find(([other, alias]) => other !== id && alias.toLowerCase() === lower)?.[0]
        ?? known.find(native => native.toLowerCase() === lower)
        ?? Object.entries(config.combos ?? {}).find(([, combo]) => comboPublicModelId("", combo).toLowerCase() === lower)?.[0];
      if (heldBy || /^(?:gpt-|o1-|o3-|o4-|codex-)/i.test(value)) conflicts.push({ alias: value, heldBy: heldBy ?? "native OpenAI family" });
      else next[id] = value;
    }
    if (conflicts.length) return jsonResponse({ error: "model alias collision", conflicts }, 409, req, config);
    provider.modelAliases = next;
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, aliases: next, catalogRefresh });
  }

  if (url.pathname === "/api/default-aliases" && req.method === "PUT") {
    let raw: unknown;
    try { raw = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(raw) || typeof raw.enabled !== "boolean" || (raw.provider !== undefined && typeof raw.provider !== "string")) return jsonResponse({ error: "enabled must be boolean" }, 400, req, config);
    if (typeof raw.provider === "string") {
      const provider = config.providers[raw.provider];
      if (!provider) return jsonResponse({ error: `provider '${raw.provider}' not found` }, 404, req, config);
      provider.defaultAliases = raw.enabled;
    } else config.defaultModelAliases = raw.enabled;
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, catalogRefresh });
  }

  if (url.pathname === "/api/catalog" && req.method === "GET") {
    // Shared with GET|HEAD /v1/catalog (#809) so both planes emit identical bytes.
    const { serializePersistedCatalog, persistedCodexVersion } = await import("../catalog-download");
    const serialized = await serializePersistedCatalog();
    // No size ceiling here on purpose: this route's behavior predates the shared serializer
    // and a 2,000-model catalog (~92 MB, within the supported bound) must keep working.
    if (serialized.body === null) return jsonResponse({ error: "catalog not found" }, 404, req, config);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...corsHeaders(req, config),
    };
    if (serialized.etag) headers.ETag = serialized.etag;
    const version = await persistedCodexVersion();
    if (version) headers["x-opencodex-codex-version"] = version;
    return new Response(serialized.body, { status: 200, headers });
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    return jsonResponse(await listManagementModelRows(config));
  }

  const displayNameMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/model-display-names$/);
  if (displayNameMatch && req.method === "PUT") {
    let name: string;
    try { name = decodeURIComponent(displayNameMatch[1]!); } catch { return jsonResponse({ error: "invalid provider encoding" }, 400); }
    if (name === "keys") return null;
    if (!hasOwnProvider(config.providers, name)) {
      return jsonResponse({ error: `provider '${name}' not found` }, 404, req, config);
    }
    let body: unknown;
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(body) || typeof body.modelId !== "string"
      || (body.displayName !== null && typeof body.displayName !== "string")) {
      return jsonResponse({ error: "modelId and displayName string or null are required" }, 400, req, config);
    }
    const modelId = body.modelId.trim();
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : null;
    if (!isValidModelDiscoveryModelId(modelId)) {
      return jsonResponse({ error: "modelId must be a valid model id" }, 400, req, config);
    }
    const validationError = displayName === null
      ? null
      : modelDisplayNamesConfigError({ [modelId]: displayName });
    if (validationError) return jsonResponse({ error: validationError }, 400, req, config);

    const provider = config.providers[name]!;
    const hadDisplayNames = Object.hasOwn(provider, "modelDisplayNames");
    const previousDisplayNames = provider.modelDisplayNames;
    const nextDisplayNames = Object.assign(
      Object.create(null) as Record<string, string>,
      previousDisplayNames ?? {},
    );
    if (displayName === null) delete nextDisplayNames[modelId];
    else nextDisplayNames[modelId] = displayName;
    const mergedValidationError = modelDisplayNamesConfigError(nextDisplayNames);
    if (mergedValidationError) return jsonResponse({ error: mergedValidationError }, 400, req, config);
    if (Object.keys(nextDisplayNames).length > 0) provider.modelDisplayNames = nextDisplayNames;
    else delete provider.modelDisplayNames;

    try {
      persistConfig(config);
    } catch (error) {
      if (hadDisplayNames) provider.modelDisplayNames = previousDisplayNames;
      else delete provider.modelDisplayNames;
      throw error;
    }
    clearModelCache(name);
    const catalogRefresh = await convergeCodexCatalog();
    const storedDisplayName = provider.modelDisplayNames?.[modelId] ?? null;
    if (catalogRefresh.status === "failed") {
      return jsonResponse({
        error: "model display name saved but catalog refresh failed",
        saved: true,
        provider: name,
        modelId,
        displayNameOverride: storedDisplayName,
        catalogRefresh,
      }, 503, req, config);
    }
    const row = (await listManagementModelRows(config)).find(candidate => (
      candidate.native !== true
      && candidate.custom !== true
      && candidate.provider === name
      && candidate.id === modelId
    ));
    return jsonResponse({
      ok: true,
      provider: name,
      modelId,
      displayName: row?.displayName ?? storedDisplayName ?? routedSlug(name, modelId),
      displayNameOverride: storedDisplayName,
      displayNameSource: row?.displayNameSource ?? (storedDisplayName ? "operator" : "fallback"),
      catalogRefresh,
    });
  }

  /**
   * Client config document for OpenCode / Pi, built from the SAME function `ocx export`
   * calls, so the bytes a user downloads here and the bytes they pipe from the CLI cannot
   * disagree. Read-only: this route never writes the user's client config.
   */
  if (url.pathname === "/api/client-config" && req.method === "GET") {
    const requested = url.searchParams.get("client")?.trim() ?? "";
    if (!isExportClientId(requested)) {
      return jsonResponse(
        { error: `client must be one of: ${EXPORT_CLIENT_IDS.join(", ")}` },
        400,
        req,
        config,
      );
    }
    const spec = EXPORT_CLIENTS[requested];
    // Resolved before the catalog load on purpose. A refused override is a
    // property of the request, not of the catalog: validating it afterwards
    // let a busy or failing catalog answer 503 first, so a user with a
    // relative override never saw the message that says how to fix it — and
    // the route did the enumeration work anyway for input it was going to
    // reject.
    let destination: string;
    try {
      destination = spec.destination(process.env);
    } catch (error) {
      // A client's own environment override can name a path the resolver
      // refuses — a relative value, which this process and the client would
      // resolve against different working directories. That is a
      // user-correctable configuration error, not a server fault, so it leaves
      // this boundary as a bounded 400 instead of escaping handleManagementAPI
      // as a generic 500 and stripping the message that says how to fix it.
      // `integrations/state.ts` and `integrations/writer.ts` already catch the
      // same error on their paths; this route was the one that did not.
      if (!(error instanceof ClientPathError)) throw error;
      return jsonResponse({ error: error.message }, 400, req, config);
    }
    let models: ExportModel[];
    try {
      // The ONE loader every export surface uses. It carries the visibility
      // filter with it, so this route and the integration routes cannot end up
      // telling a client about different models.
      models = await loadExportModels(config);
    } catch (error) {
      // A partial or empty `models` block reads as a valid config while offering nothing,
      // so a catalog failure is surfaced as unavailable rather than serialized. The
      // catalog-busy error keeps its own 503 from handleManagementAPI.
      if (error instanceof CatalogGatherBusyError) throw error;
      return jsonResponse(
        { error: `model catalog unavailable: ${error instanceof Error ? error.message : String(error)}` },
        503,
        req,
        config,
      );
    }
    const built = buildClientConfigText(requested, {
      baseUrl: opencodeProxyBaseUrl(Number(url.port) || config.port, config.hostname),
      models,
      config,
    });
    const document = built.document;
    return jsonResponse({
      client: spec.id,
      filename: spec.filename,
      destination,
      apiKeyEnv: spec.apiKeyEnv,
      exportHint: spec.exportHint,
      // The client's own format and the exact bytes for it. The GUI previously
      // re-serialized `config` as JSON, which is wrong for four of the six
      // clients; `mediaType` also drives the download blob.
      format: built.format,
      mediaType: built.mediaType,
      text: built.text,
      ...summarizeExportedModels(requested, document),
      config: document,
    }, 200, req, config);
  }

  // Enable/disable models: which routed models Codex sees. PUT hides them from the catalog +
  // /v1/models and invalidates Codex's 5-min models cache so it applies on the next turn.
  if (url.pathname === "/api/disabled-models" && req.method === "PUT") {
    let body: { models?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const disabled = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === "string") : [];
    config.disabledModels = disabled;
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, disabled, catalogRefresh });
  }

  // One user-facing visibility switch spans two persisted filters: a provider allowlist and the
  // shared blocklist. Keep the update atomic so an interrupted request cannot expose a half-applied
  // state. Native rows only use the blocklist; routed/custom rows also join a non-empty allowlist.
  if (url.pathname === "/api/model-visibility" && req.method === "PUT") {
    let parsedBody: unknown;
    try { parsedBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(parsedBody)) return jsonResponse({ error: "invalid model visibility request" }, 400);
    const body = parsedBody;
    const scope = body.scope === "models" || body.scope === "provider" ? body.scope : null;
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    if (!scope || !provider || !isValidProviderName(provider) || typeof body.enabled !== "boolean" || !Array.isArray(body.targets)) {
      return jsonResponse({ error: "invalid model visibility request" }, 400);
    }

    const providerConfig = hasOwnProvider(config.providers, provider) ? config.providers[provider] : undefined;
    const isVirtualComboNamespace = provider === COMBO_NAMESPACE && !preservesPhysicalComboProvider(config);
    if (!providerConfig && provider !== "openai" && !isVirtualComboNamespace) {
      return jsonResponse({ error: "unknown model visibility provider" }, 400);
    }
    const accountNativeQualified = shouldIncludeAccountBoundNativeOpenAi(config)
      ? [...accountBoundNativeOpenAiSlugsBySelector(config).entries()].flatMap(([selector, slugs]) =>
        slugs.filter(slug => !nativeModelRows(config).some(row => row.slug === slug)).map(slug => `${selector}/${slug}`))
      : [];
    const supportedNative = new Set([
      ...nativeModelRows(config).map(row => row.slug),
      ...accountNativeQualified,
      // A model suppressed by an unconfirmed entitlement roster is absent from
      // nativeModelRows, so validating against those rows alone rejected a model this build
      // knows perfectly well and left the operator with no way to clear its disable key
      // (#2886). Accepting the target says "this build knows this model", not "this account
      // may use it" — visibility only writes disabledModels and routing stays gated.
      ...NATIVE_OPENAI_MODELS,
    ]);
    const targets: Array<{ id: string; native: boolean }> = [];
    const seen = new Set<string>();
    for (const value of body.targets) {
      if (!isPlainRecord(value) || typeof value.id !== "string" || (value.native !== undefined && typeof value.native !== "boolean")) {
        return jsonResponse({ error: "invalid model visibility target" }, 400);
      }
      const id = value.id.trim();
      const native = value.native === true;
      if (!id || (provider === "openai") !== native || (native && !supportedNative.has(id))) {
        return jsonResponse({ error: "invalid model visibility target" }, 400);
      }
      const key = `${native ? "native" : "routed"}:${id}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ id, native });
      }
    }
    if (targets.length === 0) return jsonResponse({ error: "model visibility targets required" }, 400);

    const knownComboSelectors = new Set(
      Object.entries(config.combos ?? {}).flatMap(([id, combo]) => (
        comboDisabledModelSelectors(id, combo)
      )),
    );
    const targetComboSelectors = new Map<string, Set<string>>();
    if (isVirtualComboNamespace) {
      for (const target of targets) {
        const combo = config.combos && Object.hasOwn(config.combos, target.id) ? config.combos[target.id] : undefined;
        if (!combo) return jsonResponse({ error: "invalid model visibility target" }, 400);
        targetComboSelectors.set(target.id, new Set(comboDisabledModelSelectors(target.id, combo)));
      }
    }
    const matchesTarget = (stored: string, target: { id: string; native: boolean }) => target.native
      ? stored === target.id
      : isVirtualComboNamespace
        ? targetComboSelectors.get(target.id)!.has(stored)
        : slugEquals(stored, provider, target.id);

    let disabled = [...new Set(config.disabledModels ?? [])];
    if (body.enabled) {
      if (scope === "provider") {
        if (providerConfig && !isVirtualComboNamespace) delete providerConfig.selectedModels;
        if (isVirtualComboNamespace) {
          disabled = disabled.filter(stored => !knownComboSelectors.has(stored));
        } else {
          const nativeIds = provider === "openai"
            ? disabledNativeSlugs({ disabledModels: disabled })
            : new Set<string>();
          const accountNativeIds = provider === "openai" ? new Set(accountNativeQualified) : new Set<string>();
          const nativeAliasSlugs = provider === "openai"
            ? configuredNativeAliasSlugs(config)
            : new Set<string>();
          disabled = disabled.filter(stored => (
            knownComboSelectors.has(stored)
            || nativeAliasSlugs.has(stored)
            || (!stored.startsWith(`${provider}/`) && !nativeIds.has(stored) && !accountNativeIds.has(stored))
          ));
        }
      } else {
        if (!isVirtualComboNamespace && providerConfig?.selectedModels && providerConfig.selectedModels.length > 0) {
          const additions = targets.filter(target => !target.native).map(target => target.id);
          providerConfig.selectedModels = [...new Set([...providerConfig.selectedModels, ...additions])];
        }
        disabled = disabled.filter(stored => !targets.some(target => matchesTarget(stored, target)));
        const arrivals = config.modelDiscovery?.recentArrivals?.[provider];
        if (arrivals) config.modelDiscovery!.recentArrivals![provider] = arrivals.filter(row => (
          !targets.some(target => !target.native && target.id === row.id)
        ));
      }
    } else {
      for (const target of targets) {
        const canonical = target.native
          ? target.id
          : isVirtualComboNamespace
            ? comboModelId(target.id)
            : routedSlug(provider, target.id);
        const alreadyDisabled = disabled.some(stored => matchesTarget(stored, target));
        if (!alreadyDisabled) disabled.push(canonical);
      }
    }

    config.disabledModels = disabled;
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, scope, provider, enabled: body.enabled, disabled, catalogRefresh });
  }

  if (url.pathname === "/api/custom-models" && req.method === "GET") {
    return jsonResponse(config.customModels ?? []);
  }

  if (url.pathname === "/api/custom-models" && req.method === "POST") {
    let parsedBody: unknown;
    try { parsedBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(parsedBody)) return jsonResponse({ error: "invalid JSON body" }, 400);
    const body = parsedBody;
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!provider || !modelId) return jsonResponse({ error: "provider and modelId are required" }, 400);
    if (!isValidProviderName(provider)) return jsonResponse({ error: "invalid provider name" }, 400);
    if (!hasOwnProvider(config.providers, provider)) return jsonResponse({ error: "provider not configured" }, 404);
    const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : undefined;
    if (displayName?.includes("/")) return jsonResponse({ error: "displayName must not contain /" }, 400);
    const contextWindow = typeof body.contextWindow === "number" && body.contextWindow > 0 ? Math.floor(body.contextWindow) : undefined;
    const modalities = readInputModalities(body.inputModalities);
    if (modalities.error) return jsonResponse({ error: modalities.error }, 400);
    const inputModalities = modalities.values;
    const reasoning = readReasoningEfforts(body.reasoningEfforts);
    if (reasoning.error) return jsonResponse({ error: reasoning.error }, 400);
    const defaultEffort = readDefaultReasoningEffort(body.defaultReasoningEffort, reasoning.values);
    if (defaultEffort.error) return jsonResponse({ error: defaultEffort.error }, 400);
    const existing = config.customModels ?? [];
    const newSlug = routedSlug(provider, modelId);
    if (existing.some(cm => routedSlug(cm.provider, cm.modelId) === newSlug)) {
      return jsonResponse({ error: "duplicate model" }, 409);
    }
    const known = knownModelIdsForProvider(provider, config.providers[provider], config);
    if (encodedModelIdCollides(modelId, known)) {
      return jsonResponse({ error: "ambiguous model id" }, 409);
    }
    const entry: OcxCustomModel = {
      id: randomUUID(),
      provider,
      modelId,
      ...(displayName ? { displayName } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(inputModalities && inputModalities.length > 0 ? { inputModalities } : {}),
      ...(reasoning.values !== undefined ? { reasoningEfforts: reasoning.values } : {}),
      ...(defaultEffort.value ? { defaultReasoningEffort: defaultEffort.value } : {}),
      addedAt: new Date().toISOString(),
    };
    config.customModels = [...existing, entry];
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ...entry, catalogRefresh }, 201);
  }

  const customPutMatch = url.pathname.match(/^\/api\/custom-models\/([^/]+)$/);
  if (customPutMatch && req.method === "PUT") {
    let id: string;
    try { id = decodeURIComponent(customPutMatch[1]); } catch { return jsonResponse({ error: "invalid id encoding" }, 400); }
    let parsedBody: unknown;
    try { parsedBody = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(parsedBody)) return jsonResponse({ error: "invalid JSON body" }, 400);
    const body = parsedBody;
    const list = config.customModels ?? [];
    const idx = list.findIndex(cm => cm.id === id);
    if (idx === -1) return jsonResponse({ error: "not found" }, 404);
    const cm = { ...list[idx] };
    if (typeof body.modelId === "string" && body.modelId.trim()) {
      cm.modelId = body.modelId.trim();
    }
    if (body.displayName !== undefined) {
      const dn = typeof body.displayName === "string" ? body.displayName.trim() : "";
      if (dn.includes("/")) return jsonResponse({ error: "displayName must not contain /" }, 400);
      cm.displayName = dn || undefined;
    }
    if (body.contextWindow !== undefined) {
      cm.contextWindow = typeof body.contextWindow === "number" && body.contextWindow > 0 ? Math.floor(body.contextWindow) : undefined;
    }
    if (body.inputModalities !== undefined) {
      const edited = readInputModalities(body.inputModalities);
      if (edited.error) return jsonResponse({ error: edited.error }, 400);
      cm.inputModalities = edited.values && edited.values.length > 0 ? edited.values : undefined;
    }
    // `null` clears the stored ladder back to "inherit from the provider row"; `[]` stays
    // stored as an explicit "no reasoning" override. The default effort rides along and is
    // validated against the ladder the row ends up with.
    if (body.reasoningEfforts !== undefined) {
      if (body.reasoningEfforts === null) {
        cm.reasoningEfforts = undefined;
      } else {
        const edited = readReasoningEfforts(body.reasoningEfforts);
        if (edited.error) return jsonResponse({ error: edited.error }, 400);
        cm.reasoningEfforts = edited.values;
      }
    }
    if (body.defaultReasoningEffort !== undefined) {
      const edited = readDefaultReasoningEffort(body.defaultReasoningEffort, cm.reasoningEfforts);
      if (edited.error) return jsonResponse({ error: edited.error }, 400);
      cm.defaultReasoningEffort = edited.value;
    }
    // Mirror of the POST invariant: a default only survives as a member of the final ladder.
    // Without this, a ladder shrink/clear on a row that was created with a default leaves a
    // stale default that re-applies itself onto the inherited ladder in the generated catalog
    // (the GUI toggle-off path sends only reasoningEfforts, never the default).
    if (cm.defaultReasoningEffort !== undefined) {
      const ladder = cm.reasoningEfforts;
      if (!ladder || ladder.length === 0 || !ladder.includes(cm.defaultReasoningEffort)) {
        cm.defaultReasoningEffort = undefined;
      }
    }
    const updatedSlug = routedSlug(cm.provider, cm.modelId);
    if (list.some((other, i) => i !== idx && routedSlug(other.provider, other.modelId) === updatedSlug)) {
      return jsonResponse({ error: "duplicate model" }, 409);
    }
    const known = knownModelIdsForProvider(cm.provider, config.providers[cm.provider], {
      customModels: list.filter((_, i) => i !== idx),
    });
    if (encodedModelIdCollides(cm.modelId, known)) {
      return jsonResponse({ error: "ambiguous model id" }, 409);
    }
    list[idx] = cm;
    config.customModels = list;
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ...cm, catalogRefresh });
  }

  const customDelMatch = url.pathname.match(/^\/api\/custom-models\/([^/]+)$/);
  if (customDelMatch && req.method === "DELETE") {
    let id: string;
    try { id = decodeURIComponent(customDelMatch[1]); } catch { return jsonResponse({ error: "invalid id encoding" }, 400); }
    const list = config.customModels ?? [];
    const idx = list.findIndex(cm => cm.id === id);
    if (idx === -1) return jsonResponse({ error: "not found" }, 404);
    list.splice(idx, 1);
    config.customModels = list.length > 0 ? list : undefined;
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, catalogRefresh });
  }

  // Per-provider catalog allowlist (issue #52): when a provider has a non-empty selectedModels list,
  // only those ids ship to Codex's catalog / /v1/models. GET returns the CURRENT selection plus the
  // FULL available set per provider (unfiltered — the picker needs everything to choose from).
  if (url.pathname === "/api/selected-models" && req.method === "GET") {
    const models = await fetchAllModels(config);
    const available: Record<string, string[]> = {};
    for (const m of models) (available[m.provider] ??= []).push(m.id);
    const selected: Record<string, string[]> = {};
    // Live-catalog provenance. The GUI cannot infer this by subtracting known custom ids: an id
    // that is both custom and discovered would make a real live catalog look custom-only.
    const liveModelCounts: Record<string, number> = {};
    for (const [name, prov] of Object.entries(config.providers)) {
      if (Array.isArray(prov.selectedModels) && prov.selectedModels.length > 0) selected[name] = [...prov.selectedModels];
      const liveCount = getProviderLiveModelCount(name);
      if (liveCount !== undefined) liveModelCounts[name] = liveCount;
    }
    return jsonResponse({ selected, available, liveModelCounts });
  }
  if (url.pathname === "/api/model-presets" && req.method === "GET") {
    // Preview without applying: rules evaluated against the CURRENT catalog, so the count the
    // user sees is the count they would get.
    const models = await fetchAllModels(config);
    const byProvider = new Map<string, string[]>();
    for (const m of models) {
      const ids = byProvider.get(m.provider) ?? [];
      ids.push(m.id);
      byProvider.set(m.provider, ids);
    }
    const providers: Record<string, unknown> = {};
    for (const [name, prov] of Object.entries(config.providers)) {
      const preset = modelPresetFor(name);
      if (!preset) continue;
      const catalogIds = byProvider.get(name) ?? [];
      const presetIds = materializeModelPreset(name, catalogIds);
      providers[name] = {
        mode: prov.modelPreset?.mode ?? "all",
        ...(prov.modelPreset?.appliedVersion !== undefined
          ? { appliedVersion: prov.modelPreset.appliedVersion }
          : {}),
        availableVersion: preset.version,
        presetIds,
        presetCount: presetIds.length,
        totalCount: catalogIds.length,
        ...(prov.modelPreset?.fallback ? { fallback: prov.modelPreset.fallback } : {}),
      };
    }
    return jsonResponse({ providers });
  }
  if (url.pathname === "/api/model-presets" && req.method === "PUT") {
    let body: { provider?: unknown; mode?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const provider = typeof body.provider === "string" ? body.provider : "";
    if (!provider || !hasOwnProvider(config.providers, provider)) {
      return jsonResponse({ error: "unknown provider" }, provider ? 404 : 400);
    }
    const mode = body.mode;
    if (mode !== "preset" && mode !== "all" && mode !== "custom") {
      return jsonResponse({ error: "mode must be preset, all, or custom" }, 400);
    }
    const target = config.providers[provider];
    if (mode === "all") {
      // Same effect as today's empty-list PUT: no allowlist, no marker to reconcile.
      delete target.selectedModels;
      delete target.modelPreset;
      persistConfig(config);
      return jsonResponse({ ok: true, provider, mode, selected: [], catalogRefresh: await convergeCodexCatalog() });
    }
    if (mode === "custom") {
      // Keep whatever is selected; only the marker changes, so a user can pin their edits
      // without the proxy re-materializing over them.
      target.modelPreset = { ...(target.modelPreset ?? {}), mode: "custom" };
      persistConfig(config);
      return jsonResponse({ ok: true, provider, mode, selected: [...(target.selectedModels ?? [])] });
    }
    if (!hasModelPreset(provider)) {
      return jsonResponse({ error: `no model preset is shipped for provider '${provider}'` }, 400);
    }
    const models = await fetchAllModels(config);
    const catalogIds = models.filter(m => m.provider === provider).map(m => m.id);
    const presetIds = materializeModelPreset(provider, catalogIds);
    const preset = modelPresetFor(provider)!;
    if (presetIds.length === 0) {
      // NEVER write an empty allowlist from a preset: empty means ALL, so it would silently
      // un-curate instead of curating. Keep the previous selection and record the fallback so
      // the next convergence can retry.
      target.modelPreset = {
        mode: "all",
        appliedVersion: preset.version,
        appliedAt: new Date().toISOString(),
        fallback: "preset-empty",
      };
      persistConfig(config);
      return jsonResponse({
        ok: true,
        provider,
        mode: "all",
        fallback: "preset-empty",
        selected: [...(target.selectedModels ?? [])],
      });
    }
    target.selectedModels = presetIds;
    target.modelPreset = {
      mode: "preset",
      appliedVersion: preset.version,
      appliedAt: new Date().toISOString(),
    };
    persistConfig(config);
    return jsonResponse({
      ok: true,
      provider,
      mode: "preset",
      appliedVersion: preset.version,
      selected: presetIds,
      catalogRefresh: await convergeCodexCatalog(),
    });
  }
  if (url.pathname === "/api/selected-models" && req.method === "PUT") {
    let body: { provider?: unknown; models?: unknown };
    try { body = await readManagementJsonBody(req); } catch (error) { rethrowManagementBodyTooLarge(error); return jsonResponse({ error: "invalid JSON body" }, 400); }
    const provider = typeof body.provider === "string" ? body.provider : "";
    if (!provider || !hasOwnProvider(config.providers, provider)) {
      return jsonResponse({ error: "unknown provider" }, provider ? 404 : 400);
    }
    const models = Array.isArray(body.models)
      ? [...new Set(body.models.filter((m): m is string => typeof m === "string"))]
      : [];
    // Empty list clears the allowlist (provider reverts to exposing all models).
    if (models.length > 0) config.providers[provider].selectedModels = models;
    else delete config.providers[provider].selectedModels;
    // Divergence is detected at the WRITE path, not by diffing (#2465): a user edit while the
    // provider is in preset mode makes the selection theirs, and the proxy must never
    // re-materialize over it afterwards.
    markModelPresetDiverged(config.providers[provider]);
    persistConfig(config);
    const catalogRefresh = await convergeCodexCatalog();
    return jsonResponse({ ok: true, provider, selected: models, catalogRefresh });
  }
  return null;
}
