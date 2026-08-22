import { describe, expect, test } from "bun:test";
import { createCommandCodeAdapter } from "../src/adapters/command-code";
import { buildResponseJSON } from "../src/bridge";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";

const provider: OcxProviderConfig = {
  adapter: "command-code",
  baseUrl: "https://api.command.example",
  apiKey: "test-key",
};

function ndjsonResponse(lines: unknown[]): Response {
  return new Response(lines.map(l => JSON.stringify(l) + "\n").join(""), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

/**
 * Drives the REAL parser. An earlier suite hand-constructed the downstream error event, so it
 * stayed green while the adapter still emitted a clean `done` — the gap an audit named.
 */
describe("Command Code finishReason error", () => {
  const errorFinish = [
    { type: "text-delta", text: "partial" },
    { type: "finish", finishReason: "error", totalUsage: { inputTokens: 10, outputTokens: 4 } },
  ];

  test("streaming: yields an error terminal, not a done, and keeps usage", async () => {
    const adapter = createCommandCodeAdapter(provider);
    const events: AdapterEvent[] = [];
    for await (const e of adapter.parseStream(ndjsonResponse(errorFinish), createTestTranslatorBudget())) {
      events.push(e);
    }

    const error = events.find(e => e.type === "error") as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined;
    expect(error).toBeDefined();
    expect(events.some(e => e.type === "done")).toBe(false);
    // A failed turn still consumed tokens; dropping usage makes it look free in accounting.
    expect(error?.usage?.inputTokens).toBe(10);
    expect(error?.usage?.outputTokens).toBe(4);
  });

  test("buffered: the turn reports failed and installs no compaction history", async () => {
    const adapter = createCommandCodeAdapter(provider);
    const events = await adapter.parseResponse!(ndjsonResponse(errorFinish), createTestTranslatorBudget()) as AdapterEvent[];
    const json = buildResponseJSON(events, "command-code/model", { compaction: true });

    expect(json.status).toBe("failed");
    expect((json.output as { type: string }[]).some(o => o.type === "compaction")).toBe(false);
  });

  test("an ordinary finish still completes and keeps its usage", async () => {
    const adapter = createCommandCodeAdapter(provider);
    const events: AdapterEvent[] = [];
    for await (const e of adapter.parseStream(ndjsonResponse([
      { type: "text-delta", text: "a whole answer" },
      { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 4 } },
    ]), createTestTranslatorBudget())) events.push(e);

    const done = events.find(e => e.type === "done") as { usage?: { inputTokens?: number } } | undefined;
    expect(done).toBeDefined();
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(done?.usage?.inputTokens).toBe(10);
  });

  test("a length finish is still a truncation, not an error", async () => {
    const adapter = createCommandCodeAdapter(provider);
    const events = await adapter.parseResponse!(ndjsonResponse([
      { type: "text-delta", text: "half a summary" },
      { type: "finish", finishReason: "length", totalUsage: { inputTokens: 10, outputTokens: 4 } },
    ]), createTestTranslatorBudget()) as AdapterEvent[];
    const json = buildResponseJSON(events, "command-code/model", { compaction: true });

    expect(json.status).toBe("incomplete");
    expect((json.output as { type: string }[]).some(o => o.type === "compaction")).toBe(false);
  });
});

