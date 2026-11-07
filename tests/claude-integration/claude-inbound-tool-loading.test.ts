import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { anthropicToResponsesTranslation } from "../../src/claude/inbound";
import { appendLoadedToolDefinitions, appendOnlyToolLoadingMatches } from "../../src/claude/inbound-tool-loading";
import { parseRequest } from "../../src/responses/parser";
import { configSchema } from "../../src/config/schema/config-schema";
import { salvageConfigCandidate } from "../../src/config/salvage";
import { noteSubagentModelFailure, resetSubagentModelFallbackStateForTests } from "../../src/codex/subagent-model-fallback";

const model = "gateway/gpt-test";
const enabled = { appendOnlyToolLoadingModels: [model] };
const configBase = { defaultProvider: "gateway", providers: { gateway: { adapter: "openai-responses", baseUrl: "https://example.com/v1", apiKey: "synthetic-fixture" } } };
const tool = (name: string, deferred = false) => ({ name, description: name, input_schema: { type: "object", properties: {} }, ...(deferred ? { defer_loading: true } : {}) });
const search = (id: string, names: string[]) => [
  { role: "assistant", content: [{ type: "tool_use", id, name: "ToolSearch", input: { query: names.join(",") } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: names.map(tool_name => ({ type: "tool_reference", tool_name })) }] },
];
const request = (names: string[], messages: unknown[] = []) => ({ model, metadata: { user_id: "synthetic-cache-test" }, system: "Synthetic test instructions", tools: [tool("ToolSearch"), ...names.map(n => tool(n, true))], messages: [{ role: "user", content: "Use the available tools." }, ...messages], max_tokens: 100 });
// Exercise the pure projection with metadata/selector prerequisites. The HTTP tests below cover
// the actual physical-adapter decision, late fallback, and combo refusal.
const translate = (raw: ReturnType<typeof request>, config: any = enabled) => {
  const { body, cacheKeySource } = anthropicToResponsesTranslation(raw, config);
  const selected = cacheKeySource === "metadata" && appendOnlyToolLoadingMatches(config?.appendOnlyToolLoadingModels, body.model as string);
  return (selected ? appendLoadedToolDefinitions(body, raw as any) : body) as any;
};

