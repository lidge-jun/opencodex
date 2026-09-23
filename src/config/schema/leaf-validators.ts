import * as z from "zod/v4";
import { join } from "node:path";
import { isValidProviderName } from "../provider-name";
import {
  modelPinnedEffortsConfigError,
  pinnedReasoningEffortConfigError,
  modelDisplayNamesConfigError,
  autoReviewModelOverridesConfigError,
  autoReviewModelTargetConfigError,
  normalizeNonBlankStringArray,
  normalizeAutoReviewModelOverrides,
  modelCapabilitiesConfigError,
  mergeModelCapabilities,
} from "../provider-validation";
import { isValidCodexAccountNamespaceTarget } from "../../codex/account-namespace-match";
import { isCodexAccountPriorityKey } from "../../codex/account-priority";
import { isCodexAccountAutoSwitchThresholdKey, parseCodexAutoSwitchThreshold } from "../../codex/account-auto-switch";
import { parseAccountPriority } from "../../codex/pool-rotation";
import { credentialGroupIssues } from "../../routing/identity-domains";
import { providerDestinationConfigError } from "../../lib/destination-policy";
import { providerEgressConfigError } from "../../lib/provider-egress";
import { redactSecretString } from "../../lib/redact";
import {
  MODEL_ADAPTER_OVERRIDE_ALLOWED,
  pinnedWireAdapter,
  PROVIDER_WEB_SEARCH_BRIDGE_BACKENDS,
  UPSTREAM_HTTP_VERSION_VALUES,
  type OcxProviderConfig,
  type FastWire,
  type ProviderCostOverlay,
} from "../../types";
import { fastWireDeclarationError } from "../../providers/fastwire";
import { getProviderRegistryEntry, providerMatchesRegistryTransport, providerModelWireDefault } from "../../providers/registry";
import { resolveOpenAiVirtualModel } from "../../providers/openai-virtual-models";
import { COST4_RATE_KEYS, isValidCost4Rate } from "../../usage/user-cost-overlays";
import { MAX_COST4_RATE } from "../../usage/expected-prices";
import {
  DECLARABLE_HOSTED_TOOL_TYPES,
  declaredUnsupportedHostedTools,
  isHostedToolUnsupportedForModel,
} from "../../responses/hosted-tool-policy";
import { getConfigDir } from "../paths";
import { COMPACTION_TRIGGERS } from "./compaction-triggers";

/** One definition of "usable secret", shared by the schema and the warnings. */
export function isUsableApiKeySecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

export const compactionRoutingSchema = z.object({
  model: z.string().trim().min(1),
  reasoningEffort: z.string().refine(value => pinnedReasoningEffortConfigError(value) === null).optional(),
  triggers: z.array(z.enum(COMPACTION_TRIGGERS)).nonempty()
    .refine(values => new Set(values).size === values.length, "triggers must not repeat a value")
    .optional(),
}).strict();

/**
 * Bounds for the opt-in same-target 429 wait-and-retry policy. Single source of truth
 * shared by the config schema, the load-time sanitizer, and the management write
 * boundary. Strict, so an unknown key is rejected at every validation boundary instead
 * of being silently ignored (the load-time sanitizer still degrades unknown keys with a
 * warning before schema validation, so hand-edited configs keep loading).
 */
export const retryOn429PolicySchema = z.object({
  enabled: z.boolean().optional(),
  attempts: z.number().int().min(1).max(20).optional(),
  intervalMs: z.number().int().min(100).max(600_000).optional(),
  // The effective cap for a single wait is MAX_COOLDOWN_MS (10 min) in key-failover.ts;
  // larger configured values would be dead config.
  maxIntervalMs: z.number().int().min(100).max(600_000).optional(),
  respectRetryAfter: z.boolean().optional(),
}).strict();

/**
 * `transientRetryOn5xx` accepts only these keys. `attempts` is a TOTAL send budget shared by
 * both retry layers, so the ceiling is deliberately lower than `retryOn429`'s: 10 total sends
 * against an already-failing provider is already generous.
 */
const transientRetryOn5xxPolicySchema = z.object({
  enabled: z.boolean().optional(),
  attempts: z.number().int().min(1).max(10).optional(),
}).strict();

/**
 * `retryOnReset` accepts only these keys. `replacements` counts DUPLICATE inferences the
 * operator is willing to risk for one logical request, so the ceiling is two rather than a
 * send budget: this is the one send the proxy otherwise refuses outright, and a third of them
 * says the connection, not the retry policy, is the problem.
 */
export const retryOnResetPolicySchema = z.object({
  enabled: z.boolean().optional(),
  replacements: z.number().int().min(1).max(2).optional(),
}).strict();

const requestPacingRuleSchema = z.object({
  // Keep the RPM-derived timer within the same one-hour bound as minIntervalMs.
  requestsPerMinute: z.number().min(1 / 60).max(60_000).optional(),
  minIntervalMs: z.number().int().min(1).max(3_600_000).optional(),
}).strict().refine(value => value.requestsPerMinute !== undefined || value.minIntervalMs !== undefined, {
  message: "request pacing rules need requestsPerMinute or minIntervalMs",
});

const requestPacingSchema = z.object({
  enabled: z.boolean(),
  requestsPerMinute: z.number().min(1 / 60).max(60_000).optional(),
  minIntervalMs: z.number().int().min(1).max(3_600_000).optional(),
  models: z.record(z.string().trim().min(1), requestPacingRuleSchema).optional(),
}).strict().refine(value => value.enabled === false
  || value.requestsPerMinute !== undefined
  || value.minIntervalMs !== undefined
  || (value.models !== undefined && Object.keys(value.models).length > 0), {
  message: "enabled request pacing needs a provider rule or model override",
});

export function requestPacingConfigError(value: unknown): string | null {
  if (value === undefined) return null;
  const parsed = requestPacingSchema.safeParse(value);
  if (parsed.success) return null;
  return "requestPacing must contain enabled and a valid requestsPerMinute/minIntervalMs provider rule or model overrides";
}

