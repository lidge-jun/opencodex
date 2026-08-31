import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { routedProviderConfig } from "../src/router";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../src/types";

const ANNOTATION =
  "[ocx] empty tool output: the tool ran but produced no stdout or return value; do not treat this as success, failure, or user-provided input.";

describe("annotateEmptyToolOutputs (DeepSeek default ON)", () => {
  test("deepseek registry seed defaults the option to true", () => {
    const seed = providerConfigSeed(getProviderRegistryEntry("deepseek")!);
    expect(seed.annotateEmptyToolOutputs).toBe(true);
  });

  test("non-deepseek registry seed leaves the option unset", () => {
    const seed = providerConfigSeed(getProviderRegistryEntry("cerebras")!);
    expect(seed.annotateEmptyToolOutputs).toBeUndefined();
  });
});

describe("annotateEmptyToolOutputs runtime backfill (DeepSeek)", () => {
  const deepseekSavedConfig: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-test",
    authMode: "key",
  };

  test("a saved deepseek provider without the flag is backfilled true at routing", () => {
    expect(routedProviderConfig("deepseek", deepseekSavedConfig).annotateEmptyToolOutputs).toBe(true);
  });

  test("an explicit false survives routing and is never overridden", () => {
    const routed = routedProviderConfig("deepseek", { ...deepseekSavedConfig, annotateEmptyToolOutputs: false });
    expect(routed.annotateEmptyToolOutputs).toBe(false);
  });
});

describe("openai-chat empty tool output annotation", () => {
  function wire(provider: OcxProviderConfig, messages: OcxMessage[]): Array<Record<string, unknown>> {
    const parsed: OcxParsedRequest = {
      modelId: "test-model",
      context: { messages },
      stream: false,
      options: {},
    };
    const req = createOpenAIChatAdapter(provider).buildRequest(parsed) as { body: string };
    return (JSON.parse(req.body) as { messages: Array<Record<string, unknown>> }).messages;
  }

  function toolCallTurn(emptyResult: string | unknown[]): OcxMessage[] {
    return [
      { role: "user", content: "hi", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec_command", arguments: {} }],
        timestamp: 0,
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "exec_command", content: emptyResult as never, isError: false, timestamp: 0 },
    ];
  }

  const providerWithFlag: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    authMode: "key",
    annotateEmptyToolOutputs: true,
  };

  const providerWithoutFlag: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-test",
    authMode: "key",
  };

  test("empty string result is annotated when enabled", () => {
    const messages = wire(providerWithFlag, toolCallTurn(""));
    const tool = messages.find(m => m.role === "tool");
    expect(tool?.content).toBe(ANNOTATION);
  });

  test("whitespace-only result is annotated when enabled", () => {
    const messages = wire(providerWithFlag, toolCallTurn("   \n  "));
    const tool = messages.find(m => m.role === "tool");
    expect(tool?.content).toBe(ANNOTATION);
  });

  test("empty content array is annotated when enabled", () => {
    const messages = wire(providerWithFlag, toolCallTurn([]));
    const tool = messages.find(m => m.role === "tool");
    expect(tool?.content).toBe(ANNOTATION);
  });

  test("whitespace-only text-part array is annotated when enabled", () => {
    const messages = wire(providerWithFlag, toolCallTurn([{ type: "text", text: "   \n  " }]));
    const tool = messages.find(m => m.role === "tool");
    expect(tool?.content).toBe(ANNOTATION);
  });

  test("whitespace-only text-part array stays unchanged when the option is absent", () => {
    const messages = wire(providerWithoutFlag, toolCallTurn([{ type: "text", text: "   " }]));
    const tool = messages.find(m => m.role === "tool");
    expect(tool?.content).toBe("   ");
  });

  test("image parts with whitespace text are not treated as empty", () => {
    const messages = wire(providerWithFlag, toolCallTurn([
      { type: "text", text: "   " },
      { type: "image", imageUrl: "data:image/png;base64,AAAA" },
    ]));
    const tool = messages.find(m => m.role === "tool");
    expect(tool?.content).not.toBe(ANNOTATION);
  });
  test("non-empty result stays byte-identical when enabled", () => {
    const messages = wire(providerWithFlag, toolCallTurn("real output"));
    const tool = messages.find(m => m.role === "tool");
    expect(tool?.content).toBe("real output");
  });

  test("empty result stays empty when the option is absent (legacy behavior)", () => {
    const messages = wire(providerWithoutFlag, toolCallTurn(""));
    const tool = messages.find(m => m.role === "tool");
    expect(tool?.content).toBe("");
  });

  test("orphaned empty result is annotated when enabled", () => {
    const messages = wire(providerWithFlag, [
      { role: "toolResult", toolCallId: "call_orphan", toolName: "exec_command", content: "", isError: false, timestamp: 0 },
    ]);
    const tool = messages.find(m => m.role === "tool");
    expect(tool?.content).toBe(ANNOTATION);
  });

  test("orphaned empty result stays empty when the option is absent", () => {
    const messages = wire(providerWithoutFlag, [
      { role: "toolResult", toolCallId: "call_orphan", toolName: "exec_command", content: "", isError: false, timestamp: 0 },
    ]);
    const tool = messages.find(m => m.role === "tool");
    expect(tool?.content).toBe("");
  });
});


