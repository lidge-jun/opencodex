import { afterEach, beforeEach, expect, test } from "bun:test";
import { anthropicToResponsesTranslation } from "../../src/claude/inbound";
import { analyzeClaudeCompatibility } from "../../src/claude/compatibility";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const search = { type: "web_search_20250305", name: "web_search" };
const deferred = { name: "lookup", description: "Look up a record", defer_loading: true,
  input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } };
const restrictions = [
  { allowed_domains: ["example.com"] },
  { blocked_domains: ["blocked.example"] },
  { user_location: { type: "approximate", country: "US", city: "Boston", timezone: "America/New_York" } },
  { allowed_domains: ["example.com"], blocked_domains: ["blocked.example"],
    user_location: { type: "approximate", country: "US" } },
];
const request = (tools: unknown[]) => ({ model: "combo/pick", max_tokens: 64, stream: false,
  tools, messages: [{ role: "user", content: "Use the available tools." }] });
let home: TempHome;
let release: () => void;
beforeEach(() => { home = createTempHome("ocx-translated-tool-restrictions-"); release = acquireOwnedSpendHome(); });
afterEach(() => { release(); home.remove(); });

test("translation never turns a restricted hosted search declaration into unrestricted search", () => {
  for (const restriction of restrictions) {
    // A duplicate unrestricted declaration must not bypass the restriction on the same tool.
    for (const tools of [[{ ...search, ...restriction }, deferred], [search, { ...search, ...restriction }, deferred]]) {
      const { body } = anthropicToResponsesTranslation(request(tools));
      expect(body.tools).toEqual([{ type: "function", name: "lookup", description: deferred.description,
        parameters: deferred.input_schema, strict: false }]);
    }
  }
});

for (const adapter of ["openai-responses", "openai-chat"] as const) {
  for (const [index, restriction] of [undefined, ...restrictions].entries()) {
    test(`combo TRANSLATION to ${adapter} omits restricted search ${index} and keeps deferred functions`, async () => {
      // Failure health is process-local; distinct physical identities keep scenarios independent.
      const refusedProvider = `refused-${adapter}-${index}`;
      const captured: { url: string; body: any }[] = [];
      const fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        if (String(url).includes("api.anthropic.com")) {
          return Response.json({ type: "error", error: { type: "overloaded_error", message: "fixture refusal" } }, { status: 503 });
        }
        return adapter === "openai-responses"
          ? Response.json({ id: "resp_fixture", object: "response", status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: 1, output_tokens: 1 } })
          : new Response(`data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } });
      }) as typeof globalThis.fetch;
      const config: OcxConfig = { port: 0, defaultProvider: "target",
        claudeCode: { nativePassthrough: false, ...(restriction === undefined ? { compatibility: "enforce" as const } : {}) },
        providers: { [refusedProvider]: { adapter: "anthropic", authMode: "key", baseUrl: "https://api.anthropic.com",
          apiKey: "synthetic-fixture", models: ["claude-test"], fetch }, target: {
        adapter, authMode: "key", baseUrl: "https://fixture.invalid/v1", apiKey: "synthetic-fixture", models: ["test-model"], fetch,
      } }, combos: { pick: { strategy: "failover", targets: [
        { provider: refusedProvider, model: "claude-test" }, { provider: "target", model: "test-model" },
      ] } },
      // Enable a real sidecar plan: the pre-fix Chat path otherwise drops search for lack of auth.
      webSearchSidecar: { enabled: true, backend: "exa", exaApiKey: "synthetic-fixture" } };
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(request(restriction === undefined ? [deferred] : [{ ...search, ...restriction }, deferred])),
      }), config, { model: "", provider: "" });
      await response.text();
      expect(response.status).toBe(200);
      expect(captured).toHaveLength(2);
      expect(captured[0]!.url).toContain("api.anthropic.com");
      if (restriction) expect(captured[0]!.body.tools).toContainEqual(expect.objectContaining({ ...search, ...restriction }));
      expect(captured[1]!.url).toEndWith(adapter === "openai-responses" ? "/responses" : "/chat/completions");
      const tools = captured[1]!.body.tools.map((tool: any) => tool.function ?? tool);
      expect(tools.map((tool: any) => tool.name)).toEqual(["lookup"]);
      expect(tools[0]).toMatchObject({ description: deferred.description, parameters: deferred.input_schema });
      expect(JSON.stringify(captured[1]!.body)).not.toContain("web_search");
      expect(tools[0].defer_loading).toBeUndefined();
    });
  }
}

test("unrestricted search remains offered and deferred functions are included normally", () => {
  const raw = request([search, deferred]);
  const before = structuredClone(raw);
  const { body } = anthropicToResponsesTranslation(raw);
  expect(body.tools).toMatchObject([{ type: "web_search" }, { type: "function", name: "lookup", parameters: deferred.input_schema }]);
  expect(raw).toEqual(before);
});

test("forced restricted search refuses locally instead of naming an omitted hosted tool", () => {
  expect(() => anthropicToResponsesTranslation({ ...request([{ ...search, ...restrictions[0] }, deferred]),
    tool_choice: { type: "tool", name: "web_search" } })).toThrow("Restricted web search");
});

test("ordinary deferred functions can degrade to eager loading even under compatibility enforcement", () => {
  expect(analyzeClaudeCompatibility(request([deferred]), { mode: "enforce" }).decision).toBe("allow");
  // Unrepresentable top-level deferral and server-executed discovery retain their own admission.
  expect(analyzeClaudeCompatibility({ ...request([deferred]), defer_tools: true }, { mode: "enforce" }).decision).toBe("reject");
  expect(analyzeClaudeCompatibility(request([{ type: "tool_search_tool_regex_20251119", name: "tool_search" }, deferred]),
    { mode: "enforce" }).decision).toBe("reject");
});