/**
 * Bounds for the opt-in passthrough web-search bridge (`providers.<name>.webSearchBridge`,
 * #3761). Strict for the same reason `retryOn429` is: a misspelled key here would silently
 * leave the bridge disarmed while the operator believes they enabled it.
 *
 * `endpoint` names the destination that receives this provider's API key, so it gets the same
 * literal destination assessment `baseUrl` gets (#4519) — see `providerWebSearchBridgeConfigError`
 * below. This schema itself still only shape-checks: it is `.catch(undefined)` at the provider
 * row, and a hand-edited config file never reaches the error function at all. The authorization
 * boundary is therefore `resolveOllamaWebSearchEndpoint`, which runs the same assessment and is
 * the only reader of this field in the tree; config validation is where an operator is told why,
 * not what makes the value safe.
 */
const providerWebSearchBridgeSchema = z.object({
  enabled: z.boolean().optional(),
  backend: z.enum(PROVIDER_WEB_SEARCH_BRIDGE_BACKENDS).optional(),
  maxSearches: z.number().int().min(1).max(10).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  endpoint: z.string().min(1).optional(),
}).strict();

export function providerWebSearchBridgeConfigError(
  value: unknown,
  providerName: string,
  provider: Pick<OcxProviderConfig, "allowPrivateNetwork">,
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "webSearchBridge must be a plain object";
  }
  const parsed = providerWebSearchBridgeSchema.safeParse(value);
  if (!parsed.success) {
    return "webSearchBridge accepts only enabled (boolean), backend "
      + `(${PROVIDER_WEB_SEARCH_BRIDGE_BACKENDS.join("|")}), maxSearches (1..10), `
      + "timeoutMs (1000..600000), and endpoint (absolute http(s) URL)";
  }
  const endpoint = parsed.data.endpoint;
  if (endpoint !== undefined) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return "webSearchBridge.endpoint must be an absolute http(s) URL";
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "webSearchBridge.endpoint must be an absolute http(s) URL";
    }
    // Same classifier baseUrl uses, so a metadata address is refused outright and loopback or
    // private space needs the provider's allowPrivateNetwork opt-in (or a registry entry that is
    // local by definition, which is what keeps a self-hosted Ollama working). Literal-only and
    // synchronous, exactly as at the baseUrl boundary: no DNS is resolved here.
    const destinationError = providerDestinationConfigError(providerName, {
      baseUrl: endpoint,
      allowPrivateNetwork: provider.allowPrivateNetwork,
    });
    if (destinationError) {
      return destinationError.replace(/^baseUrl/, "webSearchBridge.endpoint");
    }
  }
  return null;
}

const fastWireSchema = z.object({
  kind: z.string(),
  canonicalToWire: z.record(z.string().trim(), z.string().trim()),
  foreignCallerTiers: z.string(),
  betas: z.array(z.string().trim()).optional(),
}).strict().superRefine((fastWire, ctx) => {
  const error = fastWireDeclarationError({ fastWire });
  if (error) ctx.addIssue({ code: "custom", message: error });
}).transform(fastWire => fastWire as FastWire);

const modelDisplayNamesSchema = z.unknown().superRefine((value, ctx) => {
  const error = modelDisplayNamesConfigError(value);
  if (error) ctx.addIssue({ code: "custom", message: error });
}).transform(value => {
  const labels = Object.create(null) as Record<string, string>;
  for (const [modelId, displayName] of Object.entries(value as Record<string, string>)) {
    labels[modelId] = displayName;
  }
  return labels;
});

const pinnedReasoningEffortSchema = z.unknown().superRefine((value, ctx) => {
  const error = pinnedReasoningEffortConfigError(value);
  if (error) ctx.addIssue({ code: "custom", message: error });
}).transform(value => value as string);

export const modelPinnedEffortsSchema = z.unknown().superRefine((value, ctx) => {
  const error = modelPinnedEffortsConfigError(value);
  if (error) ctx.addIssue({ code: "custom", message: error });
}).transform(value => Object.fromEntries(
  Object.entries(value as Record<string, string>).map(([key, effort]) => [key.trim(), effort]),
));

const autoReviewModelSchema = z.unknown().superRefine((value, ctx) => {
  const error = autoReviewModelTargetConfigError(value, "autoReviewModel", true);
  if (error) ctx.addIssue({ code: "custom", message: error });
}).transform(value => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
});

const autoReviewModelOverridesSchema = z.unknown().superRefine((value, ctx) => {
  const error = autoReviewModelOverridesConfigError(value, "autoReviewModelOverrides", true);
  if (error) ctx.addIssue({ code: "custom", message: error });
}).transform(value => normalizeAutoReviewModelOverrides(value));

const modelCapabilitiesSchema = z.unknown().superRefine((value, ctx) => {
  const error = modelCapabilitiesConfigError(value);
  if (error) ctx.addIssue({ code: "custom", message: error });
}).transform(value => mergeModelCapabilities(undefined, value));

/**
 * Per-provider egress fields, validated by the resolver the transports themselves use.
 *
 * Calling `providerEgressConfigError` rather than restating the accepted forms keeps one
 * definition of a usable value: a proxy the config loader admits is one the transport can
 * carry, and a value rejected here is rejected at request time for the identical reason.
 * Each field is checked on its own because neither depends on the other's value to be
 * well-formed; how they combine is decided per request against the destination.
 */
const providerProxySchema = z.unknown().superRefine((value, ctx) => {
  const error = providerEgressConfigError({ proxy: value as string | null | undefined });
  if (error) ctx.addIssue({ code: "custom", message: error });
}).transform(value => value as string | null | undefined);

const providerNoProxySchema = z.unknown().superRefine((value, ctx) => {
  const error = providerEgressConfigError({ noProxy: value as string | string[] | undefined });
  if (error) ctx.addIssue({ code: "custom", message: error });
}).transform(value => value as string | string[] | undefined);

