import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  modelPinnedEffortsConfigError,
  pinnedReasoningEffortConfigError,
  autoReviewModelOverridesConfigError,
  autoReviewModelTargetConfigError,
  modelCapabilitiesConfigError,
  sanitizeModelCapabilitiesForLoad,
  modelDisplayNamesConfigError,
} from "./provider-validation";
import { UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD } from "../codex/upstream-host-health";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import { redactSecretString } from "../lib/redact";
import { isValidProviderName } from "./provider-name";
import { MODEL_ALIAS_PATTERN } from "../providers/default-aliases";
import { MODEL_DISCOVERY_MAX_MODELS } from "../providers/model-discovery-limits";
import { getProviderRegistryEntry, providerMatchesRegistryTransport, registryModelServiceTierCapabilityApplies } from "../providers/registry";
import { isCodexReasoningEffort } from "../reasoning-effort";
import { refreshUserCostOverlays } from "../usage/user-cost-overlays";
import { type OcxClaudeCodeConfig, type OcxConfig } from "../types";
import {
  agentTaskRecoverySchema,
  catalogAutoRefreshSchema,
  clientConnectionSchema,
  isUsableApiKeySecret,
  managementIngressSchema,
  codexPoolSchema,
  providerModelCostsConfigError,
  credentialGroupsSchema,
  hubConfigSchema,
  quotaResetNotifySchema,
  remoteGuiConfigSchema,
  retryOn429PolicySchema,
  runtimeRoleSchema,
  spendSchema,
} from "./schema/leaf-validators";
import { hasWarnedInheritedFastWireConflict, markWarnedInheritedFastWireConflict } from "./warn-memo";

export function hardenExistingSecret(path: string): void {
  if (existsSync(path)) {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    if (process.platform === "win32") {
      hardenSecretPath(path, { required: false });
    }
  }
}
/** Load only: discard invalid optional pins without rewriting the file or losing providers. */
export function sanitizeReasoningPinsForLoad(parsed: unknown): void {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const root = parsed as Record<string, unknown>;
  let degraded = false;
  const sanitizeMap = (owner: Record<string, unknown>, field: string) => {
    const value = owner[field];
    if (value === undefined) return;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      delete owner[field];
      degraded = true;
      return;
    }
    const counts = new Map<string, number>();
    for (const key of Object.keys(value)) counts.set(key.trim(), (counts.get(key.trim()) ?? 0) + 1);
    const valid: Record<string, string> = Object.create(null);
    for (const [key, effort] of Object.entries(value)) {
      if (counts.get(key.trim()) !== 1 || modelPinnedEffortsConfigError({ [key]: effort }) !== null) {
        degraded = true;
        continue;
      }
      valid[key.trim()] = effort as string;
    }
    if (Object.keys(valid).length) owner[field] = valid;
    else delete owner[field];
  };
  sanitizeMap(root, "modelPinnedEfforts");
  if (root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)) {
    for (const value of Object.values(root.providers)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const provider = value as Record<string, unknown>;
      if (pinnedReasoningEffortConfigError(provider.pinnedReasoningEffort)) {
        delete provider.pinnedReasoningEffort;
        degraded = true;
      }
      sanitizeMap(provider, "modelPinnedReasoningEfforts");
    }
  }
  // Never include a provider/model name or value: malformed pins can contain secrets.
  if (degraded) console.warn("config.json contains invalid optional reasoning pins — ignoring invalid fields or entries");
}

/**
 * The schema's `.catch(undefined)` silently degrades an invalid persisted
 * `streamMode` to "auto"; surface that once so a hand-edited typo (e.g.
 * "legacy_tee") is discoverable instead of silently changing stream shape.
 */
export function warnDegradedStreamMode(rawParsed: unknown, validated: OcxConfig): void {
  if (!rawParsed || typeof rawParsed !== "object") return;
  const raw = (rawParsed as Record<string, unknown>).streamMode;
  if (raw !== undefined && validated.streamMode === undefined) {
    console.warn(`⚠️  config.json streamMode ${JSON.stringify(raw)} is invalid (expected "auto", "legacy-tee", or "eager-relay") — falling back to "auto"`);
  }
}

export function warnDegradedCompactionRouting(rawParsed: unknown, validated: OcxConfig): void {
  if (!rawParsed || typeof rawParsed !== "object") return;
  const raw = (rawParsed as Record<string, unknown>).compactionRouting;
  if (raw !== undefined && validated.compactionRouting === undefined) {
    console.warn("⚠️  config.json compactionRouting is invalid (expected { model, reasoningEffort?, triggers? } with a nonblank model, a declared effort, and triggers drawn without repetition from \"manual\" and \"auto\") — compaction keeps the conversation model");
  }
}

/**
 * Top-level opt-in blocks whose hand-edited form degrades to "off" instead of failing the whole
 * schema. Grouped behind one entry point because `src/config.ts` sits at its file-size cap, and
 * the ratchet only ever moves down: a per-block call there costs a line the file does not have.
 */
export function warnDegradedTopLevelOptIns(rawParsed: unknown, validated: OcxConfig): void {
  warnDegradedStreamMode(rawParsed, validated);
  warnDegradedCompactionRouting(rawParsed, validated);
}

/**
 * Load-time degradation for `retryOn429` (loadConfig only): one hand-edited invalid optional
 * field (e.g. `attempts: 0` or a string) must not trip the whole provider schema and hide every
 * provider/key behind a default config. Invalid fields are dropped with a warning; the management
 * write boundary still rejects invalid policies explicitly.
 */
