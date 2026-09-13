import { existsSync, readFileSync, statSync } from "node:fs";

import { MAX_REMOTE_CATALOG_BYTES } from "../../server/catalog-download";
import { readBoundedResponseBytes } from "../../lib/bounded-body";
import { withCatalogWriteSerialization, type CatalogSerializationOutcome } from "../catalog-write-serialization";
import { replaceActiveCodexCatalog } from "../internal/catalog-writer";
import { getCodexHome } from "../paths";
import { readCodexCatalogPathForHome } from "./parsing";
import { invalidateCodexModelsCacheWithPermit } from "./sync";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MODELS = 2_000;
const MAX_SLUG_BYTES = 512;
const ALLOWED_MODALITIES = new Set(["text", "image", "audio"]);

export type RemoteCatalogFailureCode =
  | "url_invalid" | "insecure_http_refused" | "credential_invalid" | "request_failed"
  | "redirect_refused" | "http_error" | "body_too_large" | "body_invalid"
  | "catalog_invalid" | "write_failed" | "lock_busy" | "lock_database" | "unsafe_path";

export class RemoteCatalogError extends Error {
  constructor(readonly code: RemoteCatalogFailureCode, message: string, readonly status?: number) {
    super(message);
    this.name = "RemoteCatalogError";
  }
}

export interface RemoteCatalogDocument extends Record<string, unknown> {
  models: Record<string, unknown>[];
}

export interface PullRemoteCatalogOptions {
  token?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  codexHome?: string;
}

export interface PullRemoteCatalogResult {
  status: "updated" | "unchanged";
  catalogWritten: boolean;
  cacheSynced: boolean;
  codexHome: string;
  catalogPath: string;
  modelCount: number;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export function validateRemoteCatalogUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new RemoteCatalogError("url_invalid", "Catalog URL must be an absolute HTTPS URL"); }
  if (url.username || url.password) throw new RemoteCatalogError("url_invalid", "Catalog URL must not contain credentials");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new RemoteCatalogError("insecure_http_refused", "Catalog URL requires HTTPS (HTTP is allowed only on loopback)");
  }
  if (url.pathname !== "/v1/catalog" || url.search || url.hash) {
    throw new RemoteCatalogError("url_invalid", "Catalog URL must identify /v1/catalog without query or fragment");
  }
  return url;
}

function validateToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  if (!token || token.length > 4096 || /[\r\n\0]/.test(token)) {
    throw new RemoteCatalogError("credential_invalid", "Catalog authentication environment variable is invalid");
  }
  return token;
}

export function validateRemoteCatalogDocument(value: unknown): RemoteCatalogDocument {
  const invalid = (message: string): never => { throw new RemoteCatalogError("catalog_invalid", message); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Remote catalog must be a JSON object");
  const document = value as Record<string, unknown>;
  const rawModels = document.models;
  if (!Array.isArray(rawModels) || rawModels.length === 0 || rawModels.length > MAX_MODELS) {
    invalid("Remote catalog models must be a non-empty bounded array");
  }
  const models = rawModels as unknown[];
  const slugs = new Set<string>();
  for (const row of models) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.getPrototypeOf(row) !== Object.prototype) {
      invalid("Remote catalog model rows must be plain objects");
    }
    const model = row as Record<string, unknown>;
    const rawSlug = model.slug;
    if (typeof rawSlug !== "string") invalid("Remote catalog contains an invalid model slug");
    const slug = rawSlug as string;
    if (slug !== slug.trim() || !slug
      || new TextEncoder().encode(slug).byteLength > MAX_SLUG_BYTES || /[\x00-\x1f\x7f]/.test(slug)) {
      invalid("Remote catalog contains an invalid model slug");
    }
    if (slugs.has(slug)) invalid("Remote catalog contains duplicate model slugs");
    slugs.add(slug);
    if (Object.hasOwn(model, "input_modalities")) {
      const modalities = model.input_modalities;
      if (!Array.isArray(modalities) || modalities.length === 0
        || modalities.some(item => typeof item !== "string" || !ALLOWED_MODALITIES.has(item))) {
        invalid("Remote catalog contains unsupported input modalities");
      }
    }
  }
  return document as RemoteCatalogDocument;
}

function safeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 120_000) : DEFAULT_TIMEOUT_MS;
}