/**
 * Zod schema for one provider entry: known fields are validated strictly while unknown
 * fields pass through (preserved for runtime extensions).
 */
export const providerConfigSchema = z.object({
  modelCapabilities: modelCapabilitiesSchema.optional(),
  pinnedReasoningEffort: pinnedReasoningEffortSchema.optional(),
  modelPinnedReasoningEfforts: modelPinnedEffortsSchema.optional(),
  // Validated rather than left to passthrough: an unrecognized strategy would otherwise
  // load silently and then be ignored at selection time, which reads as a broken feature
  // rather than a rejected setting.
  apiKeyPoolStrategy: z.enum(["round-robin", "fill-first", "quota"]).optional(),
  autoReviewModel: autoReviewModelSchema.optional(),
  autoReviewModelOverrides: autoReviewModelOverridesSchema.optional(),
  adapter: z.string().min(1),
  baseUrl: z.string().min(1),
  alias: z.string().optional(),
  modelAliases: z.record(z.string(), z.string()).optional(),
  modelDisplayNames: modelDisplayNamesSchema.optional(),
  defaultAliases: z.boolean().optional(),
  initialModelSelection: z.object({
    version: z.literal(1),
    registrationId: z.uuid(),
    status: z.enum(["pending", "ready", "all-off"]),
    modelCount: z.number().int().nonnegative().optional(),
  }).optional().catch(undefined),
  requestPacing: requestPacingSchema.optional().catch(undefined),
  mcpMaxTools: z.number().int().positive().optional(),
  mcpMaxSchemaBytes: z.number().int().positive().optional(),
  mcpMaxResultBytes: z.number().int().positive().optional(),
  apiKeyTransport: z.enum(["x-api-key", "bearer"]).optional(),
  responsesPath: z.string().min(1).optional(),
  chatCompletionsPath: z.string().min(1).optional(),
  statelessResponses: z.boolean().optional(),
  requiresAdjacentResponsesToolResults: z.boolean().optional(),
  requiresPairedResponsesToolResults: z.boolean().optional(),
  annotateEmptyToolOutputs: z.boolean().optional(),
  foldDeveloperRoleToSystem: z.boolean().optional(),
  fastWire: fastWireSchema.nullable().optional(),
  supportsServiceTier: z.boolean().optional(),
  modelSupportsServiceTier: z.record(z.string().min(1), z.boolean()).optional(),
  modelSuppressSyntheticMax: z.record(z.string().min(1), z.boolean()).optional(),
  preserveResponsesReasoningContent: z.boolean().optional(),
  dropResponsesReasoningItems: z.boolean().optional(),
  modelReasoningEffortsAuthoritative: z.boolean().optional(),
  decodesNativeCompactionBlobs: z.boolean().optional(),
  allowEncryptedV2AgentTasks: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  // Per-provider egress (#2894): absent inherits the global proxy decision, "direct"/null
  // refuses it, and an http(s) or socks5 URL replaces it for this provider only.
  proxy: providerProxySchema.optional(),
  noProxy: providerNoProxySchema.optional(),
  // The management API accepts `null` as "clear this", so a config written before the POST
  // canonicalization below can hold one on disk. Rejecting it here would send the operator
  // through invalid-config recovery for a value the API told them was fine.
  upstreamHttpVersion: z.enum(UPSTREAM_HTTP_VERSION_VALUES)
    .nullish()
    .transform(value => value ?? undefined),
  // Opt-in upstream Responses WebSocket for OpenAI-compatible providers (e.g.
  // aggregators whose WebSocket ingress is measurably faster than SSE). The
  // canonical ChatGPT backend WS selection is independent of this flag.
  upstreamWebsocket: z.boolean().optional(),
  directGeminiWireRenames: z.boolean().optional(),
  googleToolSchemaPolicy: z.enum(["compatible", "reject-lossy"]).optional(),
  noStructuredOutputModels: z.array(z.string().min(1))
    .transform(normalizeNonBlankStringArray)
    .optional(),
  noJsonSchemaModels: z.array(z.string().min(1))
    .transform(normalizeNonBlankStringArray)
    .optional(),
  retainModels: z.array(z.string().min(1))
    .transform(normalizeNonBlankStringArray)
    .optional(),
  omitReasoningEffortWithToolsModels: z.array(z.string().min(1))
    .transform(normalizeNonBlankStringArray)
    .optional(),
  // Validated against a closed vocabulary rather than accepted as free strings. This
  // schema ends in `.passthrough()`, so a misspelled `web_serch` would otherwise be
  // accepted, persisted, and strip nothing -- leaving the operator with the upstream 400
  // the field was set to prevent, and no message saying why (the `codexToolMode` lesson,
  // #2106).
  unsupportedHostedTools: z.array(z.string().min(1))
    .transform(normalizeNonBlankStringArray)
    .refine(
      tools => tools.every(tool => DECLARABLE_HOSTED_TOOL_TYPES.has(tool)),
      { message: `unsupportedHostedTools accepts only hosted tool types: ${[...DECLARABLE_HOSTED_TOOL_TYPES].join(", ")}` },
    )
    .optional(),
  retryOn429: retryOn429PolicySchema.optional(),
  transientRetryOn5xx: transientRetryOn5xxPolicySchema.optional(),
  // Degrades to "absent" like `webSearchBridge`: a malformed hand edit of an opt-in feature
  // that is off by default must not send the operator through invalid-config recovery. The
  // management write boundary still rejects it loudly (`retryOnResetPolicyConfigError`).
  retryOnReset: retryOnResetPolicySchema.optional().catch(undefined),
  codexAccountMode: z.enum(["pool", "direct"]).optional(),
  // Validated rather than passed through: this schema ends in `.passthrough()`, so an
  // undeclared key survives verbatim. A misspelled `codexToolMode` therefore used to be
  // accepted, persisted, and then silently resolved to the `code_mode_only` default — the
  // operator asked for shell mode, got code mode, and was told nothing (#2106).
  codexToolMode: z.enum(["code_mode_only", "shell"]).optional(),
  responsesItemIdRepair: z.object({
    message: z.array(z.string().min(1)).optional(),
    reasoning: z.array(z.string().min(1)).optional(),
    repairMissingTerminalIds: z.boolean().optional(),
    repairInvalidIds: z.boolean().optional(),
  }).strict().optional(),
  responsesSnapshotRepair: z.boolean().optional(),
  // Invalid blocks degrade to "absent" rather than failing the whole config load: an unusable
  // bridge block must never send an operator through invalid-config recovery for an opt-in
  // feature that is off by default. The management write boundary still rejects it loudly.
  webSearchBridge: providerWebSearchBridgeSchema.optional().catch(undefined),
  xaiResponsesXSearch: z.boolean().optional(),
  xaiResponsesDefaultVersion: z.number().int().positive().optional().catch(undefined),
  zaiResponsesDefaultVersion: z.number().int().positive().optional().catch(undefined),
}).passthrough();


