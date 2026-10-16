import { closeSync, fstatSync, linkSync, lstatSync, openSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getConfigDir } from "../config";
import { restoreWithoutReplacing, stableShimPathProbe } from "./shim-fingerprint";
import { isExecutableCodexCandidate } from "./shim-path-resolution";
import { readBoundedRegularFile, stateFiles, type ShimState } from "./shim-state-file";
import { SHIM_MARKER, shQuote } from "./shim-templates";

export type UnixShimMigrationResult =
  | { status: "native-restored"; launcherPath: string }
  | { status: "native-repair-required"; message: string }
  | { status: "refused"; message: string };

type Identity = { dev: number; ino: number; mode: number; size: number; mtimeMs: number; link?: string };
type MigrationRecord = { original: string; backup: string; wrapper: Identity; saved: Identity };

function identity(path: string): Identity | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("Unsupported migration entry");
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs,
      ...(stat.isSymbolicLink() ? { link: readlinkSync(path) } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function same(left: Identity | null, right: Identity | null): boolean {
  return !!left && !!right && JSON.stringify(left) === JSON.stringify(right);
}
/** Drop a journal this run created before any migration step, never a replacement at that path. */
function discardCreatedJournal(journal: string, created: { dev: number; ino: number }): void {
  try {
    const now = lstatSync(journal);
    if (now.isFile() && now.dev === created.dev && now.ino === created.ino) unlinkSync(journal);
  } catch {
    // An unreadable or vanished path is left for the next run's ownership checks.
  }
}
function binding(path: string, backup: string): boolean {
  const probe = stableShimPathProbe(path);
  return !!probe && probe.fingerprint.kind === "file" && probe.prefix.includes(SHIM_MARKER)
    && probe.prefix.includes(`exec ${shQuote(backup)} "$@"`);
}

/** Caller holds the shared lock; legacy state remains intact until overlay commit. */
export function migrateLegacyUnixShim(state: ShimState): UnixShimMigrationResult {
  const refused = (message: string): UnixShimMigrationResult => ({ status: "refused", message });
  const repair = (): UnixShimMigrationResult => ({ status: "native-repair-required", message:
    "Native Codex entry is missing or unusable. Repair Codex with its package manager, then rerun ocx codex-shim install; the recovery state was retained." });
  const files = stateFiles(state);
  if (state.platform !== process.platform || state.platform === "win32" || state.mode || files.length !== 1) {
    return refused("Legacy Unix shim has ambiguous targets or platform; preserving all files.");
  }
  const file = files[0]!;
  if (file.preserveOnly || file.realPath || file.wrapperPath !== file.originalPath
    || !isAbsolute(file.originalPath) || /[\x00-\x1f\x7f]/.test(file.originalPath)
    || file.backupPath !== `${file.originalPath}.opencodex-real`) {
    return refused("Legacy Unix shim ownership is ambiguous; manual recovery is required.");
  }
  const original = file.originalPath;
  const backup = file.backupPath;
  const quarantine = `${original}.opencodex-migrating`;
  const journal = join(getConfigDir(), "codex-shim.migration.json");
  let journalIdentity: Identity | null = null;
  try {
    let record: MigrationRecord | null = null;
    const journalBefore = identity(journal);
    if (journalBefore) {
      const entry = lstatSync(journal);
      if (!entry.isFile() || entry.uid !== process.getuid?.() || (entry.mode & 0o022)) return refused("Migration journal is not privately owned.");
    }
    const stored = readBoundedRegularFile(journal, 16 * 1024);
    const journalAfter = identity(journal);
    if (journalBefore || journalAfter) {
      if (!same(journalBefore, journalAfter)) return refused("Migration journal changed during inspection.");
    }
    if (stored) {
      if ("warning" in stored) return refused("Migration recovery record is unreadable; preserving all artifacts.");
      record = JSON.parse(stored.content) as MigrationRecord;
      if (!record || record.original !== original || record.backup !== backup || !record.wrapper || !record.saved) {
        return refused("Migration recovery record does not match the legacy state.");
      }
      journalIdentity = journalBefore;
    }
    let current = identity(original);
    const saved = identity(backup);
    const evacuated = identity(quarantine);
    const probe = current && isExecutableCodexCandidate(original) ? stableShimPathProbe(original) : null;
    if (current && (binding(original, backup) || probe?.prefix.includes(SHIM_MARKER))) {
      if (!binding(original, backup)) return refused("Legacy wrapper binding changed; preserving it.");
      if (!saved) return repair();
      if (!record) {
        if (evacuated) return refused("Unrecorded migration quarantine requires manual inspection.");
        record = { original, backup, wrapper: current, saved };
        const fd = openSync(journal, "wx", 0o600);
        const created = fstatSync(fd);
        try {
          writeFileSync(fd, JSON.stringify(record) + "\n");
          const written = fstatSync(fd);
          journalIdentity = identity(journal);
          if (journalIdentity?.ino !== created.ino || journalIdentity.dev !== created.dev
            || journalIdentity.size !== written.size || journalIdentity.mtimeMs !== written.mtimeMs) throw new Error("Journal replaced");
        } catch (error) {
          // Nothing has moved yet, so a partial journal of ours would only block every retry.
          discardCreatedJournal(journal, created);
          journalIdentity = null;
          throw error;
        } finally { closeSync(fd); }
      }
      if (!same(current, record.wrapper) || !same(saved, record.saved)) return refused("Migration inputs changed; preserving all generations.");
      if (evacuated) {
        if (!same(evacuated, record.wrapper)) return refused("Migration quarantine changed; preserving it.");
      } else {
        // A hard link is exclusive publication: unlike rename it never overwrites quarantine.
        linkSync(original, quarantine);
      }
      if (!same(identity(original), record.wrapper) || !same(identity(quarantine), record.wrapper)
        || !same(identity(backup), record.saved)) return refused("Migration inputs changed before evacuation.");
      unlinkSync(original);
      current = null;
    } else if (evacuated && (!record || !same(evacuated, record.wrapper) || !binding(quarantine, backup))) {
      return refused("Migration quarantine ownership is uncertain; preserving the recovery record.");
    }
    if (!current) {
      if (!saved) return repair();
      if (!same(identity(backup), record?.saved ?? saved)) return refused("Legacy backup changed; retry after the package manager finishes.");
      try {
        restoreWithoutReplacing(backup, original, () => {
          if (!same(identity(backup), record?.saved ?? saved)) throw new Error("Legacy backup replaced during publication");
          const restored = identity(original);
          if (saved.link !== undefined ? restored?.link !== saved.link : !same(restored, saved)) {
            throw new Error("Native entry changed during restoration");
          }
        });
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A concurrent package-manager publication wins over the saved generation.
      }
    }
    const native = isExecutableCodexCandidate(original) ? stableShimPathProbe(original) : null;
    if (!native || native.prefix.includes(SHIM_MARKER)) return repair();
    if (record && identity(quarantine)) {
      if (!same(identity(quarantine), record.wrapper) || !binding(quarantine, backup)) return refused("Migration quarantine changed during restoration.");
      unlinkSync(quarantine);
    }
    if (journalIdentity && same(identity(journal), journalIdentity)) unlinkSync(journal);
    return { status: "native-restored", launcherPath: original };
  } catch {
    return refused("Legacy migration could not complete safely; native and recovery artifacts were preserved. Retry after the package manager finishes.");
  }
}
