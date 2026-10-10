/** Process-local opt-in for cross-turn Codex WebSocket reuse. Default off. */
let reuseAcrossTurns = false;

export function setCodexWsReuseAcrossTurns(enabled: boolean): void {
  reuseAcrossTurns = enabled;
}

export function codexWsReuseAcrossTurnsEnabled(): boolean {
  return reuseAcrossTurns;
}