export { providerRelativeSendPathConfigError } from "../provider-relative-send-path";

/**
 * Validate `providers.<name>.modelCosts`: a plain object keyed by exact model
 * id, each value a 4-tuple of non-negative finite USD-per-1M-token rates.
 * Returns null when valid/absent, else a human-readable error.
 */
export function providerModelCostsConfigError(value: unknown, field = "modelCosts"): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${field} must be a plain object keyed by model id`;
  }
  for (const [modelId, entry] of Object.entries(value)) {
    if (!modelId.trim()) return `${field} keys must be nonblank model ids`;
    // Redact secret-shaped model ids and JSON-escape control characters so a
    // malformed write cannot echo a pasted key/secret back through the
    // management API response.
    const safeModelId = JSON.stringify(redactSecretString(modelId));
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return `${field}.${safeModelId} must be an object with input, output, cacheRead, and cacheWrite (USD per 1M tokens)`;
    }
    const rates = entry as Record<string, unknown>;
    for (const key of COST4_RATE_KEYS) {
      const rate = rates[key];
      if (!isValidCost4Rate(rate)) {
        return `${field}.${safeModelId}.${key} must be a non-negative finite number at most ${MAX_COST4_RATE} (USD per 1M tokens)`;
      }
    }
    // Reject unknown fields: a misplaced apiKey/apiKeyPool under a cost row
    // would otherwise be persisted and echoed verbatim by display paths that
    // mask only top-level provider secrets.
    const extraKeys = Object.keys(rates)
      .filter((key) => !(COST4_RATE_KEYS as readonly string[]).includes(key));
    if (extraKeys.length > 0) {
      return `${field}.${safeModelId} has unexpected fields ${JSON.stringify(extraKeys.map(redactSecretString).join(", "))} — only input, output, cacheRead, and cacheWrite are allowed (USD per 1M tokens)`;
    }
  }
  return null;
}

/**
 * Serialize `providers.<name>.modelCosts` for display: copy ONLY the four
 * numeric rate fields per model and DROP secret-shaped model ids, so a pasted
 * API key in a key position cannot be echoed back by CLI/DTO display paths.
 * The result uses a null prototype so "__proto__" remains an own row.
 */
export function sanitizeModelCostsForDisplay(costs: unknown): Record<string, ProviderCostOverlay> | undefined {
  if (!costs || typeof costs !== "object" || Array.isArray(costs)) return undefined;
  const out = Object.create(null) as Record<string, ProviderCostOverlay>;
  for (const [modelId, entry] of Object.entries(costs)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rates = entry as Record<string, unknown>;
    const input = rates.input;
    const output = rates.output;
    const cacheRead = rates.cacheRead;
    const cacheWrite = rates.cacheWrite;
    if (
      isValidCost4Rate(input)
      && isValidCost4Rate(output)
      && isValidCost4Rate(cacheRead)
      && isValidCost4Rate(cacheWrite)
    ) {
      // Secret-shaped ids are DROPPED rather than mapped to "[REDACTED]" so
      // distinct rows cannot collapse into one placeholder key.
      if (redactSecretString(modelId) !== modelId) continue;
      out[modelId] = { input, output, cacheRead, cacheWrite };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const SUPPORTED_PREFERRED_HOSTED_TOOLS = new Set(["image_generation"]);

export function modelPreferHostedToolsConfigError(
  value: unknown,
  field: string,
  providerName: string,
  provider: {
    adapter?: unknown;
    authMode?: unknown;
    modelAdapters?: unknown;
    baseUrl?: unknown;
    unsupportedHostedTools?: unknown;
  },
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  const entries = Object.entries(value);
  const registry = getProviderRegistryEntry(providerName);
  // A provider that denies a hosted tool cannot also prefer it. Both keys are
  // provider-owned capability statements about the same tool, and the denial wins at
  // request time, so accepting the pair would silently ignore the preference.
  const declaredUnsupported = declaredUnsupportedHostedTools(
    provider as { unsupportedHostedTools?: readonly string[] },
  );
  // Effective transport: a `preserveCustomDestination` registry row reused under a
  // different endpoint keeps its own adapter AND its own auth at runtime, because
  // `routedProviderConfig()` honors `providerMatchesRegistryTransport()`. Both the
  // wire check below and the forward-auth check here have to start from the same
  // decision, or validation accepts a preference the adapter never applies —
  // `preferConfiguredHostedTools()` runs only on the non-forward branch.
  const registryTransportMatches = typeof provider.baseUrl === "string"
    && providerMatchesRegistryTransport(providerName, {
      baseUrl: provider.baseUrl,
      adapter: provider.adapter as OcxProviderConfig["adapter"],
      ...(typeof provider.authMode === "string" ? { authMode: provider.authMode as OcxProviderConfig["authMode"] } : {}),
    });
  const effectiveForwardAuth = registryTransportMatches
    ? registry?.authKind === "forward"
    : provider.authMode === "forward";
  if (entries.length > 0 && effectiveForwardAuth) {
    return `${field} is not supported on forward-auth Responses providers`;
  }
  const requestedWireFor = (modelId: string): unknown => provider.modelAdapters
    && typeof provider.modelAdapters === "object"
    && !Array.isArray(provider.modelAdapters)
    ? (provider.modelAdapters as Record<string, unknown>)[modelId]
    : undefined;
  const resolveEffectiveWire = (modelId: string, currentWire: unknown): unknown => {
    const pinned = pinnedWireAdapter(providerName, modelId);
    if (pinned) return pinned;
    const requestedWire = requestedWireFor(modelId);
    if (typeof requestedWire === "string" && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(requestedWire)) {
      return requestedWire;
    }
    // No explicit override: fall back to the registry's per-model wire default before
    // the provider-wide adapter, because that is the order `resolveModelAdapter()`
    // uses at request time (src/server/adapter-resolve.ts:38-48). Skipping it rejected
    // preferences the runtime would have honored — DeepSeek routes `deepseek-v4-flash`
    // over native Responses for a Responses inbound while the provider-wide wire stays
    // openai-chat. Hosted-tool preferences only apply to Responses traffic, so the
    // inbound to ask about is "responses".
    const registryDefault = typeof currentWire === "string" && typeof provider.baseUrl === "string"
      ? providerModelWireDefault(
        providerName,
        {
          baseUrl: provider.baseUrl,
          adapter: currentWire,
          ...(typeof provider.authMode === "string" ? { authMode: provider.authMode as OcxProviderConfig["authMode"] } : {}),
        },
        modelId,
        MODEL_ADAPTER_OVERRIDE_ALLOWED,
        "responses",
      )
      : undefined;
    return registryDefault ?? currentWire;
  };
  for (const [key, entry] of entries) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (!Array.isArray(entry)) return `${field}.${key} must be an array`;
    if (entry.length === 0) return `${field}.${key} must include image_generation`;
    for (const tool of entry) {
      if (typeof tool !== "string" || !SUPPORTED_PREFERRED_HOSTED_TOOLS.has(tool)) {
        return `${field}.${key} supports only image_generation`;
      }
      if (declaredUnsupported.has(tool)) {
        return `${field}.${key} cannot prefer ${tool}: unsupportedHostedTools declares it unsupported`;
      }
      if (isHostedToolUnsupportedForModel(key, tool)) {
        return `${field}.${key} cannot prefer ${tool}: the model does not support it`;
      }
    }
    // Same `registryTransportMatches` decision the forward-auth check above uses:
    // start from the registry adapter only when this config still points at the
    // registry's documented transport.
    const baseWire = registryTransportMatches ? registry?.adapter ?? provider.adapter : provider.adapter;
    let effectiveWire = resolveEffectiveWire(key, baseWire);
    const virtualWireModel = resolveOpenAiVirtualModel(providerName, key)?.wireModelId;
    if (virtualWireModel && virtualWireModel !== key) {
      effectiveWire = resolveEffectiveWire(virtualWireModel, effectiveWire);
    }
    if (effectiveWire !== "openai-responses") {
      return `${field}.${key} requires the openai-responses wire`;
    }
  }
  return null;
}

const CODEX_ACCOUNT_NAMESPACES_RECORD_ERROR =
  "codexAccountNamespaces must be a plain object mapping account selectors to Codex account ids";
const CODEX_ACCOUNT_NAMESPACE_KEY_ERROR =
  "account selectors must use 1-64 letters, numbers, dots, underscores, or hyphens and cannot be reserved JavaScript object keys";
const CODEX_ACCOUNT_NAMESPACE_TARGET_ERROR =
  "account selector targets must be @main or valid Codex pool-account ids";
export const CODEX_ACCOUNT_NAMESPACE_ACCOUNT_ID_COLLISION_ERROR =
  "account selectors must not collide with configured Codex pool-account ids or account selector targets";

export function configuredCodexPoolAccountIds(value: unknown): Set<string> {
  const accountIds = new Set<string>();
  if (!Array.isArray(value)) return accountIds;
  for (const account of value) {
    if (!account || typeof account !== "object" || Array.isArray(account)) continue;
    const { id, isMain } = account as { id?: unknown; isMain?: unknown };
    if (typeof id === "string" && isMain !== true) accountIds.add(id);
  }
  return accountIds;
}

export const codexAccountNamespacesSchema = z.custom<Record<string, unknown>>(
  (value): value is Record<string, unknown> => !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  { error: CODEX_ACCOUNT_NAMESPACES_RECORD_ERROR },
).superRefine((accountNamespaces, ctx) => {
  // Inspect raw own entries before z.record parses them; Zod omits __proto__ record keys.
  for (const [namespace, accountId] of Object.entries(accountNamespaces)) {
    if (!isValidProviderName(namespace)) {
      ctx.addIssue({
        code: "custom",
        path: [namespace],
        message: CODEX_ACCOUNT_NAMESPACE_KEY_ERROR,
      });
    }
    if (!isValidCodexAccountNamespaceTarget(accountId)) {
      ctx.addIssue({
        code: "custom",
        path: [namespace],
        message: CODEX_ACCOUNT_NAMESPACE_TARGET_ERROR,
      });
    }
  }
}).pipe(z.record(z.string(), z.string()));

const CODEX_ACCOUNT_PRIORITIES_RECORD_ERROR =
  "codexAccountPriorities must be a plain object mapping Codex account ids to selection-order integers";
const CODEX_ACCOUNT_PRIORITY_KEY_ERROR =
  "selection-order keys must be a Codex pool-account id or the main Codex account and cannot be reserved JavaScript object keys";
const CODEX_ACCOUNT_PRIORITY_VALUE_ERROR =
  "selection order must be an integer between -100 and 100";

export const CODEX_ACCOUNT_PIN_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

export const codexAccountPrioritiesSchema = z.custom<Record<string, unknown>>(
  (value): value is Record<string, unknown> => !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  { error: CODEX_ACCOUNT_PRIORITIES_RECORD_ERROR },
).superRefine((priorities, ctx) => {
  // Inspect raw own entries before z.record parses them; Zod omits __proto__ record keys.
  for (const [accountId, priority] of Object.entries(priorities)) {
    if (!isCodexAccountPriorityKey(accountId)) {
      ctx.addIssue({ code: "custom", path: [accountId], message: CODEX_ACCOUNT_PRIORITY_KEY_ERROR });
    }
    if (parseAccountPriority(priority) === null) {
      ctx.addIssue({ code: "custom", path: [accountId], message: CODEX_ACCOUNT_PRIORITY_VALUE_ERROR });
    }
  }
}).pipe(z.record(z.string(), z.number().int()));

const codexQuotaAutoRefreshEntrySchema = z.object({
  fiveHour: z.boolean().optional(),
  weekly: z.boolean().optional(),
  lastFiveHourResetAt: z.number().finite().nonnegative().optional(),
  lastWeeklyResetAt: z.number().finite().nonnegative().optional(),
  nextFiveHourResetAt: z.number().finite().nonnegative().optional(),
  nextWeeklyResetAt: z.number().finite().nonnegative().optional(),
}).strict();
const CODEX_QUOTA_AUTO_REFRESH_KEY_ERROR =
  "quota auto-refresh keys must be a Codex pool-account id or the main Codex account and cannot be reserved JavaScript object keys";

const CODEX_ACCOUNT_AUTO_SWITCH_THRESHOLDS_RECORD_ERROR =
  "codexAccountAutoSwitchThresholds must be a plain object mapping Codex account ids to usage thresholds";
const CODEX_ACCOUNT_AUTO_SWITCH_THRESHOLD_KEY_ERROR =
  "usage-threshold keys must be a Codex pool-account id or the main Codex account and cannot be reserved JavaScript object keys";
const CODEX_ACCOUNT_AUTO_SWITCH_THRESHOLD_VALUE_ERROR =
  "account usage threshold must be an integer between 0 and 100";

export const codexAccountAutoSwitchThresholdsSchema = z.custom<Record<string, unknown>>(
  (value): value is Record<string, unknown> => !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  { error: CODEX_ACCOUNT_AUTO_SWITCH_THRESHOLDS_RECORD_ERROR },
).superRefine((thresholds, ctx) => {
  for (const [accountId, threshold] of Object.entries(thresholds)) {
    if (!isCodexAccountAutoSwitchThresholdKey(accountId)) {
      ctx.addIssue({
        code: "custom",
        path: [accountId],
        message: CODEX_ACCOUNT_AUTO_SWITCH_THRESHOLD_KEY_ERROR,
      });
    }
    if (parseCodexAutoSwitchThreshold(threshold) === null) {
      ctx.addIssue({
        code: "custom",
        path: [accountId],
        message: CODEX_ACCOUNT_AUTO_SWITCH_THRESHOLD_VALUE_ERROR,
      });
    }
  }
}).pipe(z.record(z.string(), z.number().int()));

/** Load only: retain valid overrides from a hand-edited map; writes use the strict schema above. */
export function salvageCodexAccountAutoSwitchThresholds(value: unknown): Record<string, number> | undefined {
  const parsed = codexAccountAutoSwitchThresholdsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const valid: Record<string, number> = Object.create(null);
  for (const [accountId, threshold] of Object.entries(value)) {
    const parsedThreshold = parseCodexAutoSwitchThreshold(threshold);
    if (isCodexAccountAutoSwitchThresholdKey(accountId) && parsedThreshold !== null) {
      valid[accountId] = parsedThreshold;
    }
  }
  return Object.keys(valid).length ? valid : undefined;
}

export const codexQuotaAutoRefreshSchema = z.custom<Record<string, unknown>>(
  (value): value is Record<string, unknown> => !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  { error: "codexQuotaAutoRefresh must be a plain object" },
).superRefine((settings, ctx) => {
  // Inspect own entries before z.record parses them; Zod omits __proto__ record keys.
  for (const [accountId, setting] of Object.entries(settings)) {
    if (!isCodexAccountPriorityKey(accountId)) {
      ctx.addIssue({ code: "custom", path: [accountId], message: CODEX_QUOTA_AUTO_REFRESH_KEY_ERROR });
    }
    const parsed = codexQuotaAutoRefreshEntrySchema.safeParse(setting);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", path: [accountId], message: "invalid quota auto-refresh setting" });
    }
  }
}).pipe(z.record(z.string(), codexQuotaAutoRefreshEntrySchema));

/**
 * Deliberately permissive. A user's config is not ours to invalidate: a strict
 * entry fails the whole parse, and loadConfig's fallback then backs the file up
 * and returns defaults — losing providers and pool accounts because one key name
 * was too long. Length and charset rules live at the POST/PATCH boundary, where
 * rejecting produces a 400 instead. `.passthrough()` keeps unknown per-key
 * properties across a load -> mutate -> save round trip.
 *
 * Only `key` is load-bearing: admission compares that string and nothing else
 * (src/server/auth-cors.ts isDataPlaneAdmissionSecret). So the secret is the one
 * field that must be a usable string, and every piece of metadata around it
 * degrades instead of taking the credential down with it. Dropping a working key
 * because its `name` was hand-edited to a number would be a silent revocation —
 * and on a remote bind, potentially a server that refuses to start.
 *
 * "Usable" matches admission exactly. The presented token is trimmed before the
 * comparison but the stored value is not, so a key with surrounding whitespace
 * can never match either form of itself. Keeping one would be worse than dropping
 * it: `system-env.ts` and `cli/claude.ts` hand `apiKeys[0].key` to launched
 * clients, so a junk first entry would mask a valid later one.
 */
const pendingApiKeyRotationSchema = z.object({
  id: z.string().trim().min(1).max(256),
  key: z.string().refine(isUsableApiKeySecret),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export const apiKeyEntrySchema = z.object({
  key: z.string().refine(isUsableApiKeySecret),
  // Degrades to "" here; every schema consumer then runs `normalizeApiKeyIds`,
  // which fills it deterministically so the id is stable across loads.
  id: z.string().catch(""),
  name: z.string().catch(""),
  createdAt: z.string().catch(""),
  // A damaged overlap record must never discard the still-authoritative key.
  pendingRotation: pendingApiKeyRotationSchema.optional().catch(undefined),
  // Deliberately NOT `.catch`ed, unlike every field above. Degrading a damaged
  // scope to `undefined` would silently widen the key to the whole catalog,
  // which is the one direction a permission field must never fail. Letting the
  // record fail instead drops the key, so a corrupted scope stops that client
  // rather than promoting it.
  allowedProviders: z.array(z.string().trim().min(1).max(256)).optional(),
  allowedModels: z.array(z.string().trim().min(1).max(256)).optional(),
}).passthrough();

/**
 * Durable per-client intent.
 *
 * `.passthrough()` is load-bearing: a binary that only knows `codex` must not
 * erase a key a later version wrote during a field-scoped mutation. And each key
 * degrades on its own — a hand edit of `{"codex": "false", "future": false}`
 * drops `codex` to absent (which reads as ON) and keeps `future`, rather than
 * invalidating the object or, worse, the whole config.
 */
export const clientIntegrationsSchema = z.object({
  codex: z.boolean().optional().catch(undefined),
  grok: z.boolean().optional().catch(undefined),
  "claude-desktop": z.boolean().optional().catch(undefined),
}).passthrough();

export const asideProfileSyncSchema = z.object({
  allProfiles: z.boolean().optional(),
  profiles: z.record(
    z.string().regex(/^(0|[1-9][0-9]*)$/).refine(value => Number.isSafeInteger(Number(value))),
    z.boolean(),
  ).optional(),
  legacyProfileId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}).passthrough();

export const agentTaskRecoverySchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().trim().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  cacheEntries: z.number().int().min(1).max(512).optional(),
}).strict();

export const runtimeRoleSchema = z.enum(["standalone", "hub", "client"]);

function canonicalHttpOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export const managementIngressSchema = z.union([
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), port: z.number().int().min(1).max(65535) }).strict(),
]);

export const hubConfigSchema = z.object({
  managementPublicOrigin: z.string().transform((value, ctx) => {
    const origin = canonicalHttpOrigin(value);
    if (!origin) {
      ctx.addIssue({ code: "custom", message: "must be a canonical http(s) origin without credentials, path, query, or fragment" });
      return z.NEVER;
    }
    return origin;
  }).optional(),
  // Same canonical-origin rule as managementPublicOrigin, and deliberately NOT `.catch`ed:
  // a mistyped data origin must be rejected at write time, because silently dropping it
  // makes `ocx hub invite` print the `http://<hostname>:<port>` fallback that the operator
  // set this field precisely to replace.
  dataPublicOrigin: z.string().transform((value, ctx) => {
    const origin = canonicalHttpOrigin(value);
    if (!origin) {
      ctx.addIssue({ code: "custom", message: "must be a canonical http(s) origin without credentials, path, query, or fragment" });
      return z.NEVER;
    }
    return origin;
  }).optional(),
  // A malformed hand edit disables only the optional ingress. Live writes are rejected by
  // managementIngressConfigError before this load-time degradation can hide the mistake.
  managementIngress: managementIngressSchema.optional().catch(undefined),
}).strict();

