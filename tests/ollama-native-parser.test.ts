import { describe, expect, test } from "bun:test";
import { createOllamaNativeAdapter } from "../src/adapters/ollama-native";
import { ollamaNativeChatUrl } from "../src/adapters/ollama-native-url";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { AdapterEvent } from "../src/types";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

/**
 * Parser/request contract tests for the native Ollama transport.
 * Structural-receipt tooling deliberately does not exist in production code; these tests use the
 * public adapter surface (buildRequest / parseStream / parseResponse) and plain fixtures only.
 */

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "ollama-native",
    baseUrl: "https://ollama.com/v1",
    authMode: "key",
    apiKey: "test-key-not-a-real-credential",
    liveModels: false,
    models: ["glm-5.3-flash"],
    ...overrides,
  } as OcxProviderConfig;
}

function parsedWith(
  messages: unknown[],
  options: Record<string, unknown> = {},
  modelId = "glm-5.3-flash",
): OcxParsedRequest {
  return { modelId, stream: true, options, context: { messages } } as unknown as OcxParsedRequest;
}

function ndjsonResponse(frames: unknown[]): Response {
  const body = frames.map(frame => `${JSON.stringify(frame)}\n`).join("");
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

function frame(message: Record<string, unknown>, done: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: "glm-5.3-flash", message, done, ...extra };
}

async function collect(adapter: ReturnType<typeof createOllamaNativeAdapter>, response: Response): Promise<AdapterEvent[]> {
  const budget = createTestTranslatorBudget();
  const out: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(response, budget)) out.push(event);
  return out;
}

