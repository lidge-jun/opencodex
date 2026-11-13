import { createHash } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, copyFileSync, openSync, readSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * The executable a release-gate run hashes and runs (tests/e2e-style/link-websocket-release-gate.test.ts). `value` is
 * OCX_LINK_GATE_CODEX: it is resolved against `cwd` once and must name an executable regular file; anything else is
 * refused (null). That file is copied read-only into `scratch`, and the copy is both what is hashed and what is spawned,
 * by absolute path. So a bare name cannot hash one file and run another found on PATH, and replacing the original after
 * it was hashed cannot change what runs.
 */
export function preparePinnedCodex(value: string, options: { cwd?: string; scratch: string }): { path: string; digest: string } | null {
  if (!value) return null;
  const file = resolve(options.cwd ?? process.cwd(), value);
  try {
    if (!statSync(file).isFile()) return null;
    accessSync(file, constants.X_OK);
  } catch { return null; }
  // The copy keeps the file name, so an extension a platform needs to execute it (codex.exe) stays.
  const copy = join(options.scratch, basename(file));
  // Exclusive: never over an existing file. FICLONE makes the copy a reflink where the file system has them (APFS, btrfs,
  // XFS), so the 1.6 GB binary costs no space there; elsewhere it is an ordinary copy.
  copyFileSync(file, copy, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  chmodSync(copy, 0o555);
  return { path: copy, digest: sha256File(copy) };
}

function sha256File(file: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  const fd = openSync(file, "r");
  try {
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) hash.update(buffer.subarray(0, read));
  } finally { closeSync(fd); }
  return hash.digest("hex");
}
