/**
 * What opencodex remembers about a client between operations.
 *
 * Two hashes, because the two questions are genuinely independent: the FILE
 * hash identifies the exact result for restore and for clients whose writer
 * re-serializes the whole document. The BLOCK hash identifies OMP's surgically
 * patched fragment and detects catalog drift. One hash cannot safely answer
 * both questions in a shared client config.
 *
 * Design of record: devlog/_fin/260802_client_toggle_api/021 §2.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManagedContribution, ManagedFragment } from "../clients/config-export";
import { atomicWriteFile, getConfigDir } from "../config";
import type { IntegrationClientId } from "./registry";

/** 16 hex chars — the same shape as the Claude Desktop applied fingerprint. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Canonical bytes of a contribution. Fragments are sorted by path so two builds
 * of the same contribution hash identically regardless of emission order.
 */
export function canonicalContribution(contribution: ManagedContribution): string {
  const sorted = [...contribution.fragments].sort((a, b) => {
    const left = a.path.join("\u0000");
    const right = b.path.join("\u0000");
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return JSON.stringify(sorted.map(fragment => [fragment.path, fragment.value]));
}

export interface OwnershipRecord {
  clientId: IntegrationClientId;
  configPath: string;
  /** Hash of the WHOLE file as we left it — protects whole-file restore. */
  fileFingerprint: string;
  /** Hash of our contribution — detects catalog/port drift. */
  blockFingerprint: string;
  /** The exact paths we own. Removal touches these and nothing else. */
  fragmentPaths: readonly (readonly string[])[];
  /**
   * Containers this apply had to CREATE, `\0`-joined.
   *
   * Kimi's `models` map exists only because our aliases need somewhere to
   * live. Without this, disable left it behind as an empty container in a file
   * the user never asked us to restructure — while a `providers: {}` the user
   * wrote themselves must survive. Optional because records written before
   * this field existed simply prune nothing, which is the old behavior.
   */
  createdContainers?: readonly string[];
  appliedAt: string;
  opId: string;
}

/**
 * The integrations directory itself. Every primitive takes THIS path, never a
 * config root, so a caller cannot accidentally produce
 * `<root>/integrations/integrations` by passing an already-resolved value.
 */
export function integrationsDir(configDir: string = getConfigDir()): string {
  return join(configDir, "integrations");
}

/** `atomicWriteFile` does not create parents. */
export function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

function recordsPath(dir: string): string {
  return join(dir, "records.json");
}

export function readRecords(
  dir: string = integrationsDir(),
): Partial<Record<IntegrationClientId, OwnershipRecord>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recordsPath(dir), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Partial<Record<IntegrationClientId, OwnershipRecord>>;
    }
  } catch {
    // Missing or corrupt records mean "we remember nothing", which the
    // classifier reads as a conflict for an existing block. Fail closed: an
    // unreadable memory is never permission to delete.
  }
  return {};
}

export function writeRecord(record: OwnershipRecord, dir: string = integrationsDir()): void {
  const all = readRecords(dir);
  all[record.clientId] = record;
  ensureDir(recordsPath(dir));
  atomicWriteFile(recordsPath(dir), `${JSON.stringify(all, null, 2)}\n`);
}

export function deleteRecord(clientId: IntegrationClientId, dir: string = integrationsDir()): void {
  const all = readRecords(dir);
  if (!(clientId in all)) return;
  delete all[clientId];
  ensureDir(recordsPath(dir));
  atomicWriteFile(recordsPath(dir), `${JSON.stringify(all, null, 2)}\n`);
}

export function fragmentPathsOf(contribution: ManagedContribution): readonly (readonly string[])[] {
  return contribution.fragments.map((fragment: ManagedFragment) => fragment.path);
}
