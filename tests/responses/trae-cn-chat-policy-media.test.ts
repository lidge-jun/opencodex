import { afterEach, describe, expect, mock, test } from "bun:test";
import type { OcxConfig } from "../../src/types";
import type { RouteDecisionTraceV1 } from "../../src/routing/trace";

const calls: Array<Record<string, unknown>> = [];
const actualResponses = await import("../../src/server/responses");
const actualPolicy = await import("../../src/server/responses/policy-fallback");
const actualCore = await import("../../src/server/responses/core");
let trace: RouteDecisionTraceV1;

mock.module("../../src/server/responses", () => ({
  ...actualResponses,
  handleResponses: async (req: Request, config: OcxConfig, logCtx: Record<string, unknown>, options: Record<string, unknown>) => {
    const body = await req.json() as Record<string, unknown>;
    options.onRequestBodyParsed?.(body);
    calls.push(body);
    if (calls.length === 1) {
      const concrete = new Request(req.url, { method: "POST", headers: req.headers,
        body: JSON.stringify({ ...body, model: "trae-cn/test-model" }) });
      const refused = await actualCore.handleResponses(concrete, config, logCtx, options);
      expect(refused.status).toBe(400);
      logCtx.routeDecision = trace;
      logCtx.requestedModel = "policy/daily";
      return refused;
    }
    return Response.json({ id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: "accept-model", output: [], usage: null });
  },
}));

const { handleChatCompletions } = await import("../../src/server/chat-completions");

describe("Chat policy fallback media retention", () => {
  afterEach(() => { calls.length = 0; });

  for (const media of ["image", "video"]) {
    test("re-projects original instruction media for the next candidate: " + media, async () => {
      const config = { port: 0, defaultProvider: "trae-cn", providers: {
        "trae-cn": { adapter: "trae-cn", baseUrl: "https://www.trae.cn", keyOptional: true,
          authMode: "key", models: ["test-model"], liveModels: false },
        capable: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-key",
          authMode: "key", models: ["accept-model"], inputModalities: ["text", "image", "video"] },
      } } as OcxConfig;
      trace = { version: 1, decisionId: "chat-media-policy-" + media, createdAt: 1, requestedModel: "policy/daily",
        routeKind: "policy", profile: { id: "daily", revision: "fixture" }, requirements: [],
        candidates: [
          { provider: "trae-cn", model: "test-model", eligible: true, exclusions: [], score: { total: 1, components: {} } },
          { provider: "capable", model: "accept-model", eligible: true, exclusions: [], score: { total: 0.5, components: {} } },
        ], selected: { candidateIndex: 0, provider: "trae-cn", model: "test-model", reason: "highest-score" } };
      const attachment = media === "image"
        ? { type: "image_url", image_url: { url: "https://fixture.invalid/image.png" } }
        : { type: "video_url", video_url: { url: "https://fixture.invalid/clip.mp4" } };
      const messages = [
        { role: "system", content: [{ type: "text", text: "Inspect the attachment" }, attachment] },
        { role: "user", content: "Question" },
      ];
      const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "policy/daily", stream: false, messages }),
      }), config, { model: "", provider: "" });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.model).toBe("capable/accept-model");
      const input = calls[1]?.input as Array<{ role?: string; content?: Array<{ type: string }> }>;
      expect(input[0]?.role).toBe("developer");
      expect(input[0]?.content?.some(part => part.type === (media === "image" ? "input_image" : "input_video"))).toBe(true);
      expect(input.at(-1)?.content?.some(part => part.type === "input_text")).toBe(true);
    });
  }
});
