import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdapterEvent, OcxConfig } from "../../src/types";

const vision = await import("../../src/vision");
const search = await import("../../src/web-search");
const images = await import("../../src/images");
const resolver = await import("../../src/server/adapter-resolve");
const forbidden = mock(() => { throw new Error("A native ZCode turn must not plan direct-API sidecars."); });
mock.module("../../src/vision", () => ({ ...vision,
  shouldResolveOpenAiVisionSidecar: forbidden, planVisionSidecar: forbidden, stripImagesInPlace: forbidden }));
mock.module("../../src/web-search", () => ({ ...search,
  shouldResolveOpenAiWebSearchSidecar: forbidden, planWebSearch: forbidden }));
mock.module("../../src/images", () => ({ ...images, planImageBridge: forbidden, planVideoBridge: forbidden }));
let sends = 0;
let terminal: AdapterEvent = { type: "done" };
mock.module("../../src/server/adapter-resolve", () => ({ ...resolver,
  resolveAdapter: () => ({ name: "zcode", replaySafe: false, allowExternalSidecars: false,
    buildRequest: forbidden, async *parseStream() { throw new Error("Unexpected HTTP transport"); },
    async runTurn(_parsed: unknown, _incoming: unknown, emit: (event: AdapterEvent) => void) {
      sends++; emit(terminal);
    },
  }),
}));
const { handleResponses } = await import("../../src/server/responses");
beforeEach(() => { sends = 0; forbidden.mockClear(); terminal = { type: "done" }; });

function config(): OcxConfig {
  return { port: 0, emptyCompletionRetry: true, defaultProvider: "zcode", providers: {
    zcode: { adapter: "zcode", baseUrl: "https://zcode.z.ai", authMode: "local", noVisionModels: ["test/model"] },
  } } as OcxConfig;
}
async function request(stream: boolean) {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "zcode/test/model", stream, input: "hello",
      tools: [{ type: "web_search" }, { type: "image_generation" }] }),
  }), config(), { model: "", provider: "" });
}

describe("ZCode routing keeps inference inside the official agent transport", () => {
  for (const stream of [false, true]) {
    test(`no helper inference or empty-completion resend (stream=${stream})`, async () => {
      const response = await request(stream);
      expect(response.status).toBe(200);
      await response.text();
      expect(sends).toBe(1);
      expect(forbidden).not.toHaveBeenCalled();
    });
  }
  test("accepted failure remains incomplete rather than becoming an HTTP retry error", async () => {
    terminal = { type: "incomplete", reason: "zcode_agent_interrupted", retryable: false };
    const response = await request(false);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "incomplete", incomplete_details: { reason: "zcode_agent_interrupted" } });
    expect(sends).toBe(1);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
