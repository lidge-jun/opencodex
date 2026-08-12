import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isSha256Hex, jcsStringify } from "../digest";
import { ensureLabDirs } from "../paths";
import { MAX_PUBLIC_BUNDLE_BYTES } from "./bundle";
import { validatePublicEvidenceAuthorities } from "./community-authority";
import { validatePublicEvidencePrivacy } from "./privacy";
import { parseStrictPublicJson } from "./strict-json";
import type { PublicEvidenceBundleV1 } from "./types";
import { verifyPublicEvidenceBundle } from "./signature";
import { PublicEvidenceValidationError } from "./validate";

const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

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

function readPrivateRegularFile(path: string): Buffer {
  const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new PublicEvidenceValidationError("public_file_unsafe", "public export is not a private regular file");
    }
    if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
      throw new PublicEvidenceValidationError("public_file_unsafe", "public export permissions must be 0600");
    }
    if (stats.size > MAX_PUBLIC_BUNDLE_BYTES) {
      throw new PublicEvidenceValidationError("public_file_too_large", "public bundle exceeds 2 MiB");
    }
    const bytes = readFileSync(fd);
    if (bytes.byteLength > MAX_PUBLIC_BUNDLE_BYTES) {
      throw new PublicEvidenceValidationError("public_file_too_large", "public bundle exceeds 2 MiB");
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function existingBody(path: string): string | null {
  try {
    return readPrivateRegularFile(path).toString("utf8");
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

export function writePublicEvidenceBundle(bundle: PublicEvidenceBundleV1, configDir?: string): string {
  validateLocalBundle(bundle);
  const body = jcsStringify(bundle) + "\n";
  if (encodedBytes(body) > MAX_PUBLIC_BUNDLE_BYTES) {
    throw new PublicEvidenceValidationError("public_file_too_large", "public bundle exceeds 2 MiB");
  }
  const path = bundlePath(bundle.bundleId, configDir);
  const existing = existingBody(path);
  if (existing !== null) {
    if (existing === body) return path;
    throw new PublicEvidenceValidationError("public_export_conflict", "public export id collision with different bytes");
  }

  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
    created = true;
    writeFileSync(fd, body, { encoding: "utf8" });
    fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = existingBody(path);
      if (raced === body) return path;
      throw new PublicEvidenceValidationError("public_export_conflict", "public export id collision with different bytes");
    }
    if (created) {
      try { unlinkSync(path); } catch { /* preserve original write failure */ }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return path;
}

export function readPublicEvidenceBundle(bundleId: string, configDir?: string): PublicEvidenceBundleV1 {
  const bytes = readPrivateRegularFile(bundlePath(bundleId, configDir));
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
