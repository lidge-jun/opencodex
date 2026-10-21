import { describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { responsesUsage } from "../../../src/bridge/internal";
import { cacheObservationFromUsage } from "../../../src/usage/summary";
import type { AdapterEvent, OcxUsage } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const adapter = () => withTestTranslatorBudget(createAnthropicAdapter({
  adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "fixture-key",
}));
function terminal(events: AdapterEvent[]): OcxUsage | undefined {
  const event = events.find(event => event.type === "done");
  return event?.type === "done" ? event.usage : undefined;
}
for (const stream of [false, true]) describe(`Anthropic ${stream ? "SSE" : "JSON"} raw cache presence`, () => {
  for (const read of [undefined, 0, 4, 40]) test(`reads ${read ?? "absent"} with ten writes stay distinct`, async () => {
    const usage = { input_tokens: 50, output_tokens: 2, cache_creation_input_tokens: 10,
      ...(read === undefined ? {} : { cache_read_input_tokens: read }) };
    let events: AdapterEvent[];
    if (stream) {
      const frames = [
        { type: "message_start", message: { usage: { ...usage, output_tokens: 0 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
      events = [];
      for await (const event of adapter().parseStream(new Response(frames))) events.push(event);
    } else {
      events = await adapter().parseResponse!(Response.json({ content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn", usage })) as AdapterEvent[];
    }
    const value = terminal(events)!;
    expect(value.inputTokens).toBe(60 + (read ?? 0));
    expect(value.cacheTelemetry).toEqual({ source: "upstream", usagePresent: true, creation: 10,
      ...(read === undefined ? {} : { read }) });
    expect(cacheObservationFromUsage(value, undefined)).toMatchObject({ read, creation: 10, readObserved: read !== undefined });
    const client = responsesUsage(value);
    expect(JSON.stringify(client)).not.toContain("cacheTelemetry");
    expect(client.input_tokens_details).toMatchObject({ cached_tokens: read ?? 0, cache_write_tokens: 10 });
  });
});
