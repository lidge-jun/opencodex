import { expect, spyOn, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../../src/bridge";
import { parseRequest } from "../../../src/responses/parser";
import { decodeReasoningEnvelope } from "../../../src/responses/reasoning-envelope";
import { decodeCompactionSummary } from "../../../src/responses/compaction";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";
import { collectAnthropicMessage, responsesJsonToAnthropicMessage, responsesSseToAnthropicSse } from "../../../src/claude/outbound";
import { buildContinuationRequest } from "../../../src/server/responses/terminal-guard";
import { runWithWebSearch } from "../../../src/web-search/loop";
import type { AdapterEvent } from "../../../src/types";

const provider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "synthetic" };
const model = "anthropic/claude-opus-5-5";
const update = { type: "thinking", thinking: "Confirmed. This is a one-time upload.\nContinuing.", signature: "SyntheticProgressSignature123456==" };
const empty = { type: "thinking", thinking: "", signature: "SyntheticReasoningSignature123456==" };
const redacted = { type: "redacted_thinking", data: "synthetic-opaque" };
const tool = { type: "tool_use", id: "toolu_lookup", name: "lookup", input: { q: "x" } };

for (const authMode of ["key", "oauth"] as const) {
  for (const summary of ["concise", "detailed"] as const) {
    for (const effort of [undefined, "high", "none"]) {
      test(`${authMode}: explicit ${summary} summary with effort ${effort ?? "omitted"} opts out of updates`, async () => {
        const adapter = createAnthropicAdapter({ ...provider, authMode });
        const request = await adapter.buildRequest(parseRequest({ model, input: "question", reasoning: { effort, summary } }));
        const body = JSON.parse(request.body as string);
        expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
        expect(body.output_config?.effort).toBe(effort === "high" ? "high" : undefined);
        const beta = new Headers(request.headers).get("anthropic-beta") ?? "";
        expect(beta).not.toContain("thinking-display-updates-2026-08-18");
        if (authMode === "oauth") expect(beta).toContain("oauth-2025-04-20");
      });
    }
  }
  for (const reasoning of [undefined, {}, { effort: "high" }, { summary: "auto" }, { effort: "high", summary: "auto" }, { summary: "none" }, { effort: "none", summary: "none" }]) {
    test(`${authMode}: absent summary opt-in preserves updates for ${JSON.stringify(reasoning)}`, async () => {
      const adapter = createAnthropicAdapter({ ...provider, authMode });
      const request = await adapter.buildRequest(parseRequest({ model, input: "question", reasoning }));
      expect(JSON.parse(request.body as string).thinking).toEqual({ type: "adaptive", display: "updates" });
      expect(new Headers(request.headers).get("anthropic-beta")).toContain("thinking-display-updates-2026-08-18");
    });
  }
  test(`${authMode}: reused adapter follows each request's display and preserves local summary hiding`, async () => {
    const adapter = withTestTranslatorBudget(createAnthropicAdapter({ ...provider, authMode }, "none"));
    for (const summary of [undefined, "detailed", undefined, "auto", "none", "concise"]) {
      const parsed = parseRequest({ model, input: "question", reasoning: { effort: "high", summary } });
      // A local presentation preference alone must not opt into summarized upstream display.
      parsed.options.hideThinkingSummary = true;
      const request = await adapter.buildRequest(parsed);
      const updates = summary === undefined || summary === "none" || summary === "auto";
      expect(JSON.parse(request.body as string).thinking).toEqual({ type: "adaptive", display: updates ? "updates" : "summarized" });
      expect((new Headers(request.headers).get("anthropic-beta") ?? "").includes("thinking-display-updates-2026-08-18")).toBe(updates);
      const events = await adapter.parseResponse!(new Response(JSON.stringify({ content: [update], stop_reason: "end_turn" })));
      expect(events.some(event => event.type === "text_delta")).toBe(updates);
      const response = buildResponseJSON(events, model, { hideThinkingSummary: parsed.options.hideThinkingSummary });
      if (!updates) expect((response.output as { summary: unknown[] }[])[0]!.summary).toEqual([]);
      // Cross-protocol presentation masks locally hidden summaries; native replay retains them.
      expect(responsesJsonToAnthropicMessage(response, model).content).toEqual([{ ...update, thinking: updates ? update.thinking : "" }]);
      const replay = await adapter.buildRequest(parseRequest({ model, input: response.output }));
      expect(JSON.parse(replay.body as string).messages[0].content).toEqual([update]);
    }
  });
}

