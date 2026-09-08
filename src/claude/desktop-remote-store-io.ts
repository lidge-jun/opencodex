import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { hardenSecretDir } from "../lib/windows-secret-acl";
import { isRecord, resolveDesktop3pConfigLibraryPath, SAFE_DESKTOP_PROFILE_ID, type Desktop3pMetadata } from "./desktop-3p-library";
import { DesktopStoreError, digest } from "./desktop-remote-store-state";

export const MAX_DESKTOP_METADATA_ENTRIES = 256;

export interface JsonFile { value: Record<string, unknown>; hash: string; identity: string }
const identity = (s: NonNullable<ReturnType<typeof lstatSync>>): string => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
export function canonicalDirectory(path: string): string {
  const absolute = resolve(path);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new DesktopStoreError("unsafe");
    return realpathSync(absolute);
  } catch (error) {
    if (!missing(error)) throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalDirectory(parent), basename(absolute));
  }
}
export function storePaths() {
  const home = canonicalDirectory(getConfigDir());
  const library = canonicalDirectory(resolveDesktop3pConfigLibraryPath());
  const root = canonicalDirectory(join(home, "desktop-remote"));
  return { home, library, root, state: join(root, "state.json"), baseline: join(root, "baseline.json"), disconnect: join(root, "disconnect.json") };
}
export class StoreIO {
  changed = false;
  private bytes = 0;
  private readonly seenSizes = new Map<string, number>();
  read(path: string, maxBytes = 1024 * 1024, privateFile = false): JsonFile | null {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); }
    catch (error) { if (missing(error)) return null; throw new DesktopStoreError("unsafe"); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes
      || (privateFile && process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new DesktopStoreError("unsafe");
    const counted = this.seenSizes.get(path) ?? 0;
    this.bytes += Math.max(0, stat.size - counted);
    this.seenSizes.set(path, Math.max(counted, stat.size));
    if (this.bytes > 8 * 1024 * 1024) throw new DesktopStoreError("unsafe");
    try {
      const bytes = readFileSync(path);
      if (bytes.byteLength > maxBytes || identity(lstatSync(path)) !== identity(stat)) throw new DesktopStoreError("conflict");
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isRecord(value)) throw new DesktopStoreError("unsafe");
      return { value, hash: digest(bytes.toString("utf8")), identity: identity(stat) };
    } catch (error) { if (error instanceof DesktopStoreError) throw error; throw new DesktopStoreError("unsafe"); }
  }
  ensureDirectory(path: string): void {
    canonicalDirectory(path);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    canonicalDirectory(path);
    chmodSync(path, 0o700);
    if (process.platform === "win32") hardenSecretDir(path, { required: true });
  }
  compare(path: string, expected: JsonFile | null): void {
    const fresh = this.read(path);
    if (fresh?.hash !== expected?.hash || fresh?.identity !== expected?.identity) throw new DesktopStoreError("conflict");
  }
  write(path: string, value: unknown, expected: JsonFile | null, maxBytes = 1024 * 1024): void {
    const bytes = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(bytes) > maxBytes) throw new DesktopStoreError("unsafe");
    this.compare(path, expected);
    this.ensureDirectory(dirname(path));
    atomicWriteFile(path, bytes, undefined, { validateBeforeRename: () => this.compare(path, expected) });
    this.changed = true;
  }
  remove(path: string, expected: JsonFile): void {
    this.compare(path, expected);
    unlinkSync(path);
    this.changed = true;
  }
}
export function metadata(io: StoreIO, library: string): { file: JsonFile | null; value: Desktop3pMetadata } {
  const file = io.read(join(library, "_meta.json"));
  if (!file) return { file, value: { entries: [] } };
  const value = file.value;
  if (!Array.isArray(value.entries) || value.entries.length > MAX_DESKTOP_METADATA_ENTRIES) throw new DesktopStoreError("unsafe");
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !SAFE_DESKTOP_PROFILE_ID.test(entry.id)
      || seen.has(entry.id) || typeof entry.name !== "string") throw new DesktopStoreError("unsafe");
    seen.add(entry.id);
  }
  if (value.appliedId !== undefined && (typeof value.appliedId !== "string" || !seen.has(value.appliedId))) throw new DesktopStoreError("unsafe");
  return { file, value: value as unknown as Desktop3pMetadata };
}