export function sanitizeRetryOn429ForLoad(parsed: unknown): void {
  if (!parsed || typeof parsed !== "object") return;
  const root = parsed as Record<string, unknown>;
  const providers = root.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
  for (const [name, provider] of Object.entries(providers as Record<string, unknown>)) {
    // This sanitizer runs BEFORE schema validation, so the provider name is untrusted: redact
    // secret-shaped names and JSON-escape control characters before it reaches any warning.
    const safeProviderName = JSON.stringify(redactSecretString(name));
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const p = provider as Record<string, unknown>;
    const policy = p.retryOn429;
    if (policy === undefined) continue;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
      delete p.retryOn429;
      // Never serialize the value: an accidental `retryOn429: "sk-..."` would leak the secret.
      console.warn(`⚠️  config.json providers.${safeProviderName}.retryOn429 (${typeof policy}) is invalid — ignoring the policy`);
      continue;
    }
    const policyRecord = policy as Record<string, unknown>;
    // An explicitly present but invalid master switch must not silently default to ENABLED:
    // drop the whole policy so a hand-edit that tried to disable retries stays disabled.
    if ("enabled" in policyRecord && typeof policyRecord.enabled !== "boolean") {
      delete p.retryOn429;
      console.warn(`⚠️  config.json providers.${safeProviderName}.retryOn429.enabled (${typeof policyRecord.enabled}) is invalid — ignoring the whole policy`);
      continue;
    }
    // Field checks derive from the shared policy schema so the bounds cannot drift
    // between the load-time sanitizer, the config schema, and the write boundary.
    const policyShape = retryOn429PolicySchema.shape;
    const hadPolicyEntries = Object.keys(policyRecord).length > 0;
    const cleaned: Record<string, unknown> = {};
    for (const [key, fieldSchema] of Object.entries(policyShape)) {
      const value = policyRecord[key];
      if (value === undefined) continue;
      if (fieldSchema.safeParse(value).success) cleaned[key] = value;
      // Log only the received type, never the value (provider config can hold secrets).
      else console.warn(`⚠️  config.json providers.${safeProviderName}.retryOn429.${key} (${typeof value}) is invalid — ignoring the field`);
    }
    const knownKeys = new Set(Object.keys(policyShape));
    for (const key of Object.keys(policyRecord)) {
      if (!knownKeys.has(key)) {
        // Redact the field NAME before logging: a malformed hand-edit can place a secret in a
        // property name (`retryOn429: { "sk-...": true }`). Ordinary typos (e.g. `attempt`)
        // stay readable, secret-shaped names become [REDACTED]. JSON-escape afterwards so a
        // control-character property name (newline/ANSI) can never forge a log line.
        console.warn(`⚠️  config.json providers.${safeProviderName}.retryOn429.${JSON.stringify(redactSecretString(key))} is not a recognized field — ignoring it`);
      }
    }
    if (hadPolicyEntries && Object.keys(cleaned).length === 0) {
      // Every supplied field was invalid: drop the whole policy. Persisting `{}` here would
      // opt IN to retries with defaults, which is the opposite of what a malformed
      // disable-oriented edit (`retryOn429: { enabled: "false" }`, `attempts: 0`) asked for.
      delete p.retryOn429;
      console.warn(`⚠️  config.json providers.${safeProviderName}.retryOn429 has no valid fields left — removing the policy (an empty policy would enable retries with defaults)`);
    } else {
      // Preserve an intentionally empty `retryOn429: {}` (presence = opt-in with defaults).
      p.retryOn429 = cleaned;
    }
  }
}

/**
 * Management write-boundary validation for `retryOn429` (fail closed). Unlike the
 * lenient load-time sanitizer, invalid values and unknown keys are rejected outright so
 * a POST/PATCH cannot persist a policy the proxy would then silently degrade. Reuses the
 * shared policy schema. Never echoes values, and secret-shaped unknown field names are
 * redacted (a malformed write can place a secret in a property name).
 */
export function retryOn429PolicyConfigError(policy: unknown): string | null {
  if (policy === undefined) return null;
  const result = retryOn429PolicySchema.safeParse(policy);
  if (result.success) return null;
  const first = result.error.issues[0];
  if (!first) return "retryOn429 is invalid";
  if (first.code === "unrecognized_keys") {
    const names = first.keys.map(key => JSON.stringify(redactSecretString(key))).join(", ");
    return `retryOn429 has unrecognized field${first.keys.length > 1 ? "s" : ""}: ${names}`;
  }
  if (first.path.length === 0) return `retryOn429 is invalid (${first.message})`;
  const field = String(first.path[first.path.length - 1]);
  return `retryOn429.${field} is invalid (${first.message})`;
}

export function sanitizeCapabilityDeclarationsForLoad(parsed: unknown): void {
  if (!parsed || typeof parsed !== "object") return;
  const providers = (parsed as Record<string, unknown>).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
  for (const [name, value] of Object.entries(providers)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const provider = value as Record<string, unknown>;
    if (provider.modelCapabilities === undefined) continue;
    if (modelCapabilitiesConfigError(provider.modelCapabilities) !== null) {
      console.warn(`config.json provider ${JSON.stringify(redactSecretString(name))} has malformed modelCapabilities; retaining valid axes and restricting malformed input modalities to text`);
      const repaired = sanitizeModelCapabilitiesForLoad(provider.modelCapabilities);
      if (repaired) provider.modelCapabilities = repaired;
      else delete provider.modelCapabilities;
    }
  }
}

