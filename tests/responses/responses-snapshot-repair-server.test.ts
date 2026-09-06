import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { handleResponses } from "../../src/server/responses";
import { isEagerRelaySseResponse } from "../../src/server/relay";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

setDefaultTimeout(30_000);

const originalFetch = globalThis.fetch;
let TEST_DIR = "";
let isolated: IsolatedCodexHome;

const SPARSE_EVENTS = [
  { type: "response.created", response: { id: "resp_sparse" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_sparse" } },
  { type: "response.output_text.delta", item_id: "msg_sparse", output_index: 0, delta: "hello" },
  { type: "response.completed", response: { id: "resp_sparse" } },
];

const EXPLICIT_EMPTY_TERMINAL_EVENTS = [
  {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      id: "msg_sparse",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    },
  },
  {
    type: "response.completed",
    response: { id: "resp_sparse", status: "completed", output: [] },
  },
];

const CODEX_SPARSE_TERMINAL_EVENTS = [
  {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hello" }],
    },
  },
  {
    type: "response.completed",
    response: { id: "resp_sparse", status: "completed" },
  },
];

function sparseSseBody(events: readonly Record<string, unknown>[] = SPARSE_EVENTS): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function stubSparseGateway(
  origin: string,
  events: readonly Record<string, unknown>[] = SPARSE_EVENTS,
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.origin === origin && url.pathname.endsWith("/models")) {
      return Response.json({ data: [] });
    }
    if (url.origin === origin && url.pathname.endsWith("/responses")) {
      return new Response(sparseSseBody(events), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-snapshot-repair-server-"));
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolated = installIsolatedCodexHome("ocx-snapshot-repair-codex-");
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await isolated.restore();
  removeTreeWithRetry(TEST_DIR);
});

