/**
 * Undeclared historical custom-tool replay for destinations that deny native custom tools.
 *
 * Lives in its own file rather than in openai-responses-passthrough.test.ts: that file is
 * exactly at its file-size ratchet cap (4,809 lines in tests/fixtures/file-size-baseline.json),
 * and the cap only ever moves downward.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

let releaseSpendHome: (() => void) | undefined;
const takeSpendHome = (): void => { releaseSpendHome ??= acquireOwnedSpendHome(); };
afterEach(() => { releaseSpendHome?.(); releaseSpendHome = undefined; });

const createResponsesPassthroughAdapter = (
  ...args: Parameters<typeof createResponsesPassthroughAdapterProduction>
) => withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const denyingProvider = {
  adapter: "openai-responses" as const,
  baseUrl: "https://provider.example/v1",
  authMode: "key" as const,
  apiKey: "test-key",
  supportsResponsesCustomTools: false as const,
};

describe("undeclared historical custom-tool replay on the passthrough wire", () => {
  test("serialized outbound JSON lowers undeclared historical custom calls on a denying destination", () => {
    const awkwardInput = 'say "hi"\npath\\file';
    const rawBody = {
      model: "routed-model",
      store: false,
      input: [
        { type: "custom_tool_call", id: "ctc_exec", call_id: "call_exec", name: "exec", input: awkwardInput },
        { type: "custom_tool_call_output", call_id: "call_exec", output: "ok" },
      ],
    };
    const before = JSON.stringify(rawBody);
    const request = createResponsesPassthroughAdapter(denyingProvider).buildRequest({
      modelId: "routed-model",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: rawBody,
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as {
      store: boolean;
      input: Array<Record<string, unknown>>;
      tools?: unknown;
    };

    expect(JSON.stringify(rawBody)).toBe(before);
    expect(body).not.toHaveProperty("tools");
    expect(body.store).toBe(false);
    expect(body.input[0]).toMatchObject({
      type: "function_call",
      call_id: "call_exec",
      name: "exec",
      arguments: JSON.stringify({ input: awkwardInput }),
    });
    expect(body.input[0]).not.toHaveProperty("id");
    expect(JSON.parse(String(body.input[0]!.arguments)).input).toBe(awkwardInput);
    expect(body.input[1]).toMatchObject({
      type: "function_call_output",
      call_id: "call_exec",
      output: "ok",
    });
    expect([...(request.convertedRoutedCustomToolNames ?? [])]).toEqual([]);
  });

  test("namespaced historical custom calls keep distinct wire identities after flattening", () => {
    const request = createResponsesPassthroughAdapter(denyingProvider).buildRequest({
      modelId: "routed-model",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: {
        model: "routed-model",
        input: [
          { type: "custom_tool_call", call_id: "c1", namespace: "alpha", name: "read", input: "a" },
          { type: "custom_tool_call_output", call_id: "c1", output: "A" },
          { type: "custom_tool_call", call_id: "c2", namespace: "beta", name: "read", input: "b" },
          { type: "custom_tool_call_output", call_id: "c2", output: "B" },
        ],
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as { input: Array<Record<string, unknown>> };
    expect(body.input[0]).toMatchObject({
      type: "function_call",
      call_id: "c1",
      name: "alpha__read",
      arguments: JSON.stringify({ input: "a" }),
    });
    expect(body.input[0]).not.toHaveProperty("namespace");
    expect(body.input[2]).toMatchObject({
      type: "function_call",
      call_id: "c2",
      name: "beta__read",
    });
  });

  test("compaction with no live tools still lowers historical custom replay items", () => {
    const request = createResponsesPassthroughAdapter({
      ...denyingProvider,
      baseUrl: "https://gateway.example/v1",
    }).buildRequest({
      modelId: "routed-model",
      context: { messages: [] },
      stream: false,
      options: {},
      _compactionRequest: true,
      _rawBody: {
        model: "routed-model",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] },
          { type: "custom_tool_call", call_id: "call_exec", name: "exec", input: "text(1)" },
          { type: "custom_tool_call_output", call_id: "call_exec", output: "1" },
          { type: "compaction_trigger" },
        ],
      },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as { input: Array<Record<string, unknown>> };
    expect(body).not.toHaveProperty("tools");
    expect(body.input.some(item => item.type === "compaction_trigger")).toBe(false);
    expect(body.input).toEqual(expect.arrayContaining([
      {
        type: "function_call",
        call_id: "call_exec",
        name: "exec",
        arguments: JSON.stringify({ input: "text(1)" }),
      },
      {
        type: "function_call_output",
        call_id: "call_exec",
        output: "1",
      },
    ]));
    expect(body.input.at(-1)).toEqual({
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: expect.stringContaining("CONTEXT CHECKPOINT COMPACTION"),
      }],
    });
    expect([...(request.convertedRoutedCustomToolNames ?? [])]).toEqual([]);
  });

  test("unmapped custom results fail closed before a denying destination is contacted", () => {
    const adapter = createResponsesPassthroughAdapter(denyingProvider);
    expect(() => adapter.buildRequest({
      modelId: "routed-model",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: {
        model: "routed-model",
        input: [{ type: "custom_tool_call_output", call_id: "call_exec", output: "ok" }],
      },
    }, { headers: new Headers() })).toThrow("custom_tool_compat: final_guard: custom_tool_call_output");
  });

  test("historical exec replay does not re-authorize a new undeclared exec call", async () => {
    const outbound: Array<Record<string, unknown>> = [];
    const leakedCall = {
      type: "function_call",
      id: "fc_new",
      call_id: "call_new",
      name: "exec",
      arguments: JSON.stringify({ input: "text(2)" }),
      status: "completed",
    };
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      outbound.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "resp_1", status: "completed", output: [leakedCall] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      takeSpendHome();
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/model",
          stream: false,
          tools: [{ type: "function", name: "wait", parameters: { type: "object" } }],
          input: [
            { type: "custom_tool_call", call_id: "call_old", name: "exec", input: "text(1)" },
            { type: "custom_tool_call_output", call_id: "call_old", output: "1" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
          ],
        }),
      }), {
        port: 0,
        defaultProvider: "fixture",
        providers: {
          fixture: {
            adapter: "openai-responses",
            baseUrl: "https://fixture.test/v1",
            authMode: "key",
            apiKey: "fixture-key",
            supportsResponsesCustomTools: false,
          },
        },
      } as OcxConfig, { model: "", provider: "" });
      expect(outbound).toHaveLength(1);
      expect(outbound[0]!.input).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          call_id: "call_old",
          name: "exec",
          arguments: JSON.stringify({ input: "text(1)" }),
        }),
      ]));
      const body = await response.text();
      expect(body).toContain("undeclared client tool");
      expect(body).toContain("exec");
      expect(body).not.toContain("\"type\":\"custom_tool_call\"");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
