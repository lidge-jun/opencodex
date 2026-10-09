/**
 * Multi-key pool for key-auth providers (the API-key twin of OAuth multiauth).
 *
 * `provider.apiKey` stays the single source of truth for routing — it always mirrors the
 * ACTIVE pool entry, so the router/adapters never learn about the pool. The pool itself
 * lives in `provider.apiKeyPool` in config.json (same file that already holds apiKey).
 * A legacy bare `apiKey` is projected as one row on reads and seeded on first mutation.
 */
import { createHash } from "node:crypto";
import { saveConfigPreservingClaudeCode } from "../config";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { GCP_CREDENTIAL_MARKER_PREFIX, gcpCredentialMarkerAccount, parseGcpCredentialJson } from "../lib/gcp-adc";
import { invalidateResolvedProviderKeyCache, probeProviderKeychain, providerKeychainEntry } from "./api-key-resolve";
import type { AccountQuotaFields } from "./quota-types";
import { commitProviderApiKeySelection } from "./api-key-selection";

export interface ProviderApiKeyInfo extends AccountQuotaFields {
  id: string;
  label?: string;
  /** First/last 4 chars only; env references (`${VAR}`) are shown verbatim (not secrets). */
  masked: string;
  active: boolean;
  addedAt?: number;
}

function isEnvReference(value: string): boolean {
  return /^\$\{?\w+\}?$/.test(value);
}

export function maskApiKey(value: string): string {
  // Env and keychain references carry no secret material; show them verbatim so an operator
  // can tell where the key lives.
  if (isEnvReference(value) || value.startsWith("keychain:") || value.startsWith(GCP_CREDENTIAL_MARKER_PREFIX)) return value;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/**
 * Split a pasted key value into candidate credentials. A plain API key is one row; a pasted GCP
 * credential JSON (or several, comma/space-separated — the same convention as newline-separated
 * API keys) is one row per JSON object. Windows file paths are rejected with guidance rather
 * than stored, because they are the most common paste mistake and silently break at runtime.
 */
export function splitCredentialPaste(value: string): Array<string | { credentialJson: string }> {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return [];
  // Fast path: a plain key (no JSON braces) — also covers env/keychain/gcp-sa references.
  if (!trimmed.startsWith("{")) {
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
      throw new Error("This looks like a file path. Paste the full JSON body of the credential, not a file path.");
    }
    return [trimmed];
  }
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "{" && depth === 0) start = i;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(trimmed.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) throw new Error("Invalid credential JSON: unbalanced braces.");
    }
  }
  if (depth !== 0 || start >= 0) throw new Error("Invalid credential JSON: the pasted text ends inside a JSON object.");
  return objects.map(json => {
    if (!parseGcpCredentialJson(json)) {
      throw new Error("Unrecognized credential JSON: expected a GCP Service Account or authorized_user JSON with a \"type\" field.");
    }
    return { credentialJson: json };
  });
}

/**
 * Store a pasted GCP credential JSON in the OS keychain and return the `gcp-sa:` marker for it.
 * Verified write (read-back check) mirrors storeProviderKeyInKeychain; on any failure the caller
 * receives an error instead of half-stored state.
 */
function storeGcpCredentialJson(config: OcxConfig, name: string, credentialJson: string): string {
  const probe = probeProviderKeychain();
  if (!probe.available) throw new Error(`OS keychain unavailable: ${probe.reason}`);
  const id = apiKeyPoolEntryId(credentialJson);
  const account = `${name}/${id}`;
  const entry = providerKeychainEntry(account);
  entry.setPassword(credentialJson);
  if (entry.getPassword() !== credentialJson) {
    try { entry.deletePassword(); } catch { /* best effort */ }
    throw new Error(`keychain read-back mismatch for ${account}`);
  }
  return `${GCP_CREDENTIAL_MARKER_PREFIX}${account}`;
}

/** Content-derived id: re-adding the same key upserts instead of duplicating. */
export function apiKeyPoolEntryId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** True for providers whose upstream auth is a configured API key (not oauth/forward). */
export function isKeyAuthProvider(provider: OcxProviderConfig): boolean {
  return provider.authMode !== "oauth" && provider.authMode !== "forward";
}

/** Trim and reject blank / CRLF-bearing secrets. Shared by pool writes and OAuth upsert. */
export function sanitizeApiKeyValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !/[\r\n]/.test(trimmed) ? trimmed : undefined;
}

/** Seed the pool from a legacy bare `apiKey`, and keep `apiKey` mirrored to the active entry. */
function ensurePool(provider: OcxProviderConfig): NonNullable<OcxProviderConfig["apiKeyPool"]> {
  if (!provider.apiKeyPool) provider.apiKeyPool = [];
  if (provider.apiKeyPool.length === 0 && provider.apiKey) {
    provider.apiKeyPool.push({ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey });
  }
  return provider.apiKeyPool;
}

