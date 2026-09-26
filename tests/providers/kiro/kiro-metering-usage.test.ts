import { expect, test } from "bun:test";
import { parseKiroStream } from "../../../src/adapters/kiro";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import { normalizeUsageEntryForTest } from "../../../src/usage/log";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const credit = 0.04582331509121062;
const conversationId = "11111111-1111-4111-8111-111111111111";
const tokens = { uncachedInputTokens: 10, outputTokens: 2, totalTokens: 12 };

async function terminal(frames: Array<[string, unknown]>) {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [type, payload] of frames) {
        controller.enqueue(encodeMessage({ ":message-type": "event", ":event-type": type },
          new TextEncoder().encode(JSON.stringify(payload))));
      }
      controller.close();
    },
  }));
  const events = await Array.fromAsync(parseKiroStream(response, createTestTranslatorBudget()));
  const result = events.at(-1);
  if (!result || !("usage" in result)) throw new Error("missing terminal usage");
  return result;
}

test.each([true, false])("credit snapshot survives token metadata (metering first=%s)", async first => {
  const metering: [string, unknown] = ["meteringEvent", { unit: "credit", unitPlural: "credits", usage: credit }];
  const metadata: [string, unknown] = ["metadataEvent", { tokenUsage: tokens }];
  const result = await terminal([
    ["initial-response", { conversationId }],
    ["assistantResponseEvent", { content: "ok" }],
    ...(first ? [metering, metadata] : [metadata, metering]),
  ]);
  expect(result).toMatchObject({ type: "done", usage: { providerCredits: credit, inputTokens: 10, outputTokens: 2 },
    providerState: { kiro: { conversationId } } });
  const persisted = normalizeUsageEntryForTest({ requestId: "metering", timestamp: 1, provider: "kiro",
    model: "test", status: 200, durationMs: 1, usageStatus: "reported", usage: result.usage });
  expect(persisted.usage?.providerCredits).toBe(credit);
});

test("repeated per-request readings replace the prior snapshot, including zero", async () => {
  const result = await terminal([
    ["assistantResponseEvent", { content: "ok" }],
    ["meteringEvent", { unit: "credit", usage: credit }],
    ["meteringEvent", { unit: "credits", amount: 0 }],
  ]);
  expect(result.usage).toMatchObject({ providerCredits: 0, estimated: true });
});

test("unreported credits and other units do not become measured zero", async () => {
  for (const extra of [[], [["meteringEvent", { unit: "token", usage: 10 }]] as Array<[string, unknown]>]) {
    const result = await terminal([["assistantResponseEvent", { content: "ok" }], ...extra]);
    expect(result.usage).not.toHaveProperty("providerCredits");
  }
});

test("a stream error preserves credits already reported", async () => {
  const result = await terminal([
    ["meteringEvent", { unit: "credit", usage: credit }],
    ["error", { message: "upstream failed" }],
  ]);
  expect(result).toMatchObject({ type: "error", usage: { providerCredits: credit } });
});