describe("responsesSnapshotRepair through /v1/responses", () => {
  test.skipIf(process.platform !== "darwin")(
    "Darwin eager-relay applies snapshot repair inline before bytes reach the client",
    async () => {
      const gateway = "https://sparse-darwin-eager.example.test";
      stubSparseGateway(gateway);
      const config = {
        port: 0,
        streamMode: "eager-relay",
        defaultProvider: "sparse",
        providers: {
          sparse: {
            adapter: "openai-responses",
            baseUrl: `${gateway}/v1`,
            authMode: "key",
            apiKey: "test-key",
            responsesSnapshotRepair: true,
          },
        },
      } as OcxConfig;

      const response = await handleResponses(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "sparse-model", input: "hi", stream: true }),
        }),
        config,
        { model: "", provider: "" },
      );

      expect(isEagerRelaySseResponse(response)).toBe(true);
      const text = await response.text();
      expect(text).toContain("response.content_part.added");
      expect(text).toContain("response.output_text.done");
      expect(text).toContain("response.output_item.done");
      const completedLine = text.split("\n").find(line => line.includes('"response.completed"'));
      expect(completedLine).toBeDefined();
      const completed = JSON.parse(completedLine!.replace(/^data: /, "")) as { response: { output: { id: string }[] } };
      expect(completed.response.output[0]?.id).toBe("msg_sparse");
    },
  );

  test("an opt-in gateway's sparse stream reaches the client as the full canonical lifecycle", async () => {
    const gateway = "https://sparse.example.test";
    stubSparseGateway(gateway);
    saveConfig({
      port: 0,
      defaultProvider: "sparse",
      providers: {
        sparse: {
          adapter: "openai-responses",
          baseUrl: `${gateway}/v1`,
          authMode: "key",
          apiKey: "test-key",
          responsesSnapshotRepair: true,
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sparse-model", input: "hi", stream: true }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const sequence = [...text.matchAll(/"type":"([^"]+)"/g)].map(match => match[1]);
      for (const expected of [
        "response.created",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
      ]) {
        expect(sequence).toContain(expected);
      }
      // The terminal snapshot carries the reconstructed committed message.
      const completedLine = text.split("\n").find(line => line.includes('"response.completed"'));
      expect(completedLine).toBeDefined();
      const completed = JSON.parse(completedLine!.replace(/^data: /, "")) as { response: { output: { id: string }[] } };
      expect(completed.response.output[0]?.id).toBe("msg_sparse");
    } finally {
      await server.stop(true);
    }
  });

  test("the same gateway without the opt-in relays the sparse stream unchanged", async () => {
    const gateway = "https://sparse-off.example.test";
    stubSparseGateway(gateway);
    saveConfig({
      port: 0,
      defaultProvider: "sparse",
      providers: {
        sparse: {
          adapter: "openai-responses",
          baseUrl: `${gateway}/v1`,
          authMode: "key",
          apiKey: "test-key",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sparse-model", input: "hi", stream: true }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("response.content_part.added");
      expect(text).not.toContain("response.output_text.done");
      expect(text).not.toContain("response.output_item.done");
    } finally {
      await server.stop(true);
    }
  });

  test("the Grok client marker alone repairs an explicit empty completed snapshot", async () => {
    const gateway = "https://grok-sparse-terminal.example.test";
    stubSparseGateway(gateway, EXPLICIT_EMPTY_TERMINAL_EVENTS);
    saveConfig({
      port: 0,
      defaultProvider: "sparse",
      providers: {
        sparse: {
          adapter: "openai-responses",
          baseUrl: `${gateway}/v1`,
          authMode: "key",
          apiKey: "test-key",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      const request = (grokMarker: boolean) => originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(grokMarker ? { "x-opencodex-grok": "1" } : {}),
        },
        body: JSON.stringify({ model: "sparse-model", input: "hi", stream: true }),
      });

      const grokResponse = await request(true);
      expect(grokResponse.status).toBe(200);
      const grokText = await grokResponse.text();
      const grokCompletedLine = grokText.split("\n")
        .find(line => line.includes('"response.completed"'));
      expect(grokCompletedLine).toBeDefined();
      const grokCompleted = JSON.parse(grokCompletedLine!.replace(/^data: /, "")) as {
        response: { output: { id: string }[] };
      };
      expect(grokCompleted.response.output[0]?.id).toBe("msg_sparse");

      const ordinaryResponse = await request(false);
      expect(ordinaryResponse.status).toBe(200);
      const ordinaryText = await ordinaryResponse.text();
      const ordinaryCompletedLine = ordinaryText.split("\n")
        .find(line => line.includes('"response.completed"'));
      expect(ordinaryCompletedLine).toBeDefined();
      const ordinaryCompleted = JSON.parse(ordinaryCompletedLine!.replace(/^data: /, "")) as {
        response: { output: unknown[] };
      };
      expect(ordinaryCompleted.response.output).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("the Grok marker repairs Codex-style done items plus a sparse completed response", async () => {
    const gateway = "https://grok-codex-sparse.example.test";
    stubSparseGateway(gateway, CODEX_SPARSE_TERMINAL_EVENTS);
    saveConfig({
      port: 0,
      defaultProvider: "sparse",
      providers: {
        sparse: {
          adapter: "openai-responses",
          baseUrl: `${gateway}/v1`,
          authMode: "key",
          apiKey: "test-key",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      const response = await originalFetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencodex-grok": "1",
        },
        body: JSON.stringify({ model: "sparse-model", input: "hi", stream: true }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const completedLine = text.split("\n").find(line => line.includes('"response.completed"'));
      expect(completedLine).toBeDefined();
      const completed = JSON.parse(completedLine!.replace(/^data: /, "")) as {
        response: { output: Array<Record<string, unknown>> };
      };
      expect(completed.response.output).toHaveLength(1);
      expect(completed.response.output[0]).toMatchObject({
        id: "msg_ocx_0",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      });
    } finally {
      await server.stop(true);
    }
  });
});

test("sparse JSON completion inference precedes function repair in client output and replay", async () => {
  const expected = '{"cell_id":"4","yield_time_ms":120000}';
  const item = { type: "function_call", id: "fc_sparse_wait", call_id: "call_sparse_wait", name: "wait", arguments: '{"cell_id":4,"yield_time_ms":120000.0}' };
  let responseId = `resp_sparse_${crypto.randomUUID()}`;
  let capturedInput: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    capturedInput = JSON.parse(String(init?.body)).input;
    return Response.json({ id: responseId, output: [item] });
  }) as typeof fetch;
  const config = {
    port: 0, defaultProvider: "sparse",
    providers: { sparse: { adapter: "openai-responses", baseUrl: "https://sparse-function.invalid/v1", authMode: "key", apiKey: "fixture", responsesSnapshotRepair: true } },
  } as OcxConfig;
  const request = (extra: object = {}) => new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sparse/probe", stream: false, input: "synthetic",
      tools: [{ type: "function", name: "wait", parameters: { type: "object", properties: { cell_id: { type: "string" }, yield_time_ms: { type: "integer" } } } }],
      ...extra,
    }),
  });
  const first = await handleResponses(request(), config, { model: "", provider: "" });
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ status: "completed", output: [{ status: "completed", arguments: expected }] });
  const previous = responseId;
  responseId = `resp_sparse_followup_${crypto.randomUUID()}`;
  const second = await handleResponses(request({ previous_response_id: previous, input: [{ type: "function_call_output", call_id: item.call_id, output: "done" }] }), config, { model: "", provider: "" });
  await second.text();
  expect(capturedInput.find(value => value.type === "function_call" && value.call_id === item.call_id)?.arguments).toBe(expected);
});
