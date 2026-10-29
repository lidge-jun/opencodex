/**
 * Process-local opt-in for incremental Codex WebSocket uploads. Default off.
 * Lives in the config layer so config loading never pulls the Responses transport into a
 * Child or Hub client's load graph; the transport subscribes to drop retained state on disable.
 */
import type { OcxConfig } from "../types";
import { setCodexWsReuseAcrossTurns } from "./codex-ws-reuse-setting";

let incrementalUpload = false;
const disableListeners = new Set<() => void>();

export function setCodexWsIncrementalUpload(enabled: boolean): void {
  incrementalUpload = enabled;
  if (!enabled) for (const listener of disableListeners) listener();
}

export function codexWsIncrementalUploadEnabled(): boolean {
  return incrementalUpload;
}

export function onCodexWsIncrementalUploadDisabled(listener: () => void): void {
  disableListeners.add(listener);
}

/**
 * Sole owner of both Codex WS process flags: bound from the adopted live server config only, so
 * detached `loadConfig()` reads (CLI, `/api/sync`, management snapshots) never toggle socket reuse,
 * enable incremental sends, or clear retained state. Incremental upload implies cross-turn reuse.
 */
export function bindCodexWsIncrementalConfig(config: Pick<OcxConfig, "codexWsIncrementalUpload" | "codexWsReuseAcrossTurns">): void {
  const enabled = config.codexWsIncrementalUpload === true;
  setCodexWsIncrementalUpload(enabled);
  setCodexWsReuseAcrossTurns(config.codexWsReuseAcrossTurns === true || enabled);
}
