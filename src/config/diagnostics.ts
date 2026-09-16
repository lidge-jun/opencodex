import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import type { OcxConfig } from "../types";
import { configReasoningPinsConfigError } from "./provider-validation";
import { loopbackCompanionAllowed } from "../codex/loopback-target";
import { UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD } from "../codex/upstream-host-health";
import { MAX_APP_OWNED_MEMORY_BUDGET_MB, MIN_APP_OWNED_MEMORY_BUDGET_MB } from "../lib/app-owned-memory";
import { isMissingPathError } from "./atomic-write";
import { getConfigPath } from "./paths";
import { getDefaultConfig } from "./proxy-env";
import { salvageConfigCandidate } from "./salvage";
import {
  sanitizeReasoningPinsForLoad,
  sanitizeRetryOn429ForLoad,
  sanitizeCapabilityDeclarationsForLoad,
  sanitizeModelCostsForLoad,
  sanitizeAutoReviewForLoad,
  degradedListenerWarnings,
  degradedCodexAccountPriorityWarnings,
  degradedCodexQuotaAutoRefreshWarning,
  normalizeApiKeyIds,
  CLAUDE_SUBAGENT_EFFORTS,
  isClaudeSubagentEffort,
  rawClaudeSubagentEffort,
  normalizeClaudeSubagentEffort,
  malformedUpstreamHostCircuitThresholdWarning,
  malformedPlaintextV2AgentMessagesWarning,
  malformedAgentTaskRecoveryWarning,
  malformedRuntimeRoleWarning,
  malformedOptionalRemoteBlockWarning,
  malformedClientConnectionWarning,
  malformedQuotaResetNotifyWarning,
  malformedCatalogAutoRefreshWarning,
  malformedCodexPoolWarning,
  rawConfigRecord,
  malformedNativeSubagentFields,
  malformedNativeSubagentFieldWarning,
  malformedCodexAccountPickerWarning,
  nativeSubagentSyncDisabledReason,
  normalizeNativeSubagentSync,
  inheritedFastWireConflictProviderNames,
  inheritedFastWireConflictWarning,
  sanitizeModelDisplayNamesForLoad,
} from "./load-degrade";
import { configSchema } from "./schema/config-schema";
import {
  agentTaskRecoverySchema,
  catalogAutoRefreshSchema,
  clientConnectionSchema,
  CODEX_ACCOUNT_PIN_PATTERN,
  codexAccountPrioritiesSchema,
  codexPoolSchema,
  codexQuotaAutoRefreshSchema,
  credentialGroupsSchema,
  hubConfigSchema,
  quotaResetNotifySchema,
  remoteGuiConfigSchema,
  runtimeRoleSchema,
  manualCompactionSchema,
} from "./schema/leaf-validators";

export type ConfigDiagnostics = {
  config: OcxConfig;
  source: "default" | "file" | "fallback";
  error: string | null;
  /** Non-fatal config concerns; absent when there are no warnings. */
  warnings?: string[];
};

export type ConfigFileSnapshot = {
  diagnostics: ConfigDiagnostics;
  /** Exact file contents, including a possible BOM, used as the optimistic revision. */
  raw?: string;
};

function configPlaceholderWarnings(config: OcxConfig): string[] {
  const warnings: string[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    const placeholder = provider.baseUrl.match(/\{[^}]*\}/)?.[0];
    if (placeholder) {
      warnings.push(`providers.${name}.baseUrl contains unresolved ${placeholder}; set the real provider URL`);
    }
  }
  return warnings;
}