const tailscaleUserSchema = z.string().trim().min(1).superRefine((value, ctx) => {
  if (new TextEncoder().encode(value).byteLength > 320) {
    ctx.addIssue({ code: "custom", message: "must be at most 320 UTF-8 bytes" });
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    ctx.addIssue({ code: "custom", message: "must not contain ASCII control characters" });
  }
});

export const remoteGuiConfigSchema = z.object({
  allowedTailscaleUsers: z.array(tailscaleUserSchema).max(64).superRefine((users, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < users.length; index++) {
      const user = users[index]!;
      if (seen.has(user)) {
        ctx.addIssue({ code: "custom", path: [index], message: "must contain unique users after trimming" });
      }
      seen.add(user);
    }
  }).optional(),
  // Retired (see OcxRemoteGuiConfig): accepted so an existing file still loads, ignored by
  // the pairing path. Removing it from a strict schema would reject the whole config.
  allowInsecureHttp: z.boolean().optional(),
}).strict();

const connectedClientIdSchema = z.enum(["codex", "claude"]);
const clientTimestampSchema = z.string().datetime({ offset: true });
const clientOriginSchema = z.string().transform((value, ctx) => {
  const origin = canonicalHttpOrigin(value);
  if (!origin) {
    ctx.addIssue({ code: "custom", message: "must be a canonical http(s) origin without credentials, path, query, or fragment" });
    return z.NEVER;
  }
  return origin;
});
export const clientConnectionSchema = z.object({
  serverUrl: clientOriginSchema,
  managementUrl: clientOriginSchema,
  managementTransport: z.enum(["direct", "relay"]),
  selectedClients: z.array(connectedClientIdSchema).min(1).max(2).superRefine((clients, ctx) => {
    if (new Set(clients).size !== clients.length) {
      ctx.addIssue({ code: "custom", message: "must contain unique client ids" });
    }
  }),
  tokenEnv: z.literal("OPENCODEX_API_AUTH_TOKEN"),
  apiKeyId: z.string().trim().min(1).max(256),
  tokenFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  protocolVersion: z.literal(1),
  connectedAt: clientTimestampSchema,
  catalogFingerprint: z.string().min(1).max(512).optional(),
  // base64 of the pre-connect catalog, or "" for "there was none". Bounded above the
  // catalog size cap so a legitimate snapshot round-trips.
  priorCatalog: z.string().max(64 * 1024 * 1024).optional(),
  catalogSyncedAt: clientTimestampSchema.optional(),
  pendingOperation: z.object({
    kind: z.literal("rotate"),
    rotationId: z.string().trim().min(1).max(256),
    newKeyIssuedAt: clientTimestampSchema,
    oldKeyBackupPath: z.string().min(1),
  }).strict().superRefine((operation, ctx) => {
    const expected = join(getConfigDir(), "service-api-token.prev");
    if (operation.oldKeyBackupPath !== expected) {
      ctx.addIssue({ code: "custom", path: ["oldKeyBackupPath"], message: `must equal ${expected}` });
    }
  }).optional(),
}).strict();

