import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import { isValidProviderName } from "../config/provider-name";
import { isValidModelDiscoveryModelId, MODEL_DISCOVERY_MAX_MODELS, MODEL_DISCOVERY_MAX_RESPONSE_BYTES } from "./model-discovery-limits";

export type AntigravitySuffixMap = Record<"low" | "medium" | "high", string>;
export interface AntigravityWireSnapshot {
  version: 1;
  provider: string;
  families: Record<string, AntigravitySuffixMap>;
}
const EFFORTS = ["low", "medium", "high"] as const;

function snapshotPath(destination: string): string {
  const key = createHash("sha256").update(destination).digest("hex");
  return join(getConfigDir(), `antigravity-wire-${key}.json`);
}

function validatedSnapshot(value: unknown): AntigravityWireSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.provider !== "string" || !isValidProviderName(row.provider)
    || !row.families || typeof row.families !== "object" || Array.isArray(row.families)) return undefined;
  const entries = Object.entries(row.families);
  if (entries.length > MODEL_DISCOVERY_MAX_MODELS) return undefined;
  const families: Record<string, AntigravitySuffixMap> = Object.create(null);
  for (const [base, candidate] of entries) {
    if (!isValidModelDiscoveryModelId(base) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const map = candidate as Record<string, unknown>;
    if (!EFFORTS.every(effort => map[effort] === `${base}-${effort}` && isValidModelDiscoveryModelId(map[effort]))) return undefined;
    families[base] = { low: `${base}-low`, medium: `${base}-medium`, high: `${base}-high` };
  }
  return { version: 1, provider: row.provider, families };
}

/** Routing evidence only, never an account's current availability or entitlement. */
export function readAntigravityWireSnapshot(destination: string): AntigravityWireSnapshot | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(snapshotPath(destination), "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MODEL_DISCOVERY_MAX_RESPONSE_BYTES) return undefined;
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MODEL_DISCOVERY_MAX_RESPONSE_BYTES + 1));
    let length = 0;
    while (length < bytes.byteLength) {
      const read = readSync(fd, bytes, length, bytes.byteLength - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > stat.size || length > MODEL_DISCOVERY_MAX_RESPONSE_BYTES) return undefined;
    return validatedSnapshot(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Throw before publishing new synthetic catalog IDs if their routing evidence cannot be saved. */
export function writeAntigravityWireSnapshot(destination: string, snapshot: AntigravityWireSnapshot): void {
  const validated = validatedSnapshot(snapshot);
  if (!validated) throw new Error("invalid Antigravity wire snapshot");
  const text = JSON.stringify(validated);
  if (Buffer.byteLength(text) > MODEL_DISCOVERY_MAX_RESPONSE_BYTES) throw new Error("Antigravity wire snapshot exceeds size limit");
  atomicWriteFileNoFollow(snapshotPath(destination), text);
}