for (const streaming of [false, true]) {
  test(`${streaming ? "SSE" : "JSON"}: explicit summary retains signed thinking as reasoning`, async () => {
    const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider, "none"));
    await adapter.buildRequest(parseRequest({ model, input: "question", reasoning: { summary: "detailed", effort: "high" } }));
    const events: AdapterEvent[] = [];
    if (streaming) {
      const wire = frame("message_start", { message: { content: [] } })
        + frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } })
        + frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: update.thinking } })
        + frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: update.signature } })
        + frame("content_block_stop", { index: 0 })
        + frame("message_delta", { delta: { stop_reason: "end_turn" } }) + frame("message_stop");
      for await (const event of adapter.parseStream(new Response(wire))) events.push(event);
    } else {
      events.push(...await adapter.parseResponse!(new Response(JSON.stringify({ content: [update], stop_reason: "end_turn" }))));
    }
    expect(events).toContainEqual({ type: "thinking_delta", thinking: update.thinking });
    expect(events).toContainEqual({ type: "thinking_signature", signature: update.signature });
    expect(events.some(event => event.type === "text_delta")).toBe(false);
    const response = buildResponseJSON(events, model);
    expect((response.output as { type: string }[]).every(item => item.type === "reasoning")).toBe(true);
    expect(responsesJsonToAnthropicMessage(response, model).content).toEqual([update]);
  });
}

