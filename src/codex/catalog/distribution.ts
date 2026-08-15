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
 * 2. A safety verdict — a HEURISTIC DENYLIST, not a guarantee. See
 *    {@link isCatalogDocumentSafeToDistribute} for exactly what it does and does not
 *    catch. The current strategy (reject the whole document rather than project or strip
 *    fields) is an executor choice, not accepted architecture; the accepted invariant is
 *    only that credentials, account identity, provider configuration, filesystem paths,
 *    and management-only state must not be distributed. "Strict projection versus
 *    heuristic rejection" is an open maintainer decision recorded in
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
 * Keys are compared after lowercasing and dropping every non-alphanumeric character, so
 * `api_key`, `apiKey`, `API-Key`, `api.key`, and `api key` are one key. Normalizing all
 * punctuation rather than a chosen three (`_`, `-`, space) is what keeps a spelling like
 * `account.id` from walking past the `accountid` suffix below; the "a real generated
 * catalog stays distributable" tests in tests/v1-catalog-route.test.ts hold the other
 * side, that a real catalog's keys still pass. Grounded in every key of the pinned
 * upstream snapshot
 * (`src/codex/data/upstream-models.json`) plus the OpenCodex-added markers — e.g.
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
 * String values whose SHAPE marks a document as carrying secrets, identities, or paths.
 *
 * Grounded in the same snapshot: a genuine catalog contains URLs inside instruction text
 * (so a blanket URL rule would reject every real catalog and is deliberately absent), but
 * it contains no email addresses, no home-directory paths, no `Bearer` values, and no
 * token-shaped strings. Each pattern below therefore only ever matches injected content.
 *
 * Case-insensitive where the protocol is: an HTTP scheme token is case-insensitive, so
 * `bearer <token>` and `Bearer <token>` are the same header value and must be treated
 * alike. The vendor prefixes (`sk-`, `ghp_`, `ocx_`, `eyJ`) stay case-sensitive because
 * those literals are fixed by their issuers' formats.
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
  /bearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
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
  // Drop every separator, not a chosen subset: `account.id`, `account-id`, `account_id`,
  // `account id`, and `accountId` are one spelling of one key.
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_KEY_EXACT.has(normalized)) return true;
  return SENSITIVE_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

function isSensitiveValue(value: string): boolean {
  return containsEmailShapedValue(value) || SENSITIVE_VALUE_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * Whether a parsed catalog document *appears* safe to distribute.
 *
 * Iterative walk (a hostile document can nest deeper than the call stack), every key and
 * every string value at every depth. The answer is a bare boolean by design: the caller's
 * error must not echo which key or value matched, because the match IS the sensitive
 * content.
 *
 * **This is a heuristic denylist, not a guarantee, and it must not be described as one.**
 * It catches content that announces itself — a sensitive key spelling, or a value in a
 * recognizable credential/identity/home-path format. It does NOT catch a secret with no
 * recognizable shape sitting in a legitimate catalog field. Verified gaps:
 *
 * - a raw provider base URL in an ordinary string field (a URL rule would reject every
 *   real catalog, whose instruction text contains URLs);
 * - an arbitrary-format admin or provider token, e.g. a bare hex string;
 * - an arbitrary account identifier that is not email-shaped and sits under a key that
 *   does not name an account;
 * - an absolute path outside a home directory, e.g. `D:\ocx\config.json`.
 *
 * Closing those needs a different strategy, not a wider denylist: either a strict field
 * projection (serialize only allowlisted fields) or exact-value comparison against the
 * live configuration and credential stores. Both are policy calls — projection can delete
 * fields belonging to a Codex schema this release does not know, and value comparison
 * would pull a config/credential dependency into this materializer — so they are recorded
 * as open maintainer decisions in `structure/05_gui-and-management-api.md` rather than
 * guessed at here. What this function is for is stopping the accidental and the obvious;
 * the accepted invariant it serves is that such content must not be distributed, not that
 * this predicate proves it never is.
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