function validFileConfigDiagnostics(config: OcxConfig, rawParsed: unknown): ConfigDiagnostics {
  // Unsafe hand-edited optional values are disabled in memory instead of rejecting
  // the entire config, which would hide unrelated providers/accounts. The next
  // ordinary save persists the normalized absence.
  const syncDisabledReason = nativeSubagentSyncDisabledReason(config, rawParsed);
  const rawEffort = rawClaudeSubagentEffort(rawParsed);
  const normalized = normalizeClaudeSubagentEffort(normalizeNativeSubagentSync(config, rawParsed), rawParsed);
  const warnings = configPlaceholderWarnings(normalized);
  warnings.push(...inheritedFastWireConflictProviderNames(normalized).map(inheritedFastWireConflictWarning));
  warnings.push(...degradedCodexAccountPriorityWarnings(rawParsed, normalized));
  warnings.push(...degradedListenerWarnings(rawParsed, normalized));
  const quotaAutoRefreshWarning = degradedCodexQuotaAutoRefreshWarning(rawParsed, normalized);
  if (quotaAutoRefreshWarning) warnings.push(quotaAutoRefreshWarning);
  if (rawEffort !== undefined && !isClaudeSubagentEffort(rawEffort)) {
    warnings.push(`claudeCode.subagentEffort ignored: expected one of ${CLAUDE_SUBAGENT_EFFORTS.join(", ")}`);
  }
  warnings.push(...malformedNativeSubagentFields(rawParsed).map(malformedNativeSubagentFieldWarning));
  const pickerWarning = malformedCodexAccountPickerWarning(rawParsed);
  if (pickerWarning) warnings.push(pickerWarning);
  const hostCircuitWarning = malformedUpstreamHostCircuitThresholdWarning(rawParsed);
  if (hostCircuitWarning) warnings.push(hostCircuitWarning);
  const recoveryWarning = malformedAgentTaskRecoveryWarning(rawParsed);
  if (recoveryWarning) warnings.push(recoveryWarning);
  const runtimeRoleWarning = malformedRuntimeRoleWarning(rawParsed);
  if (runtimeRoleWarning) warnings.push(runtimeRoleWarning);
  const hubWarning = malformedOptionalRemoteBlockWarning(rawParsed, "hub");
  if (hubWarning) warnings.push(hubWarning);
  const remoteGuiWarning = malformedOptionalRemoteBlockWarning(rawParsed, "remoteGui");
  if (remoteGuiWarning) warnings.push(remoteGuiWarning);
  const clientWarning = malformedClientConnectionWarning(rawParsed);
  if (clientWarning) warnings.push(clientWarning);
  const notifyWarning = malformedQuotaResetNotifyWarning(rawParsed);
  if (notifyWarning) warnings.push(notifyWarning);
  const catalogRefreshWarning = malformedCatalogAutoRefreshWarning(rawParsed);
  if (catalogRefreshWarning) warnings.push(catalogRefreshWarning);
  const codexPoolWarning = malformedCodexPoolWarning(rawParsed);
  if (codexPoolWarning) warnings.push(codexPoolWarning);
  const plaintextWarning = malformedPlaintextV2AgentMessagesWarning(rawParsed);
  if (plaintextWarning) warnings.push(plaintextWarning);
  if (syncDisabledReason) {
    warnings.push(`syncCodexSubagentDefaults ignored: ${syncDisabledReason}`);
  }
  return {
    config: normalized,
    source: "file",
    error: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function subagentDefaultSyncEffective(
  config: Pick<OcxConfig, "syncCodexSubagentDefaults" | "injectionModel">,
): boolean {
  return config.syncCodexSubagentDefaults === true && Boolean(config.injectionModel?.trim());
}

export function mergeConfigDefaults(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const defaults = getDefaultConfig();
  const raw = parsed as Record<string, unknown>;
  // Same absence-is-meaningful pin as the repair merge above.
  const merged: Record<string, unknown> = {
    ...defaults,
    ...raw,
    subagentModelsVersion: raw.subagentModelsVersion,
    multiAgentMode: raw.multiAgentMode,
    multiAgentSurfaceAdvisoryVersion: raw.multiAgentSurfaceAdvisoryVersion,
  };
  if (raw.providers && typeof raw.providers === "object" && defaults.providers) {
    merged.providers = { ...defaults.providers, ...(raw.providers as Record<string, unknown>) };
  }
  return merged;
}

function schemaDiagnosticsError(error: z.ZodError): string {
  const details = error.issues.map(issue => {
    const path = issue.path.join(".") || "config";
    return `${path}: ${issue.message}`;
  });
  return details.length > 0 ? `schema_invalid: ${details.join("; ")}` : "schema_invalid";
}

/**
 * Reject a hostname the schema deliberately degrades on read. Load-time has to keep a
 * blank value non-fatal (see the `hostname` field comment), but an incoming write is a
 * live caller who can be told the value is wrong — silently rewriting it to loopback
 * would look like the bind succeeded on the address they asked for.
 */
function blankHostnameError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hostname = (value as Record<string, unknown>).hostname;
  if (hostname === undefined) return null;
  if (typeof hostname !== "string" || !hostname.trim()) {
    return "schema_invalid: hostname: must be a nonblank bind address";
  }
  return null;
}

function claudeSubagentEffortError(value: unknown): string | null {
  const effort = rawClaudeSubagentEffort(value);
  if (effort === undefined || isClaudeSubagentEffort(effort)) return null;
  return `schema_invalid: claudeCode.subagentEffort: must be one of ${CLAUDE_SUBAGENT_EFFORTS.join(", ")}`;
}

function appOwnedMemoryBudgetError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const budget = (value as Record<string, unknown>).appOwnedMemoryBudgetMb;
  if (budget === undefined) return null;
  if (typeof budget !== "number" || !Number.isInteger(budget)
    || budget < MIN_APP_OWNED_MEMORY_BUDGET_MB || budget > MAX_APP_OWNED_MEMORY_BUDGET_MB) {
    return `schema_invalid: appOwnedMemoryBudgetMb: must be an integer from ${MIN_APP_OWNED_MEMORY_BUDGET_MB} to ${MAX_APP_OWNED_MEMORY_BUDGET_MB}`;
  }
  return null;
}

