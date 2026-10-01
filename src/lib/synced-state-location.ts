import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where a state directory sits relative to the folders macOS keeps in sync with a cloud.
 *
 * A sync daemon can hold a second hard link to a file while it stages or uploads a change. The
 * spend ledger refuses a journal with a second link on purpose, so a state directory inside a
 * synced folder turns ordinary requests into intermittent 502s (#6314). This only answers
 * "is it likely synced"; the guard itself stays strict.
 */
export type SyncedStateLocation = "icloud-drive" | "file-provider" | "icloud-desktop-documents";

export interface SyncedStateLocationProbe {
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  /** Resolve symlinks. Throws when the path does not exist yet. */
  readonly realpath?: (path: string) => string;
  /** Whether a directory entry exists at the path, without following it. */
  readonly entryExists?: (path: string) => boolean;
}

const defaultEntryExists = (path: string): boolean => {
  try { lstatSync(path); return true; } catch { return false; }
};

/**
 * Advisory only. Apple publishes no API a CLI can ask, so this reads the observed layout:
 * iCloud Drive lives under ~/Library/Mobile Documents, File Provider clients (OneDrive, Dropbox,
 * Google Drive) under ~/Library/CloudStorage, and with "Desktop & Documents Folders" turned on
 * iCloud Drive holds a Desktop/Documents entry of its own. A false positive costs one warning
 * line; nothing is refused on the strength of it.
 */
export function syncedStateLocation(dir: string, probe: SyncedStateLocationProbe = {}): SyncedStateLocation | undefined {
  if ((probe.platform ?? process.platform) !== "darwin") return undefined;
  const realpath = probe.realpath ?? ((path: string) => realpathSync.native(path));
  const entryExists = probe.entryExists ?? defaultEntryExists;
  const canonical = (path: string): string => {
    try { return realpath(path); } catch { return resolve(path); }
  };
  // The default APFS volume is case-insensitive, so ~/documents and ~/Documents are one folder.
  const fold = (path: string): string => path.toLowerCase();
  const home = canonical(probe.home ?? homedir());
  const target = fold(canonical(dir));
  const within = (root: string): boolean => {
    const folded = fold(root);
    return target === folded || target.startsWith(folded + "/");
  };
  const mobileDocuments = join(home, "Library", "Mobile Documents");
  if (within(mobileDocuments)) return "icloud-drive";
  if (within(join(home, "Library", "CloudStorage"))) return "file-provider";
  for (const folder of ["Desktop", "Documents"]) {
    if (within(join(home, folder)) && entryExists(join(mobileDocuments, "com~apple~CloudDocs", folder))) {
      return "icloud-desktop-documents";
    }
  }
  return undefined;
}

const LOCATION_LABEL: Record<SyncedStateLocation, string> = {
  "icloud-drive": "inside iCloud Drive",
  "file-provider": "inside a cloud-storage (File Provider) folder",
  "icloud-desktop-documents": "in Desktop or Documents, which iCloud Drive appears to sync",
};

/** The startup warning. Names the location kind, never the path. */
export function syncedStateWarning(location: SyncedStateLocation): string[] {
  return [
    `⚠️  The opencodex state directory (OPENCODEX_HOME) is ${LOCATION_LABEL[location]}.`,
    "   A sync service can briefly add a second link to the spend ledger, which opencodex",
    "   refuses, so requests may fail intermittently. Set OPENCODEX_HOME to a folder outside",
    "   synced locations (the default ~/.opencodex is not synced).",
  ];
}

let warned = false;

/** Warn once per process when the state directory looks synced. Never throws. */
export function warnIfSyncedStateDirectory(dir: string, warn: (line: string) => void = console.warn): void {
  if (warned) return;
  let location: SyncedStateLocation | undefined;
  try { location = syncedStateLocation(dir); } catch { return; }
  if (location === undefined) return;
  warned = true;
  // Runs while the startup owner lease is held and before its rollback is registered, so a
  // throwing sink must not escape and strand the lease.
  try {
    for (const line of syncedStateWarning(location)) warn(line);
  } catch { /* advisory output only */ }
}