/**
 * Codex pool selection policy section.
 *
 * `.strict()` like its neighbour: a typo in an optional feature section should surface as a
 * rejected write rather than a silently ignored key that leaves the operator believing they
 * excluded something.
 */
export const codexPoolSchema = z.object({
  excludedPlans: z.array(z.string().trim().min(1)).optional(),
}).strict();

/**
 * Shape guard for the cross-element checks below. Zod runs an array-level check even
 * when an element failed its own validation, and a failed element is not the shape the
 * checker expects — reading `credentials.length` off it would throw out of `safeParse`
 * and take the whole config load with it. Those elements already carry their own issues.
 */
export function isCredentialGroupShape(value: unknown): value is { id: string; credentials: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const group = value as { id?: unknown; credentials?: unknown };
  return typeof group.id === "string"
    && Array.isArray(group.credentials)
    && group.credentials.every(member => typeof member === "string");
}

/**
 * Operator-declared quota domains (`pool.credentialGroups`).
 *
 * Loose enough to hand-write, strict enough that it cannot mean two things: unique group
 * ids, a non-empty member list, provider-qualified members, and each credential in at
 * most one group. Those are not tidiness rules. `classifyCredential` keys a declared
 * domain by group id, so a duplicate id or a credential listed twice merges two quota
 * domains the operator never said were one -- after which the pool counts real capacity
 * once and declines to rotate into it. A bare credential id is ambiguous for the same
 * reason ids are provider-scoped in the auth store, so members carry their provider.
 * {@link credentialGroupIssues} is the single definition, shared with the classifier.
 */