function upstreamHostCircuitThresholdError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "upstreamHostCircuitThreshold")) return null;
  const threshold = raw.upstreamHostCircuitThreshold;
  if (threshold === undefined) return null;
  if (typeof threshold === "number"
    && Number.isInteger(threshold)
    && threshold >= 0
    && threshold <= UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD) return null;
  return `schema_invalid: upstreamHostCircuitThreshold: must be an integer from 0 to ${UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD}`;
}

function plaintextV2AgentMessagesError(value: unknown): string | null {
  return malformedPlaintextV2AgentMessagesWarning(value)
    ? "schema_invalid: plaintextV2AgentMessages: must be a boolean or omitted"
    : null;
}

function agentTaskRecoveryError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "agentTaskRecovery") || raw.agentTaskRecovery === undefined) return null;
  const result = agentTaskRecoverySchema.safeParse(raw.agentTaskRecovery);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  return `schema_invalid: agentTaskRecovery${field ? `.${field}` : ""}: ${issue?.message ?? "invalid configuration"}`;
}

function runtimeRoleError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "runtimeRole") || raw.runtimeRole === undefined) return null;
  if (runtimeRoleSchema.safeParse(raw.runtimeRole).success) return null;
  return 'schema_invalid: runtimeRole: must be one of "standalone", "hub", or "client"';
}

function remoteGuiConfigError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  for (const [key, schema] of [
    ["hub", hubConfigSchema],
    ["remoteGui", remoteGuiConfigSchema],
  ] as const) {
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) continue;
    const result = schema.safeParse(raw[key]);
    if (result.success) continue;
    const issue = result.error.issues[0];
    const field = issue?.path.join(".");
    return `schema_invalid: ${key}${field ? `.${field}` : ""}: ${issue?.message ?? "invalid configuration"}`;
  }
  return null;
}

function clientConnectionConfigError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "client") || raw.client === undefined) return null;
  const result = clientConnectionSchema.safeParse(raw.client);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  return `schema_invalid: client${field ? `.${field}` : ""}: ${issue?.message ?? "invalid client connection"}`;
}

