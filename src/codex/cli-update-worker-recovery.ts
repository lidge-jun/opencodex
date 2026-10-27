import { codexCliUpdateGroupGone, finishClosedCodexCliUpdateRecovery } from "./cli-update-recovery";
import { CODEX_CLI_UPDATE_FENCE_COMMITTED, CODEX_CLI_UPDATE_FENCE_RECOVERING,
  CODEX_CLI_UPDATE_FENCE_CANCELLED, cancelCodexCliUpdateFence, releaseCodexCliUpdateGateOwner } from "./cli-update-selection-gate";

/** Close is authority only before commit. After commit require exact group absence. */
export function recoverClosedCodexCliUpdateWorker(gate: SharedArrayBuffer, fence: SharedArrayBuffer, owner: number,
  token: string, configDir?: string): void {
  const view = new Int32Array(fence);
  // Bun close can precede full thread exit. Prevent a late commit before
  // treating PREPARING as proof that no installer can ever start.
  cancelCodexCliUpdateFence(fence);
  if (Atomics.load(new Int32Array(gate), 0) !== owner) return;
  Atomics.compareExchange(view, 0, CODEX_CLI_UPDATE_FENCE_COMMITTED, CODEX_CLI_UPDATE_FENCE_RECOVERING);
  const recover = () => {
    if (Atomics.load(new Int32Array(gate), 0) !== owner) return true;
    if (Atomics.load(view, 0) === CODEX_CLI_UPDATE_FENCE_CANCELLED
      || Atomics.load(view, 2) === 1 || codexCliUpdateGroupGone(Atomics.load(view, 1))) {
      try { if (process.platform !== "win32") finishClosedCodexCliUpdateRecovery(token, configDir); }
      catch { return false; }
      releaseCodexCliUpdateGateOwner(gate, owner);
      return true;
    }
    return false;
  };
  if (recover()) return;
  const timer = setInterval(() => {
    if (Atomics.load(new Int32Array(gate), 0) !== owner || recover()) clearInterval(timer);
  }, 250);
  timer.unref();
}
