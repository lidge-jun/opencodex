import type { CatalogDisposition, CatalogFailureCause, CatalogNotice } from "./convergence-types";

const INVALID_CATALOG_DISPOSITION_FIELD = Symbol("invalid-catalog-disposition-field");

/** Read an own data property without invoking prototype getters or accessors. */
function ownDataProperty(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor
    ? descriptor.value
    : INVALID_CATALOG_DISPOSITION_FIELD;
}

/** Accept only the public catalog degradation codes. */
function isCatalogNotice(value: unknown): value is CatalogNotice {
  return value === "provider-auth" || value === "provider-network" || value === "fallback";
}

/** Copy a bounded notice array without trusting accessors or a custom iterator. */
function normalizeCatalogNotices(value: unknown): CatalogNotice[] | null {
  if (!Array.isArray(value)) return null;
  const length = ownDataProperty(value, "length");
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > 3) {
    return null;
  }
  const notices: CatalogNotice[] = [];
  for (let index = 0; index < length; index += 1) {
    const notice = ownDataProperty(value, String(index));
    if (!isCatalogNotice(notice)) return null;
    notices.push(notice);
  }
  return notices;
}

/**
 * Rebuild a catalog disposition from a strict set of own data properties.
 *
 * Management callbacks are internal today, but this response is a privacy
 * boundary. Avoid coercion, accessors, custom iterators, and `toJSON` hooks so a
 * malformed callback cannot smuggle private provider or account detail into a
 * management response.
 */
export function normalizeCatalogDisposition(value: unknown): CatalogDisposition | null {
  if (value === null || typeof value !== "object") return null;
  try {
    if (Array.isArray(value)) return null;
    const status = ownDataProperty(value, "status");
    if (status === "committed") {
      const changed = ownDataProperty(value, "changed");
      const degraded = ownDataProperty(value, "degraded");
      const notices = normalizeCatalogNotices(ownDataProperty(value, "notices"));
      if (typeof changed !== "boolean" || typeof degraded !== "boolean" || notices === null) {
        return null;
      }
      return { status, changed, degraded, notices };
    }
    if (status === "skipped") {
      const reason = ownDataProperty(value, "reason");
      const retryable = ownDataProperty(value, "retryable");
      if ((reason !== "not-requested"
        && reason !== "catalog-unavailable"
        && reason !== "busy"
        && reason !== "stale"
        && reason !== "refused")
        || typeof retryable !== "boolean") return null;
      return { status, reason, retryable };
    }
    if (status === "failed") {
      const reason = ownDataProperty(value, "reason");
      const phase = ownDataProperty(value, "phase");
      const retryable = ownDataProperty(value, "retryable");
      const partialWrite = ownDataProperty(value, "partialWrite");
      if ((reason !== "provider-auth" && reason !== "provider-network" && reason !== "disk"
        && reason !== "request-invalid" && reason !== "admission" && reason !== "internal")
        || (phase !== "gather" && phase !== "commit")
        || typeof retryable !== "boolean"
        || typeof partialWrite !== "boolean") return null;
      // The cause is rebuilt from closed vocabularies, never copied through: this is the
      // boundary that keeps a message, path or account id from riding out on a failure.
      const cause = normalizeCatalogFailureCause(ownDataProperty(value, "cause"));
      return { status, reason, phase, retryable, partialWrite, ...(cause ? { cause } : {}) };
    }
    return null;
  } catch {
    return null;
  }
}

const FAILURE_CAUSE_KINDS: ReadonlySet<string> = new Set(["invalid-request", "lock-busy", "io", "unknown"]);
const FAILURE_CAUSE_CODES: ReadonlySet<string> = new Set([
  "ENOSPC", "EACCES", "EPERM", "EROFS", "ENOENT", "SQLITE_BUSY",
]);

function normalizeCatalogFailureCause(value: unknown): CatalogFailureCause | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kind = ownDataProperty(value, "kind");
  if (typeof kind !== "string" || !FAILURE_CAUSE_KINDS.has(kind)) return undefined;
  const code = ownDataProperty(value, "code");
  const safeCode = typeof code === "string" && FAILURE_CAUSE_CODES.has(code) ? code : undefined;
  return { kind, ...(safeCode ? { code: safeCode } : {}) } as CatalogFailureCause;
}

/** Whether a persisted mutation still needs a successful catalog commit. */
export function catalogRefreshIsPending(disposition: CatalogDisposition): boolean {
  return disposition.status !== "committed";
}