function clientRolePairError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  const hasClient = Object.hasOwn(raw, "client") && raw.client !== undefined;
  if (raw.runtimeRole === "client" && !hasClient) {
    return "schema_invalid: runtimeRole client requires a complete client connection";
  }
  if (hasClient && raw.runtimeRole !== "client") {
    return "schema_invalid: client connection requires runtimeRole client";
  }
  return null;
}

function quotaResetNotifyError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "quotaResetNotify") || raw.quotaResetNotify === undefined) return null;
  const result = quotaResetNotifySchema.safeParse(raw.quotaResetNotify);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  return `schema_invalid: quotaResetNotify${field ? `.${field}` : ""}: ${issue?.message ?? "invalid configuration"}`;
}

function catalogAutoRefreshError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "catalogAutoRefresh") || raw.catalogAutoRefresh === undefined) return null;
  const result = catalogAutoRefreshSchema.safeParse(raw.catalogAutoRefresh);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  return `schema_invalid: catalogAutoRefresh${field ? `.${field}` : ""}: ${issue?.message ?? "invalid configuration"}`;
}

/**
 * The read path degrades a malformed pool policy to undefined, which for an exclusion policy means
 * the excluded accounts quietly keep serving traffic. Reject it on write so `ocx config set` cannot
 * create a policy that looks applied and is not.
 */
function codexPoolError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "codexPool") || raw.codexPool === undefined) return null;
  const result = codexPoolSchema.safeParse(raw.codexPool);
  if (result.success) return null;
  const issue = result.error.issues[0];
  const field = issue?.path.join(".");
  return `schema_invalid: codexPool${field ? `.${field}` : ""}: ${issue?.message ?? "invalid configuration"}`;
}

/**
 * Same reasoning as {@link blankHostnameError}, and more urgent: the read path degrades a
 * malformed selection-order map to undefined, which on a write would drop every entry the
 * user had accumulated and still report success. A load-time degrade leaves the raw map in
 * the file to be repaired by hand; a degraded write erases it. One bad `ocx config set`
 * must not cost the whole map, so a live caller is told instead.
 */
function codexAccountPrioritiesError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  if (raw.codexAccountPriorities !== undefined) {
    const parsed = codexAccountPrioritiesSchema.safeParse(raw.codexAccountPriorities);
    if (!parsed.success) {
      return schemaDiagnosticsError(parsed.error).replace("schema_invalid: ", "schema_invalid: codexAccountPriorities.");
    }
  }
  // Tested as a string rather than coerced: `String(123)` matches the id pattern, so a
  // coercing guard waves a non-string pin through to the schema, where `.catch(undefined)`
  // drops it and reports the write as a success — the exact silent-degrade this guards.
  const pin = raw.activeCodexAccountPinned;
  if (pin !== undefined && (typeof pin !== "string" || !CODEX_ACCOUNT_PIN_PATTERN.test(pin))) {
    return "schema_invalid: activeCodexAccountPinned: must be an account id";
  }
  return null;
}

/**
 * Same reasoning as {@link codexAccountPrioritiesError}, plus one of its own. The read
 * path drops an invalid grouping, so a degraded write would erase a declaration the
 * operator is still editing and still report success. And an ambiguous declaration --
 * one id used twice, one credential in two groups -- has no safe silent answer at all:
 * resolving it by list order would quietly merge two quota domains. A live caller is
 * told which group is the problem instead.
 */
export function poolCredentialGroupsError(value: unknown): string | null {
  const pool = rawConfigRecord(rawConfigRecord(value)?.pool);
  if (!pool || pool.credentialGroups === undefined) return null;
  const parsed = credentialGroupsSchema.safeParse(pool.credentialGroups);
  if (parsed.success) return null;
  const details = parsed.error.issues.map(issue => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  }).join("; ");
  return `schema_invalid: pool.credentialGroups: ${details}`;
}