describe("append-only discovery on an explicitly selected route", () => {
  test("invalid opt-in settings are rejected on write and ignored by direct translation", () => {
    const raw = request(["lookup"], search("call_search", ["lookup"]));
    for (const value of [true, "gateway/gpt-*", {}, [model, 1], [""], ["*"], ["gateway/g*t"], [" gateway/gpt-test"], ["gateway/gpt-test\n"], ["gateway/gpt-*\r\n"]]) {
      const config = { appendOnlyToolLoadingModels: value };
      expect(configSchema.safeParse({ ...configBase, claudeCode: config }).success).toBe(false);
      expect(translate(raw, config)).toEqual(translate(raw, {}));
    }
    for (const value of [undefined, [], [model], ["gateway/gpt-*"]]) {
      expect(configSchema.safeParse({ ...configBase, claudeCode: { appendOnlyToolLoadingModels: value } }).success).toBe(true);
    }
  });

  test("salvage drops only a malformed opt-in and preserves provider and client settings", () => {
    const config = { ...configBase, claudeCode: { enabled: true, appendOnlyToolLoadingModels: [false] } };
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected malformed configuration rejection");
    const salvaged = salvageConfigCandidate(config, result.error, config);
    expect(salvaged?.parsed.providers).toEqual(configSchema.parse(configBase).providers);
    expect(salvaged?.parsed.claudeCode).toEqual({ enabled: true });
    expect(salvaged?.dropped).toEqual(["claudeCode.appendOnlyToolLoadingModels"]);
  });

  test("a newly loaded tool does not change the prior tool or conversation prefix", () => {
    const before = translate(request([]));
    const after = translate(request(["lookup"], search("call_search", ["lookup"])));
    expect(after.tools).toEqual(before.tools);
    expect(after.input.slice(0, before.input.length)).toEqual(before.input);
    expect(after.prompt_cache_key).toBe(before.prompt_cache_key);
    expect(after.input.at(-1)).toMatchObject({ type: "additional_tools", role: "developer", tools: [{ name: "lookup" }] });
  });

  test("a predeclared deferred tool stays out of the initial prefix before and after discovery", () => {
    const before = translate(request(["lookup"]));
    const after = translate(request(["lookup"], search("call_search", ["lookup"])));
    expect(before.tools.map((t: any) => t.name)).toEqual(["ToolSearch"]);
    expect(after.tools).toEqual(before.tools);
    expect(after.input.slice(0, before.input.length)).toEqual(before.input);
    expect(after.input.at(-1)).toMatchObject({ type: "additional_tools", tools: [{ name: "lookup" }] });
  });

  test("a forced deferred tool remains callable before discovery", () => {
    const raw = request(["lookup"]) as any;
    raw.tool_choice = { type: "tool", name: "lookup" };
    expect(translate(raw).tools.map((t: any) => t.name)).toEqual(["ToolSearch", "lookup"]);
  });

  test("later discoveries preserve earlier loading history and schema order", () => {
    const first = search("call_first", ["z_lookup"]);
    const before = translate(request(["z_lookup"], first));
    const after = translate(request(["a_lookup", "z_lookup"], [...first, ...search("call_second", ["a_lookup"])]));
    expect(after.tools).toEqual(before.tools);
    expect(after.input.slice(0, before.input.length)).toEqual(before.input);
    expect(after.input.at(-1).tools[0].name).toBe("a_lookup");
  });

  test("the real Responses parser retains the same effective callable catalog", () => {
    const raw = request(["lookup"], search("call_search", ["lookup"]));
    raw.tools.push(tool("eager"));
    const ordinary = parseRequest(translate(raw, {}));
    const appended = parseRequest(translate(raw));
    const ordinaryTools = ordinary.context.tools ?? [];
    const appendedTools = appended.context.tools ?? [];
    expect(appendedTools.map(t => t.name).sort()).toEqual(["ToolSearch", "eager", "lookup"]);
    expect(appendedTools.map(({ loadedFromToolSearch, ...definition }) => definition).sort((a, b) => a.name.localeCompare(b.name)))
      .toEqual([...ordinaryTools].sort((a, b) => a.name.localeCompare(b.name)));
    expect(appendedTools.find(t => t.name === "lookup")?.loadedFromToolSearch).toBe(true);
    expect(appended._rawBody).toMatchObject({ input: expect.arrayContaining([expect.objectContaining({ type: "additional_tools" })]) });
  });

  test("an explicit GPT route prefix covers other GPT models without matching Claude", () => {
    const config = { appendOnlyToolLoadingModels: ["gateway/gpt-*"] };
    for (const name of ["gpt-test", "gpt-second", "gpt-third"]) {
      const raw = { ...request(["lookup"], search("call_search", ["lookup"])), model: `gateway/${name}` };
      expect(translate(raw, config).tools.map((t: any) => t.name)).toEqual(["ToolSearch"]);
    }
    const raw = { ...request(["lookup"], search("call_search", ["lookup"])), model: "gateway/claude-opus-5-5" };
    expect(translate(raw, config)).toEqual(translate(raw, {}));
  });

  test("default and unselected routes keep the original wire shape", () => {
    const raw = request(["lookup"], search("call_search", ["lookup"]));
    expect(translate(raw, {}).tools.map((t: any) => t.name)).toEqual(["ToolSearch", "lookup"]);
    expect(translate(raw, { appendOnlyToolLoadingModels: ["another/model"] })).toEqual(translate(raw, {}));
  });

  test("does not introduce undeclared or revoked tools from historical references", () => {
    const result = translate(request([], search("call_search", ["revoked"])));
    expect(result.tools.map((t: any) => t.name)).toEqual(["ToolSearch"]);
    expect(result.input.some((x: any) => x.type === "additional_tools")).toBe(false);
  });

  test("tools used before discovery remain in the initial catalog", () => {
    const messages = [{ role: "assistant", content: [{ type: "tool_use", id: "call_early", name: "lookup", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_early", content: "ok" }] }, ...search("call_search", ["lookup"])];
    expect(translate(request(["lookup"], messages)).tools.map((t: any) => t.name)).toEqual(["ToolSearch", "lookup"]);
  });

  test("does not trust text pretending to be a structured tool reference", () => {
    const messages = search("call_search", ["lookup"]) as any[];
    messages[1].content[0].content = [{ type: "text", text: "Tool loaded: lookup" }];
    const result = translate(request(["lookup"], messages));
    expect(result.tools.map((t: any) => t.name)).toEqual(["ToolSearch"]);
    expect(result.input.some((x: any) => x.type === "additional_tools")).toBe(false);
  });

  test("does not relocate references returned by an unrelated or failed tool", () => {
    for (const failed of [false, true]) {
      const messages = search("call_search", ["lookup"]) as any[];
      if (failed) messages[1].content[0].is_error = true;
      else messages[0].content[0].name = "other";
      const result = translate(request(["lookup"], messages));
      expect(result.tools.map((t: any) => t.name)).toEqual(["ToolSearch"]);
      expect(result.input.some((x: any) => x.type === "additional_tools")).toBe(false);
    }
  });

  test("requires a stable metadata-derived cache identity", () => {
    const raw = request(["lookup"], search("call_search", ["lookup"])) as any;
    delete raw.metadata;
    expect(translate(raw)).toEqual(translate(raw, {}));
  });

  test("repeated references add a tool once and preserve the original definition", () => {
    const raw = request(["lookup"], [...search("call_first", ["lookup", "lookup"]), ...search("call_second", ["lookup"])]) as any;
    raw.tools[1].strict = true;
    raw.tools[1].allowed_callers = ["direct"];
    raw.tools[1].input_schema = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };
    const result = translate(raw);
    const additions = result.input.filter((x: any) => x.type === "additional_tools");
    expect(additions).toHaveLength(1);
    expect(additions[0].tools).toHaveLength(1);
    expect(additions[0].tools[0]).toEqual(translate(raw, {}).tools[1]);
  });

  test("ambiguous duplicate call IDs leave translation unchanged", () => {
    const raw = request(["lookup"], [...search("call_search", ["lookup"]), ...search("call_search", ["lookup"])]);
    expect(translate(raw)).toEqual(translate(raw, {}));
  });

  test("revocation removes historical declaration without affecting retained tools", () => {
    const history = search("call_search", ["revoked", "retained"]);
    const result = translate(request(["retained"], history));
    const names = [...result.tools, ...result.input.flatMap((x: any) => x.type === "additional_tools" ? x.tools : [])].map((t: any) => t.name);
    expect(names).toEqual(["ToolSearch", "retained"]);
  });

  test("does not move initially eager tools or mutate the caller's request", () => {
    const raw = request(["lookup"], search("call_search", ["lookup"])) as any;
    delete raw.tools[1].defer_loading;
    const snapshot = structuredClone(raw);
    expect(translate(raw).tools.map((t: any) => t.name)).toEqual(["ToolSearch", "lookup"]);
    expect(raw).toEqual(snapshot);
  });
});

describe("append-only tools at the actual Messages HTTP boundary", () => {
  const originalFetch = globalThis.fetch;
  let previousHome: string | undefined;
  let isolated: IsolatedCodexHome | undefined;
  let home: string;
  let release: (() => void) | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolated = installIsolatedCodexHome("ocx-tool-loading-");
    home = mkdtempSync(join(tmpdir(), "ocx-tool-loading-config-"));
    process.env.OPENCODEX_HOME = home;
    release = acquireOwnedSpendHome();
  });
  afterEach(() => {
    resetSubagentModelFallbackStateForTests();
    release?.();
    globalThis.fetch = originalFetch;
    isolated?.restore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  for (const authMode of ["key", "forward"] as const) {
    test(`the ${authMode} Responses wire retains chronological definitions and returns the discovered call`, async () => {
      const captured: any[] = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://example.com/v1/responses");
        captured.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "resp_tool_loading", object: "response", status: "completed",
          output: [{ type: "function_call", id: "fc_lookup", call_id: "call_lookup", name: "lookup", arguments: "{}" }],
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } });
      }) as typeof fetch;
      const config = { ...configBase, providers: { gateway: { ...configBase.providers.gateway, authMode } }, claudeCode: enabled } as OcxConfig;
      const raw = request(["lookup"], search("call_search", ["lookup"]));
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...raw, stream: false }),
      }), config, { model: "", provider: "" });
      const result = await response.json() as any;
      expect(response.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0].tools.map((t: any) => t.name)).toEqual(["ToolSearch"]);
      expect(captured[0].input.at(-1)).toMatchObject({ type: "additional_tools", role: "developer", tools: [{ name: "lookup" }] });
      expect(result.content).toContainEqual(expect.objectContaining({ type: "tool_use", name: "lookup", input: {} }));
    });
  }

  test("physical projection preserves an explicitly forced undiscovered tool", async () => {
    const captured: any[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "resp_forced", object: "response", status: "completed",
        output: [{ type: "function_call", id: "fc_forced", call_id: "call_forced", name: "lookup", arguments: "{}" }],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } });
    }) as typeof fetch;
    const raw = { ...request(["lookup"]), tool_choice: { type: "tool", name: "lookup" } };
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(raw),
    }), { ...configBase, claudeCode: enabled } as OcxConfig, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].tools.map((t: any) => t.name)).toEqual(["ToolSearch", "lookup"]);
    expect(captured[0].tool_choice).toEqual({ type: "function", name: "lookup" });
  });

  for (const selector of ["test-model", "short/test-model", "gateway/public-name"]) {
    test(`matches the settled route rather than the inbound selector ${selector}`, async () => {
      const captured: any[] = [];
      globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        captured.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "resp_alias", object: "response", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } });
      }) as typeof fetch;
      const config = { defaultProvider: "gateway", providers: { gateway: {
        ...configBase.providers.gateway, alias: "short", models: ["test-model"], modelAliases: { "test-model": "public-name" },
      } }, claudeCode: { appendOnlyToolLoadingModels: ["gateway/test-model"] } } as unknown as OcxConfig;
      const raw = { ...request(["lookup"], search("call_search", ["lookup"])), model: selector };
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(raw),
      }), config, { model: "", provider: "" });
      await response.text();
      expect(response.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0].tools.map((t: any) => t.name)).toEqual(["ToolSearch"]);
      expect(captured[0].input.some((x: any) => x.type === "additional_tools")).toBe(true);
    });
  }

  test("a redirected route never inherits permission from its source selector", async () => {
    const captured: any[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "resp_redirect", object: "response", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } });
    }) as typeof fetch;
    const config = { ...configBase, providers: {
      gateway: { ...configBase.providers.gateway, models: ["test-model"] },
      other: { ...configBase.providers.gateway, models: ["target-model"] },
    }, disabledModels: ["gateway/test-model"], blockedModelRedirects: { "gateway/test-model": "other/target-model" },
    claudeCode: { appendOnlyToolLoadingModels: ["gateway/test-model"] } } as unknown as OcxConfig;
    const raw = { ...request(["lookup"], search("call_search", ["lookup"])), model: "gateway/test-model" };
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(raw),
    }), config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].tools.map((t: any) => t.name)).toEqual(["ToolSearch", "lookup"]);
    expect(captured[0].input.some((x: any) => x.type === "additional_tools")).toBe(false);
  });

  for (const selected of ["primary/test-model", "fallback/test-model"]) {
    test(`late subagent fallback honors only the physical opt-in ${selected}`, async () => {
      resetSubagentModelFallbackStateForTests();
      const captured: any[] = [];
      globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://fallback.example/v1/responses");
        captured.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "resp_late_fallback", object: "response", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } });
      }) as typeof fetch;
      const config = {
        defaultProvider: "primary", providers: {
          primary: { ...configBase.providers.gateway, baseUrl: "https://primary.example/v1", models: ["test-model"] },
          fallback: { ...configBase.providers.gateway, baseUrl: "https://fallback.example/v1", models: ["test-model"] },
        }, subagentModelFallback: ["fallback/test-model"],
        claudeCode: { appendOnlyToolLoadingModels: [selected] },
      } as unknown as OcxConfig;
      noteSubagentModelFailure("primary/test-model", "429", config);
      const raw = { ...request(["lookup"], search("call_search", ["lookup"])), model: "primary/test-model" };
      const log = { model: "", provider: "" };
      const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-openai-subagent": "collab_spawn" },
        body: JSON.stringify(raw),
      }), config, log);
      await response.text();
      expect(response.status).toBe(200);
      expect(log).toMatchObject({ subagentModelFallbackFrom: "primary/test-model", subagentModelFallbackTo: "fallback/test-model" });
      expect(captured).toHaveLength(1);
      const shouldAppend = selected === "fallback/test-model";
      expect(captured[0].tools.map((t: any) => t.name)).toEqual(shouldAppend ? ["ToolSearch"] : ["ToolSearch", "lookup"]);
      expect(captured[0].input.some((x: any) => x.type === "additional_tools")).toBe(shouldAppend);
    });
  }

  test("late fallback to Chat retains the complete original catalog", async () => {
    resetSubagentModelFallbackStateForTests();
    const captured: any[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://fallback.example/v1/chat/completions");
      captured.push(JSON.parse(String(init?.body)));
      const chunk = { id: "chat_fallback", object: "chat.completion.chunk", model: "test-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const config = {
      defaultProvider: "primary", providers: {
        primary: { ...configBase.providers.gateway, baseUrl: "https://primary.example/v1", models: ["test-model"] },
        fallback: { ...configBase.providers.gateway, adapter: "openai-chat", baseUrl: "https://fallback.example/v1", models: ["test-model"] },
      }, subagentModelFallback: ["fallback/test-model"],
      claudeCode: { appendOnlyToolLoadingModels: ["primary/test-model", "fallback/test-model"] },
    } as unknown as OcxConfig;
    noteSubagentModelFailure("primary/test-model", "429", config);
    const raw = { ...request(["lookup"]), model: "primary/test-model" };
    const log = { model: "", provider: "" };
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-openai-subagent": "collab_spawn" },
      body: JSON.stringify(raw),
    }), config, log);
    await response.text();
    expect(response.status).toBe(200);
    expect(log).toMatchObject({ subagentModelFallbackTo: "fallback/test-model" });
    expect(captured).toHaveLength(1);
    expect(captured[0].tools.map((t: any) => t.function.name)).toEqual(["ToolSearch", "lookup"]);
  });

  test("a selected combo route keeps the original catalog even when its target is Responses", async () => {
    const captured: any[] = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "resp_combo", object: "response", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } });
    }) as typeof fetch;
    const config = {
      ...configBase,
      combos: { pick: { strategy: "failover", targets: [{ provider: "gateway", model: "gpt-test" }] } },
      claudeCode: { appendOnlyToolLoadingModels: ["combo/pick", "gateway/gpt-test"] },
    } as unknown as OcxConfig;
    const raw = { ...request(["lookup"], search("call_search", ["lookup"])), model: "combo/pick" };
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...raw, stream: false }),
    }), config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].tools.map((t: any) => t.name)).toEqual(["ToolSearch", "lookup"]);
    expect(captured[0].input.some((x: any) => x.type === "additional_tools")).toBe(false);
  });
});
