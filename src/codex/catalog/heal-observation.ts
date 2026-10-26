import { closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { readCodexHomeJournal } from "../codex-home-owner";
import { samePath, type RawCatalog } from "./parsing";

export const CATALOG_HEAL_MAX_BYTES = 64 * 1024 * 1024;

export interface CatalogObservation {
  readonly signature: string;
  readonly catalog: RawCatalog | null;
}

export type CatalogHealPathComparison = "same" | "different" | "unknown";
export const CATALOG_HEAL_MAX_LINKS = 40;
// Small catalog-path comparisons need only a handful of reads; unusual paths defer.
export const CATALOG_HEAL_MAX_PATH_READS = 64;
type PathRead = <T>(read: () => T) => T;
type LinkObservation = { path: string; stat: BigIntStats; value: string; parent: string; parentStat: BigIntStats; resolved?: string; resolvedStat?: BigIntStats };
type PathObservation = {
  kind: "native" | "hardlink"; path: string; stat: BigIntStats; links: LinkObservation[];
  canonical: string; parent: string; parentStat: BigIntStats;
} | { kind: "unavailable"; hardlink: boolean };

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.nlink === after.nlink && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

/** Windows normalizes ".." lexically across reparse points; POSIX resolves each component. */
function resolveLinkTarget(base: string, value: string, read: PathRead, links: LinkObservation[]): string {
  if (process.platform === "win32") return resolve(base, value);
  let current = base;
  if (isAbsolute(value)) current = parse(value).root;
  const segments = (isAbsolute(value) ? value.slice(parse(value).root.length) : value).split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { current = dirname(current); continue; }
    const next = join(current, segment);
    if (index === segments.length - 1) return next;
    const stat = read(() => lstatSync(next, { bigint: true }));
    if (stat.isSymbolicLink()) {
      // Keep the intermediate link inside the same revalidation snapshot as leaf hops.
      const parent = current, parentStat = read(() => statSync(parent, { bigint: true })), target = read(() => readlinkSync(next));
      const resolvedStat = read(() => statSync(next, { bigint: true }));
      // POSIX refuses ".." across a non-directory; statSync follows the link.
      if (!resolvedStat.isDirectory()) throw new Error("Link target crosses a non-directory");
      const resolved = read(() => realpathSync.native(next));
      links.push({ path: next, stat, value: target, parent, parentStat, resolved, resolvedStat });
      current = resolved;
    }
    else if (stat.isDirectory()) current = next;
    else throw new Error("Link target crosses a non-directory");
  }
  return current;
}

/** @internal Path observation seam; production callers supply the fixed read budget below. */
export function inspectHealPath(path: string, read: PathRead): PathObservation {
  let hardlink = false;
  let observedEntry = false;
  const links: LinkObservation[] = [];
  try {
    for (let count = 0; count < CATALOG_HEAL_MAX_LINKS; count += 1) {
      const stat = read(() => lstatSync(path, { bigint: true }));
      observedEntry = true;
      if (stat.isSymbolicLink()) {
        const parent = dirname(path), parentStat = read(() => statSync(parent, { bigint: true })), value = read(() => readlinkSync(path));
        links.push({ path, stat, value, parent, parentStat });
        path = resolveLinkTarget(read(() => realpathSync.native(parent)), value, read, links);
        continue;
      }
      // Keep native leaf aliases outside the macOS multi-link FD-name bug.
      hardlink = process.platform === "darwin" && stat.isFile() && stat.nlink > 1n;
      const parent = read(() => realpathSync.native(dirname(path))), parentStat = read(() => statSync(parent, { bigint: true }));
      if (!parentStat.isDirectory() || !unchanged(parentStat, read(() => statSync(dirname(path), { bigint: true })))) throw new Error("Changed parent");
      return { kind: hardlink ? "hardlink" : "native", path, stat, links, parent, parentStat,
        canonical: hardlink ? join(parent, basename(path)) : read(() => realpathSync.native(path)) };
    }
    // Hop exhaustion requires identity evidence; it must never fall back to lexical comparison.
    return { kind: "unavailable", hardlink: true };
  } catch { /* Observed entry evidence cannot fall back to lexical identity after a failed lookup. */ }
  return { kind: "unavailable", hardlink: hardlink || observedEntry };
}