function codexQuotaAutoRefreshError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || raw.codexQuotaAutoRefresh === undefined) return null;
  const parsed = codexQuotaAutoRefreshSchema.safeParse(raw.codexQuotaAutoRefresh);
  if (parsed.success) return null;
  const details = parsed.error.issues.map(issue => {
    const path = issue.path.join(".");
    const message = path === ""
      ? issue.message.replace(/^codexQuotaAutoRefresh\s*/, "")
      : issue.message;
    return `codexQuotaAutoRefresh${path ? `.${path}` : ""}: ${message}`;
  });
  return `schema_invalid: ${details.join("; ")}`;
}

function googleAntigravityStaticCatalogVersionError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "googleAntigravityStaticCatalogVersion")) return null;
  const version = raw.googleAntigravityStaticCatalogVersion;
  if (version === undefined || version === 1 || version === 2) return null;
  return "schema_invalid: googleAntigravityStaticCatalogVersion: must be 1, 2, or omitted";
}

function codexAccountPickerEnabledError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  const descriptor = Object.getOwnPropertyDescriptor(raw, "codexAccountPickerEnabled");
  if (!descriptor) {
    return "codexAccountPickerEnabled" in raw
      ? "schema_invalid: codexAccountPickerEnabled: must be an own boolean data property or omitted"
      : null;
  }
  if (!("value" in descriptor)) {
    return "schema_invalid: codexAccountPickerEnabled: must be an own boolean data property or omitted";
  }
  const enabled = descriptor.value;
  if (enabled === undefined || typeof enabled === "boolean") return null;
  return "schema_invalid: codexAccountPickerEnabled: must be a boolean or omitted";
}

function emptyCompletionRetryError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "emptyCompletionRetry")) return null;
  const enabled = raw.emptyCompletionRetry;
  if (enabled === undefined || typeof enabled === "boolean") return null;
  return "schema_invalid: emptyCompletionRetry: must be a boolean or omitted";
}

function dropCodexSafetyBufferingError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "dropCodexSafetyBuffering")) return null;
  const enabled = raw.dropCodexSafetyBuffering;
  if (enabled === undefined || typeof enabled === "boolean") return null;
  return "schema_invalid: dropCodexSafetyBuffering: must be a boolean or omitted";
}

function oauthOpenBrowserError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || !Object.hasOwn(raw, "oauthOpenBrowser")) return null;
  const enabled = raw.oauthOpenBrowser;
  if (enabled === undefined || typeof enabled === "boolean") return null;
  return "schema_invalid: oauthOpenBrowser: must be a boolean or omitted";
}

/** Validate an in-memory config candidate without touching disk. Used by headless CLI import/set. */
/**
 * Reject a loopback-listener port that collides with the proxy port (#1102), and a port-less
 * companion listener on a bind address that already owns 127.0.0.1 (#4236).
 *
 * The schema can only check the shape of each field on its own; the two ports being distinct —
 * and the port-less form being compatible with `hostname` — are relationships between fields.
 * Letting either through would surface as a startup failure after the public listener already
 * bound, which reads like an unrelated port conflict.
 *
 * Both keys are read from the same candidate, so `ocx config set hostname 127.0.0.1` on a host
 * whose listener is already the companion form is refused by this same check, with the same
 * message, rather than breaking the next start.
 *
 * This is write-time only, matching `blankHostnameError`: a live caller can be told the value
 * is wrong, whereas a hand-edited config on the read path degrades to undefined rather than
 * resetting the whole file. `assertLoopbackListenerBindable` repeats the decision at startup so
 * a hand edit that skipped this boundary fails with the same sentence instead of EADDRINUSE.
 */
