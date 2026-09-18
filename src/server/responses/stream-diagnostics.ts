import { randomUUID } from "node:crypto";
import type { AdapterEvent } from "../../types";
import type { RequestLogContext } from "../request-log";
import { debugStreamDiagnostic } from "../../lib/debug";
import { isDebugEnabled } from "../../lib/debug-settings";
import {
  adapterEventDiagnosticDetails,
  type BridgeDiagnosticContext,
  type BridgeDiagnosticSequence,
} from "../../bridge";
/**
 * Opt-in structural stream diagnostics shared across one request adapter,
 * continuation, sidecar, and bridge stages. Created once per request so every
 * stage appends to a single sequence; absent unless provider debug is on.
 */
export type StreamDiagnostic = {
  context: BridgeDiagnosticContext;
  state: BridgeDiagnosticSequence;
};

export function createStreamDiagnostic(initialAdapterName: string): StreamDiagnostic | undefined {
  if (!isDebugEnabled()) return undefined;
  const state: BridgeDiagnosticSequence = { value: 0 };
  return {
    context: { requestId: randomUUID(), adapterName: initialAdapterName, sequence: state },
    state,
  };
}
/**
 * Wrap an adapter event stream with per-event structural diagnostics.
 * The adapter name resolves lazily at each event so failover rotations that
 * swap the serving adapter mid-stream are attributed to the adapter that
 * actually produced the event, never to a stale capture.
 */
export function diagnoseAdapterEvents(
  events: AsyncIterable<AdapterEvent>,
  getAdapterName: () => string,
  diagnostic: StreamDiagnostic | undefined,
  logCtx: RequestLogContext,
): AsyncIterable<AdapterEvent> {
  if (!diagnostic) return events;
  const { context, state } = diagnostic;
  return (async function* () {
    for await (const event of events) {
      const attempt = logCtx.activeAttempt;
      debugStreamDiagnostic(
        {
          requestId: context.requestId,
          adapterName: getAdapterName(),
          ...(attempt?.ordinal !== undefined ? { attempt: attempt.ordinal } : {}),
          ...(attempt?.recoveryKinds.at(-1) !== undefined ? { recovery: attempt.recoveryKinds.at(-1) } : {}),
        },
        "adapter",
        ++state.value,
        event.type,
        adapterEventDiagnosticDetails(event),
      );
      yield event;
    }
  })();
}