describe("openai-responses empty tool output annotation", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  async function drive(config: OcxConfig, input: unknown[]): Promise<{ body: Record<string, unknown> }> {
    const requests: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (inputUrl: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return Response.json({ id: "resp_test", object: "response", status: "completed", output: [] });
    }) as typeof fetch;
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test/model", input, stream: true }),
      }),
      config,
      { model: "", provider: "" },
    );
    return requests[0] ?? { body: {} };
  }

  function responsesConfig(annotate: boolean | undefined): OcxConfig {
    return {
      port: 0,
      defaultProvider: "test",
      providers: {
        test: {
          adapter: "openai-responses",
          baseUrl: "https://example.test",
          apiKey: "sk-test",
          authMode: "key",
          ...(annotate === undefined ? {} : { annotateEmptyToolOutputs: annotate }),
        },
      },
    } as unknown as OcxConfig;
  }

  test("empty function_call_output is annotated when enabled", async () => {
    const { body } = await drive(responsesConfig(true), [
      { type: "function_call_output", call_id: "call_1", output: "" },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    expect(input[0].output).toBe(ANNOTATION);
  });

  test("empty custom_tool_call_output is annotated when enabled", async () => {
    const { body } = await drive(responsesConfig(true), [
      { type: "custom_tool_call_output", call_id: "call_2", output: "   " },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toBe(ANNOTATION);
  });

  test("non-empty output stays byte-identical when enabled", async () => {
    const { body } = await drive(responsesConfig(true), [
      { type: "function_call_output", call_id: "call_3", output: "ok" },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toBe("ok");
  });

  test("empty output stays empty when the option is absent", async () => {
    const { body } = await drive(responsesConfig(undefined), [
      { type: "function_call_output", call_id: "call_4", output: "" },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toBe("");
  });

  test("whitespace-only text-part array is annotated when enabled", async () => {
    const { body } = await drive(responsesConfig(true), [
      { type: "function_call_output", call_id: "call_5", output: [{ type: "text", text: "   \n  " }] },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toBe(ANNOTATION);
  });

  test("whitespace-only input_text part array is annotated when enabled", async () => {
    const { body } = await drive(responsesConfig(true), [
      { type: "function_call_output", call_id: "call_5b", output: [{ type: "input_text", text: "   \n" }] },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toBe(ANNOTATION);
  });

  test("whitespace-only output_text part array is annotated when enabled", async () => {
    const { body } = await drive(responsesConfig(true), [
      { type: "custom_tool_call_output", call_id: "call_5c", output: [{ type: "output_text", text: "\t" }] },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toBe(ANNOTATION);
  });

  test("non-empty input_text part array is never replaced when enabled", async () => {
    const output = [{ type: "input_text", text: "real tool text" }];
    const { body } = await drive(responsesConfig(true), [
      { type: "function_call_output", call_id: "call_5d", output },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toEqual(output);
  });

  test("image-only output is never replaced when enabled", async () => {
    const output = [{ type: "input_image", image_url: { url: "data:image/png;base64,AAAA" } }];
    const { body } = await drive(responsesConfig(true), [
      { type: "function_call_output", call_id: "call_6", output },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toEqual(output);
  });

  test("image plus whitespace text is never replaced when enabled", async () => {
    const output = [
      { type: "text", text: "   " },
      { type: "input_image", image_url: { url: "data:image/png;base64,AAAA" } },
    ];
    const { body } = await drive(responsesConfig(true), [
      { type: "function_call_output", call_id: "call_7", output },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toEqual(output);
  });

  test("encrypted_content output is never replaced when enabled", async () => {
    const output = [{ type: "encrypted_content", data: "opaque-blob" }];
    const { body } = await drive(responsesConfig(true), [
      { type: "function_call_output", call_id: "call_8", output },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toEqual(output);
  });

  test("file_id-only output is never replaced when enabled", async () => {
    const output = [{ type: "input_file", file_id: "file_123" }];
    const { body } = await drive(responsesConfig(true), [
      { type: "custom_tool_call_output", call_id: "call_9", output },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toEqual(output);
  });

  test("non-empty refusal output is never replaced when enabled", async () => {
    const output = [{ type: "refusal", refusal: "I cannot do that" }];
    const { body } = await drive(responsesConfig(true), [
      { type: "function_call_output", call_id: "call_10", output },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toEqual(output);
  });

  test("whitespace-only refusal output is annotated when enabled", async () => {
    const { body } = await drive(responsesConfig(true), [
      { type: "function_call_output", call_id: "call_11", output: [{ type: "refusal", refusal: "   " }] },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0].output).toBe(ANNOTATION);
  });

  test("null output is never replaced when enabled", async () => {
    const { body } = await drive(responsesConfig(true), [
      { type: "function_call_output", call_id: "call_12", output: null },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ type: "function_call_output", call_id: "call_12", output: null });
  });

  test("missing output key is never replaced when enabled", async () => {
    const { body } = await drive(responsesConfig(true), [
      { type: "custom_tool_call_output", call_id: "call_13" },
    ]);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ type: "custom_tool_call_output", call_id: "call_13" });
  });
});