function loopbackListenerPortError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const listener = (value as Record<string, unknown>).unauthenticatedLoopbackListener;
  if (listener === undefined) return null;
  if (!listener || typeof listener !== "object" || Array.isArray(listener)) {
    return "schema_invalid: unauthenticatedLoopbackListener: must be an object or omitted";
  }
  const entry = listener as Record<string, unknown>;
  // `enabled` must be a real boolean. The schema's `.catch(undefined)` would otherwise DELETE
  // a `"true"` string entry and report success, leaving an operator convinced they enabled an
  // unauthenticated listener that is in fact off. Load-time still degrades quietly — a hand
  // edit must not reset the file — but a live caller gets told.
  if (typeof entry.enabled !== "boolean") {
    return "schema_invalid: unauthenticatedLoopbackListener.enabled: must be a boolean";
  }
  if (entry.enabled !== true) return null;
  const hostname = typeof (value as Record<string, unknown>).hostname === "string"
    ? (value as Record<string, unknown>).hostname as string
    : undefined;
  const proxyPort = (value as Record<string, unknown>).port;
  const listenerPort = entry.port;
  // The companion form. `port` omitted means "same port as the public listener, on 127.0.0.1",
  // which only exists as a free address when the public listener is bound somewhere else.
  if (listenerPort === undefined) {
    return loopbackCompanionBindError(
      hostname,
      typeof proxyPort === "number" ? proxyPort : 10100,
    );
  }
  if (typeof listenerPort !== "number" || !Number.isInteger(listenerPort) || listenerPort < 1 || listenerPort > 65535) {
    return "schema_invalid: unauthenticatedLoopbackListener.port: must be an integer port when enabled, or omitted to share the proxy port";
  }
  if (typeof proxyPort === "number" && proxyPort === listenerPort) {
    return "schema_invalid: unauthenticatedLoopbackListener.port: must differ from the proxy port";
  }
  return null;
}

/**
 * The one sentence both the write boundary and startup use for an impossible companion bind.
 *
 * Exported so `startServer` can fail with the identical text: an operator who hand-edited the
 * file past `validateConfigCandidate` must read the same diagnosis, not EADDRINUSE.
 */
export function loopbackCompanionBindError(
  hostname: string | undefined,
  proxyPort: number,
): string | null {
  if (loopbackCompanionAllowed(hostname)) return null;
  const bind = (hostname ?? "").trim() || "127.0.0.1";
  return "schema_invalid: unauthenticatedLoopbackListener: a port-less listener binds "
    + `127.0.0.1:${proxyPort}, which the public listener on hostname "${bind}" already holds. `
    + "Either set a distinct unauthenticatedLoopbackListener.port, or remove the listener — a "
    + "loopback bind already admits local callers without a credential.";
}

/**
 * Validate the hub management ingress at the live-write boundary.
 *
 * The persisted schema intentionally degrades a malformed hand edit to disabled so a typo in
 * this opt-in listener cannot discard providers or credentials. A live config mutation must not
 * get that leniency: it receives an exact field error before the degrading schema is applied.
 */
function managementIngressConfigError(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw) return null;
  const hub = rawConfigRecord(raw.hub);
  if (!hub || !Object.hasOwn(hub, "managementIngress") || hub.managementIngress === undefined) return null;
  const ingress = rawConfigRecord(hub.managementIngress);
  if (!ingress) {
    return "schema_invalid: hub.managementIngress: must be an object or omitted";
  }
  if (typeof ingress.enabled !== "boolean") {
    return "schema_invalid: hub.managementIngress.enabled: must be a boolean";
  }
  const keys = Object.keys(ingress);
  if (ingress.enabled === false) {
    return keys.length === 1
      ? null
      : "schema_invalid: hub.managementIngress: disabled ingress accepts only enabled";
  }
  if (keys.some(key => key !== "enabled" && key !== "port")) {
    return "schema_invalid: hub.managementIngress: contains an unsupported field";
  }
  const ingressPort = ingress.port;
  if (typeof ingressPort !== "number" || !Number.isInteger(ingressPort) || ingressPort < 1 || ingressPort > 65535) {
    return "schema_invalid: hub.managementIngress.port: must be an integer port when enabled";
  }
  if (raw.runtimeRole !== "hub") {
    return "schema_invalid: hub.managementIngress: enabled ingress requires runtimeRole hub";
  }
  const proxyPort = typeof raw.port === "number" ? raw.port : 10100;
  if (proxyPort === ingressPort) {
    return "schema_invalid: hub.managementIngress.port: must differ from the proxy port";
  }
  const loopback = rawConfigRecord(raw.unauthenticatedLoopbackListener);
  if (loopback?.enabled === true && loopback.port === ingressPort) {
    return "schema_invalid: hub.managementIngress.port: must differ from unauthenticatedLoopbackListener.port";
  }
  return null;
}

