import { describe, expect, test } from "bun:test";
import {
  imageGenToolCallAliases,
  relaySseWithImageGenCallRestore as relaySseWithImageGenCallRestoreProduction,
  restoreImageGenCallsInJson,
} from "../src/server/responses-image-gen-repair";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import { finalizeTranslatorBudgetResponse } from "../src/lib/translator-budget";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

function relaySseWithImageGenCallRestore(
  body: ReadableStream<Uint8Array>,
  aliases: Parameters<typeof relaySseWithImageGenCallRestoreProduction>[1],
): ReadableStream<Uint8Array> {
  const budget = createTestTranslatorBudget();
  return finalizeTranslatorBudgetResponse(
    new Response(relaySseWithImageGenCallRestoreProduction(body, aliases, budget)),
    budget,
  ).body!;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

const aliases = imageGenToolCallAliases(new Map([
  ["image_gen__imagegen", { namespace: "image_gen", name: "imagegen" }],
  ["mcp__files__read", { namespace: "mcp__files", name: "read" }],
]));

describe("Responses image-gen call restoration", () => {
  test("keeps only image-gen aliases and accepts the legacy dotted name", () => {
    expect([...aliases.entries()]).toEqual([
      ["image_gen__imagegen", { namespace: "image_gen", name: "imagegen" }],
      ["image_gen.imagegen", { namespace: "image_gen", name: "imagegen" }],
    ]);
  });

  test("recovers declared dotted aliases without guessing double-underscore function names", () => {
    const recovered = imageGenToolCallAliases(new Map(), {
      tools: [
        { type: "function", name: "image_gen.imagegen", parameters: {} },
        { type: "function", name: "image_gen__unrelated", parameters: {} },
      ],
    });

    expect([...recovered.entries()]).toEqual([
      ["image_gen__imagegen", { namespace: "image_gen", name: "imagegen" }],
      ["image_gen.imagegen", { namespace: "image_gen", name: "imagegen" }],
    ]);
  });

  test("restores non-streaming function calls without changing unrelated tools", () => {
    const upstream = JSON.stringify({
      id: "resp_1",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "image_gen__imagegen",
          arguments: "{}",
        },
        {
          type: "function_call",
          id: "fc_2",
          call_id: "call_2",
          name: "exec_command",
          arguments: "{}",
        },
      ],
    });

    expect(JSON.parse(restoreImageGenCallsInJson(upstream, aliases))).toEqual({
      id: "resp_1",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          namespace: "image_gen",
          name: "imagegen",
          arguments: "{}",
        },
        {
          type: "function_call",
          id: "fc_2",
          call_id: "call_2",
          name: "exec_command",
          arguments: "{}",
        },
      ],
    });
  });

  test("restores added, done, and completed SSE snapshots across chunk boundaries", async () => {
    const item = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "image_gen__imagegen",
      arguments: "{}",
    };
    const added = `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item,
    })}\n\n`;
    const done = `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, status: "completed" },
    })}\n\n`;
    const completed = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_1", status: "completed", output: [{ ...item, status: "completed" }] },
    })}\n\ndata: [DONE]\n\n`;
    const upstream = added + done + completed;
    const splitAt = Math.floor(upstream.length / 2);
    const restored = await readAll(relaySseWithImageGenCallRestore(
      streamFromChunks([upstream.slice(0, splitAt), upstream.slice(splitAt)]),
      aliases,
    ));

    expect(restored).not.toContain("image_gen__imagegen");
    expect(restored.match(/\"namespace\":\"image_gen\"/g)).toHaveLength(3);
    expect(restored.match(/\"name\":\"imagegen\"/g)).toHaveLength(3);
    expect(restored).toContain("data: [DONE]");
  });

  test("restores legacy dotted calls and preserves invalid JSON byte-for-byte", () => {
    const legacy = JSON.stringify({
      type: "function_call",
      name: "image_gen.imagegen",
      call_id: "call_legacy",
      arguments: "{}",
    });
    expect(JSON.parse(restoreImageGenCallsInJson(legacy, aliases))).toMatchObject({
      namespace: "image_gen",
      name: "imagegen",
      call_id: "call_legacy",
    });
    expect(restoreImageGenCallsInJson("not-json", aliases)).toBe("not-json");
  });

  test("handleResponses encodes the request and restores the client-facing JSON call", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "image_gen__imagegen",
          arguments: "{}",
        }],
      });
    }) as typeof fetch;

    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://fixture.test/v1",
          authMode: "key",
          apiKey: "fixture-key",
        },
      },
    } as OcxConfig;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/gpt-5.6-sol",
          stream: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "generate an image" }] }],
          tools: [{
            type: "namespace",
            name: "image_gen",
            tools: [{ type: "function", name: "imagegen", parameters: {} }],
          }],
        }),
      }), config, { model: "", provider: "" });
      const clientBody = await response.json() as {
        output: Array<{ namespace?: string; name?: string; call_id?: string }>;
      };
      const outboundTools = outboundBody?.tools as Array<{ name?: string }> | undefined;

      expect(outboundTools?.[0]?.name).toBe("image_gen__imagegen");
      expect(clientBody.output[0]).toMatchObject({
        namespace: "image_gen",
        name: "imagegen",
        call_id: "call_1",
      });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses round-trips a legacy dotted declaration", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        status: "completed",
        output: [{
          type: "function_call",
          id: "fc_legacy",
          call_id: "call_legacy",
          name: "image_gen__imagegen",
          arguments: "{}",
        }],
      });
    }) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://fixture.test/v1",
          authMode: "key",
          apiKey: "fixture-key",
        },
      },
    } as OcxConfig;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/gpt-5.6-sol",
          stream: false,
          input: [{ role: "user", content: [{ type: "input_text", text: "generate an image" }] }],
          tools: [{ type: "function", name: "image_gen.imagegen", parameters: {} }],
        }),
      }), config, { model: "", provider: "" });
      const clientBody = await response.json() as {
        output: Array<{ namespace?: string; name?: string; call_id?: string }>;
      };
      const outboundTools = outboundBody?.tools as Array<{ name?: string }> | undefined;

      expect(outboundTools?.[0]?.name).toBe("image_gen__imagegen");
      expect(clientBody.output[0]).toMatchObject({
        namespace: "image_gen",
        name: "imagegen",
        call_id: "call_legacy",
      });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("handleResponses restores client-facing SSE calls on the passthrough rewrite path", async () => {
    const savedFetch = globalThis.fetch;
    let outboundBody: Record<string, unknown> | undefined;
    const item = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "image_gen__imagegen",
      arguments: "{}",
      status: "completed",
    };
    const upstream = [
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress" },
      })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item,
      })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: { status: "completed", output: [item] },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const config = {
      port: 0,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-responses",
          baseUrl: "https://fixture.test/v1",
          authMode: "key",
          apiKey: "fixture-key",
        },
      },
    } as OcxConfig;

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/gpt-5.6-sol",
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "generate an image" }] }],
          tools: [{
            type: "namespace",
            name: "image_gen",
            tools: [{ type: "function", name: "imagegen", parameters: {} }],
          }],
        }),
      }), config, { model: "", provider: "" });
      const clientBody = await response.text();
      const outboundTools = outboundBody?.tools as Array<{ name?: string }> | undefined;

      expect(outboundTools?.[0]?.name).toBe("image_gen__imagegen");
      expect(clientBody).not.toContain("image_gen__imagegen");
      expect(clientBody.match(/\"namespace\":\"image_gen\"/g)).toHaveLength(3);
      expect(clientBody).toContain("data: [DONE]");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
