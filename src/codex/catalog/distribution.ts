import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { parseCatalogJson, readCodexCatalogPath } from "./parsing";

/**
 * The one place a stored Codex catalog becomes an HTTP-shippable document.
 *
 * Two routes distribute the catalog — management `GET /api/catalog` and data-plane
 * `GET /v1/catalog` (#809) — and the issue's hard requirement is that they consume the
 * same authority rather than each growing its own reader and serializer. Both call this
 * function and serialize nothing themselves, so a change to catalog materialization
 * cannot land on one surface and miss the other.
 *
 * This boundary owns three decisions:
 *
 * 1. A hard-bounded source read. The file's size is checked through the open descriptor
 *    before any bytes are read, so an arbitrarily large file is refused without being
 *    pulled into memory and handed to `JSON.parse`.
 * 2. A safety verdict. `RawCatalog` deliberately preserves unknown fields (Codex owns the
 *    schema and grows it), which means this process cannot know that every field is safe
 *    to distribute. A document carrying credential-shaped, account-shaped, or
 *    config-shaped content is REJECTED deterministically rather than served, and rather
 *    than silently stripped — deleting unknown fields would corrupt a document whose
 *    schema belongs to Codex. Whether a strict field projection should replace this
 *    rejection is an open maintainer decision recorded in
 *    `structure/05_gui-and-management-api.md`.
 * 3. Serialization. The exact bytes both routes send.
 *
 * What deliberately stays with the callers is transport: admission, CORS, cache policy,
 * and each plane's own error envelope. Those differ by design; the document does not.
 */

export const CATALOG_DISTRIBUTION_CONTENT_TYPE = "application/json";

/**
 * Hard ceiling on the raw catalog file this module will read before parsing.
 *
 * Distinct from the data-plane response ceiling: the catalog writer pretty-prints, so a
 * legitimate file is larger than its compact serialization, and this bound exists to
 * protect `JSON.parse`, not the wire. Sized to match the repository's other 32 MiB input
 * bounds (upstream JSON bodies, compact responses).
 */
export const CATALOG_SOURCE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Codex version the running proxy selected, when it has an authoritative one.
 *
 * Absent is a real answer. The header is omitted rather than guessed when no runtime
 * record exists — a fabricated version is worse than none for a client comparing skew.
 */
export const CATALOG_CODEX_VERSION_HEADER = "x-opencodex-codex-version";

export interface MaterializedCatalog {
  readonly status: "ok";
  /** Exact bytes both routes send, so neither can reorder or re-shape the document. */
  readonly body: string;
  readonly byteLength: number;
  readonly codexVersion?: string;
}

export type CatalogDistribution =
  | MaterializedCatalog
  | { readonly status: "missing" }
  /** The on-disk file exceeds {@link CATALOG_SOURCE_MAX_BYTES}; nothing was parsed. */
  | { readonly status: "source-too-large" }
  /** The document carries content that must not be distributed; nothing is echoed. */
  | { readonly status: "unsafe" };

/**
 * Object keys that mark a document as carrying non-catalog state.
 *
 * Keys are compared after lowercasing and stripping `_`, `-`, and spaces, so `api_key`,
 * `apiKey`, and `API-Key` are one key. The rules were checked against every key in the
 * pinned upstream catalog snapshot (`src/codex/data/upstream-models.json`) plus the
 * OpenCodex-added markers, so a genuine catalog does not trip them — e.g.
 * `auto_compact_token_limit` normalizes to a `…limit` suffix, not `…token`.
 */
const SENSITIVE_KEY_EXACT = new Set([
  "auth",
  "oauth",
  "authorization",
  "password",
  "passwd",
  "email",
  "emails",
  "header",
  "headers",
  "env",
  "environment",
  "adapter",
  "adapters",
]);

const SENSITIVE_KEY_SUFFIXES = [
  "apikey",
  "apikeys",
  "token",
  "secret",
  "secrets",
  "password",
  "credential",
  "credentials",
  "baseurl",
  "accountid",
  "accountemail",
] as const;

