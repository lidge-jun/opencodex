import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { modelCapabilitiesConfigError, sanitizeModelCapabilitiesForLoad } from "../../src/config/provider-validation";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { captureRouteStaticPolicy, routeModel } from "../../src/router";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { handleResponsesCompact } from "../../src/server/responses";
import { parseProviderEditorConfigDTO, providerEditorConfigDTO } from "../../src/server/auth-cors";
import { getDefaultConfig } from "../../src/config";
import { baseCompactionBody, compactionRequest, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rawBody = (model: string) => ({
  model,
  input: [
    { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
    { type: "custom_tool_call_output", call_id: "c1", output: "ok" },
  ],
  tools: [{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }],
});

function parsed(model: string): OcxParsedRequest {
  return { modelId: model, context: { messages: [] }, stream: true, options: {}, _rawBody: rawBody(model) };
}

const provider = (): OcxProviderConfig => ({
  adapter: "openai-responses",
  baseUrl: "https://mixed.example/v1",
  authMode: "key",
  supportsResponsesCustomTools: true,
  modelCapabilities: {
    "claude-wire": { responsesCustomTools: false },
    "gpt-wire": { responsesCustomTools: true },
  },
});

function effective(model: string): OcxProviderConfig {
  const source = provider();
  const policy = captureRouteStaticPolicy("mixed", model, source);
  return resolveWireProtocolOverride("mixed", model, source, "responses", policy);
}

describe("exact-model Responses custom-tool capability", () => {
  test.each([false, true])("a captured %s declaration survives live edits and credential refresh", declared => {
    const source = provider();
    source.modelCapabilities!["claude-wire"]!.responsesCustomTools = declared;
    const captured = captureRouteStaticPolicy("mixed", "claude-wire", source);
    expect(Object.isFrozen(captured.model)).toBe(true);
    expect(captured.model.supportsResponsesCustomTools).toBe(declared);
    expect(captured.provenance.model.supportsResponsesCustomTools).toBe("operator-capability");
    source.modelCapabilities!["claude-wire"]!.responsesCustomTools = !declared;
    source.supportsResponsesCustomTools = !declared;
    const refreshed = { ...source, apiKey: "replacement-fixture-key" };
    const wire = resolveWireProtocolOverride("mixed", "claude-wire", refreshed, "responses", captured);
    expect(wire.supportsResponsesCustomTools).toBe(declared);
    expect(wire.apiKey).toBe("replacement-fixture-key");
    expect(refreshed.supportsResponsesCustomTools).toBe(!declared);
    const nextRoute = captureRouteStaticPolicy("mixed", "claude-wire", refreshed);
    expect(resolveWireProtocolOverride("mixed", "claude-wire", refreshed, "responses", nextRoute)
      .supportsResponsesCustomTools).toBe(!declared);
  });

  test("one provider preserves GPT grammar and lowers Claude history without mutation", () => {
    const source = provider();
    const gpt = effective("gpt-wire");
    const claude = effective("claude-wire");
    expect(gpt.supportsResponsesCustomTools).toBe(true);
    expect(claude.supportsResponsesCustomTools).toBe(false);
    expect(source.supportsResponsesCustomTools).toBe(true);

    const incoming = { headers: new Headers(), providerName: "mixed", translatorBudget: createTranslatorBudget() };
    const gptWire = JSON.parse(createResponsesPassthroughAdapter(gpt).buildRequest(parsed("gpt-wire"), incoming).body);
    const claudeWire = JSON.parse(createResponsesPassthroughAdapter(claude).buildRequest(parsed("claude-wire"), incoming).body);
    expect(gptWire.tools[0].type).toBe("custom");
    expect(gptWire.input.map((item: { type: string }) => item.type)).toEqual(["custom_tool_call", "custom_tool_call_output"]);
    expect(claudeWire.tools[0]).toMatchObject({ type: "function", name: "apply_patch" });
    expect(claudeWire.input).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "c1", name: "apply_patch" }),
      expect.objectContaining({ type: "function_call_output", call_id: "c1", output: "ok" }),
    ]);
  });

  test("the final wire id is exact and unrelated aliases inherit the provider default", () => {
    expect(effective("claude-wire").supportsResponsesCustomTools).toBe(false);
    expect(effective("public-claude-alias").supportsResponsesCustomTools).toBe(true);
    const mixed = { ...provider(), models: ["claude-wire"], modelAliases: { "claude-wire": "friendly" } };
    const route = routeModel({ defaultProvider: "mixed", providers: { mixed } } as OcxConfig, "friendly");
    expect(route.modelId).toBe("claude-wire");
    expect(resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, "responses", route.staticPolicy)
      .supportsResponsesCustomTools).toBe(false);
  });

  test("strict config and tolerant load preserve only boolean declarations", () => {
    expect(modelCapabilitiesConfigError({ m: { responsesCustomTools: false } })).toBeNull();
    expect(modelCapabilitiesConfigError({ m: { responsesCustomTools: "false" } })).toContain("boolean");
    expect(sanitizeModelCapabilitiesForLoad({ good: { responsesCustomTools: false }, bad: { responsesCustomTools: "false" } }))
      .toEqual({ good: { responsesCustomTools: false } });
  });

  test("provider export/import preserves an explicit false declaration", () => {
    const config = { ...getDefaultConfig(), defaultProvider: "mixed", providers: { mixed: provider() } };
    const dto = providerEditorConfigDTO(config);
    expect(dto.providers.mixed?.modelCapabilities?.["claude-wire"]?.responsesCustomTools).toBe(false);
    expect(parseProviderEditorConfigDTO(dto)).toMatchObject({
      ok: true,
      value: { providers: { mixed: { modelCapabilities: { "claude-wire": { responsesCustomTools: false } } } } },
    });
  });

  test("a refreshed transport cannot add a capability absent from the captured route", () => {
    const captured = captureRouteStaticPolicy("mixed", "plain-wire", {
      adapter: "openai-responses", baseUrl: "https://mixed.example/v1", authMode: "key",
    });
    const refreshed = {
      adapter: "openai-responses", baseUrl: "https://mixed.example/v1", authMode: "key",
      apiKey: "rotated-fixture-key", supportsResponsesCustomTools: false,
    } satisfies OcxProviderConfig;
    const effective = resolveWireProtocolOverride("mixed", "plain-wire", refreshed, "responses", captured);
    expect(effective.supportsResponsesCustomTools).toBeUndefined();
    expect(effective.apiKey).toBe("rotated-fixture-key");
    expect(refreshed.supportsResponsesCustomTools).toBe(false);
  });
});