function frame(type: string, data: object = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

async function eventsFor(blocks: Record<string, unknown>[], streaming: boolean, baseUrl = provider.baseUrl) {
  const adapter = withTestTranslatorBudget(createAnthropicAdapter({ ...provider, baseUrl }, "none"));
  const request = await adapter.buildRequest(parseRequest({ model, input: "question", reasoning: { effort: "high" } }));
  const events: AdapterEvent[] = [];
  let wireResponse: Response | undefined;
  if (streaming) {
    const frames = blocks.flatMap((block, index) => [
      frame("content_block_start", { index, content_block: block.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : block }),
      ...(block.type === "thinking" ? [
        frame("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } }),
        frame("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } }),
      ] : block.type === "tool_use" ? [frame("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } })]
        : block.type === "text" ? [frame("content_block_delta", { index, delta: { type: "text_delta", text: block.text } })] : []),
      frame("content_block_stop", { index }),
    ]);
    frames.push(frame("message_delta", { delta: { stop_reason: "tool_use" } }), frame("message_stop"));
    wireResponse = new Response(frame("message_start", { message: { content: [] } }) + frames.join(""));
    for await (const event of adapter.parseStream(wireResponse.clone())) events.push(event);
  } else {
    events.push(...await adapter.parseResponse!(new Response(JSON.stringify({ content: blocks, stop_reason: "tool_use" }))));
  }
  return { adapter, request, events, wireResponse };
}

for (const streaming of [false, true]) {
  test(`${streaming ? "SSE" : "JSON"}: documented updates surface commentary and replay original signed blocks`, async () => {
    const blocks = [empty, redacted, update, tool, { ...empty, signature: "OtherSyntheticReasoningSignature123456==" }, { ...update, thinking: "Next update.", signature: "OtherSyntheticProgressSignature123456==" }, { ...tool, id: "toolu_second" }];
    const { adapter, request, events } = await eventsFor(blocks, streaming);
    expect(JSON.parse(request.body as string).thinking).toEqual({ type: "adaptive", display: "updates" });
    expect(new Headers(request.headers).get("anthropic-beta")).toContain("thinking-display-updates-2026-08-18");
    const outputs: Record<string, unknown>[][] = [];
    for (const hideThinkingSummary of [false, true]) {
      const body = buildResponseJSON(events, model, { hideThinkingSummary });
      outputs.push(body.output as Record<string, unknown>[]);
      expect(responsesJsonToAnthropicMessage(body, model).content).toEqual(blocks);
      async function* source() { yield* events; }
      const sse = await new Response(bridgeToResponsesSSE(source(), model, undefined, undefined, undefined, undefined, 2000, { hideThinkingSummary })).text();
      const frames = sse.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      outputs.push(frames.filter(f => f.type === "response.output_item.done").map(f => f.item));
      expect(frames.some(f => f.type === "response.output_text.delta" && f.delta === update.thinking)).toBe(true);
      const budget = createTestTranslatorBudget();
      const original = await collectAnthropicMessage(responsesSseToAnthropicSse(new Response(sse).body!, model, { translatorBudget: budget }), model, budget);
      expect(original.content).toEqual(blocks);
    }
    for (const output of outputs) {
      expect(output.filter(item => item.type === "message")).toEqual([
        expect.objectContaining({ phase: "commentary", content: [{ type: "output_text", text: update.thinking, annotations: [] }] }),
        expect.objectContaining({ phase: "commentary", content: [{ type: "output_text", text: "Next update.", annotations: [] }] }),
      ]);
      const carrier = output.find(item => decodeReasoningEnvelope(String(item.encrypted_content))?.sig === update.signature)!;
      expect(carrier.summary).toEqual([]);
      expect(decodeReasoningEnvelope(String(carrier.encrypted_content))?.txt).toBe(update.thinking);
      const replay = await adapter.buildRequest(parseRequest({ model, input: [
        { role: "user", content: "question" }, ...output,
        { type: "function_call_output", call_id: tool.id, output: "result" },
      ] }));
      expect(JSON.parse(replay.body as string).messages[1].content).toEqual(blocks);
      const withoutIds = output.map(({ id, ...item }) => item);
      const idless = await adapter.buildRequest(parseRequest({ model, input: withoutIds }));
      expect(JSON.parse(idless.body as string).messages[0].content).toEqual(blocks);
    }
  });

  test(`${streaming ? "SSE" : "JSON"}: compatible endpoint does not guess a narration subtype`, async () => {
    const { request, events } = await eventsFor([update, tool], streaming, "https://compatible.invalid");
    expect(JSON.parse(request.body as string).thinking.display).toBe("summarized");
    expect(new Headers(request.headers).get("anthropic-beta")).toBeNull();
    expect(events.some(e => e.type === "text_delta")).toBe(false);
  });
}


test("OAuth betas survive, hidden summaries still allow updates, and old models stay summarized", async () => {
  const adapter = withTestTranslatorBudget(createAnthropicAdapter({ ...provider, authMode: "oauth" }));
  for (const effort of ["high", "none"]) {
    const parsed = parseRequest({ model, input: "question", reasoning: { effort } });
    parsed.options.hideThinkingSummary = true;
    const request = await adapter.buildRequest(parsed);
    expect(JSON.parse(request.body as string).thinking).toEqual({ type: "adaptive", display: "updates" });
    const beta = new Headers(request.headers).get("anthropic-beta")!;
    expect(beta).toContain("oauth-2025-04-20");
    expect(beta).toContain("thinking-display-updates-2026-08-18");
  }
  const old = await adapter.buildRequest(parseRequest({ model: "anthropic/claude-opus-4-8", input: "question", reasoning: { effort: "high" } }));
  expect(JSON.parse(old.body as string).thinking.display).toBe("summarized");
  expect(new Headers(old.headers).get("anthropic-beta")).not.toContain("thinking-display-updates");
});

test("edited commentary is retained and never mistaken for the original signed block", async () => {
  const { events } = await eventsFor([update, tool], false);
  const output = buildResponseJSON(events, model).output as Record<string, unknown>[];
  const edited = output.map(item => item.type === "message" ? { ...item, content: [{ type: "output_text", text: "edited" }] } : item);
  const parsed = parseRequest({ model, input: edited });
  expect(parsed.context.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "text" && part.text === "edited"))).toBe(true);
});

for (const streaming of [false, true]) {
  test(`${streaming ? "SSE" : "JSON"}: compaction excludes signed progress from output and checkpoint text`, async () => {
    const { events } = await eventsFor([update, { type: "text", text: "Checkpoint summary." }], streaming);
    let output: { type: string; encrypted_content: string }[];
    if (streaming) {
      async function* source() { yield* events; }
      const sse = await new Response(bridgeToResponsesSSE(source(), model, undefined, undefined, undefined, undefined, 2000, { compaction: true })).text();
      const frames = sse.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      expect(frames.some(f => f.type === "response.output_text.delta")).toBe(false);
      output = frames.find(f => f.type === "response.completed").response.output;
      expect(frames.filter(f => f.type === "response.output_item.done").map(f => f.item.type)).toEqual(["compaction"]);
    } else {
      output = buildResponseJSON(events, model, { compaction: true }).output as typeof output;
    }
    expect(output.map(item => item.type)).toEqual(["compaction"]);
    expect(decodeCompactionSummary(output[0]!.encrypted_content)).toBe("Checkpoint summary.");
  });
}

test("buffered progress releases its reservation when the consumer cancels", async () => {
  const budget = createTestTranslatorBudget();
  const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider));
  await adapter.buildRequest(parseRequest({ model, input: "question", reasoning: { effort: "high" } }));
  const source = adapter.parseStream(new Response([
    frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: update.thinking } }),
    ": ping\n\n", frame("message_stop"),
  ].join("")), budget);
  expect((await source.next()).value?.type).toBe("heartbeat");
  expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
  await source.return(undefined);
  expect(budget.snapshot().currentBytes).toBe(0);
});