export function validateConfigCandidate(value: unknown): { ok: true; config: OcxConfig } | { ok: false; error: string } {
  const manualCompaction = rawConfigRecord(value)?.manualCompaction;
  if (manualCompaction !== undefined && !manualCompactionSchema.safeParse(manualCompaction).success) {
    return { ok: false, error: "schema_invalid: manualCompaction: requires a nonblank model and an optional valid reasoningEffort" };
  }
  const boundaryError = configReasoningPinsConfigError(value)
    ?? blankHostnameError(value)
    ?? claudeSubagentEffortError(value)
    ?? appOwnedMemoryBudgetError(value)
    ?? upstreamHostCircuitThresholdError(value)
    ?? plaintextV2AgentMessagesError(value)
    ?? agentTaskRecoveryError(value)
    ?? quotaResetNotifyError(value)
    ?? catalogAutoRefreshError(value)
    ?? codexPoolError(value)
    ?? googleAntigravityStaticCatalogVersionError(value)
    ?? codexAccountPrioritiesError(value)
    ?? poolCredentialGroupsError(value)
    ?? codexQuotaAutoRefreshError(value)
    ?? codexAccountPickerEnabledError(value)
    ?? emptyCompletionRetryError(value)
    ?? dropCodexSafetyBufferingError(value)
    ?? oauthOpenBrowserError(value)
    ?? runtimeRoleError(value)
    ?? remoteGuiConfigError(value)
    ?? clientConnectionConfigError(value)
    ?? clientRolePairError(value)
    ?? loopbackListenerPortError(value)
    ?? managementIngressConfigError(value);
  if (boundaryError) return { ok: false, error: boundaryError };
  const result = configSchema.safeParse(value);
  if (result.success) {
    const config = normalizeApiKeyIds(result.data as OcxConfig);
    return { ok: true, config };
  }
  return { ok: false, error: schemaDiagnosticsError(result.error) };
}