describe("ollama-native — observer-free streaming", () => {
  test("no structural-receipt machinery exists in the module surface", async () => {
    const mod = await import("../src/adapters/ollama-native") as unknown as Record<string, unknown>;
    for (const name of [
      "setOllamaNativeObservationSink",
      "createOllamaNativeObservationBuffer",
    ]) {
      expect(mod[name], name).toBeUndefined();
    }
  });

  test("a ~30 MiB valid line split across reads is delivered intact", async () => {
    // The safety bound applies to the assembled RECORD, not to read boundaries. The old
    // accounting committed old + replacement together, so growth steps double-charged.
    const line = "x".repeat(30 * 1024 * 1024); // 30 MiB: under the 32 MiB record ceiling...
    // First read: 18 MiB of the giant line (incomplete), second: the remaining ~12 MiB + newline.
    // Under old+replacement charging this transiently holds 18 + 30 = 48 MiB against the 32 MiB
    // turn cap and the turn dies, even though the finished record is perfectly valid.
    const giantLine = `${JSON.stringify({ model: "m", message: { role: "assistant", content: line }, done: true, done_reason: "stop" })}\n`;
    const read1 = giantLine.slice(0, 18 * 1024 * 1024);
    const read2 = giantLine.slice(18 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(read1));
        controller.enqueue(new TextEncoder().encode(read2));
        controller.close();
      },
    });
    const adapter = createOllamaNativeAdapter(provider());
    const budget = createTestTranslatorBudget();
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(body), budget)) events.push(event);
    const text = events.filter(e => e.type === "text_delta").reduce((s, e) => s + (e as { text: string }).text.length, 0);
    expect(text).toBe(line.length);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("one >32 MiB read carrying individually-valid smaller records is accepted", async () => {
    // Nine complete 4 MiB records arrive in ONE transport read of 36 MiB. The old accounting
    // reserved the whole READ before splitting it and rejected at 36 MiB even though every record
    // was individually valid. The record is the safety unit, not the read.
    const line = "y".repeat(4 * 1024 * 1024);
    const frames: string[] = [];
    for (let i = 0; i < 8; i++) {
      frames.push(`${JSON.stringify({ model: "m", message: { role: "assistant", content: line }, done: false })}
`);
    }
    frames.push(`${JSON.stringify({ model: "m", message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}
`);
    const oneRead = frames.join("");
    expect(new TextEncoder().encode(oneRead).byteLength).toBeGreaterThan(32 * 1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(oneRead)); controller.close(); },
    });

    const adapter = createOllamaNativeAdapter(provider());
    const budget = createTestTranslatorBudget();
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(body), budget)) events.push(event);
    const deltas = events.filter(e => e.type === "text_delta");
    expect(deltas).toHaveLength(8);
    expect(deltas.reduce((s, e) => s + (e as { text: string }).text.length, 0)).toBe(8 * line.length);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("a single NDJSON record over the ceiling fails with the translation buffer limit", async () => {
    // 33 MiB in ONE record: the record itself exceeds the 32 MiB ceiling and must fail closed.
    const line = "z".repeat(33 * 1024 * 1024);
    const response = new Response(
      `${JSON.stringify({ model: "m", message: { role: "assistant", content: line }, done: true })}\n`,
      { headers: { "content-type": "application/x-ndjson" } },
    );
    const adapter = createOllamaNativeAdapter(provider());
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "translation_buffer_limit" });
  });

  test("retained high-water tracks the in-flight record/residual, not read size", async () => {
    // Same single 32 MiB read as above: the in-flight unit is one ~4 MiB record plus a near-zero
    // residual, so the high-water mark must stay near one record. The removed implementation
    // committed the whole read (≈32 MiB) before splitting it, and its release-after-reserve
    // ordering transiently double-charged growth steps.
    const line = "w".repeat(4 * 1024 * 1024);
    const frames: string[] = [];
    for (let i = 0; i < 8; i++) {
      frames.push(`${JSON.stringify({ model: "m", message: { role: "assistant", content: line }, done: false })}
`);
    }
    frames.push(`${JSON.stringify({ model: "m", message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}
`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames.join("")));
        controller.close();
      },
    });

    const adapter = createOllamaNativeAdapter(provider());
    const budget = createTestTranslatorBudget();
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(body), budget)) events.push(event);
    expect(events.at(-1)?.type).toBe("done");
    const snapshot = budget.snapshot();
    expect(snapshot.highWaterBytes).toBeLessThan(line.length * 2);
  });

  test("thinking deltas stream interleaved with content and a terminal", async () => {
    const frames = [
      { model: "m", message: { role: "assistant", thinking: "step one" }, done: false },
      { model: "m", message: { role: "assistant", content: "hello" }, done: false },
      { model: "m", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 7 },
    ];
    const adapter = createOllamaNativeAdapter(provider());
    const budget = createTestTranslatorBudget();
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(ndjsonResponse(frames), budget)) events.push(event);
    expect(events.map(e => e.type)).toEqual(["reasoning_raw_delta", "text_delta", "done"]);
    expect(events[0]).toMatchObject({ type: "reasoning_raw_delta", text: "step one" });
    expect(events[1]).toMatchObject({ type: "text_delta", text: "hello" });
    expect(events[2]).toMatchObject({ type: "done", stopReason: "stop", usage: { outputTokens: 7 } });
  });

  test("usage and done_reason map onto the terminal event", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const budget = createTestTranslatorBudget();
    const frames = [
      { model: "m", message: { role: "assistant", content: "hi" }, done: true, done_reason: "length", prompt_eval_count: 11, eval_count: 5 },
    ];
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(ndjsonResponse(frames), budget)) events.push(event);
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: "done",
      stopReason: "max_tokens",
      usage: { inputTokens: 11, outputTokens: 5 },
    });
  });

  test("malformed NDJSON fails closed with a parser error, never a done", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const budget = createTestTranslatorBudget();
    const response = new Response("{not json\n", { headers: { "content-type": "application/x-ndjson" } });
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(response, budget)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "invalid_ollama_native_payload" });
  });

  test("a native error record is sanitized and terminates without done", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const budget = createTestTranslatorBudget();
    // "Bearer <short token>" is a recognized secret shape for redaction (8+ chars) while
    // staying below the privacy scanner's 24-char bearer rule, so the fixture stays scannable.
    const frames = [{ error: { message: "boom for Bearer abcdef12345678" } }];
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(ndjsonResponse(frames), budget)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", errorType: "upstream_error" });
    expect(JSON.stringify(events[0])).not.toContain("abcdef12345678");
    expect(JSON.stringify(events[0])).toContain("[REDACTED]");
  });

  test("stream that ends without done:true is an error, not a done", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const budget = createTestTranslatorBudget();
    const frames = [{ model: "m", message: { role: "assistant", content: "partial" }, done: false }];
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(ndjsonResponse(frames), budget)) events.push(event);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some(e => e.type === "done")).toBe(false);
  });
});

