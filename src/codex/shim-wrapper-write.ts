/**
 * Wrapper write and ownership fingerprint for the Codex autostart shim.
 *
 * Extracted from shim.ts so the parent module stays inside the file-size
 * ratchet. This cluster is a closed dependency edge: everything here flows
 * from node:fs/node:path, the shim template builders, and the fingerprint
 * probes — nothing imports back into shim.ts.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { durableBunRuntime, type BunRuntimeSource, type DurableBunRuntime } from "../lib/bun-runtime";
import { sameFileIdentity, type FileIdentity } from "../lib/file-identity";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import {
  buildUnixCodexShim,
  buildWindowsCodexShim,
  buildWindowsPowerShellCodexShim,
  gitBashPath,
  SHIM_MARKER,
} from "./shim-templates";
import {
  sameFingerprint,
  stableShimPathProbe,
  type ShimPathFingerprint,
  type StableShimPathProbe,
} from "./shim-fingerprint";

function cliEntry(runtime: DurableBunRuntime = durableBunRuntime()): { bun: string; bunRuntimeSource: BunRuntimeSource; cli: string } {
  // Bundled Bun path (survives `ocx update`); all three shim builders
  // (Unix / Windows cmd / Windows PowerShell) receive it via this entry.
  // This module lives in src/codex/, the CLI entry in src/cli/index.ts.
  // Path and provenance resolve together so the marker always describes this binary.
  return { bun: runtime.path, bunRuntimeSource: runtime.source, cli: join(import.meta.dir, "..", "cli", "index.ts") };
}

/**
 * Write the wrapper and return the identity of the inode this call created, or
 * `undefined` where the platform still writes the destination in place.
 *
 * Callers must derive ownership from the returned identity rather than from a
 * later `stat` of `wrapperPath`: the shim markers are public, so a concurrent
 * updater's wrapper can carry them, and a replacement landing between the write
 * and the observation is otherwise indistinguishable from our own file.
 */
/** The Windows wrapper for `wrapperPath`'s flavor (.ps1, .cmd/.bat, or extensionless Git-Bash sh). */
export function windowsShimContent(wrapperPath: string, realCodexPath: string, runtime?: DurableBunRuntime): string {
  const { bun, bunRuntimeSource, cli } = cliEntry(runtime);
  const lower = wrapperPath.toLowerCase();
  // UTF-8 BOM: Windows PowerShell 5.1 decodes BOM-less .ps1 files in the ANSI
  // codepage, which mangles non-ASCII paths embedded in the shim.
  if (lower.endsWith(".ps1")) return `\uFEFF${buildWindowsPowerShellCodexShim(realCodexPath, bun, cli, bunRuntimeSource)}`;
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return buildWindowsCodexShim(realCodexPath, bun, cli, bunRuntimeSource);
  // Extensionless Git-Bash sh launcher: sh shim with forward-slash paths.
  return buildUnixCodexShim(gitBashPath(realCodexPath), gitBashPath(bun), gitBashPath(cli), bunRuntimeSource, gitBashPath(serviceApiTokenFilePath()));
}

export function writeShim(wrapperPath: string, realCodexPath: string, runtime?: DurableBunRuntime): FileIdentity | undefined {
  const { bun, bunRuntimeSource, cli } = cliEntry(runtime);
  if (process.platform === "win32") {
    writeFileSync(wrapperPath, windowsShimContent(wrapperPath, realCodexPath, runtime), "utf8");
    return undefined;
  } else {
    // Stage the wrapper as its own inode and rename it into place, so ownership
    // comes from the write itself rather than from observing the path afterwards.
    // Writing the destination directly leaves a window in which a concurrent
    // updater can replace the file between our write and our fingerprint; we would
    // then adopt that replacement as ours and unlink it during rollback, deleting
    // an executable we never wrote.
    // Hidden and non-executable while staged, so a crash between the write and the
    // rename cannot leave an executable `codex*` artifact that a glob or a shell
    // completion would surface.
    const staged = join(dirname(wrapperPath), `.${basename(wrapperPath)}.opencodex-staging.${process.pid}.${randomUUID()}`);
    let renamed = false;
    try {
      // "wx" fails if the staging path somehow exists, so we never inherit a file.
      writeFileSync(staged, buildUnixCodexShim(realCodexPath, bun, cli, bunRuntimeSource), { encoding: "utf8", flag: "wx", mode: 0o600 });
      const stagedStat = lstatSync(staged, { bigint: true });
      chmodSync(staged, 0o755);
      renameSync(staged, wrapperPath);
      renamed = true;
      // rename() preserves dev/ino and updates ctime, so identity is the inode
      // pair, captured from the file we created rather than from the destination.
      return { dev: stagedStat.dev, ino: stagedStat.ino };
    } finally {
      if (!renamed) {
        try { unlinkSync(staged); } catch { /* best-effort: nothing to clean up */ }
      }
    }
  }
}

/**
 * The fingerprint to record as "we wrote this", or `undefined` when the file at
 * `wrapperPath` is not the inode `writeShim()` created. Returning `undefined`
 * makes every rollback path treat the file as someone else's and leave it alone.
 */
export function ownedWrapperFingerprint(
  wrapperPath: string,
  written: FileIdentity | undefined,
): ShimPathFingerprint | undefined {
  const probe = stableShimPathProbe(wrapperPath);
  if (!probe) return undefined;
  // Platforms that still write in place (Windows) have no staged identity; fall
  // back to the marker check they have always used.
  if (!written) return probe.prefix.includes(SHIM_MARKER) ? probe.fingerprint : undefined;
  if (!sameFileIdentity(probe.fingerprint.identity, written)) return undefined;
  return probe.fingerprint;
}

/**
 * Whether the file now at the wrapper path is one this transaction may unlink.
 *
 * The inode our write created is the authority. It stays ours through an in-place
 * truncation — a partial write we must clean up — and stops being ours the moment
 * someone renames a different file over the path, which is exactly the concurrent
 * updater we must not delete. Where no inode was recorded (Windows writes the
 * destination directly), fall back to the exact fingerprint recorded at the time.
 */
export function wrapperInodeIsOurs(
  wrapper: StableShimPathProbe,
  written: FileIdentity | undefined,
  recorded: ShimPathFingerprint | undefined,
): boolean {
  // A different inode is conclusive: someone renamed their own file over ours.
  if (written && !sameFileIdentity(wrapper.fingerprint.identity, written)) {
    return false;
  }
  // Same inode is not sufficient on its own — an in-place truncation (shell `>`,
  // writeFileSync) keeps it while replacing the contents. When we recorded a full
  // fingerprint, require it to still match; that covers our own partial write,
  // whose fingerprint we record before anything can fail.
  if (recorded !== undefined) return sameFingerprint(wrapper.fingerprint, recorded);
  // No recorded fingerprint: only the inode identity we captured at write time can
  // speak for us, and there is nothing else to distinguish this file.
  return written !== undefined;
}
