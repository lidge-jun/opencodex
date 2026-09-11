import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyRequestTransforms, clearTransformCacheForTests, resolveTransformPath } from "../../src/transforms";
import { validateConfigCandidate } from "../../src/config";
import { providerManagementConfigError } from "../../src/server/auth-cors";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { parseRequest } from "../../src/responses/parser";
import { handleResponses } from "../../src/server/responses";
import { syncTransformedResponsesBody } from "../../src/transforms/responses-body";
import type { RequestTransformContext } from "../../src/transforms/types";
import { repoPath } from "../helpers/repo-root";

describe("requestTransforms", () => {
  let testDir: string;

  beforeEach(() => {
    clearTransformCacheForTests();
    testDir = join(tmpdir(), "ocx-test-transforms-" + Math.random().toString(36).slice(2));
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (_err) {
      void _err;
    }
  });

  test("resolveTransformPath resolves relative to configDir and absolute paths", () => {
    const fileInConfig = join(testDir, "custom.ts");
    writeFileSync(fileInConfig, "export default () => {};");

    const resolved = resolveTransformPath("custom.ts", testDir);
    expect(resolved).toBe(fileInConfig);

    const absPath = fileInConfig;
    expect(resolveTransformPath(absPath, testDir)).toBe(absPath);
  });

  test("native wire keeps opaque rows and fields when messages are edited and appended", () => {
    const body = {
      model: "native-model", vendor_option: { keep: true },
      tools: [{ type: "web_search", search_context_size: "low" }],
      input: [
        { role: "user", vendor_message: "keep", content: [
          { type: "input_text", text: "before" },
          { type: "input_image", image_url: "https://example.test/image.png", vendor_image: "keep" },
        ] },
        { type: "reasoning", encrypted_content: "opaque-fixture", id: "rs_fixture" },
        { role: "assistant", content: [{ type: "output_text", text: "answer", annotations: [{ type: "fixture" }] }] },
      ],
    };
    const parsed = parseRequest(body);
    const before = structuredClone(parsed);
    (parsed.context.messages[0]!.content as Array<{ text?: string }>)[0]!.text = "after";
    parsed.context.messages.push({ role: "user", content: "appended", timestamp: 0 });
    syncTransformedResponsesBody(before, parsed);
    expect(parsed._rawBody).toEqual({ ...body, input: [
      { ...body.input[0], content: [
        { type: "input_text", text: "after" },
        { type: "input_image", image_url: "https://example.test/image.png", vendor_image: "keep" },
      ] }, body.input[1], body.input[2], { role: "user", content: "appended" },
    ] });
    expect(body.input[0]!.content?.[0]).toEqual({ type: "input_text", text: "before" });
  });

  test("native synchronization preserves untouched reasoning, custom outputs, files and tool grammar", () => {
    const body = {
      model: "native-model", instructions: "old system", temperature: 0.5,
      reasoning: { effort: "high", summary: "auto", vendor_reasoning: true },
      text: { format: { type: "json_object" }, verbosity: "low" },
      tools: [{ type: "namespace", name: "mcp", vendor_namespace: true, tools: [
        { type: "custom", name: "patch", description: "old", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
      ] }, { type: "web_search", vendor_search: true }],
      input: [
        { role: "user", content: "replace" },
        { type: "reasoning", summary: [{ text: "first" }], encrypted_content: "opaque-one" },
        { type: "reasoning", summary: [{ text: "second" }], encrypted_content: "opaque-two" },
        { type: "custom_tool_call", call_id: "call_patch", name: "patch", input: "patch data" },
        { type: "custom_tool_call_output", call_id: "call_patch", output: "done", vendor_result: true },
        { role: "user", content: [{ type: "input_file", file_id: "file_fixture" }] },
      ],
    };
    const parsed = parseRequest(body);
    const before = structuredClone(parsed);
    parsed.context.messages[0]!.content = "replacement";
    parsed.context.systemPrompt = ["new system"];
    parsed.context.tools![0]!.description = "new";
    delete parsed.options.temperature;
    parsed.options.reasoning = "low";
    delete parsed.options.textFormat;
    syncTransformedResponsesBody(before, parsed);
    const wire = parsed._rawBody as typeof body;
    expect(wire.input).toEqual([{ role: "user", content: "replacement" }, ...body.input.slice(1)]);
    expect(wire.tools).toEqual([{ ...body.tools[0], tools: [{ ...body.tools[0]!.tools![0], description: "new" }] }, body.tools[1]]);
    expect(wire.reasoning).toEqual({ ...body.reasoning, effort: "low" });
    expect(wire.instructions).toBe("new system");
    expect(JSON.parse(JSON.stringify(wire.text))).toEqual({ verbosity: "low" });
    expect(wire).not.toHaveProperty("temperature");
  });

  test("complete replacement retains raw extensions and retry reuse does not append twice", async () => {
    const path = join(testDir, "replacement.ts");
    writeFileSync(path, `export default parsed => ({
      modelId: parsed.modelId, stream: parsed.stream, options: parsed.options,
      context: { ...parsed.context, messages: [...parsed.context.messages, { role: "user", content: "once", timestamp: 0 }] }
    });`);
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", requestTransforms: [path], providers: {
      fixture: { adapter: "openai-responses", baseUrl: "https://fixture.test/v1" },
    } };
    const args = { providerName: "fixture", modelId: "model", providerConfig: config.providers.fixture!, config };
    const parsed = parseRequest({ model: "model", input: "first", vendor_option: "retained" });
    parsed._previousResponseInputExpanded = true;
    const result = await applyRequestTransforms({ ...args, parsed });
    await applyRequestTransforms({ ...args, parsed: result });
    expect(result._rawBody).toEqual({ model: "model", vendor_option: "retained", input: [
      { role: "user", content: "first" }, { role: "user", content: "once" },
    ] });
    expect(result.context.messages).toHaveLength(2);
    expect(result._previousResponseInputExpanded).toBe(true);
  });

  test.each([false, true])("replacement preserves omitted previous response ID, explicit clear=%s", async clear => {
    const path = join(testDir, "previous-id.ts");
    writeFileSync(path, `export default parsed => ({
      modelId: parsed.modelId, stream: parsed.stream, context: parsed.context, options: parsed.options,
      ${clear ? "previousResponseId: undefined," : ""}
    });`);
    const providerConfig: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://fixture.test/v1" };
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", requestTransforms: [path], providers: { fixture: providerConfig } };
    const parsed = parseRequest({ model: "model", input: "next", previous_response_id: "resp_previous" });
    const scope = { clientThreadId: "fixture-thread" };
    parsed._reasoningReplayScope = scope;
    const result = await applyRequestTransforms({ parsed, providerName: "fixture", modelId: "model", providerConfig, config });
    expect(result.previousResponseId).toBe(clear ? undefined : "resp_previous");
    expect((result._rawBody as Record<string, unknown>).previous_response_id).toBe(clear ? undefined : "resp_previous");
    expect(result._reasoningReplayScope).toBe(scope);
  });

  test.each([
    "parsed.context.messages = null;",
    "parsed.options = null; return parsed;",
    "return {};",
    "throw new Error('private-request-fixture');",
    "return Promise.reject(new Error('private-request-fixture'));",
    // Passes the shallow shape check, but cannot be serialized as assistant content.
    "parsed.context.messages.push({ role: 'assistant', content: null, timestamp: 0 });",
  ])("failed hook rolls back edits and later hooks receive the last valid request: %s", async failure => {
    const paths = ["first", "failed", "last"].map(name => join(testDir, `${name}.ts`));
    writeFileSync(paths[0]!, `export default parsed => { parsed.context.messages.push({ role: "user", content: "first", timestamp: 0 }); };`);
    writeFileSync(paths[1]!, `export default parsed => {
      parsed.context.messages[0].content = "bad";
      parsed.options.temperature = 99;
      parsed._rawBody.vendor.keep = false;
      ${failure}
    };`);
    writeFileSync(paths[2]!, `export default parsed => { parsed.context.messages.push({ role: "user", content: "last", timestamp: 0 }); };`);
    const providerConfig: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://fixture.test/v1" };
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", requestTransforms: paths, providers: { fixture: providerConfig } };
    const parsed = parseRequest({ model: "model", input: "original", temperature: 0.5, vendor: { keep: true } });
    const scope = { clientThreadId: "fixture-thread" };
    parsed._reasoningReplayScope = scope;
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const result = await applyRequestTransforms({ parsed, providerName: "fixture", modelId: "model", providerConfig, config });
      expect(result.context.messages.map(message => message.content)).toEqual(["original", "first", "last"]);
      expect(result.options.temperature).toBe(0.5);
      expect(result._rawBody).toEqual({ model: "model", temperature: 0.5, vendor: { keep: true }, input: [
        { role: "user", content: "original" }, { role: "user", content: "first" }, { role: "user", content: "last" },
      ] });
      expect(result._reasoningReplayScope).toBe(scope);
      expect(result._requestTransformsApplied).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings)).not.toContain("private-request-fixture");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("transform context is deeply readonly and cannot mutate live or later-hook configuration", async () => {
    // Compile-time contract: callers cannot write through either configuration view.
    const assertReadonly = (context: RequestTransformContext) => {
      // @ts-expect-error nested global configuration is readonly
      context.config.providers.fixture.baseUrl = "changed";
      // @ts-expect-error nested effective provider configuration is readonly
      context.providerConfig.headers.fixture = "changed";
      // @ts-expect-error route metadata is readonly
      context.providerName = "changed";
    };
    void assertReadonly;
    const paths = ["mutate-config", "observe-config"].map(name => join(testDir, `${name}.ts`));
    writeFileSync(paths[0]!, `export default (parsed, context) => {
      for (const mutate of [
        () => { context.config.providers.fixture.baseUrl = "changed"; },
        () => { context.providerConfig.headers.fixture = "changed"; },
        () => { context.config.requestTransforms.push("changed"); },
        () => { context.providerName = "changed"; },
      ]) { try { mutate(); } catch (error) { if (!(error instanceof TypeError)) throw error; } }
    };`);
    writeFileSync(paths[1]!, `export default (parsed, context) => {
      parsed.context.messages.push({ role: "user", timestamp: 0, content: JSON.stringify({
        url: context.config.providers.fixture.baseUrl, header: context.providerConfig.headers.fixture,
        count: context.config.requestTransforms.length, provider: context.providerName,
        frozen: [context, context.config, context.config.providers.fixture, context.providerConfig.headers, context.config.requestTransforms].every(Object.isFrozen)
      }) });
    };`);
    const providerConfig: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://fixture.test/v1", headers: { fixture: "original" } };
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", requestTransforms: paths, providers: { fixture: providerConfig } };
    const before = structuredClone(config);
    const result = await applyRequestTransforms({ parsed: parseRequest({ model: "model", input: "original" }), providerName: "fixture", modelId: "model", providerConfig, config });
    expect(JSON.parse(result.context.messages[1]!.content as string)).toEqual({
      url: "https://fixture.test/v1", header: "original", count: 2, provider: "fixture", frozen: true,
    });
    expect(config).toEqual(before);
    expect(Object.isFrozen(config)).toBe(false);
    expect(Object.isFrozen(providerConfig.headers)).toBe(false);
  });

  test("replacement requests are rebound to the settled turn termination scope", () => {
    const source = readFileSync(repoPath("src/server/responses/core.ts"), "utf8");
    const start = source.indexOf("parsed = await applyRequestTransforms({");
    const end = source.indexOf("const toolBridgeMaps =", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("bindTurnTerminationScope(parsed, resolvedConversationId)");
  });

  test("editing a large continuation preserves every other native row and its metadata", () => {
    const rows = Array.from({ length: 1000 }, (_, index) => [
      { role: "user", content: `question ${index}`, vendor_id: `user-${index}` },
      { role: "assistant", content: [{ type: "output_text", text: `answer ${index}`, annotations: [{ type: "fixture", index }] }], vendor_id: `assistant-${index}` },
    ]).flat();
    const body = { model: "model", input: rows, previous_response_id: "resp_history" };
    const parsed = parseRequest(body);
    const before = structuredClone(parsed);
    parsed.context.messages[0]!.content = "edited question";
    syncTransformedResponsesBody(before, parsed);
    expect(parsed._rawBody).toEqual({ ...body, input: [{ ...rows[0], content: "edited question" }, ...rows.slice(1)] });
    expect(body.input).toEqual(rows);
    expect(body.input[0]!.content).toBe("question 0");
  });

  test("no-op transforms leave native input and catalog untouched", () => {
    const body = { model: "model", input: [{ type: "item_reference", id: "opaque" }], vendor: { keep: true } };
    const parsed = parseRequest(body);
    syncTransformedResponsesBody(structuredClone(parsed), parsed);
    expect(parsed._rawBody).toEqual(body);
    expect((parsed._rawBody as typeof body).input).toBe(body.input);
  });

  test("editing one repeated message keeps each native message's own metadata", () => {
    const body = { model: "model", input: [
      { role: "user", content: "continue", vendor_id: "first" },
      { role: "user", content: "continue", vendor_id: "second" },
    ] };
    const parsed = parseRequest(body);
    const before = structuredClone(parsed);
    parsed.context.messages[0]!.content = "changed";
    syncTransformedResponsesBody(before, parsed);
    expect((parsed._rawBody as typeof body).input).toEqual([
      { role: "user", content: "changed", vendor_id: "first" }, body.input[1],
    ]);
  });

  test.each(["openai-responses", "openai-chat"])("%s dispatch uses transformed messages and namespaced tool metadata", async adapter => {
    const path = join(testDir, "integration.ts");
    writeFileSync(path, `export default function(parsed) {
      parsed.context.messages.push({ role: "user", content: "hook-message", timestamp: 0 });
      parsed.context.tools = [{ namespace: "changed", name: "lookup", description: "new tool", parameters: { type: "object", properties: {} } }];
    }`);
    const config: OcxConfig = {
      port: 0, defaultProvider: "fixture", requestTransforms: [path],
      providers: { fixture: { adapter, baseUrl: "https://fixture.test/v1", apiKey: "fixture", models: ["test-model"] } },
    };
    const originalFetch = globalThis.fetch;
    const outbound: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      outbound.push(JSON.parse(String(init?.body)));
      return Response.json(adapter === "openai-responses" ? {
        id: "resp_transform", status: "completed", output: [{ type: "function_call", id: "fc_transform", call_id: "call_transform", name: "changed__lookup", arguments: "{}", status: "completed" }],
      } : {
        id: "chat_transform", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
          tool_calls: [{ id: "call_transform", type: "function", function: { name: "changed__lookup", arguments: "{}" } }] } }],
      });
    }) as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/test-model", stream: false, input: "original", vendor_option: { keep: true },
          tools: [{ type: "function", name: "old", parameters: { type: "object" } }] }),
      }), config, { model: "", provider: "" });
      const result = await response.json() as { output: Array<Record<string, unknown>> };
      expect(response.status).toBe(200);
      expect(outbound).toHaveLength(1);
      expect(JSON.stringify(outbound[0])).toContain("hook-message");
      expect(JSON.stringify(outbound[0]!.tools)).toContain("changed__lookup");
      expect(JSON.stringify(outbound[0]!.tools)).not.toContain('"old"');
      if (adapter === "openai-responses") expect(outbound[0]!.vendor_option).toEqual({ keep: true });
      expect(result.output).toContainEqual(expect.objectContaining({ type: "function_call", namespace: "changed", name: "lookup" }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("applyRequestTransforms runs global and provider transforms and marks applied", async () => {
    const transform1Path = join(testDir, "t1.ts");
    const transform2Path = join(testDir, "t2.ts");

    writeFileSync(
      transform1Path,
      `export default function (parsed, ctx) {
        parsed.context.messages.push({
          role: "user",
          content: "transformed-by-t1 (" + ctx.providerName + ":" + ctx.modelId + ")",
          timestamp: Date.now(),
        });
      };`,
    );

    writeFileSync(
      transform2Path,
      `export function transform(parsed, ctx) {
        parsed.context.messages.push({
          role: "assistant",
          content: "transformed-by-t2 (acceptsImage:" + ctx.acceptsImageInput + ")",
          timestamp: Date.now(),
        });
        return parsed;
      };`,
    );

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://example.com",
          requestTransforms: [transform2Path],
        },
      },
      requestTransforms: [transform1Path],
    };

    const initialParsed: OcxParsedRequest = {
      modelId: "gemini-3.1-pro",
      context: {
        messages: [],
      },
      stream: true,
      options: {},
    };

    const result = await applyRequestTransforms({
      parsed: initialParsed,
      providerName: "google-antigravity",
      modelId: "gemini-3.1-pro",
      providerConfig: config.providers["google-antigravity"],
      config,
    });

    expect(result._requestTransformsApplied).toBe(true);
    expect(result.context.messages.length).toBe(2);
    expect((result.context.messages[0] as any).content).toContain("transformed-by-t1 (google-antigravity:gemini-3.1-pro)");
    expect((result.context.messages[1] as any).content).toBe("transformed-by-t2 (acceptsImage:true)");

    // Running again does not duplicate executions (single run per turn)
    await applyRequestTransforms({
      parsed: result,
      providerName: "google-antigravity",
      modelId: "gemini-3.1-pro",
      providerConfig: config.providers["google-antigravity"],
      config,
    });
    expect(result.context.messages.length).toBe(2);
  });

  test("gracefully handles failing or throwing transforms without crashing", async () => {
    const failingTransformPath = join(testDir, "failing.ts");
    writeFileSync(failingTransformPath, "export default () => { throw new Error(\"boom\"); };");

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://example.com" },
      },
      requestTransforms: [failingTransformPath, "non-existent-module-xyz"],
    };

    const initialParsed: OcxParsedRequest = {
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: false,
      options: {},
    };

    const result = await applyRequestTransforms({
      parsed: initialParsed,
      providerName: "openai",
      modelId: "gpt-5.5",
      providerConfig: config.providers.openai,
      config,
    });

    expect(result._requestTransformsApplied).toBe(true);
  });

  test("rejects malformed replacement objects like {} and retains current request", async () => {
    const invalidTransformPath = join(testDir, "invalid.ts");
    writeFileSync(invalidTransformPath, "export default () => { return {}; };");

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://example.com" },
      },
      requestTransforms: [invalidTransformPath],
    };

    const initialParsed: OcxParsedRequest = {
      modelId: "gpt-5.5",
      context: { messages: [{ role: "user", content: "original-message", timestamp: 123 }] },
      stream: false,
      options: {},
    };

    const result = await applyRequestTransforms({
      parsed: initialParsed,
      providerName: "openai",
      modelId: "gpt-5.5",
      providerConfig: config.providers.openai,
      config,
    });

    expect(result._requestTransformsApplied).toBe(true);
    expect(result.modelId).toBe("gpt-5.5");
    expect(result.context.messages.length).toBe(1);
    expect((result.context.messages[0] as any).content).toBe("original-message");
  });

  test("configSchema and providerConfigSchema validate requestTransforms correctly", () => {
    const valid = validateConfigCandidate({
      port: 10100,
      defaultProvider: "openai",
      requestTransforms: ["./transforms/pxpipe.ts"],
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://example.com",
          requestTransforms: ["./transforms/provider-transform.ts"],
        },
      },
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.config.requestTransforms).toEqual(["./transforms/pxpipe.ts"]);
      expect(valid.config.providers.openai.requestTransforms).toEqual(["./transforms/provider-transform.ts"]);
    }
  });

  test("providerManagementConfigError rejects executable transform configuration even for canonical openai", () => {
    const entry = getProviderRegistryEntry("openai");
    if (!entry) return;
    const seed = providerConfigSeed(entry);

    const validCandidate = { ...seed, codexAccountMode: "pool" as const, requestTransforms: ["./custom.ts"] };
    expect(providerManagementConfigError("openai", validCandidate))
      .toBe("requestTransforms may only be configured in the local config file");

    const invalidCandidate = { ...seed, codexAccountMode: "pool" as const, requestTransforms: [""] };
    expect(providerManagementConfigError("openai", invalidCandidate))
      .toBe("requestTransforms may only be configured in the local config file");
  });
});
