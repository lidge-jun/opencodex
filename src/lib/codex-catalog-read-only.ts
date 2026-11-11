/**
 * Publish the OpenCodex-owned Codex catalog over a read-only destination (#8358).
 *
 * On a Windows Child, `%USERPROFILE%\.codex\opencodex-catalog.json` can carry the
 * read-only FILE ATTRIBUTE — set by a sync client, a backup agent, or a manual
 * property edit. Windows answers the atomic replace with `EPERM` (or `EACCES`)
 * rather than replacing the entry, so every catalog write exited with a one-line
 * `catalog sync skipped: EPERM ...` and Remote Link enrollment reported only the
 * generic "Child enrollment" phase.
 *
 * OpenCodex owns that file, so the repair is scoped by artifact name: the shared
 * atomic writer applies it only to `opencodex-catalog.json` and only on win32.
 * Every other destination keeps the ordinary write contract.
 *
 * Windows synthesizes a file's `mode` from the read-only attribute: 0o444 when the
 * attribute is set, 0o666 when clear, regardless of the mode the writer requested.
 * Clearing the owner-write bit with `chmod` is what removes the attribute, so the
 * retry works on both a real NTFS volume and a simulated one.
 */
import { chmodSync, statSync } from "node:fs";
import { basename } from "node:path";

/** A retried catalog publication that still fails after the attribute was cleared. */
export class CodexCatalogReadOnlyError extends Error {
  /** The cause's errno code, so disk-failure classification (management convergence) still applies. */
  readonly code: string;
  constructor(readonly path: string, options?: ErrorOptions) {
    super(`Codex catalog is read-only: ${path}`, options);
    this.name = "CodexCatalogReadOnlyError";
    const cause = (options?.cause as NodeJS.ErrnoException | undefined)?.code;
    this.code = typeof cause === "string" ? cause : "EPERM";
  }
}

/** The artifact name OpenCodex writes and owns. Nothing else inherits this repair. */
export const CODEX_CATALOG_FILE_NAME = "opencodex-catalog.json";

export function isOwnedCodexCatalogPath(path: string): boolean {
  return basename(path) === CODEX_CATALOG_FILE_NAME;
}

export interface CatalogReadOnlyRepair {
  readonly platform: NodeJS.Platform;
  /** Whether the destination currently carries the read-only attribute. */
  readonly isReadOnly: (path: string) => boolean;
  /** Clear it. Must leave the file writable for its owner. */
  readonly makeWritable: (path: string) => void;
}

function isReadOnlyByAttribute(path: string): boolean {
  // An unreadable stat is not evidence of read-only, so it keeps the original error.
  try { return (statSync(path).mode & 0o222) === 0; } catch { return false; }
}

function makeWritableByAttribute(path: string): void {
  // Only the owner-write bit is meaningful to Windows chmod; setting it is what
  // clears FILE_ATTRIBUTE_READONLY.
  chmodSync(path, 0o666);
}

export function defaultCatalogReadOnlyRepair(
  platform: NodeJS.Platform = process.platform,
): CatalogReadOnlyRepair {
  return { platform, isReadOnly: isReadOnlyByAttribute, makeWritable: makeWritableByAttribute };
}

let repairOverride: CatalogReadOnlyRepair | null | undefined;

/**
 * Test seam: drive the Windows branch on a POSIX runner. `null` disables it,
 * `undefined` restores the production rule. Scoped here rather than to
 * `process.platform` so an unrelated suite that forces `win32` for ACL work does
 * not start chmod-ing catalogs on a Linux runner.
 */
export function setCatalogReadOnlyRepairForTests(repair: CatalogReadOnlyRepair | null | undefined): void {
  repairOverride = repair;
}

/**
 * The repair that applies to this destination, or null when the shared writer must
 * keep its ordinary semantics: any file other than the OpenCodex-owned catalog, and
 * every platform except Windows.
 */
export function catalogReadOnlyRepairFor(
  target: string,
  platform: NodeJS.Platform = process.platform,
): CatalogReadOnlyRepair | null {
  if (!isOwnedCodexCatalogPath(target)) return null;
  if (repairOverride !== undefined) return repairOverride;
  return platform === "win32" ? defaultCatalogReadOnlyRepair(platform) : null;
}

function isPermissionDenial(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

/**
 * Publish once; on the specific Windows read-only refusal, clear the attribute and
 * publish once more. A second failure names the file and the attribute instead of
 * repeating the raw rename error, so callers can report the actual cause.
 */
export function publishWithReadOnlyRepair(
  rename: () => void,
  target: string,
  repair: CatalogReadOnlyRepair = defaultCatalogReadOnlyRepair(),
): void {
  try { rename(); return; }
  catch (error) {
    if (repair.platform !== "win32" || !isPermissionDenial(error) || !repair.isReadOnly(target)) throw error;
  }
  // A clear that fails leaves the attribute in place: that is still the read-only catalog.
  try { repair.makeWritable(target); }
  catch (clearError) { throw new CodexCatalogReadOnlyError(target, { cause: clearError }); }
  try { rename(); }
  catch (retryError) {
    // Only a destination that still refuses is named read-only; a full disk or a scanner
    // lock after the clear keeps its own error so the report names the real cause.
    if (isPermissionDenial(retryError)) throw new CodexCatalogReadOnlyError(target, { cause: retryError });
    throw retryError;
  }
}
