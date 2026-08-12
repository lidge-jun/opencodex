import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jcsStringify } from "../../lab/digest";

const VERSION_DOMAIN = "ocx-lab:compatibility-version:v1";
let cachedVersion: string | null | undefined;
let testOverride: string | null | undefined;

interface CompatibilityVersionManifest {
  schemaVersion: 1;
  assertionDslVersion: string;
  evidenceSchemaVersion: string;
  bunRuntimeVersion: string;
  files: Array<{ path: string; sha256: string }>;
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function hashManifest(manifest: unknown): string {
  const hash = createHash("sha256");
  hash.update(new TextEncoder().encode(`${VERSION_DOMAIN}\0`));
  hash.update(new TextEncoder().encode(jcsStringify(manifest)));
  return hash.digest("hex");
}

function parseEmbeddedManifest(raw: unknown): CompatibilityVersionManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== 1
    || typeof record.assertionDslVersion !== "string"
    || typeof record.evidenceSchemaVersion !== "string"
    || typeof record.bunRuntimeVersion !== "string"
    || !Array.isArray(record.files)
    || record.files.length === 0) return null;
  const files: CompatibilityVersionManifest["files"] = [];
  const seen = new Set<string>();
  for (const row of record.files) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const path = (row as Record<string, unknown>).path;
    const sha256 = (row as Record<string, unknown>).sha256;
    if (typeof path !== "string" || !path || path.includes("\\") || path.startsWith("/") || path.split("/").includes("..")) return null;
    if (typeof sha256 !== "string" || !isSha256Hex(sha256) || seen.has(path)) return null;
    seen.add(path);
    files.push({ path, sha256 });
  }
  return {
    schemaVersion: 1,
    assertionDslVersion: record.assertionDslVersion,
    evidenceSchemaVersion: record.evidenceSchemaVersion,
    // The runtime version is part of the canonical identity. The embedded file
    // hashes remain valid across bundled Bun updates, while this field reflects
    // the actual executing runtime rather than the package-build runtime.
    bunRuntimeVersion: Bun.version,
    files,
  };
}

function readEmbeddedManifest(): CompatibilityVersionManifest | null {
  const candidates = [
    join(import.meta.dir, "..", "..", "generated", "compatibility-version.json"),
    join(import.meta.dir, "..", "..", "..", "src", "generated", "compatibility-version.json"),
  ];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const manifest = parseEmbeddedManifest(parsed);
      if (manifest) return manifest;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * OpenCodex compatibility version for route subject identity.
 *
 * There is intentionally no runtime-only fallback: without the generated file
 * manifest we cannot prove exact implementation identity, so live-route subject
 * resolution fails closed and follows the profile's unknown-evidence policy.
 */
export function readOpenCodexCompatibilityVersion(): string | null {
  if (testOverride !== undefined) return testOverride;
  if (cachedVersion !== undefined) return cachedVersion;
  const embedded = readEmbeddedManifest();
  cachedVersion = embedded ? hashManifest(embedded) : null;
  return cachedVersion;
}

/** Test-only exact identity override; never sourced from process environment. */
export function setCompatibilityVersionOverrideForTests(value: string | null): void {
  if (value !== null && !isSha256Hex(value)) throw new Error("invalid test compatibility version");
  testOverride = value;
  cachedVersion = undefined;
}

/** Test-only reset of the compatibility version memo and override. */
export function resetCompatibilityVersionCacheForTests(): void {
  cachedVersion = undefined;
  testOverride = undefined;
}
