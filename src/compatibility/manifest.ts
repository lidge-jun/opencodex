export const COMPATIBILITY_MANIFEST_SCHEMA_VERSION = 1 as const;

export const COMPATIBILITY_DISPOSITIONS = [
  "passthrough",
  "translated",
  "degraded",
  "unsupported",
] as const;

export type CompatibilityDisposition = typeof COMPATIBILITY_DISPOSITIONS[number];
export type CompatibilityEvidenceKind = "fixture" | "lab-scenario";

export interface CompatibilityEvidenceRefV1 {
  kind: CompatibilityEvidenceKind;
  id: string;
  /** Exact fixture assertions that prove this claim. Required for fixture evidence. */
  assertionIds?: readonly string[];
}

export interface CompatibilityClaimV1 {
  /** Stable manifest-local claim id. */
  id: string;
  /** Stable public feature key, such as `request.previous_response_id`. */
  feature: string;
  disposition: CompatibilityDisposition;
  summary: string;
  /** Required when behavior is not byte/semantic passthrough. */
  limitation?: string;
  evidence: readonly CompatibilityEvidenceRefV1[];
}

export interface CompatibilitySubjectV1 {
  providerId: string;
  /** Exact normalized provider base URL; destination changes require a new subject/version. */
  baseUrl: string;
  adapterId: string;
  authMode: "forward" | "key" | "oauth" | "local";
  inboundProtocol: "responses" | "chat" | "messages";
  upstreamProtocol: string;
  /** Claims apply only to these exact wire model ids. */
  modelIds: readonly string[];
}

export interface CompatibilityManifestV1 {
  schemaVersion: typeof COMPATIBILITY_MANIFEST_SCHEMA_VERSION;
  id: string;
  version: string;
  subject: CompatibilitySubjectV1;
  claims: readonly CompatibilityClaimV1[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const FEATURE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const DISPOSITIONS = new Set<string>(COMPATIBILITY_DISPOSITIONS);
const EVIDENCE_KINDS = new Set<string>(["fixture", "lab-scenario"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function checkKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) issues.push(`${path}${path ? "." : ""}${key} is not allowed by schema v1`);
  }
}

function checkId(value: unknown, path: string, issues: string[]): value is string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    issues.push(`${path} must match ${ID_PATTERN}`);
    return false;
  }
  return true;
}

function checkNonBlank(value: unknown, path: string, issues: string[]): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path} must be a non-blank string`);
    return false;
  }
  return true;
}

function checkNormalizedBaseUrl(value: unknown, path: string, issues: string[]): value is string {
  if (typeof value !== "string") {
    issues.push(`${path} must be a normalized absolute HTTP(S) base URL`);
    return false;
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      issues.push(`${path} must be a normalized absolute HTTP(S) base URL without credentials, query, or fragment`);
      return false;
    }
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    const normalized = `${parsed.origin}${normalizedPath}`;
    if (value !== normalized) {
      issues.push(`${path} must be normalized as ${normalized}`);
      return false;
    }
    return true;
  } catch {
    issues.push(`${path} must be a normalized absolute HTTP(S) base URL`);
    return false;
  }
}

function checkSortedUniqueStrings(
  value: unknown,
  path: string,
  issues: string[],
  options: { nonEmpty?: boolean } = {},
): value is string[] {
  if (!Array.isArray(value) || (options.nonEmpty === true && value.length === 0)) {
    issues.push(`${path} must be${options.nonEmpty === true ? " a non-empty" : " an"} array`);
    return false;
  }
  if (value.some(item => typeof item !== "string" || item.trim().length === 0)) {
    issues.push(`${path} must contain only non-blank strings`);
    return false;
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) issues.push(`${path} must not contain duplicates`);
  const sorted = [...strings].sort();
  if (strings.some((item, index) => item !== sorted[index])) issues.push(`${path} must be sorted`);
  return true;
}

function checkEvidence(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${path} must be a non-empty array`);
    return;
  }
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    const evidencePath = `${path}[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${evidencePath} must be an object`);
      return;
    }
    checkKnownKeys(raw, ["kind", "id", "assertionIds"], evidencePath, issues);
    if (!EVIDENCE_KINDS.has(String(raw.kind))) {
      issues.push(`${evidencePath}.kind must be fixture or lab-scenario`);
    }
    const id = checkId(raw.id, `${evidencePath}.id`, issues) ? raw.id : "";
    const assertionIds = raw.assertionIds;
    if (raw.kind === "fixture") {
      checkSortedUniqueStrings(assertionIds, `${evidencePath}.assertionIds`, issues, { nonEmpty: true });
    } else if (assertionIds !== undefined) {
      checkSortedUniqueStrings(assertionIds, `${evidencePath}.assertionIds`, issues, { nonEmpty: true });
    }
    const key = `${String(raw.kind)}:${id}:${JSON.stringify(assertionIds ?? [])}`;
    if (seen.has(key)) issues.push(`${evidencePath} duplicates an earlier evidence reference`);
    seen.add(key);
  });
}

