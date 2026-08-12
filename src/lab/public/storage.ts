import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isSha256Hex, jcsStringify } from "../digest";
import { ensureLabDirs } from "../paths";
import { MAX_PUBLIC_BUNDLE_BYTES } from "./bundle";
import type { PublicEvidenceBundleV1 } from "./types";
import { verifyPublicEvidenceBundle } from "./signature";

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function bundlePath(bundleId: string, configDir?: string): string {
  if (!isSha256Hex(bundleId)) throw new Error("public bundle id must be lowercase sha256 hex");
  return join(ensureLabDirs(configDir).exportDir, `${bundleId}.json`);
}

export function writePublicEvidenceBundle(bundle: PublicEvidenceBundleV1, configDir?: string): string {
  const verification = verifyPublicEvidenceBundle(bundle);
  if (verification.status !== "cryptographically_valid") {
    throw new Error(`public bundle verification failed: ${verification.status}`);
  }
  const body = jcsStringify(bundle) + "\n";
  if (encodedBytes(body) > MAX_PUBLIC_BUNDLE_BYTES) throw new Error("public bundle exceeds 2 MiB");
  const path = bundlePath(bundle.bundleId, configDir);

  if (existsSync(path)) {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      throw new Error("existing public export is not a private regular file");
    }
    if (readFileSync(path, "utf8") === body) return path;
    throw new Error("public export id collision with different bytes");
  }

  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(path, "wx", 0o600);
    created = true;
    writeFileSync(fd, body, { encoding: "utf8" });
    fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const stats = lstatSync(path);
      if (!stats.isSymbolicLink() && stats.isFile() && stats.nlink === 1 && readFileSync(path, "utf8") === body) {
        return path;
      }
    }
    if (created) {
      try {
        unlinkSync(path);
      } catch {
        // Preserve the original write failure.
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return path;
}

export function readPublicEvidenceBundle(bundleId: string, configDir?: string): PublicEvidenceBundleV1 {
  const path = bundlePath(bundleId, configDir);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error("public export is not a private regular file");
  }
  if (stats.size > MAX_PUBLIC_BUNDLE_BYTES) throw new Error("public bundle exceeds 2 MiB");
  const body = readFileSync(path, "utf8");
  if (encodedBytes(body) > MAX_PUBLIC_BUNDLE_BYTES) throw new Error("public bundle exceeds 2 MiB");
  const parsed = JSON.parse(body) as PublicEvidenceBundleV1;
  if (parsed.bundleId !== bundleId) throw new Error("public export filename does not match bundle id");
  const verification = verifyPublicEvidenceBundle(parsed);
  if (verification.status !== "cryptographically_valid") {
    throw new Error(`public bundle verification failed: ${verification.status}`);
  }
  return parsed;
}
