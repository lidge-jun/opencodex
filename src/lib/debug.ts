import { appendDebugLogLine } from "./debug-log-buffer";
import { isDebugEnabled } from "./debug-settings";
import { redactSecrets } from "./redact";

function emitDebugLine(line: string): void {
  if (!isDebugEnabled()) return;
  try {
    appendDebugLogLine(line);
    console.error(line);
  } catch {
    /* diagnostics must never affect request handling */
  }
}

// Opt-in provider diagnostics. Streaming adapters stay quiet unless provider debug is on
// (`ocx debug provider on`, GUI Logs toggle, or OCX_DEBUG=1). Tail with `ocx debug provider logs -f`.

export function debugDroppedFrame(adapter: string, payload: string): void {
  if (!isDebugEnabled()) return;
  emitDebugLine(`[ocx:frame-drop] ${adapter}: dropped malformed upstream frame (payload redacted, bytes=${payload.length})`);
}

/** Provider-agnostic diagnostic logging: `[ocx:<adapter>:<event>] {...}`. */
export function debugProviderDiagnostic(adapter: string, event: string, details: Record<string, unknown>): void {
  if (!isDebugEnabled()) return;
  try {
    emitDebugLine(`[ocx:${adapter}:${event}] ${JSON.stringify(redactSecrets(details))}`);
  } catch {
    /* diagnostics must never affect request handling */
  }
}