export function listProviderApiKeys(config: OcxConfig, name: string): { activeId: string | null; keys: ProviderApiKeyInfo[] } {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { activeId: null, keys: [] };
  // A GET projects a legacy key without seeding/mutating live configuration.
  const pool = provider.apiKeyPool?.length
    ? provider.apiKeyPool
    : provider.apiKey ? [{ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey }] : [];
  const activeId = (pool.find(entry => entry.key === provider.apiKey) ?? pool[0])?.id ?? null;
  return {
    activeId,
    keys: pool.map(entry => ({
      id: entry.id,
      ...(entry.label ? { label: entry.label } : {}),
      masked: maskApiKey(entry.key),
      active: entry.id === activeId,
      ...(entry.addedAt !== undefined ? { addedAt: entry.addedAt } : {}),
    })),
  };
}

/** Add (or upsert) a key and make it ACTIVE. Persists config. */
export function addProviderApiKey(config: OcxConfig, name: string, key: string, label?: string): { id: string } | { error: string } {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { error: "provider does not use API-key auth" };
  if (typeof key !== "string" || !key.trim()) return { error: "key is required" };
  // GCP credential JSON never enters the literal-key path: it is diverted to the OS keychain and
  // only the `gcp-sa:` marker is stored. splitCredentialPaste runs FIRST (before the CRLF
  // rejection) because pretty-printed JSON contains line breaks, and it also catches the
  // file-path paste mistake with its own guidance before anything is stored.
  try {
    const parts = splitCredentialPaste(key);
    const first = parts[0];
    const isJsonPaste = first !== undefined && typeof first !== "string";
    if (!isJsonPaste) {
      // Not a credential paste — fall through to the plain API-key path below. splitCredentialPaste
      // has already thrown for file paths; a plain key lands here as a single literal row.
    } else {
      if (parts.length > 1) return { error: "paste one credential JSON per request; add each additional credential as its own key" };
      const credentialJson = (first as { credentialJson: string }).credentialJson;
      let marker: string;
      try {
        marker = storeGcpCredentialJson(config, name, credentialJson);
      } catch (error) {
        return { error: error instanceof Error ? error.message : "credential storage failed" };
      }
      const id = apiKeyPoolEntryId(credentialJson);
      const committed = commitProviderApiKeySelection(config, name, fresh => {
        const pool = ensurePool(fresh);
        const existing = pool.find(e => e.id === id);
        if (existing) {
          existing.key = marker;
          if (label?.trim()) existing.label = label.trim();
        } else {
          pool.push({ id, key: marker, ...(label?.trim() ? { label: label.trim() } : {}), addedAt: Date.now() });
        }
        fresh.apiKey = marker;
        return { changed: true, selectionChanged: true, value: id };
      });
      if (committed.status === "committed") {
        invalidateResolvedProviderKeyCache();
        return { id };
      }
      return { error: "provider selection unavailable" };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "credential parse failed" };
  }
  const trimmed = sanitizeApiKeyValue(key);
  if (!trimmed) return { error: "key must not include line breaks" };
  const id = apiKeyPoolEntryId(trimmed);
  const committed = commitProviderApiKeySelection(config, name, fresh => {
    const pool = ensurePool(fresh);
    const existing = pool.find(e => e.id === id);
    if (existing) {
      if (label?.trim()) existing.label = label.trim();
    } else {
      pool.push({ id, key: trimmed, ...(label?.trim() ? { label: label.trim() } : {}), addedAt: Date.now() });
    }
    fresh.apiKey = trimmed;
    return { changed: true, selectionChanged: true, value: id };
  });
  if (committed.status !== "committed") return { error: "provider selection unavailable" };
  return { id };
}

/** Switch the ACTIVE key (mirrors into `provider.apiKey`). Persists config. */
export function setActiveProviderApiKey(config: OcxConfig, name: string, id: string): boolean {
  const committed = commitProviderApiKeySelection(config, name, provider => {
    const entry = provider.apiKeyPool?.find(e => e.id === id)
      ?? (!provider.apiKeyPool?.length && provider.apiKey && apiKeyPoolEntryId(provider.apiKey) === id
        ? { id, key: provider.apiKey } : undefined);
    if (!entry) return { changed: false, value: false };
    ensurePool(provider);
    provider.apiKey = entry.key;
    return { changed: true, selectionChanged: true, value: true };
  });
  return committed.status === "committed" && committed.value;
}

/** Rename a key slot without changing its id, secret, or active routing state. */
export function setProviderApiKeyLabel(config: OcxConfig, name: string, id: string, label: string | undefined): boolean {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return false;
  const entry = ensurePool(provider).find(e => e.id === id);
  if (!entry) return false;
  if (label) entry.label = label;
  else delete entry.label;
  saveConfigPreservingClaudeCode(config);
  return true;
}

/** Remove one key; removing the active one promotes the first remaining. Persists config. */
export function removeProviderApiKey(config: OcxConfig, name: string, id: string): boolean {
  const committed = commitProviderApiKeySelection(config, name, provider => {
    const pool = provider.apiKeyPool?.length ? provider.apiKeyPool
      : provider.apiKey ? [{ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey }] : [];
    const entry = pool.find(e => e.id === id);
    if (!entry) return { changed: false, value: false };
    provider.apiKeyPool = pool.filter(e => e.id !== id);
    if (provider.apiKey === entry.key) {
      const next = provider.apiKeyPool[0];
      if (next) provider.apiKey = next.key;
      else delete provider.apiKey;
    }
    if (provider.apiKeyPool.length === 0) delete provider.apiKeyPool;
    return { changed: true, value: true };
  });
  return committed.status === "committed" && committed.value;
}
