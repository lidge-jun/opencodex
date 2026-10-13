import { closeSync, fstatSync, ftruncateSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import { formatWithOptions } from "node:util";
import { dirname } from "node:path";
import { recordOwnedConfigPath } from "../lib/config-ownership";

export const SERVICE_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const SERVICE_LOG_CHECK_INTERVAL_MS = 60_000;

/** Preserve the manager's open append descriptor; retain at most two bounded archives. */
export function rotateServiceLog(path: string, maxBytes = SERVICE_LOG_MAX_BYTES): boolean {
  let source: number | undefined;
  let archive: number | undefined;
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return false;
    source = openSync(path, "r+");
    const size = fstatSync(source).size;
    if (size <= maxBytes) return false;
    try { renameSync(`${path}.1`, `${path}.2`); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    archive = openSync(`${path}.1`, "w", 0o600);
    // A legacy unbounded file may be huge. Copy only its newest cap-sized tail,
    // using fixed memory, before truncating the original inode.
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes));
    let position = size - maxBytes;
    while (position < size) {
      const read = readSync(source, buffer, 0, Math.min(buffer.length, size - position), position);
      if (read === 0) return false;
      let written = 0;
      while (written < read) {
        const count = writeSync(archive, buffer, written, read - written);
        if (count === 0) return false;
        written += count;
      }
      position += read;
    }
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
