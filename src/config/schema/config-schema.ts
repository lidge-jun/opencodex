import * as z from "zod/v4";
import {
  agentTaskRecoverySchema,
  catalogAutoRefreshSchema,
  clientConnectionSchema,
  CODEX_ACCOUNT_PIN_PATTERN,
  codexAccountPrioritiesSchema,
  salvageCodexAccountAutoSwitchThresholds,
  codexPoolSchema,
  codexQuotaAutoRefreshSchema,
  credentialGroupsSchema,
  hubConfigSchema,
  providerConfigSchema,
  quotaResetNotifySchema,
  remoteGuiConfigSchema,
  runtimeRoleSchema,
  spendSchema,
  configuredCodexPoolAccountIds,
  apiKeyEntrySchema,
  asideProfileSyncSchema,
  clientIntegrationsSchema,
  CODEX_ACCOUNT_NAMESPACE_ACCOUNT_ID_COLLISION_ERROR,
  codexAccountNamespacesSchema,
  modelPinnedEffortsSchema,
  compactionRoutingSchema,
  modelPreferHostedToolsConfigError,
  providerModelCostsConfigError,
  providerRelativeSendPathConfigError,
} from "./leaf-validators";
import { isValidProviderName, hasOwnProvider } from "../provider-name";
import {
  apiKeyTransportConfigError,
  booleanRecordConfigError,
  modelAdapterRecordConfigError,
  modelDisplayNamesConfigError,
  nonBlankStringArrayConfigError,
  positiveIntegerConfigError,
  positiveIntegerRecordConfigError,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  reasoningSummaryDeliveryRecordConfigError,
} from "../provider-validation";
import {
  CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR,
  codexAccountNamespaceForModel,
  codexProviderNamespaceKey,
  MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET,
} from "../../codex/account-namespace-match";
import { UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD } from "../../codex/upstream-host-health";
import { MIN_USAGE_LEDGER_MAX_BYTES } from "../../usage/retention-contract";
import { COMBO_NAMESPACE, comboConfigIssues } from "../../combos/types";
import { routingProfileIssues } from "../../routing/profile";
import { POLICY_NAMESPACE } from "../../routing/profile-namespace";
import { providerDestinationConfigError } from "../../lib/destination-policy";
import { redactSecretString } from "../../lib/redact";
import { openRouterRoutingConfigError } from "../../providers/openrouter-routing";
import { vercelGatewayRoutingConfigError } from "../../providers/vercel-gateway-routing";
import { type OcxApiKeyEntry, type OcxProviderConfig } from "../../types";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { modelAutoCompactTokenLimitsConfigError } from "../../providers/auto-compact-budget";
import { hasFastWireCapabilityConflict } from "../../providers/fastwire";
import { parseDesktopProfile } from "../../claude/desktop-profile";
import { DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES, MAX_APP_OWNED_MEMORY_BUDGET_MB, MIN_APP_OWNED_MEMORY_BUDGET_MB } from "../../lib/app-owned-memory";

