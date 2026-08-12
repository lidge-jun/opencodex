import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { jcsStringify } from "../digest";
import { ensureLabDirs, labPublicExportsDir } from "../paths";
import type { PublicEvidenceBundleV1 } from "./types";
import { PublicEvidenceValidationError } from "./validate";
import { verifyPublicEvidenceBundle } from "./signing";

const MAX_BUNDLE_FILE_BYTES = 2 * 1024 * 1024;
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

function assertId(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new PublicEvidenceValidationError("invalid_bundle_id", "bundle id must be lowercase sha256 hex");
  return value;
}

function assertRegularFile(path: string, fd: number): void {
  const stats = fstatSync(fd);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > MAX_BUNDLE_FILE_BYTES) {
    throw new PublicEvidenceValidationError("export_unsafe_target", `unsafe public export file: ${path}`);
  }
}

function readBounded(path: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BUNDLE_FILE_BYTES) {
    throw new PublicEvidenceValidationError("export_unsafe_target", "public export path is unsafe or oversized");
  }
  const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  try {
    assertRegularFile(path, fd);
    const bytes = readFileSync(fd);
    if (bytes.byteLength > MAX_BUNDLE_FILE_BYTES) throw new PublicEvidenceValidationError("export_too_large", "public export exceeds read bound");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (count <= 0) throw new PublicEvidenceValidationError("export_write_failed", "public export write made no progress");
    offset += count;
  }
}

export function writePublicEvidenceBundle(bundle: PublicEvidenceBundleV1, configDir?: string): { path: string; created: boolean } {
  const verified = verifyPublicEvidenceBundle(bundle);
  if (verified.status !== "cryptographically_valid") throw new PublicEvidenceValidationError(verified.status, verified.detail ?? "public bundle is not cryptographically valid");
  ensureLabDirs(configDir);
  const exportsDir = labPublicExportsDir(configDir);
  const path = join(exportsDir, `${assertId(bundle.bundleId)}.json`);
  const bytes = Buffer.from(jcsStringify(verified.bundle), "utf8");
  if (bytes.byteLength > MAX_BUNDLE_FILE_BYTES) throw new PublicEvidenceValidationError("export_too_large", "public export exceeds file bound");
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
    writeAll(fd, bytes);
    fsyncSync(fd);
    assertRegularFile(path, fd);
    closeSync(fd);
    fd = null;
    return { path, created: true };
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readBounded(path);
    if (!existing.equals(bytes)) throw new PublicEvidenceValidationError("export_conflict", "bundle id already exists with different bytes");
    return { path, created: false };
  }
}

export function readPublicEvidenceBundle(bundleId: string, configDir?: string): PublicEvidenceBundleV1 {
  ensureLabDirs(configDir);
  const path = join(labPublicExportsDir(configDir), `${assertId(bundleId)}.json`);
  const bytes = readBounded(path);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new PublicEvidenceValidationError("export_invalid_json", "public export is not valid JSON");
  }
  const verified = verifyPublicEvidenceBundle(raw);
  if (verified.status !== "cryptographically_valid") throw new PublicEvidenceValidationError(verified.status, verified.detail ?? "public export verification failed");
  return verified.bundle;
}
