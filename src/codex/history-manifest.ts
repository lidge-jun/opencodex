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
  /**
   * Whether the row had a non-empty `first_user_message` when the snapshot was taken.
   *
   * Routing derives the post-image `has_user_event` from the message AT SNAPSHOT TIME
   * (`history-provider.ts` `routeOpenai`), so a restore that recomputes it from the
   * message as it is NOW will mistake the user's first message for OpenCodex's own write
   * and erase it. Only the emptiness is recorded, never the text: this manifest is a file
   * on disk and the message is user content.
   *
   * Optional because manifests written before this field exists cannot be given one. An
   * entry without it falls back to the current-row reading, which is exactly as imprecise
   * as the behaviour it replaces and no worse.
   */
  hadFirstUserMessage?: boolean;
  /**
   * Whether OpenCodex's routing relabel is known to have landed for this entry.
   *
   * `pending` is written before the routing write and resolved after it, so a crash
   * between the two leaves an honest "unknown" rather than a confident wrong answer. The
   * observed row resolves it: the recorded original means the write did not land, the
   * expected post-image means it did.
   *
   * Absent on entries written before the field existed. Those refuse only in the one
   * genuinely undecidable case — original tuple with `has_user_event` moved 0 to 1 —
   * which `dev` already refuses today.
   */
  relabel?: "pending" | "committed" | "none";
}

export interface CodexHistoryBackupManifest {
  version: 1 | 2;
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
    || (raw.version !== 1 && raw.version !== 2)
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
      // Optional, but not unvalidated: a truthy `hadFirstUserMessage: "false"` would select
      // the wrong restore verdict, and an unrecognized `relabel` would be read as a state
      // the classifier does not have.
      || (value.hadFirstUserMessage !== undefined && typeof value.hadFirstUserMessage !== "boolean")
      || (value.relabel !== undefined
        && value.relabel !== "pending" && value.relabel !== "committed" && value.relabel !== "none")
      || !hasAllowedProvenance(value)) {
      return { ok: false, reason: "schema", scope: "entry-provenance" };
    }
  }

  return { ok: true, manifest: raw as unknown as CodexHistoryBackupManifest };
}
