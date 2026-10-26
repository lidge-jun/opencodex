import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses/passthrough";
import { repairUrlCitationAnnotations, stripProviderInputItemMetadata } from "../../src/adapters/openai-responses/request-strips";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { prepareCodexWsRequest } from "../../src/server/responses/codex-ws-request";
import type { AdapterEvent, OcxProviderConfig } from "../../src/types";

// OpenAI Responses requires string `title` and integer `start_index`/`end_index` on every replayed
// url_citation. A history written without them made every later request (notably remote compaction)
// fail with a deterministic HTTP 400 `Missing required parameter: input[N].content[M].annotations[K].title`.

function assistantWith(annotations: unknown[]) {
  return { type: "message", role: "assistant", id: "msg_synthetic", status: "completed",
    content: [{ type: "output_text", text: "synthetic answer", annotations }] };
}
function annotationsOf(body: unknown, itemIndex = 1): Record<string, unknown>[] {
  return ((body as { input: { content: { annotations: Record<string, unknown>[] }[] }[] }).input[itemIndex]!.content[0]!.annotations);
}

describe("url_citation annotation repair on outbound history", () => {
  test("fills title from url, coerces numeric-string indexes, preserves everything else", () => {
    const body = {
      model: "gpt-6-luna",
      input: [
        { role: "user", content: "hi" },
        assistantWith([
          { type: "url_citation", url: "https://a.example/x", start_index: 0, end_index: 0 },
          { type: "url_citation", url: "https://b.example/y", title: null, start_index: "3", end_index: "9", extra: "keep" },
          { type: "url_citation", title: 7, start_index: 1, end_index: 2 },
          { type: "url_citation", url: "https://ok.example", title: "Fine", start_index: 1, end_index: 2 },
          { type: "file_citation", file_id: "file_1", index: 0 },
        ]),
      ],
    };
    const before = structuredClone(body);
    const out = repairUrlCitationAnnotations(body);
    expect(body).toEqual(before);
    expect(annotationsOf(out)).toEqual([
      { type: "url_citation", url: "https://a.example/x", title: "https://a.example/x", start_index: 0, end_index: 0 },
      { type: "url_citation", url: "https://b.example/y", title: "https://b.example/y", start_index: 3, end_index: 9, extra: "keep" },
      { type: "url_citation", title: "", start_index: 1, end_index: 2 },
      { type: "url_citation", url: "https://ok.example", title: "Fine", start_index: 1, end_index: 2 },
      { type: "file_citation", file_id: "file_1", index: 0 },
    ]);
    expect((out as { input: unknown[] }).input[0]).toBe(body.input[0]);
  });

  test("negative and unsafe indexes are replaced with 0", () => {
    const body = { input: [assistantWith([
      { type: "url_citation", url: "https://a.example", title: "t", start_index: -1, end_index: 4 },
      { type: "url_citation", url: "https://b.example", title: "t", start_index: "9".repeat(400), end_index: 2 ** 60 },
    ])] };
    expect(annotationsOf(repairUrlCitationAnnotations(body), 0)).toEqual([
      { type: "url_citation", url: "https://a.example", title: "t", start_index: 0, end_index: 4 },
      { type: "url_citation", url: "https://b.example", title: "t", start_index: 0, end_index: 0 },
    ]);
  });

  test("a valid body is returned by reference and non-array input is untouched", () => {
    const valid = { input: [assistantWith([{ type: "url_citation", url: "https://ok.example", title: "t", start_index: 0, end_index: 1 }])] };
    expect(repairUrlCitationAnnotations(valid)).toBe(valid);
    expect(repairUrlCitationAnnotations({ input: "hello" })).toEqual({ input: "hello" });
    expect(repairUrlCitationAnnotations(null)).toBeNull();
  });

  test("metadata stripping and citation repair remain independent projections", () => {
    const citation = { type: "url_citation", url: "https://a.example", start_index: "3", end_index: -1, extra: "keep" };
    const message = { ...assistantWith([citation]), extra_content: { google: { thought_signature: "fixture-signature" } } };
    const body = { input: [{ role: "user", content: "hi" }, message] };
    const before = structuredClone(body);

    const stripped = stripProviderInputItemMetadata(body) as { input: Record<string, unknown>[] };
    expect(stripped.input[1]).not.toHaveProperty("extra_content");
    expect(stripped.input[1]!.content).toBe(message.content);
    expect(annotationsOf(stripped)).toBe(message.content[0]!.annotations);
    expect(annotationsOf(stripped)).toEqual([citation]);

    const repaired = repairUrlCitationAnnotations(body) as { input: Record<string, unknown>[] };
    expect(repaired.input[1]!.extra_content).toBe(message.extra_content);
    expect(annotationsOf(repaired)).toEqual([
      { ...citation, title: citation.url, start_index: 3, end_index: 0 },
    ]);
    expect(body).toEqual(before);
  });

  const native: OcxProviderConfig[] = [
    { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key" },
  ];
  for (const provider of native) {
    test(`reaches the wire repaired for ${provider.baseUrl} over HTTP and WS`, () => {
      const rawBody = {
        model: "gpt-6-luna", stream: true, store: false,
        input: [{ role: "user", content: "hi" },
          assistantWith([{ type: "url_citation", url: "https://a.example/x", start_index: 0, end_index: 0 }])],
      };
      const budget = createTranslatorBudget();
      try {
        const request = createResponsesPassthroughAdapter(provider).buildRequest({
          modelId: rawBody.model, context: { messages: [] }, stream: true, options: {}, _rawBody: rawBody,
        }, { headers: new Headers(), translatorBudget: budget });
        try {
          const ws = prepareCodexWsRequest(request.url, { method: request.method, headers: request.headers, body: request.body });
          expect(ws).not.toBeNull();
          for (const payload of [JSON.parse(request.body), JSON.parse(ws!.frameText), JSON.parse(ws!.httpInit.body as string)]) {
            expect(annotationsOf(payload)).toEqual([
              { type: "url_citation", url: "https://a.example/x", title: "https://a.example/x", start_index: 0, end_index: 0 },
            ]);
          }
          expect((rawBody.input[1] as { content: { annotations: Record<string, unknown>[] }[] }).content[0]!.annotations[0]).not.toHaveProperty("title");
        } finally { request.releaseBodyObservation?.(); }
      } finally { budget.dispose(); }
    });
  }

  test("a third-party gateway destination is not rewritten", () => {
    const rawBody = { model: "custom", stream: true, input: [{ role: "user", content: "hi" },
      assistantWith([{ type: "url_citation", url: "https://a.example/x", start_index: 0, end_index: 0 }])] };
    const budget = createTranslatorBudget();
    try {
      const request = createResponsesPassthroughAdapter({ adapter: "openai-responses", baseUrl: "https://gateway.example/v1", authMode: "key" })
        .buildRequest({ modelId: "custom", context: { messages: [] }, stream: true, options: {}, _rawBody: rawBody }, { headers: new Headers(), translatorBudget: budget });
      try { expect(annotationsOf(JSON.parse(request.body))[0]).not.toHaveProperty("title"); }
      finally { request.releaseBodyObservation?.(); }
    } finally { budget.dispose(); }
  });
});

describe("web-search citation generation always carries a string title", () => {
  const events: AdapterEvent[] = [
    { type: "web_search_call_begin", id: "ws_t1" },
    { type: "web_search_call_end", id: "ws_t1", queries: ["q"], sources: [{ url: "https://notitle.example/a" }, { url: "https://titled.example/b", title: "Titled" }] },
    { type: "text_delta", text: "answer" },
    { type: "done" },
  ];
  const expected = [
    { type: "url_citation", url: "https://notitle.example/a", title: "https://notitle.example/a", start_index: 0, end_index: 0 },
    { type: "url_citation", url: "https://titled.example/b", title: "Titled", start_index: 0, end_index: 0 },
  ];

  test("non-streaming JSON", () => {
    const json = buildResponseJSON(events, "routed/model");
    const message = (json.output as Record<string, unknown>[]).find(item => item.type === "message") as { content: { annotations: unknown[] }[] };
    expect(message.content[0]!.annotations).toEqual(expected);
  });

  test("streaming SSE", async () => {
    async function* replay() { for (const event of events) yield event; }
    const frames: { event?: string; data: Record<string, unknown> }[] = [];
    const reader = bridgeToResponsesSSE(replay(), "routed/model").getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) break;
    }
    for (const block of buffer.split("\n\n")) {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data && data !== "[DONE]") frames.push({ event, data: JSON.parse(data) });
    }
    const done = frames.find(f => f.event === "response.output_item.done" && (f.data.item as Record<string, unknown>)?.type === "message");
    const item = done!.data.item as { content: { annotations: unknown[] }[] };
    expect(item.content[0]!.annotations).toEqual(expected);
  });
});