export const configSchema = z.object({
  codexNativeSteering: z.boolean().optional().catch(false),
  codexNativeInjection: z.boolean().optional().catch(false),
  port: z.number().int().min(0).max(65535).default(10100),
  // A malformed hand edit must disable only remote-role behavior, not discard
  // providers or data-plane keys. Live writes are rejected explicitly below.
  runtimeRole: runtimeRoleSchema.optional().catch(undefined),
  // Malformed optional remote blocks disable only remote GUI behavior. Live
  // candidates are rejected explicitly by remoteGuiConfigError below.
  hub: hubConfigSchema.optional().catch(undefined),
  remoteGui: remoteGuiConfigSchema.optional().catch(undefined),
  // A malformed privacy block must never be read as "unmask": .catch(undefined) drops it and
  // emailMaskingEnabled then falls back to masked, which is also what an absent block means.
  privacy: z.object({ maskEmails: z.boolean().optional() }).strict().optional().catch(undefined),
  // Malformed hand edits disable this opt-in exporter. Live writes reject them in diagnostics.ts.
  metricsExport: z.object({ enabled: z.boolean().optional() }).strict().optional().catch(undefined),
  // A malformed present client block must remain diagnosable from raw config and
  // fail closed through src/client/state.ts; unrelated provider state still loads.
  client: clientConnectionSchema.optional().catch(undefined),
  managementUsageMaxReadBytes: z.number().int().positive().default(64 * 1024 * 1024).describe(
    "Deprecated compatibility limit for bounded legacy usage readers; GET /api/usage always aggregates the complete ledger",
  ),
  // Opt-in ledger ceiling. A hand edit below the floor, or a non-safe integer, disables only
  // this limit rather than failing the config: refusing to start because history retention was
  // mistyped would be a worse outcome than not trimming history.
  usageLedgerMaxBytes: z.number().int()
    .min(MIN_USAGE_LEDGER_MAX_BYTES)
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .catch(undefined),
  // Invalid hand edits disable only this opt-in circuit. Live writes remain strict.
  upstreamHostCircuitThreshold: z.number().int()
    .min(0)
    .max(UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD)
    .optional()
    .catch(undefined),
  // Opt-in outbound body ceiling. An invalid hand edit disables only this guard, matching the
  // circuit threshold above: a malformed number must not make the proxy refuse traffic.
  maxUpstreamBodyBytes: z.number().int()
    .min(0)
    .optional()
    .catch(undefined),
  // Opt-in inbound body ceiling (#3573). An invalid hand edit degrades to the 256 MiB default
  // rather than failing the parse, matching the outbound guard above: a malformed number must
  // not change what the proxy admits. The hard ceiling is NOT enforced here — because of that
  // `.catch`, and because a config object can be built without this schema at all — but in
  // `resolveInboundBodyLimitBytes()`, which every reader goes through.
  maxInboundBodyBytes: z.number().int()
    .min(0)
    .optional()
    .catch(undefined),
  appOwnedMemoryBudgetMb: z.number().int()
    .min(MIN_APP_OWNED_MEMORY_BUDGET_MB)
    .max(MAX_APP_OWNED_MEMORY_BUDGET_MB)
    .default(DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES / (1024 * 1024))
    .catch(DEFAULT_APP_OWNED_MEMORY_BUDGET_BYTES / (1024 * 1024)),
  // A blank hostname degrades to undefined rather than failing the parse. `getDefaultConfig()`
  // carries no `hostname` key, so the backup-and-defaults repair path below cannot merge one
  // away — a hand-edited `"hostname": ""` would fail twice and reset providers/apiKeys to
  // defaults, which is strictly worse than the bind bug this validation exists for. Degrading
  // is safe: startServer() already falls back to 127.0.0.1 for a missing hostname. Write-time
  // rejection lives in validateConfigCandidate() so bad values still surface to the caller.
  hostname: z.string().trim().min(1).optional().catch(undefined),
  // Discriminated on `enabled` so a disabled entry cannot be forced to carry a port (#1102).
  // An enabled one MAY omit it: that is the companion form, which binds 127.0.0.1 on the proxy
  // port and is legal only off a loopback/wildcard bind — a relationship between two fields, so
  // it is enforced in validateConfigCandidate() and again at startup, not here (#4236).
  // A malformed value degrades to undefined rather than failing the whole parse: this is an
  // opt-in convenience surface, and a hand-edit typo here must never reset providers/apiKeys
  // through the backup-and-defaults repair path.
  unauthenticatedLoopbackListener: z.union([
    z.object({ enabled: z.literal(false) }),
    z.object({ enabled: z.literal(true), port: z.number().int().min(1).max(65535).optional() }),
  ]).optional().catch(undefined),
  providers: z.record(z.string(), providerConfigSchema),
  modelPinnedEfforts: modelPinnedEffortsSchema.optional(),
  compactionRouting: compactionRoutingSchema.optional().catch(undefined),
  defaultProvider: z.string().min(1).default("openai"),
  defaultModelAliases: z.boolean().optional(),
  // Malformed hand edits disable this opt-in projection without rejecting providers.
  cursorEffortRows: z.boolean().optional().catch(false),
  // Fast selectors default on; malformed hand edits disable them without rejecting providers.
  fastRows: z.boolean().default(true).catch(false),
  // Ultra Fast is opt-in for the same reason and degrades the same way: a malformed hand
  // edit turns the tier off rather than rejecting the config that carries it.
  ultraFastTier: z.boolean().optional().catch(false),
  codexMainAccountHardLock: z.boolean().optional().catch(false),
  // Future versions remain opaque through passthrough-compatible whole-config saves.
  // Only version 1 grants deletion authority in the rebase path.
  configRebaseProvenance: z.unknown().optional(),
  // A retry can be billable, so absence and malformed hand edits both stay off.
  emptyCompletionRetry: z.boolean().optional().catch(false),
  // Header suppression changes what Codex sees, so absence and malformed edits stay off.
  dropCodexSafetyBuffering: z.boolean().optional().catch(false),
  // A malformed hand edit must not silently stop opening the browser: fall back
  // to undefined, which resolves to the historical auto-open behavior.
  oauthOpenBrowser: z.boolean().optional().catch(undefined),
  openaiProviderTierVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  // Invalid hand edits must not discard an otherwise usable config.
  googleAntigravityStaticCatalogVersion: z.union([z.literal(1), z.literal(2)]).optional().catch(undefined),
  subagentModelsVersion: z.number().int().positive().optional().catch(undefined),
  subagentModels: z.array(z.string().min(1)).optional().catch(undefined),
  // A hand-edited advisory version must not cost the operator their providers; a bad
  // value degrades to undefined, which simply raises the notice again.
  multiAgentSurfaceAdvisoryVersion: z.number().int().nonnegative().optional().catch(undefined),
  clientIntegrations: clientIntegrationsSchema.optional().catch(undefined),
  // A malformed profile policy must not fall back to legacy all-profile activation.
  asideProfileSync: asideProfileSyncSchema.optional().catch({ allProfiles: false }),
  providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
  providerContextCapValues: z.record(z.string(), z.number().int().positive()).optional(),
  contextCapValue: z.number().int().positive().optional(),
  multiAgentGuidanceEnabled: z.boolean().optional(),
  // Invalid optional recovery config must not discard unrelated provider/account state.
  plaintextV2AgentMessages: z.boolean().optional().catch(undefined),
  agentTaskRecovery: agentTaskRecoverySchema.optional().catch(undefined),
  // Same rationale: a bad notify section must not cost the operator their providers.
  quotaResetNotify: quotaResetNotifySchema.optional().catch(undefined),
  // Same rationale: a bad auto-refresh section must not cost the operator their providers.
  catalogAutoRefresh: catalogAutoRefreshSchema.optional().catch(undefined),
  // Same rationale again, with the failure direction stated: a malformed spend section
  // degrades to "no ceiling", which means observe-only accounting rather than an outage. That
  // is the safe degrade for traffic and the dangerous one for the operator, so the write path
  // rejects it and loadConfig warns -- the same pair codexPool uses below.
  spend: spendSchema.optional().catch(undefined),
  // These selections pre-date schema validation and used to pass through as
  // unknown fields. Invalid hand edits must disable only the optional
  // delegation/native-default feature, not reject the whole config and hide
  // otherwise valid providers, accounts, or the configured listen port.
  injectionModel: z.string().optional().catch(undefined),
  injectionEffort: z.string().optional().catch(undefined),
  syncCodexSubagentDefaults: z.boolean().optional().catch(undefined),
  // Per-primary-model fallback chains. Values must be non-empty string arrays;
  // malformed entries degrade to undefined rather than rejecting the whole config.
  subagentModelFallbackByModel: z.record(
    z.string(),
    z.array(z.string().trim().min(1)).min(1),
  ).optional().catch(undefined),
  codexShimAutoRestore: z.boolean().optional(),
  codexDesktopAuthless: z.boolean().optional().catch(undefined),
  codexClientCompaction: z.boolean().optional().catch(undefined),
  // Presentation-only label for the injected provider. A malformed value degrades to undefined
  // and the default label is emitted, rather than failing the parse or writing a config Codex
  // would refuse to load — the provider id routing depends on is never derived from it.
  codexProviderDisplayName: z.string().trim().min(1).max(128).optional().catch(undefined),
  pausedCodexAccountIds: z.array(z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/)).optional(),
  // A malformed policy degrades to "no policy" rather than failing the parse, so a hand-edited
  // typo cannot trip the backup-and-defaults repair path and wipe providers or pool accounts.
  // Silently ignoring it would be its own trap, so the write path rejects it and loadConfig warns.
  codexPool: codexPoolSchema.optional().catch(undefined),
  codexQuotaAutoRefresh: codexQuotaAutoRefreshSchema.optional().catch(undefined),
  codexAccountNamespaces: codexAccountNamespacesSchema.optional(),
  // Selection order is a preference, not a safety control like pause: a malformed
  // map degrades to "no ordering" rather than failing the parse, so a hand-edited
  // typo cannot trip the backup-and-defaults repair path and wipe providers or
  // pool accounts. Warning emitted in loadConfig.
  codexAccountPriorities: codexAccountPrioritiesSchema.optional().catch(undefined),
  // A bad hand-edited entry must not retire valid overrides on the next unrelated save.
  codexAccountAutoSwitchThresholds: z.unknown().optional().transform(salvageCodexAccountAutoSwitchThresholds),
  // An invalid optional preference must not discard providers or credential rows.
  codexAccountPriorityFailback: z.boolean().optional().catch(false),
  activeCodexAccountPinned: z.string().regex(CODEX_ACCOUNT_PIN_PATTERN).optional().catch(undefined),
  // A malformed hand edit must degrade to false without discarding providers, accounts,
  // or the exact selector map. Live writes remain strict.
  codexAccountPickerEnabled: z.boolean().optional().catch(false),
  resetCreditAutoRedeem: z.object({
    enabled: z.boolean().optional(),
    leadTimeMinutes: z.number().int().min(1).max(60).optional(),
  }).optional().catch(undefined),
  // Same degrade-to-off rule as the flags above: a hand-edited typo in an opt-in pool
  // feature must never cost the operator their providers.
  pool: z.object({
    kernel: z.boolean().optional(),
    cacheAffinity: z.boolean().optional(),
    // The catch belongs on the list, not on `pool`. Left to the outer catch below, one
    // malformed group failed this nested object and dropped the whole `pool` -- taking
    // `kernel` and `cacheAffinity` with it, which is a live routing change the operator
    // never made. Scoped here, a malformed or ambiguous group costs only the declared
    // grouping: loadConfig warns, and the write path rejects it outright.
    credentialGroups: credentialGroupsSchema.optional().catch(undefined),
  }).optional().catch(undefined),
  // Model ids excluded from the Grok Build managed block (dashboard switches).
  grokExcludedModels: z.array(z.string()).optional(),
  // Invalid values degrade to undefined ("auto") instead of failing the whole
  // parse: a hand-edited typo must never trip the backup-and-defaults repair
  // path below and wipe providers/pool accounts. Warning emitted in loadConfig.
  streamMode: z.enum(["auto", "legacy-tee", "eager-relay"]).optional().catch(undefined),
  blockedModelRedirects: z.record(z.string(), z.string()).optional().catch(undefined),
  // Same degrade-don't-reject rationale as the fields above: a hand-edited
  // non-string must not trip the backup-and-defaults repair path. Unset then
  // takes the canonical sideband path (src/server/live.ts normalizeSidebandRoot).
  experimentalRealtimeWsBaseUrl: z.string().optional().catch(undefined),
  // Salvage element by element, and never fail the parse. Two spellings were
  // measured on this zod version and both lose data:
  //   `z.array(entry).catch(undefined)` -> one bad entry discards EVERY key
  //   `z.array(z.unknown())`            -> a non-array value still raises
  //                                        invalid_type, reaching the
  //                                        backup-and-defaults repair path
  // Starting from `unknown` is what makes both survivable. A key the user still
  // has deployed must not be collateral damage for one bad neighbour, and on a
  // remote bind an emptied array is worse than cosmetic: assertServerAuthConfig
  // refuses to start without a data credential.
  apiKeys: z.unknown().optional().transform(value => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return undefined;
    return value
      .filter(row => apiKeyEntrySchema.safeParse(row).success)
      .map(row => apiKeyEntrySchema.parse(row) as OcxApiKeyEntry);
  }),
}).passthrough().superRefine((config, ctx) => {
  const claudeCode = (config as { claudeCode?: unknown }).claudeCode;
  if (claudeCode !== undefined && (!claudeCode || typeof claudeCode !== "object" || Array.isArray(claudeCode))) {
    ctx.addIssue({ code: "custom", path: ["claudeCode"], message: "claudeCode must be an object" });
  } else if (claudeCode) {
    const claude = claudeCode as { desktopProfile?: unknown; desktopMode?: unknown; intercept?: unknown };
    if (claude.desktopMode !== undefined && claude.desktopMode !== "first-party" && claude.desktopMode !== "gateway") {
      ctx.addIssue({ code: "custom", path: ["claudeCode", "desktopMode"], message: "desktopMode must be \"first-party\" or \"gateway\"" });
    }
    if (claude.intercept !== undefined) {
      const intercept = claude.intercept;
      if (!intercept || typeof intercept !== "object" || Array.isArray(intercept)) {
        ctx.addIssue({ code: "custom", path: ["claudeCode", "intercept"], message: "intercept must be an object" });
      } else {
        const { enabled, port } = intercept as { enabled?: unknown; port?: unknown };
        if (enabled !== undefined && typeof enabled !== "boolean") {
          ctx.addIssue({ code: "custom", path: ["claudeCode", "intercept", "enabled"], message: "intercept.enabled must be a boolean" });
        }
        if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
          ctx.addIssue({ code: "custom", path: ["claudeCode", "intercept", "port"], message: "intercept.port must be an integer between 1 and 65535" });
        }
      }
    }
    if (claude.desktopProfile !== undefined) {
      try {
        parseDesktopProfile(claude.desktopProfile);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["claudeCode", "desktopProfile"],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const accountNamespaces = config.codexAccountNamespaces;
  if (accountNamespaces) {
    const configuredAccountIds = configuredCodexPoolAccountIds(config.codexAccounts);
    const configuredProviderNamespaces = new Set([
      COMBO_NAMESPACE,
      OPENAI_CODEX_PROVIDER_ID,
      POLICY_NAMESPACE,
      ...Object.keys(config.providers),
    ].map(codexProviderNamespaceKey));
    const namespaceTargets = new Set(
      Object.values(accountNamespaces)
        .filter(accountId => accountId !== MAIN_CODEX_ACCOUNT_NAMESPACE_TARGET),
    );
    for (const namespace of Object.keys(accountNamespaces)) {
      if (configuredProviderNamespaces.has(codexProviderNamespaceKey(namespace))) {
        ctx.addIssue({
          code: "custom",
          path: ["codexAccountNamespaces", namespace],
          message: "account selectors must not collide with configured provider, combo, or routing policy namespaces",
        });
      }
      if (configuredAccountIds.has(namespace) || namespaceTargets.has(namespace)) {
        ctx.addIssue({
          code: "custom",
          path: ["codexAccountNamespaces", namespace],
          message: CODEX_ACCOUNT_NAMESPACE_ACCOUNT_ID_COLLISION_ERROR,
        });
      }
    }
  }
  for (const name of Object.keys(config.providers)) {
    if (!isValidProviderName(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name)],
        message: "provider names must use letters, numbers, dot, underscore, or hyphen and cannot be reserved JavaScript object keys or routing namespaces (policy)",
      });
    }
    const provider = config.providers[name];
    if (hasFastWireCapabilityConflict(provider)) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "fastWire"],
        message: "fastWire=null conflicts with supportsServiceTier=true",
      });
    }
    const openRouterRoutingError = openRouterRoutingConfigError(provider);
    if (openRouterRoutingError) {
      ctx.addIssue({
        code: "custom",
        path: [
          "providers",
          redactSecretString(name),
          openRouterRoutingError.startsWith("modelOpenRouterRouting")
            ? "modelOpenRouterRouting"
            : "openRouterRouting",
        ],
        message: openRouterRoutingError,
      });
    }
    const vercelRoutingError = vercelGatewayRoutingConfigError(provider);
    if (vercelRoutingError) {
      ctx.addIssue({
        code: "custom",
        path: [
          "providers",
          redactSecretString(name),
          vercelRoutingError.startsWith("modelVercelGatewayRouting")
            ? "modelVercelGatewayRouting"
            : "vercelGatewayRouting",
        ],
        message: vercelRoutingError,
      });
    }
    if (Object.hasOwn(provider, "virtualModels")) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "virtualModels"],
        message: "virtualModels is registry-only and must not be persisted",
      });
    }
    const baseUrlError = providerBaseUrlConfigError(provider.baseUrl);
    if (baseUrlError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "baseUrl"],
        message: baseUrlError,
      });
    } else {
      const destinationError = providerDestinationConfigError(name, provider);
      if (destinationError) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", redactSecretString(name), "baseUrl"],
          message: destinationError,
        });
      }
    }
    for (const field of ["responsesPath", "chatCompletionsPath"] as const) {
      const sendPathError = providerRelativeSendPathConfigError(field, provider[field]);
      if (sendPathError) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", redactSecretString(name), field],
          message: sendPathError,
        });
      }
    }
    const headersError = providerHeadersConfigError((provider as { headers?: unknown }).headers);
    if (headersError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "headers"],
        message: headersError,
      });
    }
    const modelCostsError = providerModelCostsConfigError((provider as { modelCosts?: unknown }).modelCosts);
    if (modelCostsError) {
      ctx.addIssue({
        code: "custom",
        // The provider key is caller-controlled and can be token-shaped; redact it
        // before schemaDiagnosticsError serializes the path (ocx config validate/import).
        path: ["providers", redactSecretString(name), "modelCosts"],
        message: modelCostsError,
      });
    }
    const modelDisplayNamesError = modelDisplayNamesConfigError(
      (provider as { modelDisplayNames?: unknown }).modelDisplayNames,
    );
    if (modelDisplayNamesError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelDisplayNames"],
        message: modelDisplayNamesError,
      });
    }
    const apiKeyTransportError = apiKeyTransportConfigError(provider as OcxProviderConfig);
    if (apiKeyTransportError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "apiKeyTransport"],
        message: apiKeyTransportError,
      });
    }
    const modelAdaptersError = modelAdapterRecordConfigError(
      (provider as { modelAdapters?: unknown }).modelAdapters,
      "modelAdapters",
      name,
      provider,
    );
    if (modelAdaptersError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelAdapters"],
        message: modelAdaptersError,
      });
    }
    const preferHostedToolsError = modelPreferHostedToolsConfigError(
      (provider as { modelPreferHostedTools?: unknown }).modelPreferHostedTools,
      "modelPreferHostedTools",
      name,
      provider,
    );
    if (preferHostedToolsError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelPreferHostedTools"],
        message: preferHostedToolsError,
      });
    }
    const maxInputError = positiveIntegerRecordConfigError(
      (provider as { modelMaxInputTokens?: unknown }).modelMaxInputTokens,
      "modelMaxInputTokens",
    );
    if (maxInputError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelMaxInputTokens"],
        message: maxInputError,
      });
    }
    const autoCompactError = modelAutoCompactTokenLimitsConfigError(
      (provider as { modelAutoCompactTokenLimits?: unknown }).modelAutoCompactTokenLimits,
      { requireNativeIds: name === OPENAI_CODEX_PROVIDER_ID },
    );
    if (autoCompactError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelAutoCompactTokenLimits"],
        message: autoCompactError,
      });
    }
    const reasoningSummariesError = booleanRecordConfigError(
      (provider as { modelSupportsReasoningSummaries?: unknown }).modelSupportsReasoningSummaries,
      "modelSupportsReasoningSummaries",
    );
    if (reasoningSummariesError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelSupportsReasoningSummaries"],
        message: reasoningSummariesError,
      });
    }
    const suppressSyntheticMaxError = booleanRecordConfigError(
      (provider as { modelSuppressSyntheticMax?: unknown }).modelSuppressSyntheticMax,
      "modelSuppressSyntheticMax",
    );
    if (suppressSyntheticMaxError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelSuppressSyntheticMax"],
        message: suppressSyntheticMaxError,
      });
    }
    const verbositySupportError = booleanRecordConfigError(
      (provider as { modelSupportsVerbosity?: unknown }).modelSupportsVerbosity,
      "modelSupportsVerbosity",
    );
    if (verbositySupportError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelSupportsVerbosity"],
        message: verbositySupportError,
      });
    }
    const serviceTierModelsError = booleanRecordConfigError(
      (provider as { modelSupportsServiceTier?: unknown }).modelSupportsServiceTier,
      "modelSupportsServiceTier",
    );
    if (serviceTierModelsError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelSupportsServiceTier"],
        message: serviceTierModelsError,
      });
    }
    const reasoningSummaryDeliveryError = reasoningSummaryDeliveryRecordConfigError(
      (provider as { modelReasoningSummaryDelivery?: unknown }).modelReasoningSummaryDelivery,
      (provider as { modelSupportsReasoningSummaries?: unknown }).modelSupportsReasoningSummaries,
    );
    if (reasoningSummaryDeliveryError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelReasoningSummaryDelivery"],
        message: reasoningSummaryDeliveryError,
      });
    }
    const defaultMaxOutputError = positiveIntegerConfigError(
      (provider as { defaultMaxOutputTokens?: unknown }).defaultMaxOutputTokens,
      "defaultMaxOutputTokens",
    );
    if (defaultMaxOutputError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "defaultMaxOutputTokens"],
        message: defaultMaxOutputError,
      });
    }
    const maxOutputError = positiveIntegerRecordConfigError(
      (provider as { modelMaxOutputTokens?: unknown }).modelMaxOutputTokens,
      "modelMaxOutputTokens",
    );
    if (maxOutputError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "modelMaxOutputTokens"],
        message: maxOutputError,
      });
    }
    const structuredOutputOptOutError = nonBlankStringArrayConfigError(
      (provider as { noStructuredOutputModels?: unknown }).noStructuredOutputModels,
      "noStructuredOutputModels",
    );
    if (structuredOutputOptOutError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "noStructuredOutputModels"],
        message: structuredOutputOptOutError,
      });
    }
    const jsonSchemaOptOutError = nonBlankStringArrayConfigError(
      (provider as { noJsonSchemaModels?: unknown }).noJsonSchemaModels,
      "noJsonSchemaModels",
    );
    if (jsonSchemaOptOutError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "noJsonSchemaModels"],
        message: jsonSchemaOptOutError,
      });
    }
    const retainModelsError = nonBlankStringArrayConfigError(
      (provider as { retainModels?: unknown }).retainModels,
      "retainModels",
    );
    if (retainModelsError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "retainModels"],
        message: retainModelsError,
      });
    }
    const toolReasoningOptOutError = nonBlankStringArrayConfigError(
      (provider as { omitReasoningEffortWithToolsModels?: unknown }).omitReasoningEffortWithToolsModels,
      "omitReasoningEffortWithToolsModels",
    );
    if (toolReasoningOptOutError) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", redactSecretString(name), "omitReasoningEffortWithToolsModels"],
        message: toolReasoningOptOutError,
      });
    }
    if (Object.hasOwn(provider, "codexAccountMode") && provider.codexAccountMode !== undefined) {
      // Persisted account mode is valid ONLY on the canonical built-in `openai` forward provider.
      // Old openai-multi rows stay parseable (they never carry a mode) so startup can migrate them.
      const canonicalOpenAiShape = name === "openai"
        && provider.adapter === "openai-responses"
        && (provider as { authMode?: unknown }).authMode === "forward"
        && typeof provider.baseUrl === "string"
        && provider.baseUrl.replace(/\/+$/, "") === "https://chatgpt.com/backend-api/codex";
      if (!canonicalOpenAiShape) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", redactSecretString(name), "codexAccountMode"],
          message: "codexAccountMode is valid only on the canonical built-in openai provider",
        });
      }
    }
  }
  if (!hasOwnProvider(config.providers, config.defaultProvider)) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultProvider"],
      message: "defaultProvider must exist in providers",
    });
  }
  const combos = (config as { combos?: unknown }).combos;
  if (combos !== undefined) {
    if (!combos || typeof combos !== "object" || Array.isArray(combos)) {
      ctx.addIssue({ code: "custom", path: ["combos"], message: "combos must be an object" });
    } else {
      for (const [id, raw] of Object.entries(combos as Record<string, unknown>)) {
        const alias = raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as { alias?: unknown }).alias
          : undefined;
        if (typeof alias === "string" && codexAccountNamespaceForModel(accountNamespaces, alias.trim())) {
          ctx.addIssue({
            code: "custom",
            path: ["combos", id, "alias"],
            message: CODEX_ACCOUNT_NAMESPACE_COMBO_ALIAS_COLLISION_ERROR,
          });
        }
        // Pass the full map so cross-combo rules (alias uniqueness) apply at load time
        // too, not just via the management API; each combo is excluded from its own check.
        for (const issue of comboConfigIssues(id, raw, config.providers, {
          combos: combos as Record<string, import("../../types").OcxComboConfig>,
          excludeComboId: id,
        })) {
          ctx.addIssue({
            code: "custom",
            path: ["combos", id, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  }
  const routingProfiles = (config as { routingProfiles?: unknown }).routingProfiles;
  if (routingProfiles !== undefined) {
    if (!routingProfiles || typeof routingProfiles !== "object" || Array.isArray(routingProfiles)) {
      ctx.addIssue({ code: "custom", path: ["routingProfiles"], message: "routingProfiles must be an object" });
    } else {
      for (const [id, raw] of Object.entries(routingProfiles as Record<string, unknown>)) {
        for (const issue of routingProfileIssues(id, raw, {
          providers: config.providers,
          combos: combos as Record<string, import("../../types").OcxComboConfig> | undefined,
          routingProfiles: routingProfiles as Record<string, import("../../types").OcxRoutingProfileConfig>,
          codexAccountNamespaces: accountNamespaces,
        }, { excludeProfileId: id })) {
          ctx.addIssue({
            code: "custom",
            path: ["routingProfiles", id, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  }
});