export async function fetchRemoteCatalog(
  input: string,
  options: Pick<PullRemoteCatalogOptions, "token" | "timeoutMs" | "maxBytes" | "fetchImpl"> = {},
): Promise<{ document: RemoteCatalogDocument; content: string }> {
  const url = validateRemoteCatalogUrl(input);
  const token = validateToken(options.token);
  const headers = new Headers({ Accept: "application/json" });
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(safeTimeout(options.timeoutMs)),
    });
  } catch {
    throw new RemoteCatalogError("request_failed", "Remote catalog request did not complete");
  }
  if (response.status >= 300 && response.status < 400) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new RemoteCatalogError("redirect_refused", "Remote catalog redirect was refused", response.status);
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new RemoteCatalogError("http_error", `Remote catalog request failed with HTTP ${response.status}`, response.status);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && contentType?.endsWith("+json") !== true) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new RemoteCatalogError("body_invalid", "Remote catalog response was not JSON");
  }
  const maxBytes = options.maxBytes ?? MAX_REMOTE_CATALOG_BYTES;
  const declaredRaw = response.headers.get("content-length");
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw new RemoteCatalogError("body_too_large", "Remote catalog exceeded the allowed size");
    }
  }
  let bytes: Uint8Array;
  try {
    const bounded = await readBoundedResponseBytes(response, { maxBytes, inactivityTimeoutMs: safeTimeout(options.timeoutMs) });
    if (bounded.oversized) throw new RemoteCatalogError("body_too_large", "Remote catalog exceeded the allowed size");
    bytes = bounded.bytes;
  } catch (error) {
    if (error instanceof RemoteCatalogError) throw error;
    throw new RemoteCatalogError("request_failed", "Remote catalog download did not complete");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new RemoteCatalogError("body_invalid", "Remote catalog was not valid UTF-8"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new RemoteCatalogError("body_invalid", "Remote catalog was not valid JSON"); }
  const document = validateRemoteCatalogDocument(parsed);
  return { document, content: `${JSON.stringify(document, null, 2)}\n` };
}

function mapSerializationFailure<T>(outcome: CatalogSerializationOutcome<T>): never {
  if (outcome.kind === "completed") throw new RemoteCatalogError("write_failed", "Remote catalog installation failed");
  const code = outcome.reason === "busy" ? "lock_busy" : outcome.reason === "database" ? "lock_database" : "unsafe_path";
  throw new RemoteCatalogError(code, `Remote catalog installation unavailable (${outcome.reason})`);
}

export async function pullRemoteCatalog(input: string, options: PullRemoteCatalogOptions = {}): Promise<PullRemoteCatalogResult> {
  // Network acquisition and fail-closed validation intentionally happen before K.
  const fetched = await fetchRemoteCatalog(input, options);
  const codexHome = options.codexHome ?? getCodexHome();
  const catalogPath = readCodexCatalogPathForHome(codexHome);
  const current = existsSync(catalogPath) ? readFileSync(catalogPath) : null;
  const candidate = Buffer.from(fetched.content, "utf8");
  if (current?.equals(candidate)) {
    return { status: "unchanged", catalogWritten: false, cacheSynced: false, codexHome, catalogPath, modelCount: fetched.document.models.length };
  }
  const outcome = withCatalogWriteSerialization(codexHome, permit => {
    // Re-check under K: another writer may have installed these bytes while the request was in flight.
    const lockedCurrent = existsSync(catalogPath) ? readFileSync(catalogPath) : null;
    if (lockedCurrent?.equals(candidate)) return { catalogWritten: false, cacheSynced: false };
    replaceActiveCodexCatalog(permit, codexHome, { path: catalogPath, content: fetched.content });
    const cacheSynced = invalidateCodexModelsCacheWithPermit(permit, codexHome, { allowWhenDesiredDisabled: true });
    if (!cacheSynced) throw new RemoteCatalogError("write_failed", "Remote catalog cache synchronization failed");
    return { catalogWritten: true, cacheSynced: true };
  });
  if (outcome.kind !== "completed") return mapSerializationFailure(outcome);
  return {
    status: outcome.value.catalogWritten ? "updated" : "unchanged",
    ...outcome.value,
    codexHome,
    catalogPath,
    modelCount: fetched.document.models.length,
  };
}