/**
 * Validate one versioned compatibility manifest without importing provider or Lab state.
 * Keeping this as a leaf lets future CLI/GUI readers load contracts without activating Lab.
 */
export function compatibilityManifestIssues(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["manifest must be an object"];
  checkKnownKeys(value, ["schemaVersion", "id", "version", "subject", "claims"], "", issues);
  if (value.schemaVersion !== COMPATIBILITY_MANIFEST_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${COMPATIBILITY_MANIFEST_SCHEMA_VERSION}`);
  }
  checkId(value.id, "id", issues);
  checkNonBlank(value.version, "version", issues);

  if (!isRecord(value.subject)) {
    issues.push("subject must be an object");
  } else {
    checkKnownKeys(
      value.subject,
      ["providerId", "baseUrl", "adapterId", "authMode", "inboundProtocol", "upstreamProtocol", "modelIds"],
      "subject",
      issues,
    );
    checkId(value.subject.providerId, "subject.providerId", issues);
    checkNormalizedBaseUrl(value.subject.baseUrl, "subject.baseUrl", issues);
    checkId(value.subject.adapterId, "subject.adapterId", issues);
    if (!["forward", "key", "oauth", "local"].includes(String(value.subject.authMode))) {
      issues.push("subject.authMode must be forward, key, oauth, or local");
    }
    if (!["responses", "chat", "messages"].includes(String(value.subject.inboundProtocol))) {
      issues.push("subject.inboundProtocol must be responses, chat, or messages");
    }
    checkNonBlank(value.subject.upstreamProtocol, "subject.upstreamProtocol", issues);
    checkSortedUniqueStrings(value.subject.modelIds, "subject.modelIds", issues, { nonEmpty: true });
  }

  if (!Array.isArray(value.claims) || value.claims.length === 0) {
    issues.push("claims must be a non-empty array");
    return issues;
  }
  const claimIds = new Set<string>();
  const claimFeatures = new Set<string>();
  value.claims.forEach((raw, index) => {
    const path = `claims[${index}]`;
    if (!isRecord(raw)) {
      issues.push(`${path} must be an object`);
      return;
    }
    checkKnownKeys(raw, ["id", "feature", "disposition", "summary", "limitation", "evidence"], path, issues);
    const id = checkId(raw.id, `${path}.id`, issues) ? raw.id : "";
    if (id && claimIds.has(id)) issues.push(`${path}.id duplicates ${id}`);
    if (id) claimIds.add(id);
    if (typeof raw.feature !== "string" || !FEATURE_PATTERN.test(raw.feature)) {
      issues.push(`${path}.feature must be a dotted stable feature key`);
    } else if (claimFeatures.has(raw.feature)) {
      issues.push(`${path}.feature duplicates ${raw.feature}`);
    } else {
      claimFeatures.add(raw.feature);
    }
    if (!DISPOSITIONS.has(String(raw.disposition))) {
      issues.push(`${path}.disposition is invalid`);
    }
    checkNonBlank(raw.summary, `${path}.summary`, issues);
    if (raw.disposition !== "passthrough") {
      checkNonBlank(raw.limitation, `${path}.limitation`, issues);
    } else if (raw.limitation !== undefined) {
      issues.push(`${path}.limitation must be omitted for passthrough claims`);
    }
    checkEvidence(raw.evidence, `${path}.evidence`, issues);
  });
  return issues;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

export function defineCompatibilityManifest<T extends CompatibilityManifestV1>(manifest: T): Readonly<T> {
  const issues = compatibilityManifestIssues(manifest);
  if (issues.length > 0) throw new TypeError(`Invalid compatibility manifest ${manifest.id}: ${issues.join("; ")}`);
  return deepFreeze(manifest);
}
