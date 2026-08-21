import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import { hasInjectedCodexRouting } from "./injected-marker";
import { CODEX_HOME, CODEX_CONFIG_PATH, CODEX_PROFILE_PATH } from "./paths";

/**
 * Exported so that anything reasoning ABOUT the journal points at the journal.
 *
 * The Codex admission snapshot re-derived this path by hand and got it wrong in
 * both halves — wrong directory and wrong filename — so its "journal identity"
 * watched a file nothing writes. The fixture re-derived it the same wrong way,
 * agreed with the producer, and the pair stayed green. One exported constant
 * removes the opportunity.
 */
export const JOURNAL_PATH = join(CODEX_HOME, "opencodex-journal.json");

interface Journal {
  version: 1;
  originalConfig: string;
  originalProfile: string | null;
  injectedConfigHash?: string;
  injectedProfileHash?: string | null;
  /**
   * The exact root `openai_base_url` this injection wrote, when it wrote one.
   *
   * #1798: ownership used to be inferred from a marker COMMENT on the preceding line,
   * which a reserializing Codex app deletes while keeping the value. Recording the value
   * we actually wrote makes ownership provable from evidence rather than from formatting,
   * and it is what lets restore tell OUR loopback URL apart from a gateway the user set.
   */
  injectedOpenaiBaseUrl?: string | null;
  /**
   * The catalog path this injection actually wrote to.
   *
   * #1798: restore re-resolves the catalog from the CURRENT config, so a Codex app rewrite
   * that dropped `model_catalog_json` sends restore to the default catalog while the
   * proxy-written one is left routed. The injected path is the only durable record of which
   * file we actually touched.
   */
  injectedCatalogPath?: string | null;
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

export interface InjectedJournalOwnership {
  injectedOpenaiBaseUrl: string | null;
  injectedCatalogPath: string | null;
}

export function markJournalInjectedState(
  config: string,
  profile: string | null,
  ownership: InjectedJournalOwnership,
): void {
  const journal = readJournal();
  if (!journal) return;
  // The first exact injected config is the only safe whole-snapshot restore boundary for
  // the first native snapshot. A later reinjection may preserve user edits made while routed;
  // hashing those newer bytes and restoring the first snapshot would delete those edits.
  // Keep the first hash so changed/reinjected configs take the owned-field fallback path.
  journal.injectedConfigHash ??= sha256(config) ?? undefined;
  // The profile file is wholly generated by OpenCodex, so its latest exact hash remains safe
  // to refresh and lets restore remove the latest generated profile after a port change.
  journal.injectedProfileHash = sha256(profile);
  // Only the caller knows which values it actually owns. Deriving these from the final TOML
  // would mistake a preserved user override for injected routing.
  journal.injectedOpenaiBaseUrl = ownership.injectedOpenaiBaseUrl;
  journal.injectedCatalogPath = ownership.injectedCatalogPath;
  atomicWriteFile(JOURNAL_PATH, JSON.stringify(journal));
}

/**
 * The root `openai_base_url` the last injection wrote, or null when it wrote none.
 *
 * #1798: the fallback strip recognizes an injected URL by the marker COMMENT above it,
 * and a Codex app rewrite keeps values while dropping comments. This is the evidence that
 * survives such a rewrite, so restore can still prove the URL is ours -- and, just as
 * importantly, prove that a DIFFERENT URL is not.
 */
export function journaledInjectedOpenaiBaseUrl(): string | null {
  return readJournal()?.injectedOpenaiBaseUrl ?? null;
}

/** The catalog path the last injection wrote to, or null when none was recorded. */
export function journaledInjectedCatalogPath(): string | null {
  return readJournal()?.injectedCatalogPath ?? null;
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
