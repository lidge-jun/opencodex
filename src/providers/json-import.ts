import { getProviderRegistryEntry } from "./registry";
import { providerConfigSeed } from "./derive";
import type { OcxProviderConfig } from "../types";

import { extractCodexAccountsFromRaw, type NormalizedCodexAccountImport } from "../codex/bulk-import";

export interface ProviderJsonImportResult {
  providers: Record<string, OcxProviderConfig>;
  codexAccounts: NormalizedCodexAccountImport[];
  sourceKind: "9router-connections" | "9router-account-bulk" | "codex-account-bulk" | "opencodex-providers" | "unknown";
  importedProviderNames: string[];
  importedAccountCount: number;
  warnings: string[];
}

function sanitizeProviderKey(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-");
  return clean || "custom-provider";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses and normalizes 9router or OpenCodex JSON exports/payloads into
 * ready-to-save OpenCodex configuration entries.
 */
export function parseAndNormalizeProviderJson(input: string | unknown): ProviderJsonImportResult {
  let parsed: unknown = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("Empty input JSON");
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch (err: unknown) {
      throw new Error(`Invalid JSON: ${(err as Error).message}`);
    }
  }

  const result: ProviderJsonImportResult = {
    providers: {},
    codexAccounts: [],
    sourceKind: "unknown",
    importedProviderNames: [],
    importedAccountCount: 0,
    warnings: [],
  };

  if (!parsed || (typeof parsed !== "object" && !Array.isArray(parsed))) {
    throw new Error("JSON payload must be an object or array");
  }

  // 1. Check if Codex accounts payload (9router, Cockpit, Sub2API, auth.json, token lists)
  const codexAccounts = extractCodexAccountsFromRaw(parsed);
  if (codexAccounts.length > 0) {
    result.codexAccounts = codexAccounts;
    result.importedAccountCount = codexAccounts.length;
    result.sourceKind = "codex-account-bulk";

    // If it is solely an account export, return directly
    const hasConnections = isPlainObject(parsed) && (Array.isArray((parsed as Record<string, unknown>).connections) || isPlainObject((parsed as Record<string, unknown>).providers));
    if (!hasConnections && (Array.isArray(parsed) || (isPlainObject(parsed) && Array.isArray((parsed as Record<string, unknown>).accounts)) || isPlainObject(parsed))) {
      // Check if there are any top-level provider configurations
      const isPureAccounts = !isPlainObject(parsed) || !("providers" in (parsed as Record<string, unknown>));
      if (isPureAccounts) {
        return result;
      }
    }
  }

  // 2. Check if 9router connections export:
  // e.g. { connections: [ { provider, apiKey, name, baseUrl, ... } ] }
  if (isPlainObject(parsed) && Array.isArray((parsed as Record<string, unknown>).connections)) {
    result.sourceKind = "9router-connections";
    const connections = (parsed as Record<string, unknown>).connections as unknown[];
    for (const conn of connections) {
      if (isPlainObject(conn)) {
        normalizeSingleConnection(conn, result);
      }
    }
    result.importedProviderNames = Object.keys(result.providers);
    return result;
  }

  // 3. Check if array of connections:
  // e.g. [ { provider: "groq", apiKey: "gsk_...", ... } ]
  if (Array.isArray(parsed)) {
    result.sourceKind = "9router-connections";
    for (const item of parsed) {
      if (isPlainObject(item)) {
        normalizeSingleConnection(item, result);
      }
    }
    result.importedProviderNames = Object.keys(result.providers);
    return result;
  }

  // 4. Check if standard OpenCodex { providers: { [name]: { adapter, baseUrl, ... } } }
  if (isPlainObject(parsed) && isPlainObject((parsed as Record<string, unknown>).providers)) {
    result.sourceKind = "opencodex-providers";
    const provs = (parsed as Record<string, unknown>).providers as Record<string, unknown>;
    for (const [key, val] of Object.entries(provs)) {
      if (isPlainObject(val)) {
        normalizeSingleProvider(key, val, result);
      }
    }
    result.importedProviderNames = Object.keys(result.providers);
    return result;
  }

  // 5. Single connection object: e.g. { provider: "deepseek", apiKey: "sk-...", baseUrl: "..." }
  if (isPlainObject(parsed) && (typeof parsed.provider === "string" || typeof parsed.adapter === "string")) {
    result.sourceKind = "9router-connections";
    normalizeSingleConnection(parsed, result);
    result.importedProviderNames = Object.keys(result.providers);
    return result;
  }

  // 6. Generic map of provider configs: { "my-prov": { baseUrl: "...", apiKey: "..." } }
  if (isPlainObject(parsed)) {
    result.sourceKind = "opencodex-providers";
    for (const [key, val] of Object.entries(parsed)) {
      if (isPlainObject(val) && (val.baseUrl || val.adapter || val.apiKey)) {
        normalizeSingleProvider(key, val, result);
      }
    }
    result.importedProviderNames = Object.keys(result.providers);
    return result;
  }

  return result;
}

