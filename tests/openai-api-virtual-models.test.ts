import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvalidOpenAiVirtualModelRegistryError,
  applyOpenAiVirtualModel,
  resolveOpenAiCompactModel,
  resolveOpenAiVirtualModel,
  validateOpenAiVirtualModelDefinition,
} from "../src/providers/openai-virtual-models";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { usageLogPath } from "../src/usage/log";

const moduleOriginalFetch = globalThis.fetch;
const moduleOriginalHome = process.env.OPENCODEX_HOME;
afterEach(() => {
  globalThis.fetch = moduleOriginalFetch;
  if (moduleOriginalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = moduleOriginalHome;
});

describe("OpenAI API virtual model resolution", () => {
  // 1. Each Pro virtual id resolves to base + reasoningMode "pro"
  for (const [virtual, base] of [
    ["gpt-5.6-sol-pro", "gpt-5.6-sol"],
    ["gpt-5.6-terra-pro", "gpt-5.6-terra"],
    ["gpt-5.6-luna-pro", "gpt-5.6-luna"],
  ] as const) {
    test(`${virtual} resolves to ${base} with mode pro on openai-apikey`, () => {
      const result = resolveOpenAiVirtualModel("openai-apikey", virtual);
      expect(result).toBeDefined();
      expect(result!.wireModelId).toBe(base);
      expect(result!.reasoningMode).toBe("pro");
      expect(result!.selectedModelId).toBe(virtual);
    });
  }

  // 2. Base models are NOT virtual
  for (const base of ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    test(`base model ${base} is not virtual on openai-apikey`, () => {
      expect(resolveOpenAiVirtualModel("openai-apikey", base)).toBeUndefined();
    });
  }

  // 3. Non-API providers never resolve virtuals
  for (const provider of ["openai", "anthropic", "cursor"]) {
    test(`${provider} never resolves virtual models`, () => {
      expect(resolveOpenAiVirtualModel(provider, "gpt-5.6-sol-pro")).toBeUndefined();
    });
  }

  // 4. Unknown -pro suffix is not virtual
  test("unknown model with -pro suffix is not virtual", () => {
    expect(resolveOpenAiVirtualModel("openai-apikey", "gpt-99-pro")).toBeUndefined();
  });

  test.each(["__proto__", "constructor", "toString"])("prototype key %s is an ordinary no-match", model => {
    expect(resolveOpenAiVirtualModel("openai-apikey", model)).toBeUndefined();
    expect(resolveOpenAiCompactModel("openai-apikey", model)).toBeUndefined();
  });
});

describe("applyOpenAiVirtualModel", () => {
  test("rewrites Pro request: model to base, merges reasoning.mode=pro, preserves effort", () => {
    const parsed = {
      modelId: "gpt-5.6-sol-pro",
      _rawBody: { model: "gpt-5.6-sol-pro", reasoning: { effort: "high" } },
      options: { reasoning: "high" },
    } as any;
    const route = { providerName: "openai-apikey", modelId: "gpt-5.6-sol-pro", provider: {} } as any;
    const logCtx = { model: "gpt-5.6-sol-pro", provider: "openai-apikey" } as any;
    applyOpenAiVirtualModel(parsed, route, logCtx);
    expect(parsed.modelId).toBe("gpt-5.6-sol");
    expect(parsed._rawBody.model).toBe("gpt-5.6-sol");
    expect(parsed._rawBody.reasoning).toEqual({ effort: "high", mode: "pro" });
    expect(route.modelId).toBe("gpt-5.6-sol");
    expect(logCtx.model).toBe("gpt-5.6-sol-pro");
    expect(logCtx.resolvedModel).toBe("gpt-5.6-sol");
    expect(applyOpenAiVirtualModel(parsed, route, logCtx)).toEqual({
      selectedModelId: "gpt-5.6-sol-pro",
      wireModelId: "gpt-5.6-sol",
      reasoningMode: "pro",
    });
    expect(parsed._rawBody.reasoning).toEqual({ effort: "high", mode: "pro" });
  });

  test.each([undefined, null])("omitted/null reasoning becomes mode pro", reasoning => {
    const raw: Record<string, unknown> = { model: "gpt-5.6-luna-pro" };
    if (reasoning !== undefined) raw.reasoning = reasoning;
    const parsed = { modelId: "gpt-5.6-luna-pro", _rawBody: raw, options: {} } as any; // justified: focused mutation fixture
    const route = { providerName: "openai-apikey", modelId: "gpt-5.6-luna-pro", provider: {} } as any; // justified: focused mutation fixture
    const logCtx = { model: "gpt-5.6-luna-pro", requestedModel: "openai-apikey/gpt-5.6-luna-pro", provider: "openai-apikey" } as any; // justified: focused mutation fixture
    expect(applyOpenAiVirtualModel(parsed, route, logCtx)?.wireModelId).toBe("gpt-5.6-luna");
    expect(raw.reasoning).toEqual({ mode: "pro" });
  });

  test("conflicting mode is replaced while supported reasoning fields survive", () => {
    const raw = { model: "gpt-5.6-terra-pro", reasoning: { mode: "other", effort: "max", summary: "auto", generate_summary: "concise" } };
    const parsed = { modelId: "gpt-5.6-terra-pro", _rawBody: raw, options: {} } as any; // justified: focused mutation fixture
    const route = { providerName: "openai-apikey", modelId: "gpt-5.6-terra-pro", provider: {} } as any; // justified: focused mutation fixture
    const logCtx = { model: "gpt-5.6-terra-pro", provider: "openai-apikey" } as any; // justified: focused mutation fixture
    applyOpenAiVirtualModel(parsed, route, logCtx);
    expect(raw.reasoning).toEqual({ mode: "pro", effort: "max", summary: "auto", generate_summary: "concise" });
  });

  test("non-virtual model is unchanged", () => {
    const parsed = { modelId: "gpt-5.6-sol", _rawBody: { model: "gpt-5.6-sol" }, options: {} } as any;
    const route = { providerName: "openai-apikey", modelId: "gpt-5.6-sol", provider: {} } as any;
    const logCtx = { model: "gpt-5.6-sol", provider: "openai-apikey" } as any;
    applyOpenAiVirtualModel(parsed, route, logCtx);
    expect(parsed.modelId).toBe("gpt-5.6-sol");
    expect(route.modelId).toBe("gpt-5.6-sol");
  });
});

describe("resolveOpenAiCompactModel", () => {
  test("Pro virtual returns base wire model", () => {
    const result = resolveOpenAiCompactModel("openai-apikey", "gpt-5.6-sol-pro");
    expect(result).toEqual({ selectedModelId: "gpt-5.6-sol-pro", wireModelId: "gpt-5.6-sol", reasoningMode: "pro" });
  });

  test("base model returns itself", () => {
    expect(resolveOpenAiCompactModel("openai-apikey", "gpt-5.6-sol")).toBeUndefined();
  });
});

describe("validateOpenAiVirtualModelDefinition", () => {
  test("returns a pure normalized resolution without mutating the definition", () => {
    const definition = { wireModelId: "gpt-5.6-sol", reasoningMode: "pro" as const };
    const before = structuredClone(definition);
    expect(validateOpenAiVirtualModelDefinition("gpt-5.6-sol-pro", definition)).toEqual({
      selectedModelId: "gpt-5.6-sol-pro",
      wireModelId: "gpt-5.6-sol",
      reasoningMode: "pro",
    });
    expect(definition).toEqual(before);
  });

  test.each([
    { definition: undefined },
    { definition: null },
    { definition: [] },
    { definition: {} },
    { definition: { wireModelId: "", reasoningMode: "pro" } },
    { definition: { wireModelId: " openai/gpt-5.6-sol", reasoningMode: "pro" } },
    { definition: { wireModelId: "openai/gpt-5.6-sol", reasoningMode: "pro" } },
    { definition: { wireModelId: 5, reasoningMode: "pro" } },
    { definition: { wireModelId: "gpt-5.6-sol", reasoningMode: "max" } },
    { definition: { wireModelId: "gpt-5.6-sol-pro", reasoningMode: "pro" } },
  ])("rejects malformed synthetic definitions", ({ definition }) => {
    const registryBefore = JSON.stringify(PROVIDER_REGISTRY);
    expect(() => validateOpenAiVirtualModelDefinition("gpt-5.6-sol-pro", definition))
      .toThrow(InvalidOpenAiVirtualModelRegistryError);
    expect(JSON.stringify(PROVIDER_REGISTRY)).toBe(registryBefore);
  });
});

describe("OpenAI API compact transport", () => {
  test("maps every Pro id to base, strips reasoning, buffers failures, caps bodies, and logs exactly once", async () => {
    const originalFetch = globalThis.fetch;
    const home = mkdtempSync(join(tmpdir(), "ocx-openai-api-compact-"));
    process.env.OPENCODEX_HOME = home;
    saveConfig({
      port: 0,
      defaultProvider: "openai-apikey",
      openaiProviderTierVersion: 2,
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "sk-platform",
        },
      },
    });

    type UpstreamMode = "ok" | "upstream-400" | "upstream-500" | "connect-error" | "fetch-abort" | "body-abort" | "body-error" | "declared-overflow" | "chunked-overflow";
    let mode: UpstreamMode = "ok";
    let cancelled = 0;
    let signalUpstreamStarted: (() => void) | undefined;
    const captures: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://api.openai.com/v1/responses/compact") throw new Error(`unexpected upstream URL: ${url}`);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      captures.push({ url, authorization: headers.get("authorization"), body });
      if (mode === "upstream-400") return new Response("upstream bad request", { status: 400, headers: { "content-type": "text/plain" } });
      if (mode === "upstream-500") return new Response("upstream server failure", { status: 500, headers: { "content-type": "text/plain" } });
      if (mode === "connect-error") throw new Error("connect failed");
      if (mode === "fetch-abort") {
        signalUpstreamStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      if (mode === "body-abort") {
        signalUpstreamStarted?.();
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
          },
        }));
      }
      if (mode === "body-error") {
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error("read failed")); } }));
      }
      if (mode === "declared-overflow") {
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode("must-not-relay")); },
          cancel() { cancelled += 1; },
        }), { headers: { "content-length": String(32 * 1024 * 1024 + 1) } });
      }
      if (mode === "chunked-overflow") {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024));
            controller.enqueue(new Uint8Array(16 * 1024 * 1024));
            controller.enqueue(new Uint8Array(1));
          },
          cancel() { cancelled += 1; },
        }));
      }
      return new Response(JSON.stringify({ output: [], model: body.model }), { headers: { "content-type": "application/json" } });
    };

    const server = startServer(0);
    const readLogs = () => originalFetch(new URL("/api/logs", server.url)).then(response => response.json()) as Promise<Array<Record<string, unknown>>>;
    const readUsage = (): Array<Record<string, unknown>> => existsSync(usageLogPath())
      ? readFileSync(usageLogPath(), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      : [];
    const compact = (model: string, signal?: AbortSignal) => originalFetch(new URL("/v1/responses/compact", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: [], reasoning: { effort: "high" } }),
      signal,
    });

    try {
      for (const [virtual, base] of [
        ["gpt-5.6-sol-pro", "gpt-5.6-sol"],
        ["gpt-5.6-terra-pro", "gpt-5.6-terra"],
        ["gpt-5.6-luna-pro", "gpt-5.6-luna"],
      ] as const) {
        const beforeLogs = (await readLogs()).length;
        const beforeUsage = readUsage().length;
        const response = await compact(`openai-apikey/${virtual}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ model: base });
        expect(captures.at(-1)).toMatchObject({ authorization: "Bearer sk-platform", body: { model: base } });
        expect(captures.at(-1)?.body.reasoning).toBeUndefined();
        const logs = await readLogs();
        expect(logs).toHaveLength(beforeLogs + 1);
        expect(logs.at(-1)).toMatchObject({
          status: 200,
          provider: "openai-apikey",
          model: virtual,
          requestedModel: `openai-apikey/${virtual}`,
          resolvedModel: base,
          usageStatus: "unreported",
        });
        const usage = readUsage();
        expect(usage).toHaveLength(beforeUsage + 1);
        expect(usage.at(-1)).toMatchObject({ provider: "openai-apikey", model: virtual, requestedModel: `openai-apikey/${virtual}`, resolvedModel: base });
      }

      for (const [nextMode, expectedStatus, expectedText] of [
        ["upstream-400", 400, "upstream bad request"],
        ["upstream-500", 500, "upstream server failure"],
        ["connect-error", 502, "Failed to connect to compact upstream"],
        ["body-error", 502, "Failed to read compact response"],
        ["declared-overflow", 502, "compact_response_too_large"],
        ["chunked-overflow", 502, "compact_response_too_large"],
      ] as const) {
        mode = nextMode;
        const before = (await readLogs()).length;
        const beforeUsage = readUsage().length;
        const response = await compact("openai-apikey/gpt-5.6-sol-pro");
        expect(response.status).toBe(expectedStatus);
        expect(await response.text()).toContain(expectedText);
        expect(await readLogs()).toHaveLength(before + 1);
        const usage = readUsage();
        expect(usage).toHaveLength(beforeUsage + 1);
        expect(usage.at(-1)).toMatchObject({
          status: expectedStatus,
          provider: "openai-apikey",
          model: "gpt-5.6-sol-pro",
          requestedModel: "openai-apikey/gpt-5.6-sol-pro",
          resolvedModel: "gpt-5.6-sol",
        });
      }
      expect(cancelled).toBe(2);

      mode = "ok";
      const beforeLocal = (await readLogs()).length;
      const beforeLocalUsage = readUsage().length;
      const beforeCapture = captures.length;
      const localFailure = await compact("");
      expect(localFailure.status).toBe(400);
      expect(captures).toHaveLength(beforeCapture);
      expect(await readLogs()).toHaveLength(beforeLocal + 1);
      expect(readUsage()).toHaveLength(beforeLocalUsage + 1);
      expect(readUsage().at(-1)).toMatchObject({ status: 400, model: "unknown", provider: "unknown" });

      for (const abortMode of ["fetch-abort", "body-abort"] as const) {
        mode = abortMode;
        const before = (await readLogs()).length;
        const beforeUsage = readUsage().length;
        const started = new Promise<void>(resolve => { signalUpstreamStarted = resolve; });
        const controller = new AbortController();
        const pending = compact("openai-apikey/gpt-5.6-sol-pro", controller.signal);
        await started;
        controller.abort();
        await pending.catch(() => undefined);
        await Bun.sleep(10);
        const logs = await readLogs();
        expect(logs).toHaveLength(before + 1);
        expect(logs.at(-1)).toMatchObject({ status: 499, model: "gpt-5.6-sol-pro", resolvedModel: "gpt-5.6-sol" });
        const usage = readUsage();
        expect(usage).toHaveLength(beforeUsage + 1);
        expect(usage.at(-1)).toMatchObject({
          status: 499,
          provider: "openai-apikey",
          model: "gpt-5.6-sol-pro",
          requestedModel: "openai-apikey/gpt-5.6-sol-pro",
          resolvedModel: "gpt-5.6-sol",
        });
        signalUpstreamStarted = undefined;
      }

      mode = "ok";
      const standard = await compact("openai-apikey/gpt-5.6-sol");
      expect(standard.status).toBe(200);
      expect(captures.at(-1)?.body).toMatchObject({ model: "gpt-5.6-sol" });
      expect(captures.at(-1)?.body.reasoning).toBeUndefined();
      const prototypeKey = await compact("openai-apikey/toString");
      expect(prototypeKey.status).toBe(200);
      expect(captures.at(-1)?.body).toMatchObject({ model: "toString" });
    } finally {
      globalThis.fetch = originalFetch;
      await server.stop(true);
      delete process.env.OPENCODEX_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("OpenAI API Pro transport identities", () => {
  test("HTTP JSON, HTTP SSE, and real WebSocket keep base wire/client identity and virtual logs", async () => {
    const originalFetch = globalThis.fetch;
    const home = mkdtempSync(join(tmpdir(), "ocx-openai-api-pro-"));
    process.env.OPENCODEX_HOME = home;
    saveConfig({
      port: 0,
      websockets: true,
      defaultProvider: "openai-apikey",
      openaiProviderTierVersion: 2,
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "sk-platform",
        },
      },
    });
    const captures: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://api.openai.com/v1/responses") throw new Error(`unexpected upstream URL: ${url}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      captures.push({ body, headers });
      const payload = {
        id: `resp_${captures.length}`,
        object: "response",
        status: "completed",
        model: body.model,
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      if (body.stream === true) {
        return new Response([
          `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...payload, status: "in_progress" } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`,
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json(payload);
    };

    const server = startServer(0);
    const readUsage = (): Array<Record<string, unknown>> => existsSync(usageLogPath())
      ? readFileSync(usageLogPath(), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
      : [];
    const readLogs = () => originalFetch(new URL("/api/logs", server.url)).then(response => response.json()) as Promise<Array<Record<string, unknown>>>;
    const expectOnePersisted = async (
      beforeLogs: number,
      beforeUsage: number,
      selected: string,
      virtual: string,
      base: string,
    ): Promise<void> => {
      const logs = await readLogs();
      expect(logs).toHaveLength(beforeLogs + 1);
      expect(logs.at(-1)).toMatchObject({ provider: "openai-apikey", model: virtual, requestedModel: selected, resolvedModel: base, status: 200 });
      const usage = readUsage();
      expect(usage).toHaveLength(beforeUsage + 1);
      expect(usage.at(-1)).toMatchObject({ provider: "openai-apikey", model: virtual, requestedModel: selected, resolvedModel: base, status: 200 });
    };
    const request = (model: string, stream: boolean) => originalFetch(new URL("/v1/responses", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: "hello", stream, reasoning: { effort: "high" } }),
    });
    const wsTurn = (model: string) => {
      const url = new URL("/v1/responses", server.url);
      url.protocol = "ws:";
      const ws = new WebSocket(url);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("OpenAI API Pro websocket timeout")), 2000);
        ws.addEventListener("open", () => {
          ws.send(JSON.stringify({ type: "response.create", model, input: "hello", reasoning: { effort: "high" } }));
        }, { once: true });
        ws.addEventListener("message", event => {
          const text = typeof event.data === "string" ? event.data : "";
          if (!text.includes('"type":"response.completed"')) return;
          clearTimeout(timer);
          ws.close();
          resolve(text);
        });
        ws.addEventListener("error", () => reject(new Error("OpenAI API Pro websocket failed")), { once: true });
      });
    };

    try {
      for (const [virtual, base] of [
        ["gpt-5.6-sol-pro", "gpt-5.6-sol"],
        ["gpt-5.6-terra-pro", "gpt-5.6-terra"],
        ["gpt-5.6-luna-pro", "gpt-5.6-luna"],
      ] as const) {
        const selected = `openai-apikey/${virtual}`;
        const beforeJsonLogs = (await readLogs()).length;
        const beforeJsonUsage = readUsage().length;
        const json = await request(selected, false);
        expect(json.status).toBe(200);
        expect(await json.json()).toMatchObject({ model: base });
        await expectOnePersisted(beforeJsonLogs, beforeJsonUsage, selected, virtual, base);

        const beforeSseLogs = (await readLogs()).length;
        const beforeSseUsage = readUsage().length;
        const sse = await request(selected, true);
        expect(sse.status).toBe(200);
        const sseText = await sse.text();
        expect(sseText).toContain(`\"model\":\"${base}\"`);
        expect(sseText).not.toContain(`\"model\":\"${virtual}\"`);
        await expectOnePersisted(beforeSseLogs, beforeSseUsage, selected, virtual, base);

        const beforeWsLogs = (await readLogs()).length;
        const beforeWsUsage = readUsage().length;
        const wsText = await wsTurn(selected);
        expect(wsText).toContain(`\"model\":\"${base}\"`);
        expect(wsText).not.toContain(`\"model\":\"${virtual}\"`);
        await expectOnePersisted(beforeWsLogs, beforeWsUsage, selected, virtual, base);

        for (const capture of captures.slice(-3)) {
          expect(capture.body).toMatchObject({ model: base, reasoning: { effort: "high", mode: "pro" } });
          expect(capture.headers.get("authorization")).toBe("Bearer sk-platform");
          expect(capture.headers.get("chatgpt-account-id")).toBeNull();
          expect(capture.headers.get("x-codex-account-id")).toBeNull();
        }
      }

      const prototypeHttp = await request("openai-apikey/constructor", false);
      expect(prototypeHttp.status).toBe(200);
      expect(await prototypeHttp.json()).toMatchObject({ model: "constructor" });
      const prototypeWs = await wsTurn("openai-apikey/toString");
      expect(prototypeWs).toContain('"model":"toString"');

      for (const invalidReasoning of ["high", ["high"]]) {
        const before = captures.length;
        const response = await originalFetch(new URL("/v1/responses", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openai-apikey/gpt-5.6-sol-pro", input: "hello", stream: false, reasoning: invalidReasoning }),
        });
        expect(response.status).toBe(400);
        expect(captures).toHaveLength(before);
      }
    } finally {
      globalThis.fetch = originalFetch;
      await server.stop(true);
      delete process.env.OPENCODEX_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
