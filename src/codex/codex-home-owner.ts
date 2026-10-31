import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getConfigDir } from "../config/paths";
import { sameFileIdentity } from "../lib/file-identity";
import { samePathIdentity } from "./user-identity";

export const CODEX_HOME_JOURNAL_FILE = "opencodex-journal.json";
const MAX_JOURNAL_BYTES = 1024 * 1024;

/** K imports this module; keep it independent of the config barrel and journal writer. */
export function currentOpencodexHome(): string {
  const configured = getConfigDir();
  try { return realpathSync.native(configured); }
  catch { return resolve(configured); }
}

export type CodexHomeOwnership =
  | { readonly kind: "unbound" }
  | { readonly kind: "owned" }
  | { readonly kind: "stale"; readonly boundHome: string }
  | { readonly kind: "foreign"; readonly boundHome: string }
  | { readonly kind: "unknown" };

export type CodexHomeJournalInspection =
  | { kind: "missing" }
  | { kind: "read"; journal: Record<string, unknown> }
  | { kind: "unknown" };

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** ENOENT through a dangling link or an unresolvable ancestor is not proven absence. */
function provenAbsent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { if (!absent(error)) return false; }
  const parent = dirname(path);
  if (parent === path) return false;
  try { return statSync(realpathSync.native(parent)).isDirectory(); }
  catch (error) { return absent(error) && provenAbsent(parent); }
}

/** A missing directory entry is a no-op; dangling links and unreadable homes are not. */
export function codexHomeIsAbsent(home: string): boolean { return provenAbsent(home); }

function validJournal(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  return journal.version === 1 && typeof journal.originalConfig === "string"
    && (journal.originalProfile === null || typeof journal.originalProfile === "string")
    && (journal.opencodexHome === undefined || (typeof journal.opencodexHome === "string"
      && isAbsolute(journal.opencodexHome) && !journal.opencodexHome.includes("\0")));
}

/** Bounded, regular-file-only observation. Failure never supplies cleanup authority. */
export function readCodexHomeJournal(journalPath: string): CodexHomeJournalInspection {
  let fd: number | undefined;
  try {
    const before = lstatSync(journalPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_JOURNAL_BYTES)) return { kind: "unknown" };
    fd = openSync(journalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(MAX_JOURNAL_BYTES) || !sameFileIdentity(before, opened)) return { kind: "unknown" };
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = lstatSync(journalPath, { bigint: true });
    if (BigInt(length) !== opened.size || !after.isFile() || !sameFileIdentity(after, opened)
      || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) return { kind: "unknown" };
    const journal: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    return validJournal(journal) ? { kind: "read", journal } : { kind: "unknown" };
  } catch (error) {
    return fd === undefined && absent(error) && provenAbsent(journalPath) ? { kind: "missing" } : { kind: "unknown" };
  } finally { if (fd !== undefined) closeSync(fd); }
}

function inspectBinding(boundHome: string, current: string): CodexHomeOwnership {
  let physical: string;
  try {
    physical = realpathSync.native(boundHome);
    if (!statSync(physical).isDirectory()) return { kind: "unknown" };
  } catch { return provenAbsent(boundHome) ? { kind: "stale", boundHome } : { kind: "unknown" }; }
  try {
    const own = realpathSync.native(current);
    if (!statSync(own).isDirectory()) return { kind: "unknown" };
    return samePathIdentity(physical, own) ? { kind: "owned" } : { kind: "foreign", boundHome };
  } catch { return { kind: "unknown" }; }
}

export function inspectCodexHomeOwner(canonicalHome: string, current = currentOpencodexHome()): CodexHomeOwnership {
  const read = readCodexHomeJournal(join(canonicalHome, CODEX_HOME_JOURNAL_FILE));
  if (read.kind === "unknown") return { kind: "unknown" };
  if (read.kind === "missing" || read.journal.opencodexHome === undefined) return { kind: "unbound" };
  return inspectBinding(read.journal.opencodexHome as string, current);
}

/** Preserve extant and uncertain bindings; only legacy or proven stale records are adopted. */
export function opencodexHomeForInjection(recorded: string | undefined, current = currentOpencodexHome()): string {
  if (recorded === undefined) return current;
  return inspectBinding(recorded, current).kind === "stale" ? current : recorded;
}

export type CodexHomeOwnerRefusalReason = "foreign-owner" | "owner-unknown";
export class CodexHomeOwnerRefusal extends Error {
  constructor(readonly reason: CodexHomeOwnerRefusalReason) {
    super(reason === "foreign-owner"
      ? "Codex home is bound to another OpenCodex home; configuration and journal were preserved. Restore from the owning home first."
      : "Codex home ownership could not be verified; configuration and journal were preserved.");
    this.name = "CodexHomeOwnerRefusal";
  }
}
export function assertCodexHomeOwner(home: string): void {
  const owner = inspectCodexHomeOwner(home);
  if (owner.kind === "foreign" || owner.kind === "unknown") {
    throw new CodexHomeOwnerRefusal(owner.kind === "foreign" ? "foreign-owner" : "owner-unknown");
  }
}

/** Compensation must not replace evidence another home published during this operation. */
export function codexHomeOwnerBlocksCompensation(home: string, error: unknown): boolean {
  if (!(error instanceof CodexHomeOwnerRefusal)) return false;
  const owner = inspectCodexHomeOwner(home);
  return owner.kind === "foreign" || owner.kind === "unknown";
}
