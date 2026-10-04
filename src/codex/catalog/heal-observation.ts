import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { readCodexHomeJournal } from "../codex-home-owner";
import type { RawCatalog } from "./parsing";

export const CATALOG_HEAL_MAX_BYTES = 64 * 1024 * 1024;

export interface CatalogObservation {
  readonly signature: string;
  readonly catalog: RawCatalog | null;
}

/** Resolve authority without reading catalog bytes or cleaning journal evidence. */
export function selectCatalogHealPath(
  journalPath: string,
  defaultPath: string,
  resolvePath: (path: string) => string,
): string | null {
  const inspected = readCodexHomeJournal(journalPath);
  if (inspected.kind === "unknown") return null;
  if (inspected.kind === "missing") return defaultPath;
  const selected = inspected.journal.injectedCatalogPath;
  if (selected === undefined || selected === null) return defaultPath;
  // A selected custom catalog remains selected even when missing or corrupt.
  if (typeof selected !== "string" || !selected.trim() || selected.includes("\0")) return null;
  try { return resolvePath(selected); }
  catch { return null; }
}

function signature(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Bounded regular descriptor reads; never open a FIFO/device or follow a replaced symlink. */
export function observeCatalogHealFile(path: string, readContent: boolean): CatalogObservation | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.size > CATALOG_HEAL_MAX_BYTES) return null;
    if (!readContent) return { signature: signature(before), catalog: null };
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > CATALOG_HEAL_MAX_BYTES || signature(before) !== signature(opened)) return null;
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== opened.size || signature(fstatSync(fd)) !== signature(opened)
      || signature(lstatSync(path)) !== signature(opened)) return null;
    let catalog: RawCatalog | null = null;
    try {
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (value && typeof value === "object" && Array.isArray((value as RawCatalog).models)) catalog = value as RawCatalog;
    } catch { /* Invalid catalog bytes remain unavailable until their stat changes. */ }
    return { signature: signature(opened), catalog };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