export function configDiagnosticsFromRaw(raw: string): ConfigDiagnostics {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    sanitizeReasoningPinsForLoad(parsed);
    // Same degradation as loadConfig: a hand-edited invalid retryOn429 must not trip the
    // schema and send the caller a default-config fallback (the config command could then
    // persist that fallback over the user's providers/keys).
    sanitizeModelDisplayNamesForLoad(parsed);
    sanitizeAutoReviewForLoad(parsed);
    sanitizeRetryOn429ForLoad(parsed);
    sanitizeModelCostsForLoad(parsed);
    sanitizeCapabilityDeclarationsForLoad(parsed);
    const result = configSchema.safeParse(parsed);
    if (result.success) {
      return validFileConfigDiagnostics(normalizeApiKeyIds(result.data as OcxConfig), parsed);
    }

    const merged = mergeConfigDefaults(parsed);
    const retryResult = configSchema.safeParse(merged);
    if (retryResult.success) {
      return validFileConfigDiagnostics(normalizeApiKeyIds(retryResult.data as OcxConfig), parsed);
    }

    // #1785: one invalid routing profile must not make diagnostics report the built-in
    // defaults AS the config, because a later config write persists those defaults over the
    // operator's providers, keys and prices.
    //
    // The failure is still reported. `source` stays "fallback" and `error` keeps the real
    // schema message -- diagnostics is the surface that tells callers the file is invalid,
    // and every consumer that must refuse an invalid config (provider reload, catalog sync,
    // cost reconcile, codex admission) gates on exactly those two fields. Only `config`
    // changes: it carries the salvaged document instead of factory defaults, so a caller
    // that ignores the error and writes it back preserves what the operator configured.
    const salvaged = salvageConfigCandidate(merged, retryResult.error);
    if (salvaged) {
      const config = normalizeApiKeyIds(salvaged.parsed);
      const warnings = degradedListenerWarnings(parsed, config);
      return {
        config,
        source: "fallback",
        error: schemaDiagnosticsError(result.error),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    return { config: getDefaultConfig(), source: "fallback", error: schemaDiagnosticsError(result.error) };
  } catch {
    return { config: getDefaultConfig(), source: "fallback", error: "invalid_json" };
  }
}

export function readConfigFileSnapshot(): ConfigFileSnapshot {
  try {
    const raw = readFileSync(getConfigPath(), "utf-8");
    return { diagnostics: configDiagnosticsFromRaw(raw), raw };
  } catch (error) {
    if (isMissingPathError(error)) {
      return {
        diagnostics: { config: getDefaultConfig(), source: "default", error: null },
      };
    }
    return {
      diagnostics: { config: getDefaultConfig(), source: "fallback", error: "invalid_json" },
    };
  }
}

export function readConfigDiagnostics(): ConfigDiagnostics {
  return readConfigFileSnapshot().diagnostics;
}

/** Read-only init preflight. Occupied unsafe entries are never treated as absence. */
export function observeInitialConfigState(): "missing" | "exists" | "invalid" {
  try {
    if (!lstatSync(getConfigPath()).isFile()) return "invalid";
  } catch (error) {
    return isMissingPathError(error) ? "missing" : "invalid";
  }
  return readConfigFileSnapshot().diagnostics.source === "file" ? "exists" : "invalid";
}

/**
 * The persisted config, plus a digest of the EXACT bytes it was parsed from.
 *
 * A union rather than a nullable digest, because `{ kind: "read" }` with no
 * digest is a state that cannot occur — and a state that cannot occur should
 * not be a state that can be written down. Refusing it at runtime is a check
 * somebody eventually forgets; making it unrepresentable is not.
 *
 * Why a byte digest at all: the Codex write lock compares an authority snapshot
 * taken before the lock against one taken while holding it, and its config
 * component used to hash the PARSED object. Two files that differ only in
 * whitespace or key order parse identically, so a non-cooperating writer could
 * rewrite the file between admission and commit and the comparison would see
 * nothing. Hashing what was actually read closes that.
 *
 * `readConfigFileSnapshot` stays private on purpose. Its `raw` carries provider
 * API keys and admission tokens, and `privacy:scan` reads tracked source text,
 * not runtime values — so it would not catch a caller that logged or serialized
 * that string. The digest travels; the bytes do not.
 */
export type ConfigAdmissionSnapshot =
  | Readonly<{ kind: "read"; diagnostics: ConfigDiagnostics; contentSha256: string }>
  | Readonly<{ kind: "unreadable"; diagnostics: ConfigDiagnostics; contentSha256: null }>;

export function readConfigAdmissionSnapshot(): ConfigAdmissionSnapshot {
  let bytes: Buffer;
  try {
    // ONE read. Hashing the file and then reading it again to parse would leave
    // a window for the two to disagree, which is the exact hazard this exists
    // to detect — the check would become a second chance to be wrong.
    bytes = readFileSync(getConfigPath());
  } catch (error) {
    return {
      kind: "unreadable",
      diagnostics: isMissingPathError(error)
        ? { config: getDefaultConfig(), source: "default", error: null }
        : { config: getDefaultConfig(), source: "fallback", error: "invalid_json" },
      contentSha256: null,
    };
  }
  return {
    kind: "read",
    // Decoded from the same buffer that was hashed, not re-read from disk.
    diagnostics: configDiagnosticsFromRaw(bytes.toString("utf-8")),
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
