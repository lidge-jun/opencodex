import { afterEach, describe, expect, test } from "bun:test";
import { formatErrorResponse } from "../../src/bridge";
import { adapterFailureFromEvent } from "../../src/bridge/internal";
import { devinErrorClassification } from "../../src/adapters/devin";
import { clearCachedCatalog } from "../../src/adapters/devin/cloud-direct/catalog";
import { CloudChatError, streamChatEvents } from "../../src/adapters/devin/cloud-direct/chat";
import {
  clearComboTargetCooldowns, comboFailureCooldownScope, comboFailureDecision,
  coolComboTarget, isComboTargetInCooldown,
} from "../../src/combos/failover";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import type { AdapterEvent } from "../../src/types";

const combo = "quota-code-provenance";
const target = { provider: "devin", model: "swe-2-high" };
const sibling = { provider: "devin", model: "swe-2-low" };
const now = 1_000_000;
const credential = "devin-session-token$fixture.payload.signature";
afterEach(() => clearComboTargetCooldowns(combo));

async function consumeAdapterError(event: Extract<AdapterEvent, { type: "error" }>) {
  const { httpStatus, error } = adapterFailureFromEvent(event);
  // Same child formatter boundary as run-turn-execution, including the original event code.
  return consumeComboFailure(formatErrorResponse(httpStatus, error.type, error.message, {
    code: error.code, classified: true, upstreamCode: event.code ?? null,
  }));
}

async function devinTrailer(code: string, message: string): Promise<CloudChatError> {
  const trailer = Buffer.from(JSON.stringify({ error: { code, message: `${message} ${credential}` } }));
  const envelope = Buffer.alloc(5 + trailer.length);
  envelope[0] = 0x02;
  envelope.writeUInt32BE(trailer.length, 1);
  trailer.copy(envelope, 5);
  const originalFetch = globalThis.fetch;
  clearCachedCatalog();
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 1
    ? new Response("catalog unavailable", { status: 503 })
    : new Response(envelope, { status: 200 })) as typeof fetch;
  try {
    try {
      for await (const _ of streamChatEvents({
        apiKey: credential, modelUid: target.model, messages: [{ role: "user", content: "hi" }],
      })) { /* trailer-only stream */ }
    } catch (error) {
      expect(error).toBeInstanceOf(CloudChatError);
      return error as CloudChatError;
    }
    throw new Error("expected a trailer refusal");
  } finally {
    globalThis.fetch = originalFetch;
    clearCachedCatalog();
  }
}

async function consumeDevin(error: CloudChatError) {
  return consumeAdapterError({
    type: "error", code: error.code, ...devinErrorClassification(error),
    message: `Devin cloud error${error.code ? ` ${error.code}` : ""}: ${error.message}`,
  });
}