describe("ollama-native — buffered terminal contract", () => {
  test("buffered done:true produces content + done with usage", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const events = await adapter.parseResponse!(
      ndjsonResponse([{
        model: "m",
        message: { role: "assistant", content: "answer" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 3,
        eval_count: 4,
      }]),
      createTestTranslatorBudget(),
    );
    expect(events.map(e => e.type)).toEqual(["text_delta", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
  });

  test("buffered done:false is incomplete: never a downstream done", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const events = await adapter.parseResponse!(
      ndjsonResponse([{ model: "m", message: { role: "assistant", content: "half" }, done: false }]),
      createTestTranslatorBudget(),
    );
    expect(events.at(-1)?.type).toBe("error");
    expect((events.at(-1) as { message?: string }).message).toContain("done:false");
    expect(events.some(e => e.type === "done")).toBe(false);
    // The complete payload is already known invalid, so its partial text is suppressed too.
    expect(events.some(e => e.type === "text_delta")).toBe(false);
    expect(events).toHaveLength(1);
  });

  test("buffered tool calls are suppressed unless done:true", async () => {
    const call = {
      model: "m",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ index: 0, type: "function", id: "c0", function: { name: "ns_x__f", arguments: { p: 1 } } }],
      },
    };
    const adapter = createOllamaNativeAdapter(provider());
    // done:true -> the tool call is emitted normally.
    const ok = await adapter.parseResponse!(
      ndjsonResponse([{ ...call, done: true, done_reason: "stop" }]), createTestTranslatorBudget());
    expect(ok.filter(e => e.type === "tool_call_start")).toHaveLength(1);
    expect(ok.at(-1)?.type).toBe("done");

    // done:false / missing / malformed -> error only: no tool_call events may execute.
    for (const envelope of [{ done: false }, {}, { done: "yes" }]) {
      const events = await adapter.parseResponse!(
        ndjsonResponse([{ ...call, ...envelope }]), createTestTranslatorBudget());
      expect(events.filter(e => e.type === "tool_call_start"), JSON.stringify(envelope)).toHaveLength(0);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
    }
  });

  test("buffered missing done is incomplete", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const events = await adapter.parseResponse!(
      ndjsonResponse([{ model: "m", message: { role: "assistant", content: "half" } }]),
      createTestTranslatorBudget(),
    );
    expect(events.at(-1)?.type).toBe("error");
    expect((events.at(-1) as { message?: string }).message).toContain("did not include done:true");
  });

  test("buffered malformed done is malformed", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const events = await adapter.parseResponse!(
      ndjsonResponse([{ model: "m", message: { role: "assistant", content: "x" }, done: "yes" }]),
      createTestTranslatorBudget(),
    );
    expect(events.at(-1)?.type).toBe("error");
    expect((events.at(-1) as { message?: string }).message).toContain("done flag was not boolean");
  });

  test("buffered invalid JSON and non-object payloads fail closed", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const budget = createTestTranslatorBudget();
    const badJson = await adapter.parseResponse!(new Response("[1,2"), budget);
    expect(badJson[0].type).toBe("error");
    expect((badJson[0] as { message?: string }).message).toContain("not valid JSON");
    const notObject = await adapter.parseResponse!(ndjsonResponse([[1, 2]]), budget);
    expect(notObject[0]).toMatchObject({ type: "error", code: "invalid_ollama_native_payload" });
  });
});

