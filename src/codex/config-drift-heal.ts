/**
 * Config-surface drift detection for the injected Codex config.
 *
 * The Codex desktop app rewrites `~/.codex/config.toml` on its own schedule — app updates,
 * settings changes, reserializations — and a 26.924-era rewrite strips the injected root keys
 * (`openai_base_url`, `model_catalog_json`, the realtime sideband) that carry proxy routing
 * and the model list. Nothing else notices: the catalog file survives, so the catalog-only
 * converge funnel reports "no change", and the app keeps serving its native model picker.
 * Startup sync re-injects, but the proxy may run for days between restarts.
 *
 * This module answers the one question the journal was built to answer and nobody asked in
 * the background: are the bytes on disk still the bytes opencodex injected? The journal
 * records the values the last injection wrote (`injectedOpenaiBaseUrl`,
 * `injectedRealtimeWsBaseUrl`). A caller polls `codexConfigDrift()`; when a journaled root
 * key is absent while the journal says it should be present, the caller re-runs the standard
 * injection, which rewrites the keys and re-journals the new baseline.
 *
 * Deliberately not a filesystem watcher: launchd/FSWatcher coverage for an arbitrary home
 * adds an agent surface for a file that also changes for legitimate reasons (the user's own
 * edits, `ocx restore`). Polling at the auto-refresh cadence bounds staleness to one interval
 * and reuses an already-armed timer.
 */

import { existsSync, readFileSync } from "node:fs";
import { CODEX_CONFIG_PATH } from "./paths";
import {
  REALTIME_WS_BASE_URL_KEY,
  rootTomlString,
} from "./injected-marker";

export interface CodexConfigDrift {
  /**
   * An injected routing key is absent from the on-disk config while the journal says the
   * last injection wrote it: the surface was rewritten underneath opencodex.
   */
  readonly drifted: boolean;
  /** Which injected keys went missing. Empty when not drifted. */
  readonly missingKeys: readonly string[];
}

/**
 * Compare the on-disk config against what the journal says the last injection wrote.
 *
 * The journal is the only authority: a config that never was injected (no journal, or a
 * journal without recorded URLs) reports no drift, because there is nothing to heal. A
 * PRESENT key always satisfies the check regardless of its value — the injector's own
 * user-ownership rules (a user's `openai_base_url` without the marker is kept, reported as
 * `keptUserBaseUrl`, and re-journaled as null) own that case, so a heal triggered on a
 * missing key runs into them and stops on its own rather than stomping a user's routing.
 */
export function codexConfigDrift(
  readJournal: () => { injectedOpenaiBaseUrl?: string | null; injectedRealtimeWsBaseUrl?: string | null } | null,
  configPath: string = CODEX_CONFIG_PATH,
  readFile: (path: string) => string = path => readFileSync(path, "utf-8"),
  fileExists: (path: string) => boolean = existsSync,
): CodexConfigDrift {
  const journal = readJournal();
  const journaledBaseUrl = journal?.injectedOpenaiBaseUrl;
  const journaledRealtimeWsUrl = journal?.injectedRealtimeWsBaseUrl;
  if (!journaledBaseUrl && !journaledRealtimeWsUrl) {
    return { drifted: false, missingKeys: [] };
  }
  if (!fileExists(configPath)) {
    return { drifted: false, missingKeys: [] };
  }
  let content: string;
  try {
    content = readFile(configPath);
  } catch {
    return { drifted: false, missingKeys: [] };
  }
  const missingKeys: string[] = [];
  if (journaledBaseUrl && rootTomlString(content, "openai_base_url") === null) {
    missingKeys.push("openai_base_url");
  }
  if (journaledRealtimeWsUrl && rootTomlString(content, REALTIME_WS_BASE_URL_KEY) === null) {
    missingKeys.push(REALTIME_WS_BASE_URL_KEY);
  }
  return { drifted: missingKeys.length > 0, missingKeys };
}
