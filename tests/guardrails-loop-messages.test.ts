import { afterEach, describe, expect, test } from "bun:test";
import { prepareGuardrailsLoopMessages } from "../src/guardrails/loop-messages";
import { clearGuardrailsTelemetryForTests, guardrailsActivity } from "../src/guardrails/telemetry";
import { prepareGuardrailsTurn, type GuardrailsTurn } from "../src/guardrails/turn";
import type { OcxConfig, OcxMessage } from "../src/types";

const INITIAL_SECRET = "sk_live_abcdefghijklmnopqrstuvwx";
const LATE_SECRET = "sk_live_zyxwvutsrqponmlkjihgfedc";

afterEach(() => {
  clearGuardrailsTelemetryForTests();
});

async function activeTurn(
  failurePolicy: "block" | "passthrough",
): Promise<{ masked: string; turn: GuardrailsTurn }> {
  const prepared = await prepareGuardrailsTurn(
    {
      guardrails: {
        enabled: true,
        mode: "enforce",
        failurePolicy,
      },
    } as OcxConfig,
    "responses",
    { input: INITIAL_SECRET },
  );
  if (!prepared.turn) throw new Error("Expected an active Guardrails turn");
  return {
    masked: (prepared.body as { input: string }).input,
    turn: prepared.turn,
  };
}

function loopMessages(maskedPrefix: string, lateText: string): OcxMessage[] {
  return [
    { role: "user", content: maskedPrefix, timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: LATE_SECRET }], timestamp: 2 },
    {
      role: "toolResult",
      toolCallId: "call-1",
      content: lateText,
      timestamp: 3,
    },
  ];
}

describe("Guardrails sidecar loop preparation", () => {
  test("masks only newly materialized tool results and records their finding delta", async () => {
    const { masked, turn } = await activeTurn("block");
    const messages = loopMessages(masked, LATE_SECRET);

    const result = prepareGuardrailsLoopMessages({
      addedFromIndex: 1,
      inboundProtocol: "responses",
      messages,
      passthroughFailure: false,
      rawBody: { input: masked },
      surface: "Web-search",
      telemetrySurface: "responses",
      turn,
    });

    expect(result.kind).toBe("protected");
    expect(messages[0]?.content).toBe(masked);
    expect(messages[1]?.content).toEqual([{ type: "text", text: LATE_SECRET }]);
    expect(messages[2]?.content).toMatch(/^<STRIPE_ACCESS_TOKEN_\d+>$/);
    expect(guardrailsActivity({ result: "masked" }).filteredSummary.findingCount).toBe(1);
  });

  test("restores the whole staged turn after a passthrough capacity failure", async () => {
    const { masked, turn } = await activeTurn("passthrough");
    const oversized = "x".repeat(128 * 1024 + 1);
    const messages = loopMessages(masked, oversized);

    const result = prepareGuardrailsLoopMessages({
      addedFromIndex: 1,
      inboundProtocol: "responses",
      messages,
      passthroughFailure: false,
      rawBody: { input: masked },
      surface: "Media",
      telemetrySurface: "responses",
      turn,
    });

    expect(result).toEqual({
      kind: "passthrough",
      rawBody: { input: INITIAL_SECRET },
    });
    expect(messages[0]?.content).toBe(INITIAL_SECRET);
    expect(messages[2]?.content).toBe(oversized);
    expect(guardrailsActivity({ result: "passthrough" }).filteredSummary.eventCount).toBe(1);
  });

  test("keeps the caller messages untouched and returns a blocking failure", async () => {
    const { masked, turn } = await activeTurn("block");
    const oversized = "x".repeat(128 * 1024 + 1);
    const messages = loopMessages(masked, oversized);
    const before = structuredClone(messages);

    const result = prepareGuardrailsLoopMessages({
      addedFromIndex: 1,
      inboundProtocol: "responses",
      messages,
      passthroughFailure: false,
      rawBody: { input: masked },
      surface: "Media",
      telemetrySurface: "responses",
      turn,
    });

    expect(result).toEqual({
      kind: "blocked",
      failure: {
        status: 413,
        code: "guardrails_capacity_exceeded",
        errorType: "invalid_request_error",
        message: "Media tool results exceed the Guardrails processing limit",
      },
    });
    expect(messages).toEqual(before);
    expect(guardrailsActivity({ result: "blocked" }).filteredSummary.eventCount).toBe(1);
  });
});
