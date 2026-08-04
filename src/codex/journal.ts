import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import { hasInjectedCodexRouting } from "./injected-marker";
import { CODEX_HOME, CODEX_CONFIG_PATH, CODEX_PROFILE_PATH } from "./paths";

const JOURNAL_PATH = join(CODEX_HOME, "opencodex-journal.json");

interface Journal {
  version: 1;
  originalConfig: string;
  originalProfile: string | null;
  injectedConfigHash?: string;
  injectedProfileHash?: string | null;
  pid: number;
  timestamp: string;
}

interface RestoreJournalResult {
  configRestored: boolean;
  profileRestored: boolean;
  configChanged: boolean;
  profileChanged: boolean;
  complete: boolean;
}

function sha256(content: string | null): string | null {
  return content === null ? null : createHash("sha256").update(content).digest("hex");
}

export interface WriteJournalOptions {
  /**
   * The caller's verdict on the config it is about to transform: false when
   * `hasInjectedCodexRouting` matched. This does NOT decide whether the content
   * may be journaled — that is checked below, from the bytes themselves. It only
   * authorizes REPLACING an existing snapshot, which is why omitting it still
   * allows a first snapshot but never an overwrite.
   */
  currentStateIsNative?: boolean;
  /**
   * The exact bytes the caller classified. Journaling these rather than re-reading
   * the file keeps the snapshot and the verdict describing the same content when
   * another process rewrites config.toml mid-flight.
   */
  configContent?: string;
}

/**
 * Snapshot the pre-injection Codex state.
 *
 * Only native (non-opencodex-owned) config may be journaled, and native config
 * always supersedes an older snapshot. The first half stops a re-inject from
 * recording opencodex's own routing as the user's original — which would survive
 * `ocx stop` and make the injection unremovable. The second half is the #477 fix:
 * without it the first snapshot a machine ever takes is the only one it ever has,
 * so an unclean shutdown days later replays a day-one config over the user's
 * plugins, model choice, and trusted projects.
 */
export function writeJournal(options: WriteJournalOptions = {}): void {
  if (!existsSync(CODEX_CONFIG_PATH)) return;
  const config = options.configContent ?? readFileSync(CODEX_CONFIG_PATH, "utf-8");
  // Ownership is decided HERE, from the bytes about to be journaled — never taken
  // on the caller's word. A caller that says "native" about injected content would
  // otherwise make opencodex's own routing the user's permanent "original".
  if (hasInjectedCodexRouting(config)) return;
  // The caller's verdict only authorizes REPLACEMENT. It is weaker evidence than
  // the check above (it may describe bytes read a moment earlier), so an
  // unclassified call creates a first snapshot but never overwrites one.
  if (existsSync(JOURNAL_PATH) && readJournal() && options.currentStateIsNative !== true) return;
  const profile = existsSync(CODEX_PROFILE_PATH)
    ? readFileSync(CODEX_PROFILE_PATH, "utf-8")
    : null;
  const journal: Journal = {
    version: 1,
    originalConfig: Buffer.from(config).toString("base64"),
    originalProfile: profile ? Buffer.from(profile).toString("base64") : null,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  };
  atomicWriteFile(JOURNAL_PATH, JSON.stringify(journal));
}

export function markJournalInjectedState(config: string, profile: string | null): void {
  const journal = readJournal();
  if (!journal) return;
  if (journal.injectedConfigHash) return;
  journal.injectedConfigHash = sha256(config) ?? undefined;
  journal.injectedProfileHash = sha256(profile);
  atomicWriteFile(JOURNAL_PATH, JSON.stringify(journal));
}

export function removeJournal(): void {
  try { unlinkSync(JOURNAL_PATH); } catch { /* ignore */ }
}

function readJournal(): Journal | null {
  if (!existsSync(JOURNAL_PATH)) return null;
  try {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf-8")) as Journal;
    if (journal.version !== 1) throw new Error("unknown version");
    return journal;
  } catch {
    removeJournal();
    return null;
  }
}

export function restoreJournalState(): RestoreJournalResult {
  const journal = readJournal();
  if (!journal) {
    return { configRestored: false, profileRestored: false, configChanged: false, profileChanged: false, complete: false };
  }
  const currentConfig = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, "utf-8") : "";
  const currentProfile = existsSync(CODEX_PROFILE_PATH) ? readFileSync(CODEX_PROFILE_PATH, "utf-8") : null;
  const configUnchanged = !journal.injectedConfigHash || sha256(currentConfig) === journal.injectedConfigHash;
  const profileUnchanged = journal.injectedProfileHash === undefined || sha256(currentProfile) === (journal.injectedProfileHash ?? null);

  let configRestored = false;
  let profileRestored = false;
  if (configUnchanged) {
    atomicWriteFile(CODEX_CONFIG_PATH, Buffer.from(journal.originalConfig, "base64").toString("utf-8"));
    configRestored = true;
  }
  if (profileUnchanged) {
    if (journal.originalProfile !== null) {
      atomicWriteFile(CODEX_PROFILE_PATH, Buffer.from(journal.originalProfile, "base64").toString("utf-8"));
    } else if (existsSync(CODEX_PROFILE_PATH)) {
      try { unlinkSync(CODEX_PROFILE_PATH); } catch { /* ignore */ }
    }
    profileRestored = true;
  }
  const complete = configRestored && profileRestored;
  if (complete) removeJournal();
  return {
    configRestored,
    profileRestored,
    configChanged: !configUnchanged,
    profileChanged: !profileUnchanged,
    complete,
  };
}

export function restoreJournal(): boolean {
  return restoreJournalState().complete;
}

export function reconcileJournal(): boolean {
  const journal = readJournal();
  if (!journal) return false;
  try {
    process.kill(journal.pid, 0);
    return false;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
  }
  const restored = restoreJournalState();
  if (!restored.configRestored && !restored.profileRestored) return false;
  console.error(`⚠️  Previous session (PID ${journal.pid}) did not shut down cleanly. Codex state restored from journal.`);
  return true;
}