/**
 * Load-time degradation for `providers.<name>.modelCosts`, mirroring
 * {@link sanitizeRetryOn429ForLoad}. A hand-edited malformed display-price row
 * must not fail the whole config parse — that would back up config.json and
 * fall back to defaults, dropping otherwise valid providers and the default
 * route for a typo in a non-runtime display field. Invalid rows are dropped
 * with a warning; strict rejection stays at the management/write boundary
 * (providerManagementConfigError).
 */
export function sanitizeModelCostsForLoad(parsed: unknown): void {
  if (!parsed || typeof parsed !== "object") return;
  const root = parsed as Record<string, unknown>;
  const providers = root.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
  for (const [name, provider] of Object.entries(providers as Record<string, unknown>)) {
    // Runs before schema validation, so the provider name is untrusted: redact
    // secret-shaped names and JSON-escape control characters for the warning.
    const safeProviderName = JSON.stringify(redactSecretString(name));
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const p = provider as Record<string, unknown>;
    const costs = p.modelCosts;
    if (costs === undefined) continue;
    if (!costs || typeof costs !== "object" || Array.isArray(costs)) {
      delete p.modelCosts;
      console.warn(`⚠️  config.json providers.${safeProviderName}.modelCosts (${typeof costs}) is invalid — ignoring the overlay`);
      continue;
    }
    const costsRecord = costs as Record<string, unknown>;
    const hadEntries = Object.keys(costsRecord).length > 0;
    let kept = 0;
    for (const [modelId, entry] of Object.entries(costsRecord)) {
      // Reuse the shared per-row shape contract so the load-time sanitizer
      // cannot drift from the schema and the write boundary.
      if (providerModelCostsConfigError({ [modelId]: entry }) === null) {
        kept++;
        continue;
      }
      delete costsRecord[modelId];
      // Redact the model id: a hand-edit can place a secret in a key name.
      console.warn(`⚠️  config.json providers.${safeProviderName}.modelCosts.${JSON.stringify(redactSecretString(modelId))} is invalid — ignoring the row`);
    }
    if (hadEntries && kept === 0) {
      delete p.modelCosts;
      console.warn(`⚠️  config.json providers.${safeProviderName}.modelCosts has no valid rows left — removing the overlay`);
    }
  }
}

/**
 * Load-time degradation for provider-scoped auto-review selectors. A malformed
 * hand edit must not fail the whole config parse; the management boundary stays
 * strict and rejects the same shapes before they can be written.
 */
export function sanitizeAutoReviewForLoad(parsed: unknown): void {
  if (!parsed || typeof parsed !== "object") return;
  const root = parsed as Record<string, unknown>;
  const providers = root.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
  for (const [name, providerValue] of Object.entries(providers as Record<string, unknown>)) {
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) continue;
    const provider = providerValue as Record<string, unknown>;
    const safeProviderName = JSON.stringify(redactSecretString(name));
    if (name === "openai") {
      delete provider.autoReviewModel;
      delete provider.autoReviewModelOverrides;
      continue;
    }
    if (provider.autoReviewModel !== undefined
      && autoReviewModelTargetConfigError(provider.autoReviewModel, "autoReviewModel", true) !== null) {
      console.warn(`⚠️  config.json providers.${safeProviderName}.autoReviewModel is invalid — ignoring the selector`);
      delete provider.autoReviewModel;
    }
    if (provider.autoReviewModelOverrides !== undefined) {
      const overridesError = autoReviewModelOverridesConfigError(
        provider.autoReviewModelOverrides,
        "autoReviewModelOverrides",
        true,
      );
      if (overridesError) {
        console.warn(`⚠️  config.json providers.${safeProviderName}.autoReviewModelOverrides is invalid — ignoring the map`);
        delete provider.autoReviewModelOverrides;
      }
    }
  }
}

/**
 * Companion to {@link warnDegradedStreamMode} for a blank persisted `hostname`. The bind
 * falls back to loopback, which is the safe direction but not what the file asked for —
 * say so once instead of silently ignoring the field.
 */
export function warnDegradedHostname(rawParsed: unknown, validated: OcxConfig): void {
  if (!rawParsed || typeof rawParsed !== "object") return;
  const raw = (rawParsed as Record<string, unknown>).hostname;
  if (raw !== undefined && validated.hostname === undefined) {
    console.warn(`⚠️  config.json hostname ${JSON.stringify(raw)} is not a usable bind address — falling back to 127.0.0.1`);
  }
}

export function degradedListenerWarnings(rawParsed: unknown, validated: OcxConfig): string[] {
  const raw = rawConfigRecord(rawParsed);
  if (!raw) return [];
  const warnings: string[] = [];
  if (raw.unauthenticatedLoopbackListener !== undefined && validated.unauthenticatedLoopbackListener === undefined) {
    warnings.push("unauthenticatedLoopbackListener ignored: invalid listener configuration; repair config.json before enabling the listener");
  }
  const hub = rawConfigRecord(raw.hub);
  if (hub?.managementIngress !== undefined && !managementIngressSchema.safeParse(hub.managementIngress).success) {
    warnings.push("hub.managementIngress ignored: invalid management listener configuration; repair config.json before enabling the listener");
  }
  return warnings;
}