function revalidateHealPath(seen: Exclude<PathObservation, { kind: "unavailable" }>, read: PathRead): boolean {
  if (!unchanged(seen.stat, read(() => lstatSync(seen.path, { bigint: true })))) return false;
  for (const link of seen.links) {
    if (!unchanged(link.stat, read(() => lstatSync(link.path, { bigint: true }))) || read(() => readlinkSync(link.path)) !== link.value
      || !unchanged(link.parentStat, read(() => statSync(link.parent, { bigint: true })))) return false;
    const resolved = link.resolved, resolvedStat = link.resolvedStat;
    if (resolved !== undefined && resolvedStat !== undefined
      && !unchanged(resolvedStat, read(() => statSync(resolved, { bigint: true })))) return false;
  }
  return unchanged(seen.parentStat, read(() => statSync(seen.parent, { bigint: true })))
    && unchanged(seen.parentStat, read(() => statSync(dirname(seen.path), { bigint: true })));
}

/** Retain publication entry/link/parent evidence across its catalog read, within one budget. */
export function retainCatalogHealPath(path: string): (signature: string) => boolean {
  let reads = 0;
  const read: PathRead = fn => {
    if (reads++ >= CATALOG_HEAL_MAX_PATH_READS) throw new Error("Catalog path read limit reached");
    return fn();
  };
  const seen = inspectHealPath(path, read);
  return observedSignature => {
    try {
      return seen.kind !== "unavailable" && signature(seen.stat) === observedSignature && revalidateHealPath(seen, read);
    } catch { return false; }
  };
}

/** Entry uncertainty is distinct from a proven different path, especially for releases. */
export function compareCatalogHealPaths(left: string, right: string): CatalogHealPathComparison {
  let reads = 0, exhausted = false;
  const read: PathRead = fn => {
    if (reads >= CATALOG_HEAL_MAX_PATH_READS) { exhausted = true; throw new Error("Catalog path read limit reached"); }
    reads += 1;
    return fn();
  };
  const a = inspectHealPath(left, read), b = inspectHealPath(right, read);
  if (exhausted) return "unknown";
  const needsEntry = a.kind === "hardlink" || b.kind === "hardlink"
    || (a.kind === "unavailable" && a.hardlink) || (b.kind === "unavailable" && b.hardlink);
  if (!needsEntry) {
    if (a.kind === "unavailable" || b.kind === "unavailable") {
      try {
        if ((a.kind !== "unavailable" && !revalidateHealPath(a, read))
          || (b.kind !== "unavailable" && !revalidateHealPath(b, read))) return "unknown";
        return samePath(left, right) ? "same" : "different";
      } catch { return "unknown"; }
    }
    const result = samePath(a.canonical, b.canonical) ? "same" : "different";
    // Native normalization must not hide changed entries, links or parents on any platform.
    try {
      return revalidateHealPath(a, read) && revalidateHealPath(b, read) ? result : "unknown";
    } catch { return "unknown"; }
  }
  if (a.kind === "unavailable" || b.kind === "unavailable") return "unknown";
  try {
    let result: CatalogHealPathComparison = "unknown";
    if (a.stat.dev !== b.stat.dev || a.stat.ino !== b.stat.ino) result = "different";
    else if (a.kind === "hardlink" && b.kind === "hardlink") {
      if (a.parentStat.dev !== b.parentStat.dev || a.parentStat.ino !== b.parentStat.ino) result = "different";
      else if (basename(a.path) === basename(b.path)) result = "same";
      // Bun 1.4.3 opendir/Glob eagerly enumerate the whole directory. Without a
      // bounded entry-name primitive, aliases and sibling hardlinks stay unknown.
    }
    return revalidateHealPath(a, read) && revalidateHealPath(b, read) ? result : "unknown";
  } catch { return "unknown"; }
}

/** Admission-style convenience; release consumers must retain the unknown result. */
export function sameCatalogHealPath(left: string, right: string): boolean {
  return compareCatalogHealPaths(left, right) === "same";
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

function signature(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** Bounded regular descriptor reads; never open a FIFO/device or follow a replaced symlink. */
export function observeCatalogHealFile(path: string, readContent: boolean): CatalogObservation | null {
  let fd: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.size > BigInt(CATALOG_HEAL_MAX_BYTES)) return null;
    if (!readContent) return { signature: signature(before), catalog: null };
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(CATALOG_HEAL_MAX_BYTES) || signature(before) !== signature(opened)) return null;
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== Number(opened.size) || signature(fstatSync(fd, { bigint: true })) !== signature(opened)
      || signature(lstatSync(path, { bigint: true })) !== signature(opened)) return null;
    let catalog: RawCatalog | null = null;
    try {
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (value && typeof value === "object" && Array.isArray((value as RawCatalog).models)) catalog = value as RawCatalog;
    } catch { /* Invalid catalog bytes remain unavailable until their stat changes. */ }
    return { signature: signature(opened), catalog };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
