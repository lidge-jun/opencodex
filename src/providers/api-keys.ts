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
import { cleanupRemovedGcpCredentials } from "./gcp-credential-cleanup";

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
 * API keys) is one row per JSON object. File paths are rejected with guidance rather
 * than stored, because they are the most common paste mistake and silently break at runtime.
 *
 * Honors the parseGcpCredentialJson contract "a literal key that starts with `{` is never eaten":
 * a brace-leading value that is NOT recognizable credential JSON falls back to a plain literal
 * row (preserving the old single-line behavior), and only a multi-line or multi-object paste that
 * fails credential validation rejects with guidance. The brace scanner tracks JSON string and
 * escape state so a `}` inside a string field does not split the object early; any non-separator
 * text between objects is rejected rather than silently discarded.
 */
export function splitCredentialPaste(value: string): Array<string | { credentialJson: string }> {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return [];
  // Fast path: a plain key (no JSON braces) — also covers env/keychain/gcp-sa references.
  if (!trimmed.startsWith("{")) {
    if (/^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/])/.test(trimmed) || /^[^\s{}]+\.json$/i.test(trimmed)) {
      throw new Error("This looks like a file path. Paste the full JSON body of the credential, not a file path.");
    }
    return [trimmed];
  }
  // Brace-leading scans: split adjacent JSON objects (comma/newline separated). The scanner
  // tracks string/escape state so braces inside JSON string fields do not count, and records
  // each object's [start, end] so the gap check below can reject non-separator junk between
  // objects in one pass.
  const spans: Array<{ start: number; end: number }> = [];
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" && depth === 0) {
      start = i;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(trimmed.slice(start, i + 1));
        spans.push({ start, end: i });
        start = -1;
      }
      if (depth < 0) throw new Error("Invalid credential JSON: unbalanced braces.");
    }
  }
  if (depth !== 0 || start >= 0) throw new Error("Invalid credential JSON: the pasted text ends inside a JSON object.");
  // Single unrecognized object on a single line = a plain key starting with `{` (never eaten) —
  // BUT only when it is NOT real JSON: a parseable JSON object with an unrecognized `type`
  // (e.g. `external_account`) is a credential the user believes is valid, and saving it as a
  // plaintext literal key would send it to the wire. Distinguish by parse success, not shape.
  const singleLine = !/[\r\n]/.test(trimmed);
  const isRealJson = (() => {
    try { JSON.parse(objects[0]!); return true; } catch { return false; }
  })();
  if (objects.length === 1 && singleLine && spans[0]!.end === trimmed.length - 1 && !parseGcpCredentialJson(objects[0]!) && !isRealJson) {
    return [trimmed];
  }
  // Non-separator content BETWEEN and AFTER objects is rejected, not silently discarded:
  // everything between/after one object's close must be a separator character.
  for (let i = 0; i < spans.length; i++) {
    if (i === 0) {
      if (!/^[\s,]*$/.test(trimmed.slice(0, spans[0]!.start))) {
        throw new Error("Unrecognized credential JSON: unexpected content before the first JSON object. Paste credential JSON(s) separated by commas or newlines, or a plain API key.");
      }
      continue;
    }
    const gap = trimmed.slice(spans[i - 1]!.end + 1, spans[i]!.start);
    if (!/^[\s,]*$/.test(gap)) {
      throw new Error("Unrecognized credential JSON: unexpected content between JSON objects. Paste credential JSON(s) separated by commas or newlines, or a plain API key.");
    }
  }
  // Tail gap: content after the LAST object's close up to EOF must also be separators —
  // trailing garbage (`<json> garbage`) is rejected rather than silently kept.
  const tailGap = trimmed.slice(spans[spans.length - 1]!.end + 1);
  if (!/^[\s,]*$/.test(tailGap)) {
    throw new Error("Unrecognized credential JSON: unexpected content after the last JSON object. Paste credential JSON(s) separated by commas or newlines, or a plain API key.");
  }
  return objects.map((json) => {
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
function storeGcpCredentialJson(config: OcxConfig, name: string, credentialJson: string, existedBefore: boolean): string {
  const probe = probeProviderKeychain();
  if (!probe.available) throw new Error(`OS keychain unavailable: ${probe.reason}`);
  const id = apiKeyPoolEntryId(credentialJson);
  const account = gcpCredentialStoreAccount(name, id);
  const entry = providerKeychainEntry(account);
  entry.setPassword(credentialJson);
  if (entry.getPassword() !== credentialJson) {
    // Delete on mismatch ONLY when this write created the entry: a re-paste targets an account an
    // existing `gcp-sa:` marker already names, and deleting it would destroy the live credential
    // the config still references.
    if (!existedBefore) {
      try { entry.deletePassword(); } catch { /* best effort */ }
    }
    throw new Error(`keychain read-back mismatch for ${account}`);
  }
  return `${GCP_CREDENTIAL_MARKER_PREFIX}${account}`;
}

/** The credential-store account a marker names for `name`/`id` (write + cleanup share it). */
function gcpCredentialStoreAccount(name: string, id: string): string {
  return `${name}/${id}`;
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
      const stored: Array<{ id: string; marker: string }> = [];
      const created: string[] = [];
      try {
        for (const part of parts) {
          const credentialJson = (part as { credentialJson: string }).credentialJson;
          const id = apiKeyPoolEntryId(credentialJson);
          const account = gcpCredentialStoreAccount(name, id);
          const existedBefore = providerKeychainEntry(account).getPassword() !== null;
          if (!existedBefore) created.push(`${GCP_CREDENTIAL_MARKER_PREFIX}${account}`);
          stored.push({ id, marker: storeGcpCredentialJson(config, name, credentialJson, existedBefore) });
        }
        const committed = commitProviderApiKeySelection(config, name, fresh => {
          const pool = ensurePool(fresh);
          for (const { id, marker } of stored) {
            const existing = pool.find(e => e.id === id);
            if (existing) {
              existing.key = marker;
              if (label?.trim()) existing.label = label.trim();
            } else {
              pool.push({ id, key: marker, ...(label?.trim() ? { label: label.trim() } : {}), addedAt: Date.now() });
            }
          }
          fresh.apiKey = stored[0]!.marker;
          return { changed: true, selectionChanged: true, value: stored[0]!.id };
        });
        if (committed.status === "committed") {
          invalidateResolvedProviderKeyCache();
          return { id: committed.value };
        }
        cleanupRemovedGcpCredentials(created);
        return { error: "provider selection unavailable" };
      } catch (error) {
        cleanupRemovedGcpCredentials(created);
        return { error: error instanceof Error ? error.message : "credential storage failed" };
      }
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
  let removed: string | undefined;
  const committed = commitProviderApiKeySelection(config, name, provider => {
    const pool = provider.apiKeyPool?.length ? provider.apiKeyPool
      : provider.apiKey ? [{ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey }] : [];
    const entry = pool.find(e => e.id === id);
    if (!entry) return { changed: false, value: false };
    removed = entry.key;
    provider.apiKeyPool = pool.filter(e => e.id !== id);
    if (provider.apiKey === entry.key) {
      const next = provider.apiKeyPool[0];
      if (next) provider.apiKey = next.key;
      else delete provider.apiKey;
    }
    if (provider.apiKeyPool.length === 0) delete provider.apiKeyPool;
    return { changed: true, value: true };
  });
  if (committed.status !== "committed" || !committed.value) return false;
  if (removed?.startsWith(GCP_CREDENTIAL_MARKER_PREFIX)) cleanupRemovedGcpCredentials([removed]);
  invalidateResolvedProviderKeyCache();
  return true;
}
