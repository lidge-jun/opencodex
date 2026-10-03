import { appendFileSync, chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { redactUserPath } from "../../lib/redact";
import type { CatalogWriteIntent } from "../catalog-write-serialization";
import { currentOpencodexHome } from "../codex-home-owner";

/**
 * Who wrote the Codex catalog, from where, and what it did to the routed rows (#6529).
 *
 * The native-only catalog in #6529 was found a day after the write, and nothing could say which
 * process wrote it: no catalog writer logged. Every catalog or models-cache write, and every
 * refused one, now appends one line here. The file sits in CODEX_HOME, beside the catalog, so a
 * writer from any OPENCODEX_HOME reports into the same place, and it survives a reboot.
 *
 * Bounded: past {@link CATALOG_AUDIT_MAX_BYTES} the oldest lines are dropped, keeping the newest
 * {@link CATALOG_AUDIT_KEEP_RECORDS}. Lines carry counts, never model ids or provider names. Paths
 * are user-home-redacted. Auditing never fails a write: every error is swallowed.
 */
export const CODEX_CATALOG_AUDIT_FILE = "opencodex-catalog-audit.jsonl";
export const CATALOG_AUDIT_MAX_BYTES = 256 * 1024;
export const CATALOG_AUDIT_KEEP_RECORDS = 400;

export interface CatalogWriteAuditEvent {
  readonly target: "catalog" | "cache";
  readonly outcome: "written" | "refused";
  /** Why a write was refused. */
  readonly reason?: "foreign-owner" | "unbacked-routed-removal" | "unbacked-routed-clear";
  readonly intent: CatalogWriteIntent;
  /** The writer that asked for the permit, e.g. `convergence` or `retained-sync`. */
  readonly writer: string;
  /** OpenCodex-authored routed rows before and after; null when the file could not be parsed. */
  readonly routedBefore?: number | null;
  readonly routedAfter?: number | null;
  /**
   * Where the writing process's config came from at write time: `default` is a missing config.json,
   * `fallback` a salvaged parse failure.
   */
  readonly configSource?: "file" | "default" | "fallback" | "unreadable";
}

export function codexCatalogAuditPath(codexHome: string): string {
  return join(codexHome, CODEX_CATALOG_AUDIT_FILE);
}

function auditLine(event: CatalogWriteAuditEvent): string {
  return `${JSON.stringify({
    at: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    // Enough to tell `ocx sync`, the service and a test runner apart, never full argument lists.
    command: process.argv.slice(1, 3).map(part => redactUserPath(part)).join(" ").slice(0, 200),
    opencodexHome: redactUserPath(currentOpencodexHome()),
    ...event,
  })}\n`;
}

function trimToNewest(path: string): void {
  const lines = readFileSync(path, "utf8").split("\n").filter(line => line.length > 0);
  if (lines.length <= CATALOG_AUDIT_KEEP_RECORDS) return;
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${lines.slice(-CATALOG_AUDIT_KEEP_RECORDS).join("\n")}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Append one record. `create: false` only appends to an existing file, for a writer that is not
 * this Codex home's owner: it must leave a trace, but not a file the owner's uninstall cannot claim.
 * Returns whether the file was created, so the owner can register it for uninstall.
 */
export function appendCatalogWriteAudit(
  codexHome: string,
  event: CatalogWriteAuditEvent,
  options: { readonly create: boolean },
): "appended" | "created" | "skipped" {
  const path = codexCatalogAuditPath(codexHome);
  try {
    let existed = true;
    try {
      const entry = lstatSync(path);
      if (!entry.isFile()) return "skipped";
      if (entry.size > CATALOG_AUDIT_MAX_BYTES) trimToNewest(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "skipped";
      if (!options.create) return "skipped";
      existed = false;
    }
    appendFileSync(path, auditLine(event), { mode: 0o600 });
    if (!existed) {
      try { chmodSync(path, 0o600); } catch { /* Windows: ACLs, not modes */ }
    }
    return existed ? "appended" : "created";
  } catch {
    return "skipped";
  }
}