export function warnDegradedListeners(rawParsed: unknown, validated: OcxConfig): void {
  for (const warning of degradedListenerWarnings(rawParsed, validated)) {
    console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
  }
}

/**
 * Companion to {@link warnDegradedStreamMode} for a malformed selection-order map.
 * Priority is a preference, so the schema drops the whole map rather than failing
 * the parse — say so once, otherwise the pool silently reverts to flat ordering.
 */
export function degradedCodexAccountPriorityWarnings(rawParsed: unknown, validated: OcxConfig): string[] {
  const record = rawConfigRecord(rawParsed);
  const warnings: string[] = [];
  // The pin degrades silently otherwise, which reads as the manual selection simply
  // not having survived the restart.
  if (record?.activeCodexAccountPinned !== undefined && validated.activeCodexAccountPinned === undefined) {
    warnings.push("activeCodexAccountPinned is not a valid account id — the manually selected account is no longer pinned");
  }
  const raw = record?.codexAccountPriorities;
  if (raw !== undefined && validated.codexAccountPriorities === undefined) {
    warnings.push("codexAccountPriorities is invalid (expected account ids mapped to integers between -100 and 100) — account selection order is disabled");
  }
  return warnings;
}

export function warnDegradedCodexAccountPriorities(rawParsed: unknown, validated: OcxConfig): void {
  for (const warning of degradedCodexAccountPriorityWarnings(rawParsed, validated)) {
    console.warn(`⚠️  config.json ${warning}`);
  }
}

export function degradedCodexQuotaAutoRefreshWarning(rawParsed: unknown, validated: OcxConfig): string | null {
  const raw = rawConfigRecord(rawParsed)?.codexQuotaAutoRefresh;
  if (raw === undefined || validated.codexQuotaAutoRefresh !== undefined) return null;
  return "codexQuotaAutoRefresh is invalid — automatic quota-window activation is disabled";
}

export function warnDegradedCodexQuotaAutoRefresh(rawParsed: unknown, validated: OcxConfig): void {
  const warning = degradedCodexQuotaAutoRefreshWarning(rawParsed, validated);
  if (warning) console.warn(`⚠️  config.json ${warning}`);
}

/**
 * Companion to the degrade warnings above, for a malformed or ambiguous declared
 * grouping. The list now degrades on its own so the rest of `pool` survives, which is
 * also why it needs a voice: nothing else about the config looks different afterwards,
 * and silently ungrouped credentials read as capacity the pool does not have.
 */
export function degradedCredentialGroupsWarning(rawParsed: unknown): string | null {
  const pool = rawConfigRecord(rawConfigRecord(rawParsed)?.pool);
  if (!pool || pool.credentialGroups === undefined) return null;
  const parsed = credentialGroupsSchema.safeParse(pool.credentialGroups);
  if (parsed.success) return null;
  // Every issue message is redacted before it is joined. The custom messages embed the
  // offending member through `JSON.stringify`, so a malformed credential string that
  // happens to carry secret material would otherwise be printed verbatim at config load
  // — a config file is exactly where a pasted token ends up in the wrong field.
  const details = parsed.error.issues.map(issue => redactSecretString(issue.message)).join("; ");
  return `pool.credentialGroups is invalid (${details}) — declared quota grouping is disabled; other pool settings were preserved`;
}