export const credentialGroupsSchema = z.array(z.object({
  id: z.string().trim().min(1),
  credentials: z.array(z.string().trim().min(1)).min(1),
  note: z.string().optional(),
})).superRefine((groups, ctx) => {
  if (!Array.isArray(groups) || !groups.every(isCredentialGroupShape)) return;
  for (const message of credentialGroupIssues(groups)) {
    ctx.addIssue({ code: "custom", message });
  }
});

/**
 * Quota-reset notification section.
 *
 * `.strict()` like its neighbour: a typo in an optional feature section should surface as a
 * rejected write rather than a silently ignored key that leaves the operator believing they
 * enabled something.
 *
 * `pollSeconds` admits 0 (passive-only, no timer) and the resolver clamps anything between 1
 * and the 60-second floor. Bounds live in the resolver rather than here so a hand-edited value
 * degrades to a sane one instead of discarding the whole section.
 */
export const quotaResetNotifySchema = z.object({
  enabled: z.boolean().optional(),
  kinds: z.array(z.enum(["scheduled", "surprise"])).optional(),
  pollSeconds: z.number().int().min(0).optional(),
  // `z.string().url()` accepts any scheme. The payload carries account identity and the hook
  // URL is frequently a bearer-equivalent secret, so an http: sink puts both in cleartext.
  webhookUrl: z.string().url().refine(
    value => { try { return new URL(value).protocol === "https:"; } catch { return false; } },
    { message: "webhookUrl must use https" },
  ).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  command: z.array(z.string()).optional(),
}).strict();

