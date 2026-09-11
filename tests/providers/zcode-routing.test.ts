import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AdapterEvent, OcxConfig, OcxParsedRequest } from "../../src/types";

const vision = await import("../../src/vision");
const search = await import("../../src/web-search");
const images = await import("../../src/images");
const resolver = await import("../../src/server/adapter-resolve");
const forbidden = mock(() => { throw new Error("A native ZCode turn must not plan direct-API sidecars."); });
const describeImages = mock(async (parsed: OcxParsedRequest, plan: {backend: string; routedModel?: string}) => {
  expect(plan).toMatchObject({ backend: "routed", routedModel: "eyes/vision-model" });
  vision.stripImagesInPlace(parsed);
  parsed.context.messages.push({ role: "user", content: "Vision caption: a red square", timestamp: 0 });
});
mock.module("../../src/vision", () => ({ ...vision, describeImagesInPlace: describeImages }));
mock.module("../../src/web-search", () => ({ ...search,
  shouldResolveOpenAiWebSearchSidecar: forbidden, planWebSearch: forbidden }));
mock.module("../../src/images", () => ({ ...images, planImageBridge: forbidden, planVideoBridge: forbidden }));
let sends = 0;
let received: OcxParsedRequest | undefined;
let terminal: AdapterEvent = { type: "done" };
mock.module("../../src/server/adapter-resolve", () => ({ ...resolver,
  resolveAdapter: () => ({ name: "zcode", replaySafe: false, allowExternalSidecars: false, allowVisionSidecar: true,
    buildRequest: forbidden, async *parseStream() { throw new Error("Unexpected HTTP transport"); },
    async runTurn(_parsed: OcxParsedRequest, _incoming: unknown, emit: (event: AdapterEvent) => void) {
      received = _parsed; sends++; emit(terminal);
    },
  }),
}));
const { handleResponses } = await import("../../src/server/responses");
beforeEach(() => { received = undefined; describeImages.mockClear(); sends = 0; forbidden.mockClear(); terminal = { type: "done" }; });

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

for (const model of ["builtin:zai-coding-plan/GLM-5.3", "builtin:zai-coding-plan/GLM-5.3-Flash"]) {
  for (const enabled of [true, false]) {
    test(`ZCode image adaptation uses configured vision only: ${model}, enabled=${enabled}`, async () => {
      const c = config();
      c.providers.zcode!.noVisionModels = [];
      c.providers.eyes = { adapter: "openai-chat", baseUrl: "https://example.invalid" };
      c.visionSidecar = { enabled, backend: "routed", model: "eyes/vision-model" };
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "zcode/" + model, stream: false, input: [{ role: "user", content: [
          {type:"input_text",text:"Describe this"}, {type:"input_image",image_url:"data:image/png;base64,aGVsbG8="},
        ] }], tools: [{type:"web_search"}, {type:"image_generation"}] }),
      }), c, { model:"", provider:"" });
      await response.text();
      expect(response.status).toBe(200);
      expect(sends).toBe(1);
      expect(describeImages).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(JSON.stringify(received?.context)).not.toContain('"type":"image"');
      expect(JSON.stringify(received?._rawBody)).not.toContain('"type":"input_image"');
      if (enabled) expect(JSON.stringify(received?.context)).toContain("Vision caption: a red square");
      expect(forbidden).not.toHaveBeenCalled();
    });
  }
}
