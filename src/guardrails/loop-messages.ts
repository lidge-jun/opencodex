import type { OcxMessage } from "../types";
import { decideAndRecordGuardrailsLateFailure } from "./late-failure";
import {
  extendGuardrailsTurnText,
  restoreGuardrailsMessages,
  restoreGuardrailsResponsesBody,
  type GuardrailsInboundProtocol,
  type GuardrailsTurn,
} from "./turn";
import {
  recordGuardrailsTurnDelta,
  type GuardrailsTelemetrySurface,
} from "./telemetry";

type GuardrailsLoopSurface = "Media" | "Web-search";

export type GuardrailsLoopPreparationFailure = {
  code: string;
  errorType: "invalid_request_error";
  message: string;
  status: number;
};

export type GuardrailsLoopPreparationResult =
  | { kind: "inactive" }
  | { kind: "protected"; turn: GuardrailsTurn }
  | { kind: "passthrough"; rawBody: unknown }
  | { kind: "blocked"; failure: GuardrailsLoopPreparationFailure };

/**
 * Protect tool results materialized between sidecar iterations. Work is staged
 * on clones so a blocking failure cannot leave a partially masked message list.
 */
export function prepareGuardrailsLoopMessages(input: {
  addedFromIndex: number;
  inboundProtocol: GuardrailsInboundProtocol;
  messages: OcxMessage[];
  passthroughFailure: boolean;
  rawBody: unknown;
  surface: GuardrailsLoopSurface;
  telemetrySurface: GuardrailsTelemetrySurface;
  turn?: GuardrailsTurn;
}): GuardrailsLoopPreparationResult {
  if (!input.turn || input.passthroughFailure) return { kind: "inactive" };

  const nextMessages = structuredClone(input.messages.slice(input.addedFromIndex));
  const passthroughMessages = structuredClone(nextMessages);
  let nextTurn = input.turn;
  const findingCountBeforeLoop = nextTurn.findings.length;
  const guardrailsStartedAt = performance.now();

  try {
    for (const message of nextMessages) {
      if (message.role !== "toolResult") continue;
      if (typeof message.content === "string") {
        const extended = extendGuardrailsTurnText(message.content, nextTurn);
        message.content = extended.text;
        nextTurn = extended.turn;
        continue;
      }
      for (const part of message.content) {
        if (part.type !== "text") continue;
        const extended = extendGuardrailsTurnText(part.text, nextTurn);
        part.text = extended.text;
        nextTurn = extended.turn;
      }
    }
  } catch (error) {
    const decision = decideAndRecordGuardrailsLateFailure({
      error,
      inboundProtocol: input.inboundProtocol,
      latencyMs: performance.now() - guardrailsStartedAt,
      turn: nextTurn,
    });
    if (decision.kind === "passthrough") {
      console.warn(`[opencodex] Guardrails ${input.surface.toLowerCase()} rescan failed in passthrough mode`);
      const restoredPrefix = restoreGuardrailsMessages(
        input.messages.slice(0, input.addedFromIndex),
        nextTurn,
      );
      input.messages.splice(
        0,
        input.messages.length,
        ...restoredPrefix,
        ...passthroughMessages,
      );
      return {
        kind: "passthrough",
        rawBody: restoreGuardrailsResponsesBody(input.rawBody, nextTurn),
      };
    }
    return {
      kind: "blocked",
      failure: {
        status: decision.status,
        code: decision.code,
        errorType: "invalid_request_error",
        message: decision.status === 413
          ? `${input.surface} tool results exceed the Guardrails processing limit`
          : `Guardrails could not safely process ${input.surface.toLowerCase()} tool results`,
      },
    };
  }

  input.messages.splice(
    input.addedFromIndex,
    input.messages.length - input.addedFromIndex,
    ...nextMessages,
  );
  recordGuardrailsTurnDelta(
    input.telemetrySurface,
    nextTurn,
    findingCountBeforeLoop,
    performance.now() - guardrailsStartedAt,
  );
  return { kind: "protected", turn: nextTurn };
}
