import {
  guardrailsFailureCode,
  guardrailsFailureStatus,
  type GuardrailsInboundProtocol,
  type GuardrailsTurn,
} from "./turn";
import {
  recordGuardrailsEvent,
  type GuardrailsTelemetrySurface,
} from "./telemetry";

export type GuardrailsLateFailureDecision =
  | {
      kind: "block";
      code: "guardrails_capacity_exceeded" | "guardrails_scan_failed";
      status: 400 | 413;
    }
  | {
      kind: "passthrough";
    };

function telemetrySurface(
  inboundProtocol: GuardrailsInboundProtocol,
): GuardrailsTelemetrySurface {
  if (inboundProtocol === "chat") return "chat";
  if (inboundProtocol === "anthropic") return "messages";
  return "responses";
}

/**
 * Apply the immutable turn policy to a late Guardrails failure and emit one
 * bounded metadata-only event. Raw errors and request text never enter telemetry.
 */
export function decideAndRecordGuardrailsLateFailure(input: {
  allowPassthrough?: boolean;
  error: unknown;
  inboundProtocol: GuardrailsInboundProtocol;
  latencyMs: number;
  turn: GuardrailsTurn;
}): GuardrailsLateFailureDecision {
  const passthrough = input.allowPassthrough !== false
    && input.turn.snapshot.failurePolicy === "passthrough";
  recordGuardrailsEvent({
    surface: telemetrySurface(input.inboundProtocol),
    mode: input.turn.mode,
    result: passthrough ? "passthrough" : "blocked",
    registryGeneration: input.turn.snapshot.generation,
    count: 1,
    categoryIds: [],
    ruleIds: [],
    latencyMs: input.latencyMs,
    severity: passthrough ? "high" : "warning",
  });

  if (passthrough) return { kind: "passthrough" };
  return {
    kind: "block",
    code: guardrailsFailureCode(input.error),
    status: guardrailsFailureStatus(input.error),
  };
}
