import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeDesktopConfigLibraryDir, resolveConfigLibraryDir } from "./desktop-3p-paths";

export interface Desktop3pConfigLibraryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

/**
 * Resolve the config library from the same user-data root Claude Desktop uses. Keeping this in one
 * helper prevents the writer and dashboard status probe from agreeing on a path Desktop never reads.
 *
 * The resolution itself lives in `./desktop-3p-paths`, which ports Claude Desktop's own `GE()`
 * branch for branch — including the `-3p` suffix the app appends to its userData root. Dropping
 * that suffix points us at a directory Desktop never reads (GitHub #539).
 */
export function resolveDesktop3pConfigLibraryPath(
  options: Desktop3pConfigLibraryOptions = {},
): string {
  if (options.env === undefined && options.platform === undefined && options.homeDir === undefined) {
    return claudeDesktopConfigLibraryDir();
  }
  return resolveConfigLibraryDir({
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    home: options.homeDir ?? homedir(),
  });
}

export interface Desktop3pMetadataEntry {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface Desktop3pMetadata {
  appliedId?: string;
  entries: Desktop3pMetadataEntry[];
  [key: string]: unknown;
}

export const DESKTOP_PICKER_ENTRY_NAME = "opencodex-picker";

export const MAX_DESKTOP_PROFILE_FILE_BYTES = 4 * 1024 * 1024;

export function assertDesktopLibraryTextSize(text: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_DESKTOP_PROFILE_FILE_BYTES) {
    throw new Error("desktop_config_too_large");
  }
}

export function serializeDesktopLibraryJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2) + "\n";
  assertDesktopLibraryTextSize(text);
  return text;
}

/** A path that no longer names the observed file was swapped; a same-path failure keeps its own errno. */
function pathStillNamesExpectedFile(path: string, expected: BigIntStats): boolean {
  try {
    const now = lstatSync(path, { bigint: true });
    return now.isFile() && now.dev === expected.dev && now.ino === expected.ino
      && now.ctimeNs === expected.ctimeNs;
  } catch { return false; }
}

/** Read regular config files only; a path swap must not turn an observation into a FIFO wait. */
export function readDesktopLibraryBytes(
  path: string,
  maxBytes: number = MAX_DESKTOP_PROFILE_FILE_BYTES,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DESKTOP_PROFILE_FILE_BYTES) {
    throw new RangeError("invalid Desktop library read limit");
  }
  const expected = lstatSync(path, { bigint: true });
  if (!expected.isFile()) throw new Error("desktop_config_not_regular");
  // POSIX open of a FIFO can itself block, before fstat is possible. Windows has no POSIX
  // FIFO entry; retain descriptor identity validation there without unsupported open flags.
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (error) {
    // A swap can fail at open — ELOOP on a symlink, ENXIO on a socket — before fstat can
    // classify it. Re-observing the path reports every swap as the documented refusal.
    if (pathStillNamesExpectedFile(path, expected)) throw error;
    throw new Error("desktop_config_not_regular");
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino
      || opened.ctimeNs !== expected.ctimeNs) throw new Error("desktop_config_not_regular");
    if (opened.size > BigInt(maxBytes)) throw new Error("desktop_config_too_large");
    // Allocate for the observed size plus one sentinel byte, not the full cap: callers scan many
    // small profiles, and the cap would zero-fill megabytes per read. A file that fills the
    // buffer grew after validation — keep reading within the bound so it classifies as
    // desktop_config_too_large rather than silently truncating.
    let bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, bytes, length, Math.min(64 * 1024, bytes.length - length), null);
      if (count === 0) break;
      length += count;
      if (length > maxBytes) throw new Error("desktop_config_too_large");
      if (length === bytes.length && bytes.length <= maxBytes) {
        const grown = Buffer.alloc(Math.min(maxBytes + 1, bytes.length * 2));
        bytes.copy(grown, 0, 0, length);
        bytes = grown;
      }
    }
    if (length > maxBytes) throw new Error("desktop_config_too_large");
    if (!pathStillNamesExpectedFile(path, opened)) throw new Error("desktop_config_not_regular");
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** Text decoding stays identical to node:fs readFileSync(path, "utf8"). */
export function readDesktopLibraryText(path: string): string {
  return readDesktopLibraryBytes(path).toString("utf8");
}

/** Only an absent directory entry is optional; dangling links and failed reads still refuse. */
export function readOptionalDesktopLibraryBytes(path: string): Buffer | undefined {
  try { return readDesktopLibraryBytes(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read optional verified metadata; a present file must contain an entries array. */
export function parseMetadata(path: string): Desktop3pMetadata {
  const bytes = readOptionalDesktopLibraryBytes(path);
  if (bytes === undefined) return { entries: [] };
  const parsed = JSON.parse(bytes.toString("utf8")) as Partial<Desktop3pMetadata>;
  if (!Array.isArray(parsed.entries)) throw new Error("Claude Desktop 3P _meta.json has no entries array");
  return { ...parsed, entries: parsed.entries };
}

export const SAFE_DESKTOP_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOwnedDesktopEntry(entry: Desktop3pMetadataEntry | undefined): boolean {
  return entry?.name === "opencodex" || entry?.name === "opencodex-standard" || entry?.name === DESKTOP_PICKER_ENTRY_NAME;
}

/** A gateway row is removable; the selected standard row must always remain. */
export function isOwnedDesktopGatewayEntry(entry: Desktop3pMetadataEntry | undefined): boolean {
  return entry?.name === "opencodex";
}

export function profilePath(libraryPath: string, id: string): string {
  if (!SAFE_DESKTOP_PROFILE_ID.test(id)) throw new Error("desktop_profile_id_unsafe");
  return join(libraryPath, `${id}.json`);
}

export const OPENCODEX_DESKTOP_PROFILE_KEYS = new Set([
  "inferenceProvider",
  "inferenceCredentialKind",
  "inferenceGatewayBaseUrl",
  "inferenceGatewayApiKey",
  "modelDiscoveryEnabled",
  "inferenceModels",
]);

export interface DesktopProfileSnapshot {
  /** Verified bytes of the existing profile; undefined only when the entry is absent. */
  bytes?: Buffer;
  foreign: Record<string, unknown>;
}

/** Capture verified bytes for key preservation, backup and rollback; publication revalidates them. */
export function readDesktopProfileSnapshot(path: string): DesktopProfileSnapshot {
  const bytes = readOptionalDesktopLibraryBytes(path);
  if (bytes === undefined) return { foreign: {} };
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Claude Desktop 3P profile is not a JSON object");
  const foreign = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !OPENCODEX_DESKTOP_PROFILE_KEYS.has(key)),
  );
  return { bytes, foreign };
}

/** Preserve settings outside the gateway-owned keys from a verified profile. */
export function readDesktopProfileForeignKeys(path: string): Record<string, unknown> {
  return readDesktopProfileSnapshot(path).foreign;
}