export function warnDegradedCredentialGroups(rawParsed: unknown): void {
  const warning = degradedCredentialGroupsWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}`);
}

/**
 * The apiKeys schema salvages entry by entry rather than failing the parse, so a
 * dropped key is otherwise invisible — and it will not be re-saved by the next
 * mutation. Say so out loud. Compares the raw array against the validated one,
 * the same shape as the degrade warnings above.
 */
/**
 * Give every salvaged key a stable, targetable id.
 *
 * Pure and deterministic on purpose. Two earlier spellings were wrong: minting a
 * UUID inside the schema transform handed out a different id on every parse, and
 * repairing-then-writing during `loadConfig` put a file write on the read path,
 * where it could clobber a concurrent legitimate save with a stale snapshot.
 *
 * So the replacement id is derived from the entry's position, which is already
 * how the file orders these rows: same file in, same ids out, no I/O and no
 * randomness. It is not derived from the secret — a public identifier should
 * never be a function of key material.
 */
export function normalizeApiKeyIds(config: OcxConfig): OcxConfig {
  const keys = config.apiKeys;
  if (!keys?.length) return config;
  // Reserve every explicit id BEFORE synthesizing any, or a synthetic
  // `salvaged-1` assigned to row 1 would push a row that legitimately owns that
  // id onto `salvaged-2`. An id the user already has is the one thing this
  // repair must never take away.
  const reserved = new Set<string>();
  for (const entry of keys) {
    if (entry.id) reserved.add(entry.id);
  }
  const taken = new Set<string>(reserved);
  const kept = new Set<string>();
  keys.forEach((entry, index) => {
    // The first row holding an explicit id keeps it; later collisions are the
    // ones that move.
    if (entry.id && !kept.has(entry.id)) {
      kept.add(entry.id);
      return;
    }
    let candidate = `salvaged-${index + 1}`;
    let suffix = 1;
    while (taken.has(candidate)) candidate = `salvaged-${index + 1}-${++suffix}`;
    entry.id = candidate;
    taken.add(candidate);
    kept.add(candidate);
  });
  return config;
}

export function warnDegradedApiKeys(rawParsed: unknown, validated: OcxConfig): void {
  if (!rawParsed || typeof rawParsed !== "object") return;
  const raw = (rawParsed as Record<string, unknown>).apiKeys;
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    console.warn(`⚠️  config.json apiKeys is not an array — ignoring it; generate a new key from the API tab`);
    return;
  }
  const dropped = raw.length - (validated.apiKeys?.length ?? 0);
  if (dropped > 0) {
    console.warn(`⚠️  config.json apiKeys: skipped ${dropped} malformed entr${dropped === 1 ? "y" : "ies"} — the remaining keys still work`);
  }
  // Same-length repairs are invisible to the count above, and they are the ones
  // that show up as a blank name or an unknown date in the dashboard. Say so.
  const repaired = raw.filter(row => {
    if (!row || typeof row !== "object") return false;
    const entry = row as Record<string, unknown>;
    // Must match the schema exactly: a row whose key is unusable was DROPPED, and
    // saying "the key still works" about it would be a lie.
    if (!isUsableApiKeySecret(entry.key)) return false;
    return typeof entry.id !== "string" || !entry.id
      || typeof entry.name !== "string"
      || typeof entry.createdAt !== "string";
  }).length;
  if (repaired > 0) {
    console.warn(`⚠️  config.json apiKeys: repaired metadata on ${repaired} entr${repaired === 1 ? "y" : "ies"} — the key still works, but its name or date may read as unknown`);
  }
  // A duplicate id is repaired too, and it is not visible in either count above.
  const ids = raw.filter(row => row && typeof row === "object" && isUsableApiKeySecret((row as Record<string, unknown>).key))
    .map(row => (row as Record<string, unknown>).id)
    .filter((id): id is string => typeof id === "string" && !!id);
  const duplicates = ids.length - new Set(ids).size;
  if (duplicates > 0) {
    console.warn(`⚠️  config.json apiKeys: ${duplicates} entr${duplicates === 1 ? "y" : "ies"} shared an id — reassigned so each key can be renamed and revoked on its own`);
  }
}

export const CLAUDE_SUBAGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function isClaudeSubagentEffort(value: unknown): value is NonNullable<OcxClaudeCodeConfig["subagentEffort"]> {
  return typeof value === "string" && CLAUDE_SUBAGENT_EFFORTS.includes(value as typeof CLAUDE_SUBAGENT_EFFORTS[number]);
}

export function rawClaudeSubagentEffort(rawParsed: unknown): unknown {
  const raw = rawConfigRecord(rawParsed);
  const claudeCode = raw?.claudeCode;
  if (!claudeCode || typeof claudeCode !== "object" || Array.isArray(claudeCode)) return undefined;
  return (claudeCode as Record<string, unknown>).subagentEffort;
}

export function normalizePersistedClaudeCode(claudeCode: unknown): OcxConfig["claudeCode"] {
  if (!claudeCode || typeof claudeCode !== "object" || Array.isArray(claudeCode)) {
    return claudeCode as OcxConfig["claudeCode"];
  }
  const normalized = { ...claudeCode } as Record<string, unknown>;
  if (Object.hasOwn(normalized, "subagentEffort") && !isClaudeSubagentEffort(normalized.subagentEffort)) {
    delete normalized.subagentEffort;
  }
  // A hand-authored config never passes through the management validator, so coerce here too.
  // A malformed classifierFallbacks (a bare string, or an array with non-string entries) would
  // otherwise reach the resolver unchecked.
  if (Object.hasOwn(normalized, "classifierModel")) {
    const value = typeof normalized.classifierModel === "string" ? normalized.classifierModel.trim() : "";
    if (value.length > 0) normalized.classifierModel = value;
    else delete normalized.classifierModel;
  }
  if (Object.hasOwn(normalized, "classifierFallbacks")) {
    const raw = normalized.classifierFallbacks;
    const kept = Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map(entry => entry.trim())
      : [];
    if (kept.length > 0) normalized.classifierFallbacks = kept;
    else delete normalized.classifierFallbacks;
  }
  const desktopProfile = normalized.desktopProfile;
  if (desktopProfile && typeof desktopProfile === "object" && !Array.isArray(desktopProfile)) {
    const profile = { ...desktopProfile } as Record<string, unknown>;
    if (typeof profile.appliedFingerprint !== "string") delete profile.appliedFingerprint;
    if (typeof profile.appliedAt !== "string") delete profile.appliedAt;
    normalized.desktopProfile = profile;
  }
  return normalized as OcxConfig["claudeCode"];
}

export function normalizeClaudeSubagentEffort(config: OcxConfig, _rawParsed: unknown): OcxConfig {
  // Unconditional. This used to short-circuit when `subagentEffort` was absent or already valid,
  // which meant a config whose ONLY defect was elsewhere in `claudeCode` was never normalized.
  // The specialized subagentEffort WARNING is a separate concern and stays exactly as it is.
  if (!config.claudeCode) return config;
  return { ...config, claudeCode: normalizePersistedClaudeCode(config.claudeCode) };
}

export function warnDegradedClaudeSubagentEffort(rawParsed: unknown): void {
  const rawEffort = rawClaudeSubagentEffort(rawParsed);
  if (rawEffort !== undefined && !isClaudeSubagentEffort(rawEffort)) {
    console.warn(`⚠️  config.json claudeCode.subagentEffort is invalid (expected ${CLAUDE_SUBAGENT_EFFORTS.join(", ")}) — ignoring it. Other settings were preserved.`);
  }
}

export function malformedUpstreamHostCircuitThresholdWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "upstreamHostCircuitThreshold")) return null;
  const threshold = raw.upstreamHostCircuitThreshold;
  if (threshold === undefined) return null;
  if (typeof threshold === "number"
    && Number.isInteger(threshold)
    && threshold >= 0
    && threshold <= UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD) return null;
  return `upstreamHostCircuitThreshold ignored: expected an integer from 0 to ${UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD}`;
}

export function warnDegradedUpstreamHostCircuitThreshold(rawParsed: unknown): void {
  const warning = malformedUpstreamHostCircuitThresholdWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
}

export function malformedPlaintextV2AgentMessagesWarning(value: unknown): string | null {
  const raw = rawConfigRecord(value);
  if (!raw || raw.plaintextV2AgentMessages === undefined || typeof raw.plaintextV2AgentMessages === "boolean") return null;
  return "plaintextV2AgentMessages ignored: expected a boolean";
}

export function warnDegradedPlaintextV2AgentMessages(value: unknown): void {
  const warning = malformedPlaintextV2AgentMessagesWarning(value);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
}

export function malformedAgentTaskRecoveryWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "agentTaskRecovery")) return null;
  const result = agentTaskRecoverySchema.safeParse(raw.agentTaskRecovery);
  if (result.success) return null;
  const field = result.error.issues[0]?.path.join(".");
  return `agentTaskRecovery${field ? `.${field}` : ""} ignored: invalid experimental recovery configuration`;
}

export function warnDegradedAgentTaskRecovery(rawParsed: unknown): void {
  const warning = malformedAgentTaskRecoveryWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
}

export function malformedRuntimeRoleWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "runtimeRole") || raw.runtimeRole === undefined) return null;
  if (runtimeRoleSchema.safeParse(raw.runtimeRole).success) return null;
  return 'runtimeRole ignored: expected "standalone", "hub", or "client"; falling back to "standalone"';
}

export function warnDegradedRuntimeRole(rawParsed: unknown): void {
  const warning = malformedRuntimeRoleWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
}

export function malformedOptionalRemoteBlockWarning(
  rawParsed: unknown,
  key: "hub" | "remoteGui",
): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, key) || raw[key] === undefined) return null;
  const schema = key === "hub" ? hubConfigSchema : remoteGuiConfigSchema;
  const result = schema.safeParse(raw[key]);
  if (result.success) return null;
  const field = result.error.issues[0]?.path.join(".");
  return `${key}${field ? `.${field}` : ""} ignored: invalid remote GUI configuration`;
}

export function malformedClientConnectionWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "client") || raw.client === undefined) return null;
  const result = clientConnectionSchema.safeParse(raw.client);
  if (result.success) return null;
  const field = result.error.issues[0]?.path.join(".");
  return `client${field ? `.${field}` : ""} invalid: remote client mode is disabled until config.json is repaired`;
}

export function warnDegradedOptionalRemoteBlocks(rawParsed: unknown): void {
  for (const key of ["hub", "remoteGui"] as const) {
    const warning = malformedOptionalRemoteBlockWarning(rawParsed, key);
    if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
  }
}

export function malformedQuotaResetNotifyWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "quotaResetNotify")) return null;
  const result = quotaResetNotifySchema.safeParse(raw.quotaResetNotify);
  if (result.success) return null;
  const field = result.error.issues[0]?.path.join(".");
  return `quotaResetNotify${field ? `.${field}` : ""} ignored: invalid quota-reset notification configuration`;
}

export function malformedCatalogAutoRefreshWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "catalogAutoRefresh")) return null;
  const result = catalogAutoRefreshSchema.safeParse(raw.catalogAutoRefresh);
  if (result.success) return null;
  const field = result.error.issues[0]?.path.join(".");
  return `catalogAutoRefresh${field ? `.${field}` : ""} ignored: invalid catalog auto-refresh configuration`;
}

/**
 * The same silent-in-the-wrong-direction failure, and the most expensive instance of it here:
 * a dropped spend section means the ceilings are not enforced, and an unenforced ceiling is
 * indistinguishable from one nothing has reached. The operator finds out from the bill.
 */
export function malformedSpendWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "spend")) return null;
  const result = spendSchema.safeParse(raw.spend);
  if (result.success) return null;
  const field = result.error.issues[0]?.path.join(".");
  return `spend${field ? `.${field}` : ""} ignored: invalid spend ceiling configuration, so no token ceiling is enforced`;
}

/**
 * Same silent-in-the-wrong-direction failure as the notification block: a dropped pool policy means
 * the accounts the operator meant to exclude keep taking traffic, and the only visible symptom is
 * traffic going somewhere it was supposed to stop going.
 */
export function malformedCodexPoolWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "codexPool")) return null;
  const result = codexPoolSchema.safeParse(raw.codexPool);
  if (result.success) return null;
  const field = result.error.issues[0]?.path.join(".");
  return `codexPool${field ? `.${field}` : ""} ignored: invalid Codex pool selection policy`;
}

/**
 * Warn once per load that the section was dropped.
 *
 * This matters more than a usual degradation notice: the failure is SILENT in the direction
 * that hurts. A dropped section means notifications are off, so the operator sees nothing —
 * which is exactly what they would see if the feature were working and no reset had happened.
 */
export function warnDegradedQuotaResetNotify(rawParsed: unknown): void {
  const warning = malformedQuotaResetNotifyWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
}

/**
 * Warn once per load that the section was dropped.
 *
 * Same silent-in-the-wrong-direction failure as the notification block: a dropped section
 * means the scheduler never starts, so the operator sees a stale catalog — which is exactly
 * what they would see if the feature were working and no new models had shipped.
 */
export function warnDegradedCatalogAutoRefresh(rawParsed: unknown): void {
  const warning = malformedCatalogAutoRefreshWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
}

/**
 * Warn once per load that the pool policy was dropped.
 *
 * `.catch(undefined)` turns a malformed policy into a SUCCESSFUL parse, so without this the proxy
 * starts, rotates onto the accounts the operator meant to exclude, and prints nothing. The visible
 * symptom would be traffic going exactly where it was told not to go.
 */
export function warnDegradedCodexPool(rawParsed: unknown): void {
  const warning = malformedCodexPoolWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
}

type NativeSubagentPersistedField = "injectionModel" | "injectionEffort" | "syncCodexSubagentDefaults";

export function rawConfigRecord(rawParsed: unknown): Record<string, unknown> | null {
  return rawParsed !== null && typeof rawParsed === "object" && !Array.isArray(rawParsed)
    ? rawParsed as Record<string, unknown>
    : null;
}

export function malformedNativeSubagentFields(rawParsed: unknown): NativeSubagentPersistedField[] {
  const raw = rawConfigRecord(rawParsed);
  if (!raw) return [];
  const malformed: NativeSubagentPersistedField[] = [];
  if (Object.hasOwn(raw, "injectionModel") && typeof raw.injectionModel !== "string") {
    malformed.push("injectionModel");
  }
  if (Object.hasOwn(raw, "injectionEffort") && typeof raw.injectionEffort !== "string") {
    malformed.push("injectionEffort");
  }
  if (Object.hasOwn(raw, "syncCodexSubagentDefaults") && typeof raw.syncCodexSubagentDefaults !== "boolean") {
    malformed.push("syncCodexSubagentDefaults");
  }
  return malformed;
}

export function malformedNativeSubagentFieldWarning(field: NativeSubagentPersistedField): string {
  const expected = field === "syncCodexSubagentDefaults" ? "a boolean" : "a string";
  return `${field} ignored: expected ${expected}`;
}

export function malformedCodexAccountPickerWarning(rawParsed: unknown): string | null {
  const raw = rawConfigRecord(rawParsed);
  if (!raw || !Object.hasOwn(raw, "codexAccountPickerEnabled")) return null;
  if (typeof raw.codexAccountPickerEnabled === "boolean") return null;
  return "codexAccountPickerEnabled ignored: expected a boolean";
}

export function warnDegradedCodexAccountPicker(rawParsed: unknown): void {
  const warning = malformedCodexAccountPickerWarning(rawParsed);
  if (warning) console.warn(`⚠️  config.json ${warning}. Other settings were preserved.`);
}

export function nativeSubagentSyncDisabledReason(config: OcxConfig, rawParsed?: unknown): string | null {
  if (config.syncCodexSubagentDefaults !== true) return null;
  const malformed = malformedNativeSubagentFields(rawParsed);
  if (malformed.includes("injectionModel")) return "injectionModel must be a string";
  if (!config.injectionModel?.trim()) return "a nonblank injectionModel is required";
  if (malformed.includes("injectionEffort")) return "injectionEffort must be a string or omitted";
  if (config.injectionEffort !== undefined && !isCodexReasoningEffort(config.injectionEffort)) {
    return "injectionEffort must be a supported Codex reasoning effort";
  }
  return null;
}

export function normalizeNativeSubagentSync(config: OcxConfig, rawParsed?: unknown): OcxConfig {
  if (!nativeSubagentSyncDisabledReason(config, rawParsed)) return config;
  const normalized = { ...config };
  delete normalized.syncCodexSubagentDefaults;
  return normalized;
}

export function warnDegradedNativeSubagentConfig(rawParsed: unknown, config: OcxConfig): void {
  for (const field of malformedNativeSubagentFields(rawParsed)) {
    console.warn(`⚠️  config.json ${malformedNativeSubagentFieldWarning(field)}. Other settings were preserved.`);
  }
  const reason = nativeSubagentSyncDisabledReason(config, rawParsed);
  if (reason) {
    console.warn(`⚠️  config.json syncCodexSubagentDefaults was disabled: ${reason}. Other settings were preserved.`);
  }
}

/**
 * Registry metadata can gain service-tier capability after a config was written. An explicit
 * `fastWire: null` remains authoritative on load and on whole-document writes; rejecting either
 * would discard or lock access to unrelated providers and API keys. Direct contradictions within
 * one provider row remain schema errors through the outer config refinement, where the dynamic
 * provider name can be redacted before it reaches diagnostics.
 */
export function inheritedFastWireConflictProviderNames(
  config: Pick<OcxConfig, "providers">,
): string[] {
  const conflicts: string[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.fastWire !== null || provider.supportsServiceTier === false) continue;
    const registry = providerMatchesRegistryTransport(name, provider)
      ? getProviderRegistryEntry(name)
      : undefined;
    if (!registry) continue;
    const effectiveProviderCapability = provider.supportsServiceTier ?? registry.supportsServiceTier;
    const effectiveModelCapabilities = {
      ...(registryModelServiceTierCapabilityApplies(registry, provider)
        ? registry.modelSupportsServiceTier ?? {}
        : {}),
      ...(provider.modelSupportsServiceTier ?? {}),
    };
    if (
      effectiveProviderCapability === true
      || Object.values(effectiveModelCapabilities).some(value => value === true)
    ) {
      conflicts.push(name);
    }
  }
  return conflicts;
}

export function inheritedFastWireConflictWarning(name: string): string {
  return `providers.${redactSecretString(name)}.fastWire=null overrides service-tier capability inherited from the matching registry entry`;
}

export function warnInheritedFastWireConflicts(configPath: string, config: OcxConfig): void {
  const names = inheritedFastWireConflictProviderNames(config);
  if (names.length === 0 || hasWarnedInheritedFastWireConflict(configPath)) return;
  markWarnedInheritedFastWireConflict(configPath);
  console.warn(
    `⚠️  config.json ${names.map(inheritedFastWireConflictWarning).join("; ")}. `
    + "The persisted providers and API keys were preserved.",
  );
}

/** Hand-edited alias mistakes disable only the bad alias; providers and routing survive. */
export function sanitizeAliasesForLoad(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const root = raw as Record<string, unknown>;
  if (!root.providers || typeof root.providers !== "object" || Array.isArray(root.providers)) return;
  const providers = root.providers as Record<string, Record<string, unknown>>;
  const providerNames = new Set(Object.keys(providers).map(name => name.toLowerCase()));
  const claimedProviders = new Set<string>();
  const comboAliases = new Set(Object.values((root.combos as Record<string, { alias?: unknown }> | undefined) ?? {})
    .map(combo => typeof combo?.alias === "string" ? combo.alias.toLowerCase() : "").filter(Boolean));
  const accountNamespaces = new Set(Object.keys((root.codexAccountNamespaces as Record<string, unknown> | undefined) ?? {}).map(name => name.toLowerCase()));
  for (const provider of Object.values(providers)) {
    const alias = provider.alias;
    if (typeof alias !== "string" || !isValidProviderName(alias)
      || providerNames.has(alias.toLowerCase()) || claimedProviders.has(alias.toLowerCase())
      || comboAliases.has(alias.toLowerCase()) || accountNamespaces.has(alias.toLowerCase())) {
      if (alias !== undefined) console.warn("Ignoring invalid or colliding provider alias in config.json");
      delete provider.alias;
    } else claimedProviders.add(alias.toLowerCase());
    if (!provider.modelAliases || typeof provider.modelAliases !== "object" || Array.isArray(provider.modelAliases)) {
      if (provider.modelAliases !== undefined) delete provider.modelAliases;
      continue;
    }
    const aliases = provider.modelAliases as Record<string, unknown>;
    const nativeIds = new Set((Array.isArray(provider.models) ? provider.models : []).filter((id): id is string => typeof id === "string").map(id => id.toLowerCase()));
    const claimed = new Set<string>();
    for (const [id, value] of Object.entries(aliases)) {
      const lower = typeof value === "string" ? value.toLowerCase() : "";
      if (typeof value !== "string" || !MODEL_ALIAS_PATTERN.test(value) || claimed.has(lower)
        || nativeIds.has(lower) || comboAliases.has(lower) || /^(?:gpt-|o1-|o3-|o4-|codex-)/i.test(value)) {
        console.warn(`Ignoring invalid or colliding model alias for ${id} in config.json`);
        delete aliases[id];
      } else claimed.add(lower);
    }
  }
}

/** Hand-edited display-name mistakes disable only the bad label. */
export function sanitizeModelDisplayNamesForLoad(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const root = raw as Record<string, unknown>;
  if (!root.providers || typeof root.providers !== "object" || Array.isArray(root.providers)) return;
  for (const [providerName, providerValue] of Object.entries(root.providers as Record<string, unknown>)) {
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) continue;
    const provider = providerValue as Record<string, unknown>;
    const value = provider.modelDisplayNames;
    if (value === undefined) continue;
    const providerLabel = JSON.stringify(redactSecretString(providerName));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.entries(value).length > MODEL_DISCOVERY_MAX_MODELS) {
      console.warn(`Ignoring invalid modelDisplayNames map for provider ${providerLabel} in config.json`);
      delete provider.modelDisplayNames;
      continue;
    }
    const labels = value as Record<string, unknown>;
    for (const [modelId, rawDisplayName] of Object.entries(labels)) {
      const displayName = typeof rawDisplayName === "string" ? rawDisplayName.trim() : rawDisplayName;
      if (modelDisplayNamesConfigError({ [modelId]: displayName })) {
        const safeModelId = JSON.stringify(redactSecretString(modelId));
        console.warn(`Ignoring invalid modelDisplayNames entry ${safeModelId} for provider ${providerLabel} in config.json`);
        delete labels[modelId];
      } else {
        labels[modelId] = displayName;
      }
    }
    if (Object.keys(labels).length === 0) delete provider.modelDisplayNames;
  }
}

/** Refresh the user cost-overlay registry from `config` and return it unchanged. */
export function withRefreshedCostOverlays(config: OcxConfig): OcxConfig {
  refreshUserCostOverlays(config);
  return config;
}