test("signature updates replace across heartbeats without manufacturing a second progress block", async () => {
  const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider));
  await adapter.buildRequest(parseRequest({ model, input: "question", reasoning: { effort: "high" } }));
  const frames = [
    frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: update.thinking } }),
    frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "OldSyntheticSignature123456==" } }),
    ": ping\n\n",
    frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: update.signature } }),
    frame("content_block_stop", { index: 0 }), frame("message_stop"),
  ];
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(new Response(frames.join("")))) events.push(event);
  expect(events.filter(event => event.type === "text_delta")).toEqual([
    { type: "text_delta", text: update.thinking, phase: "commentary", anthropicThinkingSignature: update.signature },
  ]);
});

test("large updates obey the translator limit and clean up after overflow", async () => {
  const adapter = withTestTranslatorBudget(createAnthropicAdapter(provider));
  await adapter.buildRequest(parseRequest({ model, input: "question", reasoning: { effort: "high" } }));
  const budget = createTestTranslatorBudget({ maxTurnBytes: 4096 });
  const response = new Response([
    frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    ...Array.from({ length: 20 }, () => frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "x".repeat(500) } })),
    frame("message_stop"),
  ].join(""));
  let failed = false;
  try { for await (const event of adapter.parseStream(response, budget)) if (event.type === "error") failed = true; }
  catch (error) { expect((error as { code?: string }).code).toBe("translation_buffer_limit"); failed = true; }
  expect(failed).toBe(true);
  expect(budget.snapshot().currentBytes).toBe(0);
});


test("internal terminal continuation replays signed progress instead of unsigned display text", async () => {
  const { adapter, events } = await eventsFor([empty, redacted, update], false);
  const continuation = buildContinuationRequest(parseRequest({ model, input: "question" }), events);
  const request = await adapter.buildRequest(continuation);
  expect(JSON.parse(request.body as string).messages[1].content).toEqual([empty, redacted, update]);
});


for (const streamRoutedModelOutput of [false, true]) test(`hosted search displays signed commentary once and retains replay (live=${streamRoutedModelOutput})`, async () => {
  const search = { ...tool, name: "web_search", input: { query: "docs" } };
  const { adapter, wireResponse } = await eventsFor([empty, redacted, update, search], true);
  let pass = 0;
  let replay: unknown;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"source result"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  ));
  try {
    const response = await runWithWebSearch({
      parsed: parseRequest({ model, input: "look up docs", stream: true, reasoning: { effort: "high" }, tools: [{ type: "web_search" }] }),
      adapter: { ...adapter,
        async buildRequest(parsed, meta) {
          const request = await adapter.buildRequest(parsed, meta);
          replay = JSON.parse(request.body as string).messages;
          return request;
        },
        fetchResponse: async () => pass++ === 0 ? wireResponse!.clone() : new Response(
          frame("message_start", { message: { content: [] } })
          + frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
          + frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Final answer." } })
          + frame("content_block_stop", { index: 0 })
          + frame("message_delta", { delta: { stop_reason: "end_turn" } }) + frame("message_stop")),
      },
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      forwardProvider: { adapter: "openai-responses", baseUrl: "https://sidecar.invalid", authMode: "forward" },
      hostedTool: { type: "web_search" }, selectedForwardHeaders: new Headers({ authorization: "Bearer synthetic" }),
      settings: { model: "synthetic", reasoning: "low", timeoutMs: 1000 }, maxSearches: 1,
      streamRoutedModelOutput,
    });
    const text = await response.text();
    expect(text).not.toContain("response.failed");
    const frames = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(frames.filter(f => f.type === "response.output_text.delta" && f.delta === update.thinking)).toHaveLength(1);
    expect(frames.findIndex(f => f.type === "response.output_text.delta" && f.delta === update.thinking))
      .toBeLessThan(frames.findIndex(f => f.type === "response.output_item.added" && f.item.type === "web_search_call"));
    expect((replay as { role: string; content: unknown }[]).find(m => m.role === "assistant")?.content).toEqual([
      empty, redacted, update, expect.objectContaining({ type: "tool_use", id: tool.id }),
    ]);
  } finally { fetchSpy.mockRestore(); }
});