describe("quota evidence through child formatting and combo consumption", () => {
  test("R1: a real Devin weekly window hops, cools only the target for ten minutes, and redacts", async () => {
    const error = await devinTrailer("failed_precondition", "Your weekly usage quota has been exhausted.");
    const failure = await consumeDevin(error);
    expect(failure.response.status).toBe(429);
    expect(comboFailureDecision(429, failure.classificationText, { code: failure.upstreamCode })).toBe("hop");
    expect(comboFailureCooldownScope(429, failure.classificationText, { code: failure.upstreamCode })).toBe("target");
    coolComboTarget(combo, target, { now, status: 429, code: failure.upstreamCode, message: failure.classificationText });
    expect(isComboTargetInCooldown(combo, target, now + 599_999)).toBe(true);
    expect(isComboTargetInCooldown(combo, target, now + 600_000)).toBe(false);
    expect(isComboTargetInCooldown(combo, sibling, now)).toBe(false);
    const body = await failure.response.text();
    expect(body).not.toContain(credential);
    expect(body).not.toContain("Your weekly usage quota");
  });

  for (const message of [
    "Your monthly quota is exhausted", "Your daily usage quota has been exhausted",
    "Your usage window is exhausted", "Usage limit reached", "Out of credits",
  ]) {
    test(`explicit Devin spent-window evidence retains target scope: ${message}`, async () => {
      const failure = await consumeDevin(await devinTrailer("failed_precondition", message));
      expect(failure.response.status).toBe(429);
      expect(comboFailureDecision(429, failure.classificationText, { code: failure.upstreamCode })).toBe("hop");
      expect(comboFailureCooldownScope(429, failure.classificationText, { code: failure.upstreamCode })).toBe("target");
      coolComboTarget(combo, target, { now, status: 429, code: failure.upstreamCode, message: failure.classificationText });
      expect(isComboTargetInCooldown(combo, target, now + 599_999)).toBe(true);
      expect(isComboTargetInCooldown(combo, target, now + 600_000)).toBe(false);
    });
  }

  for (const status of [400, 422]) {
    for (const phrase of ["weekly usage quota exceeded", "quota exhausted", "quota has been exhausted", "insufficient_quota"]) {
      test(`R2: HTTP ${status} reflected '${phrase}' never supplies structured exhaustion`, async () => {
        const failure = await consumeAdapterError({
          type: "error", status, message: `Invalid parameter: value quotes '${phrase}'`,
        });
        expect(failure.response.status).toBe(status);
        expect(failure.upstreamCode).not.toBe("insufficient_quota");
        expect(comboFailureDecision(status, failure.classificationText, { code: failure.upstreamCode })).toBe("stop");
        expect(comboFailureCooldownScope(status, failure.classificationText, { code: failure.upstreamCode })).not.toBe("provider");
        coolComboTarget(combo, target, { now, status, code: failure.upstreamCode, message: failure.classificationText });
        expect(isComboTargetInCooldown(combo, target, now + 60_000)).toBe(false);
      });
    }
    test(`R2: HTTP ${status} unclassified formatter prose cannot mint upstream quota evidence`, async () => {
      const failure = await consumeComboFailure(formatErrorResponse(status, "upstream_error", "Invalid value: quota exhausted"));
      expect(comboFailureDecision(status, failure.classificationText, { code: failure.upstreamCode })).toBe("stop");
      expect(comboFailureCooldownScope(status, failure.classificationText, { code: failure.upstreamCode })).not.toBe("provider");
    });
    for (const code of ["usage_limit_exceeded", "usage_limit_reached", "1308", "insufficient_quota"]) {
      test(`HTTP ${status} genuine upstream ${code} still authorizes a hop`, async () => {
        const failure = await consumeAdapterError({ type: "error", status, code, message: "Account window spent" });
        expect(failure.upstreamCode).toBe(code);
        expect(comboFailureDecision(status, failure.classificationText, { code: failure.upstreamCode })).toBe("hop");
      });
    }
  }

  test("R2: a real Devin invalid_argument reflecting weekly quota text stops", async () => {
    const error = await devinTrailer("invalid_argument", "Invalid value: Your weekly usage quota has been exhausted");
    const failure = await consumeDevin(error);
    expect(failure.response.status).toBe(400);
    expect(comboFailureDecision(400, failure.classificationText, { code: failure.upstreamCode })).toBe("stop");
    expect(comboFailureCooldownScope(400, failure.classificationText, { code: failure.upstreamCode })).not.toBe("provider");
  });

  for (const message of [
    "per-minute quota is exhausted for this tool",
    "per-minute quota has been exhausted for this tool",
    "per-hour quota is exhausted for this tool",
    "quota has been exhausted for this tool",
    "per-minute usage quota is exhausted for this tool",
    "usage limit reached for requests per minute",
    "weekly quota is exhausted by a rate limit",
  ]) {
    test(`R3: transient or unqualified precondition stays 400: ${message}`, async () => {
      const error = await devinTrailer("failed_precondition", message);
      const failure = await consumeDevin(error);
      expect(error.status).toBe(400);
      expect(error.message).not.toContain("usage limit reached");
      expect(failure.response.status).toBe(400);
      expect(comboFailureDecision(400, failure.classificationText, { code: failure.upstreamCode })).toBe("stop");
    });
  }

  test("MCP configuration preconditions remain redacted 400 stops", async () => {
    const failure = await consumeDevin(await devinTrailer("failed_precondition", "Unable to process request due to an MCP configuration issue"));
    expect(failure.response.status).toBe(400);
    expect(comboFailureDecision(400, failure.classificationText, { code: failure.upstreamCode })).toBe("stop");
    expect(await failure.response.text()).not.toContain(credential);
  });
});
