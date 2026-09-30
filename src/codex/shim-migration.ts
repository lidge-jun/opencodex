import { lstatSync, renameSync, unlinkSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SHIM_MARKER, shQuote } from "./shim-templates";
import { restoreWithoutReplacing, sameFingerprint, sameFingerprintAfterRename, shimPathFingerprint, stableShimPathProbe } from "./shim-fingerprint";
import { stateFiles, type ShimState } from "./shim-state-file";

let beforeNativePublish: (() => void) | undefined;
export function setShimMigrationPublishHookForTests(hook?: () => void): void { beforeNativePublish = hook; }

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** The legacy state remains the recovery record until the overlay commit succeeds.
 * Recovery never recreates an in-place shim. Publication uses no-replace primitives.
 */
export function migrateLegacyUnixShim(state: ShimState): { launcher?: string; message: string } {
  const files = stateFiles(state);
  if (files.length !== 1) return { message: "Legacy Unix shim has ambiguous targets; manual recovery is required." };
  const file = files[0]!;
  if (file.preserveOnly || file.realPath || file.wrapperPath !== file.originalPath
    || !isAbsolute(file.originalPath) || file.backupPath !== `${file.originalPath}.opencodex-real`) {
    return { message: "Legacy Unix shim ownership is ambiguous; preserving all files." };
  }
  const original = file.originalPath;
  const quarantine = `${original}.opencodex-migrating`;
  const current = stableShimPathProbe(original);
  if (present(original) && !current) return { message: "Legacy Codex entry is unreadable; preserving it." };
  if (current?.prefix.includes(SHIM_MARKER)) {
    if (current.fingerprint.kind !== "file" || !current.prefix.includes(`exec ${shQuote(file.backupPath)} "$@"`)) {
      return { message: "Legacy wrapper binding changed; preserving the entry." };
    }
    if (present(quarantine)) return { message: `Previous migration artifact requires inspection: ${quarantine}` };
    const rechecked = shimPathFingerprint(original);
    if (!rechecked || !sameFingerprint(current.fingerprint, rechecked)) return { message: "Legacy Codex entry changed; retry migration." };
    renameSync(original, quarantine);
    const moved = shimPathFingerprint(quarantine);
    if (!moved || !sameFingerprintAfterRename(current.fingerprint, moved)) {
      try { restoreWithoutReplacing(quarantine, original); } catch { /* preserve both generations */ }
      return { message: "Codex entry changed during migration; concurrent files were preserved." };
    }
  }
  if (!present(original)) {
    if (!present(file.backupPath)) return { message: "Native Codex launcher and legacy backup are missing; repair the native installation." };
    beforeNativePublish?.();
    try { restoreWithoutReplacing(file.backupPath, original); }
    catch { return { message: "Native Codex entry changed during migration; retry after the package manager finishes." }; }
  }
  // The native entry may have been upgraded externally. Never replace it with an old backup.
  const native = stableShimPathProbe(original);
  if (native?.prefix.includes(SHIM_MARKER)) return { message: "Codex entry still resolves to a shim; manual recovery is required." };
  if (present(quarantine)) {
    const saved = stableShimPathProbe(quarantine);
    if (saved?.fingerprint.kind === "file" && saved.prefix.includes(SHIM_MARKER)
      && saved.prefix.includes(`exec ${shQuote(file.backupPath)} "$@"`)) unlinkSync(quarantine);
  }
  // Broken symlinks are restored as symlinks too, allowing Homebrew to repair its own
  // entry. Do not guess a Caskroom version or report a runnable installation.
  if (!native) return { message: "Legacy shim released the native entry, but its target is missing. Repair Codex with its package manager, then rerun ocx codex-shim install." };
  return { launcher: original, message: "Legacy native entry restored." };
}
