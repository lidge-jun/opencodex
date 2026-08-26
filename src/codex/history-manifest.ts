import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

/** Sources whose native OpenAI provenance can be restored exactly. */
export const CODEX_HISTORY_RESUMABLE_SOURCES = ["cli", "vscode"] as const;

export interface CodexHistoryBackupEntry {
  id: string;
  rolloutPath: string;
  modelProvider: string;
  source: string;
  hasUserEvent: 0 | 1;
}

export interface CodexHistoryBackupManifest {
  version: 1;
  stateDbPath: string;
  entries: Record<string, CodexHistoryBackupEntry>;
}

export type CodexHistoryManifestValidation =
  | { readonly ok: true; readonly manifest: CodexHistoryBackupManifest }
  | { readonly ok: false; readonly reason: "foreign-database" }
  | {
      readonly ok: false;
      readonly reason: "schema";
      readonly scope: "manifest" | "entry-shape" | "entry-provenance";
    };

function codexHistoryPathIdentity(path: string): string {
  const canonical = resolve(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/**
 * Canonical identity used by both backup naming and manifest ownership checks.
 * Windows paths are case-insensitive for this contract; other platforms keep
 * the resolved path's case.
 */
export function codexHistoryStateDbIdentity(path: string): string {
  return codexHistoryPathIdentity(path);
}

/** Stable, non-secret file-name component for one state database. */
export function codexHistoryBackupId(stateDbPath: string): string {
  return createHash("sha256")
    .update(codexHistoryStateDbIdentity(stateDbPath))
    .digest("hex")
    .slice(0, 16);
}

/** Platform-aware identity comparison shared by database and rollout checks. */
export function sameCodexHistoryPath(left: string, right: string): boolean {
  return codexHistoryPathIdentity(left) === codexHistoryPathIdentity(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAllowedProvenance(entry: Record<string, unknown>): boolean {
  return (entry.modelProvider === "openai"
      && CODEX_HISTORY_RESUMABLE_SOURCES.includes(
        entry.source as (typeof CODEX_HISTORY_RESUMABLE_SOURCES)[number],
      ))
    || (entry.modelProvider === "opencodex" && entry.source === "exec");
}

/**
 * Validate only the versioned data contract and database ownership identity.
 * Filesystem type checks, reads, fingerprints, rollout inspection, SQLite, and
 * mutation deliberately remain with the callers.
 */
export function validateCodexHistoryBackupManifest(
  raw: unknown,
  expectedStateDbPath: string,
): CodexHistoryManifestValidation {
  if (!isRecord(raw)
    || raw.version !== 1
    || typeof raw.stateDbPath !== "string"
    || !raw.stateDbPath.trim()
    || !isAbsolute(raw.stateDbPath)
    || !isRecord(raw.entries)) {
    return { ok: false, reason: "schema", scope: "manifest" };
  }
  if (!sameCodexHistoryPath(raw.stateDbPath, expectedStateDbPath)) {
    return { ok: false, reason: "foreign-database" };
  }

  for (const [id, value] of Object.entries(raw.entries)) {
    if (!isRecord(value)) {
      return { ok: false, reason: "schema", scope: "entry-shape" };
    }
    if (!id
      || value.id !== id
      || typeof value.rolloutPath !== "string"
      || !value.rolloutPath.trim()
      || !isAbsolute(value.rolloutPath)
      || typeof value.modelProvider !== "string"
      || !value.modelProvider.trim()
      || typeof value.source !== "string"
      || !value.source.trim()
      || typeof value.hasUserEvent !== "number"
      || !Number.isSafeInteger(value.hasUserEvent)
      || (value.hasUserEvent !== 0 && value.hasUserEvent !== 1)
      || !hasAllowedProvenance(value)) {
      return { ok: false, reason: "schema", scope: "entry-provenance" };
    }
  }

  return { ok: true, manifest: raw as unknown as CodexHistoryBackupManifest };
}