/**
 * Catalog auto-refresh section (issue #3630).
 *
 * `.strict()` like its neighbour: a typo in an optional feature section should surface as a
 * rejected write rather than a silently ignored key that leaves the operator believing they
 * enabled something.
 *
 * `intervalMinutes` admits 0 (configured but dormant, no timer) and the resolver clamps
 * anything between 1 and the 15-minute floor. Bounds live in the resolver rather than here
 * so a hand-edited value degrades to a sane one instead of discarding the whole section.
 * The 1440 ceiling keeps a hand edit from scheduling the refresh further out than a day,
 * which is operator error far more often than intent.
 */
export const catalogAutoRefreshSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(0).max(1440).optional(),
}).strict();

/**
 * One spend scope's ceiling.
 *
 * `.strict()` for the usual reason and one sharper one. Elsewhere a silently ignored key
 * leaves a feature off that the operator believed was on; here it leaves a BUDGET off, and a
 * budget nobody is enforcing looks exactly like a budget nobody has exceeded. That is #2106 --
 * an undeclared option accepted, persisted, and then read as its default -- aimed at spend.
 *
 * Only positive integers: 0 would read as "no tokens at all" and refuse every request under
 * the scope, which is never what writing a budget means. An operator who wants no ceiling
 * removes the key.
 */
const spendScopeSchema = z.object({
  maxTokens: z.number().int().positive().optional(),
}).strict();

/**
 * Durable spend ceilings (#4546).
 *
 * Absent, empty, and all-scopes-absent are the same thing: observe-only accounting. There is
 * no default ceiling anywhere in this section, deliberately.
 */
export const spendSchema = z.object({
  root: spendScopeSchema.optional(),
  identity: spendScopeSchema.optional(),
  pool: spendScopeSchema.optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
}).strict();
