import { redactSecrets } from "./redact";

// Opt-in frame-drop visibility. The streaming path is intentionally quiet (no unconditional
// console output), so this no-ops unless OCX_DEBUG_FRAMES=1. Lets a malformed/chunk-split
// upstream frame be detected instead of silently truncating content.
function debugFramesEnabled(): boolean {
  return process.env.OCX_DEBUG_FRAMES === "1";
}

export function debugDroppedFrame(adapter: string, payload: string): void {
  if (!debugFramesEnabled()) return;
  console.error(`[ocx:frame-drop] ${adapter}: dropped malformed upstream frame (payload redacted, bytes=${payload.length})`);
}

export function debugProviderDiagnostic(adapter: string, event: string, details: Record<string, unknown>): void {
  if (!debugFramesEnabled()) return;
  try {
    console.error(`[ocx:${adapter}:${event}] ${JSON.stringify(redactSecrets(details))}`);
  } catch {
    /* diagnostics must never affect request handling */
  }
}
