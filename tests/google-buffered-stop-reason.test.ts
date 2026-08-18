import { describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import { buildResponseJSON } from "../src/bridge";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const provider: OcxProviderConfig = {
  adapter: "google",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey: "test-key",
};

function geminiResponse(finishReason: string, text = "half a summary"): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  }), { status: 200 });
}

describe("Google buffered parseResponse carries its stop reason", () => {
  // The streaming path already mapped MAX_TOKENS to stopReason "max_tokens"; parseResponse
  // emitted a clean `done`. The bridge therefore reported a truncated buffered turn as
  // completed — and on a compaction turn installed the half-written summary as replacement
  // history, the #422 hazard.
  test("MAX_TOKENS becomes stopReason max_tokens", async () => {
    const adapter = createGoogleAdapter(provider);
    const events = await adapter.parseResponse!(geminiResponse("MAX_TOKENS")) as AdapterEvent[];
    const done = events.find(e => e.type === "done") as { stopReason?: string } | undefined;

    expect(done).toBeDefined();
    expect(done?.stopReason).toBe("max_tokens");
  });

  test("a safety finish reason becomes stopReason content_filter", async () => {
    const adapter = createGoogleAdapter(provider);
    const events = await adapter.parseResponse!(geminiResponse("SAFETY")) as AdapterEvent[];
    const done = events.find(e => e.type === "done") as { stopReason?: string } | undefined;

    expect(done?.stopReason).toBe("content_filter");
  });

  test("a normal STOP carries no stop reason", async () => {
    const adapter = createGoogleAdapter(provider);
    const events = await adapter.parseResponse!(geminiResponse("STOP", "a whole answer")) as AdapterEvent[];
    const done = events.find(e => e.type === "done") as { stopReason?: string } | undefined;

    expect(done).toBeDefined();
    expect(done?.stopReason).toBeUndefined();
  });

  test("a truncated buffered compaction turn installs no replacement history", async () => {
    const adapter = createGoogleAdapter(provider);
    const events = await adapter.parseResponse!(geminiResponse("MAX_TOKENS")) as AdapterEvent[];
    const json = buildResponseJSON(events, "google/gemini-3-pro", { compaction: true });

    expect(json.status).toBe("incomplete");
    expect((json.output as { type: string }[]).some(o => o.type === "compaction")).toBe(false);
  });
});
