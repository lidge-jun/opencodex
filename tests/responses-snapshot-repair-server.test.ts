import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { handleResponses } from "../src/server/responses";
import { isEagerRelaySseResponse } from "../src/server/relay";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

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

function sparseSseBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of SPARSE_EVENTS) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function stubSparseGateway(origin: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.origin === origin && url.pathname.endsWith("/models")) {
      return Response.json({ data: [] });
    }
    if (url.origin === origin && url.pathname.endsWith("/responses")) {
      return new Response(sparseSseBody(), {
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
  rmSync(TEST_DIR, { recursive: true, force: true });
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
});
