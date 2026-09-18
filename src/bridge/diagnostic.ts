import type { AdapterEvent } from "../types";
import { debugFingerprint, debugStreamDiagnostic, type DebugStreamDiagnosticContext } from "../lib/debug";

export interface BridgeDiagnosticSequence { value: number }

export interface BridgeDiagnosticContext extends DebugStreamDiagnosticContext {
  sequence?: BridgeDiagnosticSequence;
}

export function adapterEventDiagnosticDetails(event: AdapterEvent): Record<string, unknown> {
  switch (event.type) {
    case "text_delta":
      return { byteLength: Buffer.byteLength(event.text), fingerprint: debugFingerprint(event.text) };
    case "thinking_delta":
      return { byteLength: Buffer.byteLength(event.thinking), fingerprint: debugFingerprint(event.thinking) };
    case "reasoning_raw_delta":
      return { byteLength: Buffer.byteLength(event.text), fingerprint: debugFingerprint(event.text) };
    case "thinking_signature":
    case "redacted_thinking":
    case "kiro_redacted_reasoning": {
      const content = event.type === "thinking_signature" ? event.signature : event.data;
      return { byteLength: Buffer.byteLength(content), fingerprint: debugFingerprint(content) };
    }
    case "tool_call_delta":
      return { byteLength: Buffer.byteLength(event.arguments), fingerprint: debugFingerprint(event.arguments) };
    case "tool_call_start":
      return {
        idByteLength: Buffer.byteLength(event.id),
        idFingerprint: debugFingerprint(event.id),
        nameByteLength: Buffer.byteLength(event.name),
        nameFingerprint: debugFingerprint(event.name),
      };
    case "web_search_call_begin":
      return { idByteLength: Buffer.byteLength(event.id), idFingerprint: debugFingerprint(event.id) };
    case "web_search_call_end": {
      const queries = JSON.stringify(event.queries);
      return {
        idByteLength: Buffer.byteLength(event.id),
        idFingerprint: debugFingerprint(event.id),
        byteLength: Buffer.byteLength(queries),
        fingerprint: debugFingerprint(queries),
        status: event.status,
      };
    }
    case "error":
      return {
        byteLength: Buffer.byteLength(event.message),
        fingerprint: debugFingerprint(event.message),
        ...(event.status !== undefined ? { status: event.status } : {}),
        ...(event.code !== undefined
          ? { codeByteLength: Buffer.byteLength(event.code), codeFingerprint: debugFingerprint(event.code) }
          : {}),
        ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
      };
    case "incomplete":
      return {
        ...(event.message !== undefined ? { byteLength: Buffer.byteLength(event.message), fingerprint: debugFingerprint(event.message) } : {}),
        reasonByteLength: Buffer.byteLength(event.reason),
        reasonFingerprint: debugFingerprint(event.reason),
        ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
      };
    case "done":
      return {
        ...(event.stopReason !== undefined
          ? { stopReasonByteLength: Buffer.byteLength(event.stopReason), stopReasonFingerprint: debugFingerprint(event.stopReason) }
          : {}),
        ...(event.endTurn !== undefined ? { endTurn: event.endTurn } : {}),
      };
    default:
      return {};
  }
}

/** Emit one adapter-stage diagnostic while preserving one sequence across sidecar iterations. */
export function diagnoseAdapterEvent(context: BridgeDiagnosticContext, event: AdapterEvent): void {
  const sequence = context.sequence ??= { value: 0 };
  debugStreamDiagnostic(
    context,
    "adapter",
    ++sequence.value,
    event.type,
    adapterEventDiagnosticDetails(event),
  );
}

