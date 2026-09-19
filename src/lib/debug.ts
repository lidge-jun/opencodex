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

/**
 * The same diagnostic for details that are expensive to compute or read live request state.
 *
 * The eager form takes an already-built object, so the build runs in ARGUMENT position: outside
 * this module's gate, and outside its try/catch. For a projection that walks a whole request
 * that is wrong twice over — it pays the walk while debug is off, and a throw inside it reaches
 * the caller, which for an adapter means a built request becomes a rejected one and a send that
 * would have happened does not. Pass the builder instead: it runs only when debug is on, and a
 * throw inside it is swallowed exactly like a throw in the emit.
 */
export function debugProviderDiagnosticLazy(
  adapter: string,
  event: string,
  details: () => Record<string, unknown>,
): void {
  if (!isDebugEnabled()) return;
  try {
    emitDebugLine(`[ocx:${adapter}:${event}] ${JSON.stringify(redactSecrets(details()))}`);
  } catch {
    /* diagnostics must never affect request handling */
  }
}
