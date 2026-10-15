import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, realpathSync, renameSync, statSync, writeSync, type BigIntStats } from "node:fs";
import { formatWithOptions } from "node:util";
import { basename, dirname, join } from "node:path";
import { recordOwnedConfigPath } from "../lib/config-ownership";

export const SERVICE_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const SERVICE_LOG_CHECK_INTERVAL_MS = 60_000;

function regularLeaf(path: string): BigIntStats | undefined {
  try {
    const info = lstatSync(path, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.ino === 0n) throw new Error("Unsafe service log leaf");
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameFile(left: BigIntStats | undefined, right: BigIntStats | undefined): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function matchesDescriptor(path: string, fd: number, expected: BigIntStats): boolean {
  const info = fstatSync(fd, { bigint: true });
  return info.isFile() && info.nlink === 1n && sameFile(expected, info)
    && sameFile(info, regularLeaf(path));
}

/** Preserve the manager's open append descriptor; retain at most two bounded archives. */
export function rotateServiceLog(requestedPath: string, maxBytes = SERVICE_LOG_MAX_BYTES): boolean {
  let source: number | undefined;
  let archive: number | undefined;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return false;
    // Resolve only the parent: exclusive creation through a Windows junction
    // can report EEXIST for a missing leaf. Never resolve away a leaf symlink.
    const parent = dirname(requestedPath);
    const directory = statSync(parent, { bigint: true });
    if (!directory.isDirectory() || directory.ino === 0n) return false;
    const canonicalParent = realpathSync(parent);
    const path = join(canonicalParent, basename(requestedPath));
    const sameDirectory = () => {
      const alias = statSync(parent, { bigint: true });
      const canonical = statSync(canonicalParent, { bigint: true });
      return alias.isDirectory() && canonical.isDirectory()
        && sameFile(directory, alias) && sameFile(directory, canonical);
    };
    const matches = (suffix: string, fd: number, expected: BigIntStats) => sameDirectory()
      && matchesDescriptor(`${path}${suffix}`, fd, expected)
      && matchesDescriptor(`${requestedPath}${suffix}`, fd, expected);
    if (!sameDirectory()) return false;
    const original = regularLeaf(requestedPath);
    if (!original) return false;
    // Windows does not expose O_NOFOLLOW: descriptor/leaf identity checks still
    // apply there. Do not reject legitimate junctions in the home path.
    const guardedFlags = process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK;
    source = openSync(path, constants.O_RDWR | guardedFlags);
    if (!matches("", source, original)) return false;
    const size = Number(fstatSync(source, { bigint: true }).size);
    if (!Number.isSafeInteger(size) || size <= maxBytes) return false;
    const previous = regularLeaf(`${path}.1`);
    const oldest = regularLeaf(`${path}.2`);
    if (!matches("", source, original)) return false;
    if (previous) {
      if (!sameFile(previous, regularLeaf(`${path}.1`))) return false;
      const currentOldest = regularLeaf(`${path}.2`);
      if (oldest ? !sameFile(oldest, currentOldest) : currentOldest !== undefined) return false;
      if (!sameDirectory()) return false;
      renameSync(`${path}.1`, `${path}.2`);
      if (!sameFile(previous, regularLeaf(`${path}.2`))) return false;
    }
    // Never truncate an existing archive, even if another rotation or a path
    // replacement wins the gap after rename. Failure leaves the source intact.
    if (!sameDirectory()) return false;
    archive = openSync(`${path}.1`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | guardedFlags, 0o600);
    const created = fstatSync(archive, { bigint: true });
    if (!matches(".1", archive, created)) return false;
    // A legacy unbounded file may be huge. Copy only its newest cap-sized tail,
    // using fixed memory, before truncating the original inode.
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes));
    let position = size - maxBytes;
    while (position < size) {
      const read = readSync(source, buffer, 0, Math.min(buffer.length, size - position), position);
      if (read === 0) return false;
      let written = 0;
      while (written < read) {
        if (!matches(".1", archive, created)) return false;
        const count = writeSync(archive, buffer, written, read - written);
        if (count === 0) return false;
        written += count;
      }
      position += read;
    }
    fsyncSync(archive);
    // Revalidate both names and open objects at the destructive boundary. These
    // checks detect observed replacement; they are not an atomic namespace lock.
    if (!matches(".1", archive, created)
      || !matches("", source, original)) return false;
    ftruncateSync(source, 0);
    return true;
  } catch {
    return false; // Missing files, permissions and disk failures must never stop the service.
  } finally {
    for (const fd of [archive, source]) {
      if (fd !== undefined) try { closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/** One sink wrapper covers startup, provider diagnostics and multiline errors. */
export function startServiceLogging(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  intervalMs = SERVICE_LOG_CHECK_INTERVAL_MS,
): () => void {
  if (!env.OCX_SERVICE) return () => {};
  const restore: (() => void)[] = [];
  for (const method of ["log", "info", "debug", "warn", "error"] as const) {
    const original = console[method];
    console[method] = (...args: unknown[]) => {
      const at = new Date().toISOString();
      const line = formatWithOptions({ colors: false }, ...args);
      original.call(console, line.split("\n").map(part => `${at} ${part}`).join("\n"));
    };
    restore.push(() => { console[method] = original; });
  }
  try {
    for (const suffix of [".1", ".2"]) recordOwnedConfigPath(dirname(path), `${path}${suffix}`);
  } catch { /* ownership bookkeeping must not break logging */ }
  rotateServiceLog(path);
  const timer = setInterval(() => { rotateServiceLog(path); }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); for (const reset of restore) reset(); };
}
