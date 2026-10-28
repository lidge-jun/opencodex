import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { rewriteProviderReferences } from "../../src/providers/provider-id-rewrite";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
let home: TempHome;
let release: () => void;
beforeEach(() => {
  home = createTempHome("ocx-tool-loading-destination-");
  release = acquireOwnedSpendHome();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  release();
  home.remove();
});

test("provider rename carries exact and wildcard append-only selectors without widening them", () => {
  const config: OcxConfig = { port: 0, defaultProvider: "other", providers: {}, claudeCode: {
    appendOnlyToolLoadingModels: ["old/gpt-one", "old/gpt-*", "older/gpt-*", "other/gpt-one"],
  } };
  expect(rewriteProviderReferences(config, "old", "new")).toEqual({ changed: 2, collisions: [] });
  expect(config.claudeCode!.appendOnlyToolLoadingModels)
    .toEqual(["new/gpt-one", "new/gpt-*", "older/gpt-*", "other/gpt-one"]);
});

for (const [baseUrl, append, responsesPath] of [
  ["https://opencode.ai/zen/go/v1", false, undefined],
  ["https://api.x.ai/v1", false, undefined],
  ["https://cli-chat-proxy.grok.com/v1", false, undefined],
  ["https://gateway.example/v1", true, undefined],
  ["https://api.x.ai.gateway.example/v1", true, undefined],
  ["https://opencode.ai/other/v1", true, undefined],
  ["https://opencode.ai", false, "/zen/go/v1/responses"],
] as const) for (const authMode of ["key", "forward"] as const) {
  test(`physical ${authMode} ${baseUrl}${responsesPath ?? ""} honors destination eligibility`, async () => {
    const captured: any[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "resp_destination", object: "response", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } });
    }) as typeof fetch;
    const config: OcxConfig = { port: 0, defaultProvider: "gateway", providers: { gateway: {
      adapter: "openai-responses", authMode, baseUrl, responsesPath, apiKey: "synthetic-fixture", models: ["gpt-test"],
    } }, claudeCode: { appendOnlyToolLoadingModels: ["gateway/gpt-test"] } };
    const tools = [
      { name: "ToolSearch", input_schema: { type: "object", properties: {} } },
      { name: "lookup", input_schema: { type: "object", properties: {} }, defer_loading: true },
    ];
    for (const discovered of [false, true]) {
      const messages = [
        { role: "user", content: "Use the tools." },
        ...(discovered ? [
          { role: "assistant", content: [{ type: "tool_use", id: "search", name: "ToolSearch", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "search",
            content: [{ type: "tool_reference", tool_name: "lookup" }] }] },
        ] : []),
      ];
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gateway/gpt-test", metadata: { user_id: "fixture-session" },
          tools, messages, max_tokens: 100, stream: false }),
      }), config, { model: "", provider: "" });
      await response.text();
      expect(response.status).toBe(200);
    }
    expect(captured).toHaveLength(2);
    // Forward transport appends /responses to its base and ignores responsesPath.
    const shouldAppend = append || (authMode === "forward" && responsesPath !== undefined);
    const expected = shouldAppend ? ["ToolSearch"] : ["ToolSearch", "lookup"];
    expect(captured[0].tools.map((tool: any) => tool.name)).toEqual(expected);
    expect(captured[1].tools).toEqual(captured[0].tools);
    expect(captured[0].input.some((item: any) => item.type === "additional_tools")).toBe(false);
    expect(captured[1].input.some((item: any) => item.type === "additional_tools")).toBe(shouldAppend);
  });
}