describe("native compact uses the exact-model capability", () => {
  let home: string;
  let previousHome: string | undefined;
  let release: (() => void) | undefined;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-model-custom-tools-"));
    process.env.OPENCODEX_HOME = home;
    release = acquireOwnedSpendHome();
  });
  afterEach(async () => {
    release?.();
    globalThis.fetch = originalFetch;
    await removeCompactionFixture(home);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
  });

  test("a custom history collision is a client refusal without an upstream send", async () => {
    let sends = 0;
    globalThis.fetch = (async () => {
      sends++;
      return Response.json({ status: "completed", output: [{ type: "compaction", encrypted_content: "opaque-fixture" }] });
    }) as typeof fetch;
    const mixed = { ...provider(), supportsNativeCompactEndpoint: true, apiKey: "fixture-key" };
    const config = { ...getDefaultConfig(), defaultProvider: "mixed", providers: { mixed } };
    const body = baseCompactionBody({
      ...rawBody("mixed/claude-wire"),
      tools: [{ type: "function", name: "apply_patch", parameters: { type: "object", properties: {} } }],
    });
    const response = await handleResponsesCompact(compactionRequest(body), config, { model: "", provider: "" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error", message: expect.stringContaining("custom_tool_compat") } });
    expect(sends).toBe(0);
  });

  test("a native compact retry keeps the captured policy after a live model edit", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const mixed = { ...provider(), supportsNativeCompactEndpoint: true, apiKey: "fixture-key",
      transientRetryOn5xx: { attempts: 2 } };
    const config = { ...getDefaultConfig(), defaultProvider: "mixed", providers: { mixed } };
    globalThis.fetch = (async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      if (sent.length === 1) {
        mixed.modelCapabilities!["claude-wire"]!.responsesCustomTools = true;
        return Response.json({ error: "fixture overload" }, { status: 503 });
      }
      return Response.json({ status: "completed", output: [{ type: "compaction", encrypted_content: "opaque-fixture" }] });
    }) as typeof fetch;
    const response = await handleResponsesCompact(
      compactionRequest(baseCompactionBody(rawBody("mixed/claude-wire"))), config, { model: "", provider: "" },
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(sent).toHaveLength(2);
    for (const body of sent) {
      expect(body.tools).toEqual([expect.objectContaining({ type: "function", name: "apply_patch" })]);
      expect((body.input as Array<{ type: string }>).map(item => item.type)).toEqual(["function_call", "function_call_output"]);
    }
    expect(mixed.modelCapabilities!["claude-wire"]!.responsesCustomTools).toBe(true);
  });

  test("lowers a complete custom call/result history before native compaction", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ status: "completed", output: [{ type: "compaction", encrypted_content: "opaque-fixture" }] });
    }) as typeof fetch;
    const mixed = { ...provider(), supportsNativeCompactEndpoint: true, apiKey: "fixture-key" };
    const config = { ...getDefaultConfig(), defaultProvider: "mixed", providers: { mixed } };
    const body = baseCompactionBody(rawBody("mixed/claude-wire"));
    const response = await handleResponsesCompact(compactionRequest(body), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect((sent.input as Array<{ type: string }>).map(item => item.type)).toEqual(["function_call", "function_call_output"]);
    expect(sent.tools).toEqual([expect.objectContaining({ type: "function", name: "apply_patch" })]);
    expect((await response.json()).output).toEqual([{ type: "compaction", encrypted_content: "opaque-fixture" }]);
  });

  test("preserves native GPT grammar and history on the same compact destination", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ status: "completed", output: [{ type: "compaction", encrypted_content: "opaque-fixture" }] });
    }) as typeof fetch;
    const mixed = { ...provider(), supportsNativeCompactEndpoint: true, apiKey: "fixture-key" };
    const config = { ...getDefaultConfig(), defaultProvider: "mixed", providers: { mixed } };
    const response = await handleResponsesCompact(
      compactionRequest(baseCompactionBody(rawBody("mixed/gpt-wire"))), config, { model: "", provider: "" },
    );
    expect(response.status).toBe(200);
    expect((sent.input as Array<{ type: string }>).map(item => item.type)).toEqual(["custom_tool_call", "custom_tool_call_output"]);
    expect(sent.tools).toEqual([expect.objectContaining({ type: "custom", name: "apply_patch" })]);
    await response.text();
  });
});
