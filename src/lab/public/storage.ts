import { join } from "node:path";
import { isSha256Hex, jcsStringify } from "../digest";
import { ensureLabDirs } from "../paths";
import { MAX_PUBLIC_BUNDLE_BYTES } from "./bundle";
import { validatePublicEvidenceAuthorities } from "./community-authority";
import { readPrivateRegularFile } from "./file-safety";
import { cleanupStalePrivateFileStages, publishPrivateFileExclusive } from "./private-file";
import { validatePublicEvidencePrivacy } from "./privacy";
import { parseStrictPublicJson } from "./strict-json";
import type { PublicEvidenceBundleV1 } from "./types";
import { verifyPublicEvidenceBundle } from "./signature";
import { PublicEvidenceValidationError } from "./validate";

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function bundlePath(bundleId: string, configDir?: string): string {
  if (!isSha256Hex(bundleId)) throw new Error("public bundle id must be lowercase sha256 hex");
  return join(ensureLabDirs(configDir).exportDir, `${bundleId}.json`);
}

function assertLocalArtifactExportAuthority(bundle: PublicEvidenceBundleV1): void {
  if (bundle.artifacts.length !== 0) {
    throw new PublicEvidenceValidationError(
      "public_artifact_authority_required",
      "artifact bytes require reviewed public_export policy authority before local export storage",
    );
  }
}

function readLocalExport(path: string): Buffer {
  cleanupStalePrivateFileStages(path);
  return readPrivateRegularFile(path, {
    maxBytes: MAX_PUBLIC_BUNDLE_BYTES,
    errorCode: "public_file_unsafe",
    errorMessage: "public export is not a private regular file with 0600 permissions",
    sizeErrorCode: "public_file_too_large",
    sizeErrorMessage: "public bundle exceeds 2 MiB",
    requireMode600: true,
  });
}

function existingBody(path: string): string | null {
  try {
    return readLocalExport(path).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function validateLocalBundle(bundle: PublicEvidenceBundleV1): void {
  const verification = verifyPublicEvidenceBundle(bundle);
  if (verification.status !== "cryptographically_valid") {
    throw new PublicEvidenceValidationError(verification.status, `public bundle verification failed: ${verification.status}`);
  }
  assertLocalArtifactExportAuthority(bundle);
  validatePublicEvidenceAuthorities(bundle.records);
  validatePublicEvidencePrivacy(bundle);
}

export function storePublicEvidenceBundle(
  bundle: PublicEvidenceBundleV1,
  configDir?: string,
): { path: string; created: boolean } {
  validateLocalBundle(bundle);
  const body = jcsStringify(bundle) + "\n";
  if (encodedBytes(body) > MAX_PUBLIC_BUNDLE_BYTES) {
    throw new PublicEvidenceValidationError("public_file_too_large", "public bundle exceeds 2 MiB");
  }
  const path = bundlePath(bundle.bundleId, configDir);
  const existing = existingBody(path);
  if (existing !== null) {
    if (existing === body) return { path, created: false };
    throw new PublicEvidenceValidationError("public_export_conflict", "public export id collision with different bytes");
  }

  const published = publishPrivateFileExclusive(path, Buffer.from(body, "utf8"));
  if (!published.created) {
    const raced = existingBody(path);
    if (raced === body) return { path, created: false };
    throw new PublicEvidenceValidationError("public_export_conflict", "public export id collision with different bytes");
  }
  return { path, created: true };
}

/** Backward-compatible local storage helper for callers that need the private path. */
export function writePublicEvidenceBundle(bundle: PublicEvidenceBundleV1, configDir?: string): string {
  return storePublicEvidenceBundle(bundle, configDir).path;
}

export function readPublicEvidenceBundle(bundleId: string, configDir?: string): PublicEvidenceBundleV1 {
  const bytes = readLocalExport(bundlePath(bundleId, configDir));
  const raw = parseStrictPublicJson(bytes, "public export", "public_file_json");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PublicEvidenceValidationError("public_file_json", "public export must contain a bundle object");
  }
  const parsed = raw as PublicEvidenceBundleV1;
  if (parsed.bundleId !== bundleId) {
    throw new PublicEvidenceValidationError("public_file_identity", "public export filename does not match bundle id");
  }
  validateLocalBundle(parsed);
  return parsed;
}
