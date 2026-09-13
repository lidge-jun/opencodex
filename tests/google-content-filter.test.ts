import { test, expect } from "bun:test";
import { createGoogleAdapter } from "/Users/vanch/Documents/Codex/2026-08-05/https-github-com-lidge-jun-opencodex/outputs/upgrade-2.51.0/merged/src/adapters/google";
import { createTranslatorBudget } from "/Users/vanch/Documents/Codex/2026-08-05/https-github-com-lidge-jun-opencodex/outputs/upgrade-2.51.0/merged/src/lib/translator-budget";
import { bridgeToResponsesSSE, buildResponseJSON } from "/Users/vanch/Documents/Codex/2026-08-05/https-github-com-lidge-jun-opencodex/outputs/upgrade-2.51.0/merged/src/bridge";
import { httpStatusFromTerminalError } from "/Users/vanch/Documents/Codex/2026-08-05/https-github-com-lidge-jun-opencodex/outputs/upgrade-2.51.0/merged/src/lib/errors";

const provider = { name: "google-antigravity", adapter: "google", baseUrl: "http://invalid.local", googleMode: "cloud-code-assist", models: [] } as const;
const usage = { promptTokenCount: 123, candidatesTokenCount: 2, thoughtsTokenCount: 4 };
const refusal = "The prompt could not be submitted. The prompt contains sensitive words that violate Google's [Generative AI Prohibited Use policy](https://policies.google.com/terms/generative-ai/use-policy). Try rephrasing the prompt. If you think this was an error, [send feedback](https://ai.google.dev/gemini-api/docs/troubleshooting).";
async function parse(frames: object[], stream = true) {
  const adapter = createGoogleAdapter(provider as any);
  const budget = createTranslatorBudget();
  try {
    const events = [];
    if (stream) {
      const response = new Response(frames.map(response => `data: ${JSON.stringify({ response })}\n\n`).join(""));
      for await (const event of adapter.parseStream(response, budget)) {
        if (event.type !== "heartbeat") events.push(event);
      }
      return events;
    }
    return await adapter.parseResponse!(Response.json({ response: frames[0] }), budget);
  } finally {
    budget.dispose();
  }
}

for (const stream of [true, false]) {
  for (const reason of ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"]) {
    test(`${stream ? "SSE" : "JSON"}: ${reason} is explicit, non-retryable, retains usage`, async () => {
      const events = await parse([{ candidates: [{ finishReason: reason }], usageMetadata: usage }], stream);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", status: 400, code: "invalid_prompt", errorType: "invalid_request_error", retryable: false, usage: { inputTokens: 123, outputTokens: 2 } });
      expect((events[0] as any).message).toContain(`finishReason=${reason}`);
      const wire = buildResponseJSON(events, "gemini-3.8-flash");
      expect(wire.status).toBe("failed");
      expect(wire.retryable).toBe(false);
      expect(httpStatusFromTerminalError(wire.error as any)).toBe(400);
    });
  }
  test(`${stream ? "SSE" : "JSON"}: prompt block does not become empty-completion`, async () => {
    const events = await parse([{ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: usage }], stream);
    expect(events[0]).toMatchObject({ type: "error", code: "invalid_prompt", retryable: false });
    expect((events[0] as any).message).toContain("promptFeedback.blockReason=SAFETY");
  });
  test(`${stream ? "SSE" : "JSON"}: blocked frame cannot emit a tool call or blocked text`, async () => {
    const events = await parse([{ candidates: [{ finishReason: "SAFETY", finishMessage: "sensitive upstream text", content: { parts: [{ text: "blocked output" }, { functionCall: { name: "exec", args: {} } }] } }] }], stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(JSON.stringify(events)).not.toContain("sensitive upstream text");
    expect(JSON.stringify(events)).not.toContain("blocked output");
  });
  test(`${stream ? "SSE" : "JSON"}: normal stop and token limit keep existing semantics`, async () => {
    for (const reason of ["STOP", "MAX_TOKENS"]) {
      const events = await parse([{ candidates: [{ finishReason: reason, content: { parts: [{ text: "OK" }] } }], usageMetadata: usage }], stream);
      const wire = buildResponseJSON(events, "gemini-3.8-flash");
      expect(wire.status).toBe(reason === "STOP" ? "completed" : "incomplete");
      if (reason === "MAX_TOKENS") expect(wire.incomplete_details).toEqual({ reason: "max_output_tokens" });
    }
  });
  test(`${stream ? "SSE" : "JSON"}: malformed tool generation stays distinct from content filtering`, async () => {
    const events = await parse([{ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] }], stream);
    expect(events[0].type).toBe("error");
    expect((events[0] as any).message).toContain("MALFORMED_FUNCTION_CALL");
    expect((events[0] as any).code).not.toBe("invalid_prompt");
  });
}

test("SSE: trailing usage survives filtering, bridge fails once without caching a compaction", async () => {
  const events = await parse([
    { candidates: [{ content: { parts: [{ text: "Checking progress" }] } }] },
    { candidates: [{ finishReason: "RECITATION" }] },
    { usageMetadata: usage },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "error", retryable: false, usage: { inputTokens: 123 } });
  let cached = false;
  const body = bridgeToResponsesSSE((async function* () { yield* events; })(), "gemini-3.8-flash", undefined, undefined, undefined, undefined, 2000, { compaction: true, onCompletedResponse: () => { cached = true; } });
  const wire = await new Response(body).text();
  expect(wire).toContain("event: response.failed");
  expect(wire).toContain('"retryable":false');
  expect(wire).not.toContain("event: response.incomplete");
  expect(wire).not.toContain("event: response.completed");
  expect(wire).not.toContain('"type":"compaction"');
  expect(cached).toBe(false);
});

test("SSE: exact split text policy refusal at EOF is terminal, not a reconnect", async () => {
  const events = await parse([refusal.slice(0, 55), refusal.slice(55)].map(text => ({ candidates: [{ content: { parts: [{ text }] } }] })));
  expect(events.at(-1)).toMatchObject({ type: "error", code: "invalid_prompt", retryable: false });
  expect((events.at(-1) as any).message).toContain("No structured filter category");
});

test("SSE: ordinary EOF, quoted refusal and oversized output remain transport errors", async () => {
  for (const text of ["A normal partial answer", `Example: ${refusal}`, "x".repeat(1100) + refusal]) {
    const events = await parse([{ candidates: [{ content: { parts: [{ text }] } }] }]);
    expect((events.at(-1) as any).message).toContain("without a terminal signal");
    expect((events.at(-1) as any).code).not.toBe("invalid_prompt");
  }
});

test("SSE: completed text and tool-containing EOF are never text-matched as policy", async () => {
  const complete = await parse([{ candidates: [{ finishReason: "STOP", content: { parts: [{ text: refusal }] } }] }]);
  expect(complete.at(-1)?.type).toBe("done");
  const tool = await parse([{ candidates: [{ content: { parts: [{ text: refusal }, { functionCall: { name: "exec", args: {} } }] } }] }]);
  expect((tool.at(-1) as any).code).not.toBe("invalid_prompt");
});