function normalizeSingleConnection(conn: Record<string, unknown>, out: ProviderJsonImportResult): void {
  const providerId = typeof conn.provider === "string" ? conn.provider.trim() : "";
  const candidateName = typeof conn.name === "string" && conn.name.trim()
    ? conn.name.trim()
    : providerId || "custom-provider";
  
  let key = sanitizeProviderKey(candidateName);
  let suffix = 1;
  while (out.providers[key]) {
    suffix += 1;
    key = `${sanitizeProviderKey(candidateName)}-${suffix}`;
  }

  const entry = providerId ? getProviderRegistryEntry(providerId) : undefined;
  const apiKey = typeof conn.apiKey === "string" ? conn.apiKey.trim() : undefined;
  
  // Specific data in 9router often nests baseUrl
  const specificData = isPlainObject(conn.providerSpecificData) ? conn.providerSpecificData : null;
  const customBaseUrl = typeof conn.baseUrl === "string" && conn.baseUrl.trim()
    ? conn.baseUrl.trim()
    : typeof specificData?.baseUrl === "string" && specificData.baseUrl.trim()
      ? specificData.baseUrl.trim()
      : undefined;

  if (entry) {
    const seed = providerConfigSeed(entry);
    if (apiKey) {
      seed.apiKey = apiKey;
    }
    if (customBaseUrl && (entry.allowBaseUrlOverride || customBaseUrl !== entry.baseUrl)) {
      seed.baseUrl = customBaseUrl;
    }
    if (Array.isArray(conn.models) && conn.models.every(m => typeof m === "string")) {
      seed.models = conn.models as string[];
    }
    if (typeof conn.defaultModel === "string" && conn.defaultModel.trim()) {
      seed.defaultModel = conn.defaultModel.trim();
    }
    out.providers[key] = seed;
  } else {
    // Custom OpenAI or Anthropic compatible provider
    const baseUrl = customBaseUrl || (conn.baseUrl as string) || "https://api.openai.com/v1";
    const adapter = typeof conn.adapter === "string" && conn.adapter.trim()
      ? conn.adapter.trim()
      : baseUrl.toLowerCase().includes("anthropic")
        ? "anthropic"
        : "openai-chat";

    const customSeed: OcxProviderConfig = {
      adapter,
      baseUrl,
      liveModels: true,
    };
    if (apiKey) {
      customSeed.apiKey = apiKey;
    }
    if (Array.isArray(conn.models) && conn.models.every(m => typeof m === "string")) {
      customSeed.models = conn.models as string[];
    }
    if (typeof conn.defaultModel === "string" && conn.defaultModel.trim()) {
      customSeed.defaultModel = conn.defaultModel.trim();
    }
    out.providers[key] = customSeed;
  }
}

function normalizeSingleProvider(name: string, val: Record<string, unknown>, out: ProviderJsonImportResult): void {
  const key = sanitizeProviderKey(name);
  const entry = getProviderRegistryEntry(key);

  const apiKey = typeof val.apiKey === "string" ? val.apiKey.trim() : undefined;
  const baseUrl = typeof val.baseUrl === "string" ? val.baseUrl.trim() : entry?.baseUrl || "https://api.openai.com/v1";
  const adapter = typeof val.adapter === "string" ? val.adapter.trim() : entry?.adapter || "openai-chat";

  const config: OcxProviderConfig = entry
    ? { ...providerConfigSeed(entry), ...val, adapter, baseUrl }
    : { ...val, adapter, baseUrl };

  if (apiKey) {
    config.apiKey = apiKey;
  }

  out.providers[key] = config;
}