describe("ollama-native — tool calls", () => {
  test("indexed tool calls preserve order and identity", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const budget = createTestTranslatorBudget();
    const frames = [
      {
        model: "m",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { index: 0, type: "function", id: "c0", function: { name: "ns_one__alpha", arguments: { a: 1 } } },
            { index: 1, type: "function", id: "c1", function: { name: "ns_two__beta", arguments: { b: 2 } } },
          ],
        },
        done: true,
        done_reason: "stop",
      },
    ];
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(ndjsonResponse(frames), budget)) events.push(event);
    const starts = events.filter(e => e.type === "tool_call_start") as Array<{ type: "tool_call_start"; id: string; name: string }>;
    expect(starts.map(s => s.id)).toEqual(["c0", "c1"]);
    expect(starts.map(s => s.name)).toEqual(["ns_one__alpha", "ns_two__beta"]);
    expect(events.at(-1)?.type).toBe("done");
  });

  test("parallelToolCalls:false rejects a second provider tool call", async () => {
    const frames = [
      {
        model: "m",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { index: 0, type: "function", function: { name: "ns_a__t", arguments: {} } },
            { index: 1, type: "function", function: { name: "ns_b__u", arguments: {} } },
          ],
        },
        done: true,
        done_reason: "stop",
      },
    ];
    // buildRequest latches the request-level parallel flag into the adapter closure; parseStream
    // then enforces it against the wire. Same instance, sequential calls — exactly the runtime path.
    const strict = createOllamaNativeAdapter(provider());
    strict.buildRequest(parsedWith([{ role: "user", content: "go" }], { parallelToolCalls: false }));
    const events: AdapterEvent[] = [];
    for await (const event of strict.parseStream!(ndjsonResponse(frames), createTestTranslatorBudget())) {
      events.push(event);
    }
    expect(events.some(e => e.type === "tool_call_start")).toBe(false);
    expect(events.at(-1)?.type).toBe("error");
    expect((events.at(-1) as { message?: string }).message).toContain("parallel tool calls");

    // The default (parallel allowed) still forwards both calls.
    const permissive = createOllamaNativeAdapter(provider());
    permissive.buildRequest(parsedWith([{ role: "user", content: "go" }]));
    const both: AdapterEvent[] = [];
    for await (const event of permissive.parseStream!(ndjsonResponse(frames), createTestTranslatorBudget())) {
      both.push(event);
    }
    expect(both.filter(e => e.type === "tool_call_start")).toHaveLength(2);
  });

  test("tool-result replay pairs a toolResult message with its call id", () => {
    const adapter = createOllamaNativeAdapter(provider());
    const built = adapter.buildRequest(parsedWith([
      { role: "user", content: "run it" },
      {
        role: "assistant",
        timestamp: 1,
        content: [{ type: "toolCall", id: "c0", name: "f", namespace: "ns", arguments: { p: 1 } }],
      },
      {
        role: "toolResult",
        toolCallId: "c0",
        toolName: "f",
        toolNamespace: "ns",
        content: "result-text",
        isError: false,
      },
    ] as never));
    const body = JSON.parse(String(built.body));
    const assistant = body.messages.at(-2);
    const replayed = body.messages.at(-1);
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls[0].id).toBe("c0");
    expect(assistant.tool_calls[0].function.name).toBe("ns__f");
    expect(replayed.role).toBe("tool");
    expect(replayed.tool_call_id).toBe("c0");
    expect(replayed.content).toContain("result-text");
  });
});

describe("ollama-native — request control parity", () => {
  test("presence/frequency penalties map onto native Options", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const built = await adapter.buildRequest(
      parsedWith([{ role: "user", content: "hi" }], { presencePenalty: 0.25, frequencyPenalty: -0.5 }),
    );
    expect(ollamaNativeChatUrl(provider().baseUrl as string)).toBe(built.url);
    const options = JSON.parse(String(built.body)).options;
    expect(options.presence_penalty).toBe(0.25);
    expect(options.frequency_penalty).toBe(-0.5);
  });

  test("noPenaltyModels suppresses both penalties; noTemperature/noTopP suppress their own", async () => {
    const gated = provider({
      noPenaltyModels: ["glm-5.3-flash"],
      noTemperatureModels: ["glm-5.3-flash"],
      noTopPModels: ["glm-5.3-flash"],
    });
    const adapter = createOllamaNativeAdapter(gated);
    const built = await adapter.buildRequest(parsedWith(
      [{ role: "user", content: "hi" }],
      { presencePenalty: 1, frequencyPenalty: 1, temperature: 0.7, topP: 0.9 },
    ));
    const options = JSON.parse(String(built.body)).options;
    expect(options).not.toHaveProperty("presence_penalty");
    expect(options).not.toHaveProperty("frequency_penalty");
    expect(options).not.toHaveProperty("temperature");
    expect(options).not.toHaveProperty("top_p");

    // The gates are per model, not per provider: a non-listed id keeps its controls.
    const otherAdapter = createOllamaNativeAdapter(provider({
      noPenaltyModels: ["some-other-model"],
    }));
    const ok = await otherAdapter.buildRequest(
      parsedWith([{ role: "user", content: "hi" }], { presencePenalty: 0.5 }, "glm-5.3-flash"),
    );
    expect(JSON.parse(String(ok.body)).options.presence_penalty).toBe(0.5);
  });

  test("num_predict, temperature, top_p and stop map as before", async () => {
    const adapter = createOllamaNativeAdapter(provider());
    const built = await adapter.buildRequest(parsedWith(
      [{ role: "user", content: "hi" }],
      { maxOutputTokens: 128, temperature: 0.2, topP: 0.9, stopSequences: ["END"] },
    ));
    const options = JSON.parse(String(built.body)).options;
    expect(options).toMatchObject({ num_predict: 128, temperature: 0.2, top_p: 0.9, stop: ["END"] });
  });
});