/**
 * String values that mark a document as carrying secrets, identities, or local paths.
 *
 * Grounded in the same snapshot: the genuine catalog contains URLs inside instruction
 * text (so a URL rule would reject every real catalog and is deliberately absent), but
 * it contains no email addresses, no home-directory paths, no `Bearer` values, and no
 * token-shaped strings. Each pattern below therefore only ever matches injected content.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // The proxy's own admission-secret shapes (see isProxyAdmissionSecret).
  /ocx_(?:data|admin|session)_[A-Za-z0-9]/,
  /\bocx_[0-9a-f]{40}\b/,
  // Provider / platform key and OAuth token shapes (same family privacy-scan flags).
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bghp_[A-Za-z0-9_]{20,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  // Authorization header values. The length floor keeps prose like "Bearer token" out.
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/,
  // Local filesystem home paths, POSIX and Windows.
  /\/(?:Users|home)\/[^\s"'\\]+/,
  /[A-Za-z]:[\\/](?:Users|home)[\\/]/i,
];

const EMAIL_LOCAL_PART = /[A-Za-z0-9._%+-]{1,64}$/;
const EMAIL_DOMAIN_PART = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Email detection anchored at each `@` rather than expressed as one unanchored regex.
 *
 * The obvious `/local+@domain/` pattern is quadratic under a backtracking engine on a
 * large non-matching string: every position greedily consumes the local-part class to the
 * end of the input before failing. A catalog document is allowed to be megabytes, so the
 * walk scans for `@` (linear) and tests only a bounded neighborhood around each hit.
 */
function containsEmailShapedValue(value: string): boolean {
  let at = value.indexOf("@");
  while (at !== -1) {
    if (
      EMAIL_LOCAL_PART.test(value.slice(Math.max(0, at - 64), at))
      && EMAIL_DOMAIN_PART.test(value.slice(at + 1, at + 256))
    ) {
      return true;
    }
    at = value.indexOf("@", at + 1);
  }
  return false;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  if (SENSITIVE_KEY_EXACT.has(normalized)) return true;
  return SENSITIVE_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

function isSensitiveValue(value: string): boolean {
  return containsEmailShapedValue(value) || SENSITIVE_VALUE_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * Whether a parsed catalog document is safe to distribute.
 *
 * Iterative walk (a hostile document can nest deeper than the call stack), every key and
 * every string value at every depth. The answer is a bare boolean by design: the caller's
 * error must not echo which key or value matched, because the match IS the sensitive
 * content.
 */
export function isCatalogDocumentSafeToDistribute(document: unknown): boolean {
  const pending: unknown[] = [document];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (isSensitiveValue(current)) return false;
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    if (current && typeof current === "object") {
      for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
        if (isSensitiveKey(key)) return false;
        pending.push(value);
      }
    }
  }
  return true;
}

/**
 * Read at most {@link CATALOG_SOURCE_MAX_BYTES} of the catalog file.
 *
 * The size check runs on the already-open descriptor, and the read is capped at the size
 * that was checked — a file that grows between the two calls yields a short or failed
 * parse, never an unbounded read. Open/stat/read failures all collapse to `missing`: the
 * distinction is a local filesystem fact and neither plane should describe the
 * operator's disk to a caller.
 */
function readCatalogSourceBounded(path: string): { status: "ok"; text: string } | { status: "missing" } | { status: "source-too-large" } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { status: "missing" };
  }
  try {
    const size = Number(fstatSync(fd).size);
    if (!Number.isSafeInteger(size) || size < 0) return { status: "missing" };
    if (size > CATALOG_SOURCE_MAX_BYTES) return { status: "source-too-large" };
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return { status: "ok", text: buffer.subarray(0, offset).toString("utf8") };
  } catch {
    return { status: "missing" };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read, bound, vet, and serialize the stored catalog — or report deterministically why
 * it cannot be distributed. Every failure variant is content-free by construction.
 */
export async function materializeCatalogDistribution(): Promise<CatalogDistribution> {
  const source = readCatalogSourceBounded(readCodexCatalogPath());
  if (source.status !== "ok") return { status: source.status };
  const catalog = parseCatalogJson(source.text);
  if (!catalog) return { status: "missing" };
  if (!isCatalogDocumentSafeToDistribute(catalog)) return { status: "unsafe" };
  const body = JSON.stringify(catalog);
  // Imported here rather than at module scope: the runtime module pulls in Codex
  // process resolution, and the catalog routes are the only reason it would load.
  const { loadPersistedCodexRuntime } = await import("../runtime");
  const codexVersion = loadPersistedCodexRuntime()?.selectedVersion;
  return {
    status: "ok",
    body,
    byteLength: Buffer.byteLength(body, "utf8"),
    ...(codexVersion ? { codexVersion } : {}),
  };
}

/**
 * Content type and version metadata for a materialized catalog.
 *
 * Shared so the two routes cannot disagree about the document's declared type or its
 * version/skew header. Cache and security headers are per-plane and are added by the
 * caller.
 */
export function catalogDistributionHeaders(catalog: MaterializedCatalog): Record<string, string> {
  return {
    "Content-Type": CATALOG_DISTRIBUTION_CONTENT_TYPE,
    ...(catalog.codexVersion ? { [CATALOG_CODEX_VERSION_HEADER]: catalog.codexVersion } : {}),
  };
}
