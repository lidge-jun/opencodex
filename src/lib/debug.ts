import { createHmac, randomBytes } from "node:crypto";
import { appendDebugLogLine } from "./debug-log-buffer";
import { isDebugEnabled } from "./debug-settings";
import { redactSecrets } from "./redact";

let debugFingerprintKey: Uint8Array | undefined;

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

/** Process-local, content-free correlation aid for opt-in provider diagnostics. */
export function debugFingerprint(value: string | Uint8Array): string | undefined {
  if (!isDebugEnabled()) return undefined;
  try {
    debugFingerprintKey ??= randomBytes(32);
    return createHmac("sha256", debugFingerprintKey).update(value).digest("hex");
  } catch {
    return undefined;
  }
}

export interface DebugStreamDiagnosticContext {
  requestId: string;
  adapterName: string;
  attempt?: number;
  recovery?: string;
}

export type DebugStreamDiagnosticStage = "adapter" | "bridge";

/** Emit one structural line for an adapter/bridge event without retaining its content. */
export function debugStreamDiagnostic(
  context: DebugStreamDiagnosticContext,
  stage: DebugStreamDiagnosticStage,
  sequence: number,
  eventType: string,
  details?: Record<string, unknown>,
): void {
  debugProviderDiagnostic(context.adapterName, "stream", {
    stage,
    sequence,
    eventType,
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
    ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
    ...(context.recovery !== undefined ? { recovery: context.recovery } : {}),
    ...details,
  });
}