describe("ollama-native — transport security", () => {
  function headered(headers: Record<string, string>, overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
    return provider({ headers, ...overrides });
  }

  test("remote http with an apiKey is refused", () => {
    expect(() => createOllamaNativeAdapter(
      provider({ baseUrl: "http://api.example.test", apiKey: "k" }),
    ).buildRequest(parsedWith([{ role: "user", content: "hi" }]))).toThrow(/plaintext non-loopback HTTP/);
  });

  test("remote http with an Authorization header is refused even without an apiKey", () => {
    expect(() => createOllamaNativeAdapter(
      headered({ Authorization: "Bearer x" }, { baseUrl: "http://api.example.test", apiKey: undefined }),
    ).buildRequest(parsedWith([{ role: "user", content: "hi" }]))).toThrow(/credential headers: Authorization/);
  });

  test("remote http with x-api-key and api-key headers is refused", () => {
    for (const name of ["x-api-key", "api-key"]) {
      expect(() => createOllamaNativeAdapter(
        headered({ [name]: "v" }, { baseUrl: "http://api.example.test", apiKey: undefined }),
      ).buildRequest(parsedWith([{ role: "user", content: "hi" }]))).toThrow(/plaintext non-loopback HTTP/);
    }
  });

  test("loopback targets never receive credential headers, even from a copied provider row", () => {
    const adapter = createOllamaNativeAdapter(headered(
      { Authorization: "Bearer x", "x-api-key": "v", "api-key": "v2", "X-Custom": "keep" },
      { baseUrl: "http://127.0.0.1:11434", apiKey: "local-should-not-leak" },
    ));
    const built = adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    const headers = built.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["api-key"]).toBeUndefined();
    expect(headers["X-Custom"]).toBe("keep");
    expect(JSON.stringify(headers)).not.toContain("Bearer");
  });

  test("https header precedence matches openAIChatTransport: configured Authorization wins", () => {
    // apiKey only -> generated Bearer.
    const keyOnly = createOllamaNativeAdapter(provider({ baseUrl: "https://api.example.test", apiKey: "k" }));
    expect((keyOnly.buildRequest(parsedWith([{ role: "user", content: "hi" }])).headers as Record<string, string>).Authorization)
      .toBe("Bearer k");

    // apiKey + configured Authorization -> the CONFIGURED header wins (openai-chat applies
    // provider.headers after the generated Bearer; V2 had this reversed).
    const both = createOllamaNativeAdapter(
      headered({ Authorization: "Bearer configured" }, { baseUrl: "https://api.example.test", apiKey: "k" }),
    );
    expect((both.buildRequest(parsedWith([{ role: "user", content: "hi" }])).headers as Record<string, string>).Authorization)
      .toBe("Bearer configured");

    // apiKey + configured LOWERCASE authorization -> exactly one effective authorization header,
    // with the configured value.
    const lower = createOllamaNativeAdapter(
      headered({ authorization: "Bearer configured-lower" }, { baseUrl: "https://api.example.test", apiKey: "k" }),
    );
    const lowerHeaders = lower.buildRequest(parsedWith([{ role: "user", content: "hi" }])).headers as Record<string, string>;
    const authKeys = Object.keys(lowerHeaders).filter(name => name.toLowerCase() === "authorization");
    expect(authKeys).toEqual(["authorization"]);
    expect(lowerHeaders.authorization).toBe("Bearer configured-lower");

    // Header-only auth with keyOptional stays supported on a secure channel.
    const headerOnly = createOllamaNativeAdapter(
      headered({ Authorization: "Bearer configured" }, { baseUrl: "https://api.example.test", apiKey: undefined, keyOptional: true }),
    );
    expect((headerOnly.buildRequest(parsedWith([{ role: "user", content: "hi" }])).headers as Record<string, string>).Authorization)
      .toBe("Bearer configured");
  });
});
