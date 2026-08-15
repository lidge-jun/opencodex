import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureLabDirs, labPublicOriginDir } from "../paths";
import { readPrivateRegularFile } from "./file-safety";
import { cleanupStalePrivateFileStagesInDir, isPrivateFileStageName } from "./private-file";
import { parseStrictPublicJson } from "./strict-json";

const MAX_ORIGIN_BYTES = 1024;
const ORIGIN_RE = /^origin-([0-9a-f]{64})-([0-9a-f]{64})\.json$/;

export interface PurgeOriginIdentity {
  publisherKeyId: string;
  bundleId: string;
}

export interface PurgeOriginRecovery {
  identities: PurgeOriginIdentity[];
  skipped: number;
}

/**
 * Purge must salvage each provenance marker independently. A corrupt marker is untrusted
 * and skipped, but it cannot hide later valid markers that are needed to classify local
 * community copies after the export or publisher key is unavailable. The operational
 * 1024-marker quota is deliberately not a read cutoff here: recovery must inspect every
 * valid-format marker present after a race/crash instead of silently losing provenance.
 */
export function recoverPublicOriginsForPurge(configDir?: string): PurgeOriginRecovery {
  ensureLabDirs(configDir);
  const dir = labPublicOriginDir(configDir);
  cleanupStalePrivateFileStagesInDir(dir);
  const names = readdirSync(dir)
    .filter((name) => !isPrivateFileStageName(name) && ORIGIN_RE.test(name))
    .sort();
  const identities: PurgeOriginIdentity[] = [];
  let skipped = 0;

  for (const name of names) {
    const match = ORIGIN_RE.exec(name)!;
    const expected = { publisherKeyId: match[1]!, bundleId: match[2]! };
    try {
      const raw = parseStrictPublicJson(
        readPrivateRegularFile(join(dir, name), {
          maxBytes: MAX_ORIGIN_BYTES,
          errorCode: "public_origin_unsafe",
          errorMessage: "public origin marker is unsafe during purge",
          sizeErrorCode: "public_origin_unsafe",
          sizeErrorMessage: "public origin marker exceeds its size bound",
          requireMode600: true,
        }),
        "public origin marker during purge",
        "public_origin_json",
      );
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        skipped += 1;
        continue;
      }
      const row = raw as Record<string, unknown>;
      if (
        Object.keys(row).sort().join(",") !== "bundleId,publisherKeyId,schemaVersion"
        || row.schemaVersion !== "public_origin_v1"
        || row.publisherKeyId !== expected.publisherKeyId
        || row.bundleId !== expected.bundleId
      ) {
        skipped += 1;
        continue;
      }
      identities.push(expected);
    } catch {
      skipped += 1;
      // Salvage continues with the next marker.
    }
  }
  return { identities, skipped };
}

export function listValidPublicOriginsForPurge(configDir?: string): PurgeOriginIdentity[] {
  return recoverPublicOriginsForPurge(configDir).identities;
}
