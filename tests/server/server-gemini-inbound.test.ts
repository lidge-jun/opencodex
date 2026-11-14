import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const DATA_TOKEN = "ocx_data_geminifixture";
const ADMIN_TOKEN = "admin-secret-for-gemini";
const PROVIDER_KEY = "provider-fixture-key";
const saved = { home: process.env.OPENCODEX_HOME, data: process.env.OPENCODEX_API_AUTH_TOKEN, admin: process.env.OPENCODEX_ADMIN_AUTH_TOKEN };
let home = "";
let mode: "text" | "tools" | "error400" = "text";
let seen: { auth: string | null; url: string; body: Record<string, unknown> }[] = [];
let upstream: ReturnType<typeof Bun.serve>;

const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
  "data: " + JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "m1", choices, ...extra }) + "\n\n";

beforeAll(() => {
  upstream = Bun.serve({ port: 0, async fetch(req) {
    if (req.method === "GET") return Response.json({ object: "list", data: [{ id: "m1", object: "model" }] });
    const body = await req.json() as Record<string, unknown>;
    seen.push({ auth: req.headers.get("authorization"), url: req.url, body });
    if (mode === "error400") return Response.json({ error: { message: "fixture upstream rejected the request", type: "invalid_request_error" } }, { status: 400 });
    const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
    const toolCall = { id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } };
    const finish = mode === "tools" ? "tool_calls" : "stop";
    if (body.stream !== true) {
      const message = mode === "tools" ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: "Hello" };
      return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: "m1", choices: [{ index: 0, message, finish_reason: finish }], usage });
    }
    const frames = mode === "tools"
      ? [chunk([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] } }])]
      : [chunk([{ index: 0, delta: { role: "assistant", content: "Hel" } }]), chunk([{ index: 0, delta: { content: "lo" } }])];
    frames.push(chunk([{ index: 0, delta: {}, finish_reason: finish }]), chunk([], { usage }), "data: [DONE]\n\n");
    return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
  } });
});
afterAll(() => { upstream.stop(true); });

function config(remote = false): OcxConfig {
  return {
    port: 0,
    // A public bind is what makes the data-plane key mandatory.
    ...(remote ? { hostname: "0.0.0.0" } : {}),
    defaultProvider: "fx",
    providers: { fx: { adapter: "openai-chat", baseUrl: upstream.url.origin + "/v1", authMode: "key", apiKey: PROVIDER_KEY, allowPrivateNetwork: true, models: ["m1"] }, off: { adapter: "openai-chat", baseUrl: "https://off.example/v1", authMode: "key", apiKey: "fixture", models: ["m1"], disabled: true } },
  } as OcxConfig;
}

// The spend ledger binds one state directory per process, so the whole file shares one home.
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-gemini-inbound-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_API_AUTH_TOKEN = DATA_TOKEN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
});
beforeEach(() => {
  mode = "text";
  seen = [];
  clearRequestLogsForTests();
  saveConfig(config());
});
afterAll(() => {
  for (const [key, value] of [["OPENCODEX_HOME", saved.home], ["OPENCODEX_API_AUTH_TOKEN", saved.data], ["OPENCODEX_ADMIN_AUTH_TOKEN", saved.admin]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (home) removeTreeWithRetry(home);
  home = "";
});

// startServer hydrates earlier rows from disk, so a test counts only the rows it wrote.
let earlierRows = new Set<string>();
const newRows = () => getRequestLogEntries().filter(entry => !earlierRows.has(entry.requestId));
async function withServer(run: (base: URL) => Promise<void>): Promise<void> {
  const server = startServer(0);
  earlierRows = new Set(getRequestLogEntries().map(entry => entry.requestId));
  try { await run(server.url); } finally { await server.stop(true); }
}

const googKey = { "x-goog-api-key": DATA_TOKEN };
const post = (base: URL, path: string, body: unknown, headers: Record<string, string> = googKey) =>
  fetch(new URL(path, base), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const request = (extra: Record<string, unknown> = {}) => ({ contents: [{ role: "user", parts: [{ text: "hi" }] }], ...extra });
const sseRecords = async (res: Response) => (await res.text()).split("\r\n\r\n").filter(Boolean).map(frame => {
  expect(frame.startsWith("data: ")).toBe(true);
  return JSON.parse(frame.slice("data: ".length)) as Record<string, any>;
});
const textOf = (records: Record<string, any>[]) => records.flatMap(record => record.candidates?.[0]?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? "").join("");

describe("Gemini-compatible inbound routes", () => {
  test("model list and point lookup describe configured routes only", async () => {
    await withServer(async base => {
      const list = await fetch(new URL("/v1beta/models", base), { headers: googKey });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ models: [{ name: "models/fx/m1", displayName: "fx/m1", supportedGenerationMethods: ["generateContent", "streamGenerateContent"] }] });
      for (const path of ["/v1beta/models/fx/m1", "/v1beta/models/models/fx/m1", "/v1beta/models/fx%2Fm1"]) {
        const one = await fetch(new URL(path, base), { headers: googKey });
        expect(one.status).toBe(200);
        expect(await one.json()).toMatchObject({ name: "models/fx/m1" });
      }
      const missing = await fetch(new URL("/v1beta/models/fx/absent", base), { headers: googKey });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: 404, message: "model not found", status: "NOT_FOUND" } });
    });
  });

  test("streamGenerateContent?alt=sse with x-goog-api-key streams Gemini SSE and reaches the provider as Chat", async () => {
    saveConfig(config(true));
    await withServer(async base => {
      const res = await post(base, "/v1beta/models/fx/m1:streamGenerateContent?alt=sse", request({ systemInstruction: { parts: [{ text: "rules" }] } }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const records = await sseRecords(res);
      expect(textOf(records)).toBe("Hello");
      expect(records.at(-1)).toMatchObject({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, totalTokenCount: 7 } });
      expect(records.filter(record => record.candidates?.[0]?.finishReason)).toHaveLength(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.auth).toBe("Bearer " + PROVIDER_KEY);
      expect(seen[0]!.body).toMatchObject({ model: "m1", stream: true, messages: [{ role: "system", content: "rules" }, { role: "user", content: "hi" }] });
      await Bun.sleep(20);
      expect(newRows()).toHaveLength(1);
      expect(newRows()[0]!.status).toBe(200);
    });
  });

  test("the ?key= query credential admits the request and is never forwarded", async () => {
    saveConfig(config(true));
    await withServer(async base => {
      const res = await post(base, `/v1beta/models/fx/m1:generateContent?key=${DATA_TOKEN}`, request(), {});
      expect(res.status).toBe(200);
      await res.text();
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).not.toContain(DATA_TOKEN);
      expect(seen[0]!.auth).toBe("Bearer " + PROVIDER_KEY);
      for (const headers of [{}, { "x-goog-api-key": "wrong-key" }]) {
        const refused = await post(base, "/v1beta/models/fx/m1:generateContent", request(), headers);
        expect(refused.status).toBe(401);
        expect(await refused.json()).toEqual({ error: { code: 401, message: "opencodex API key required", status: "UNAUTHENTICATED" } });
      }
      const list = await fetch(new URL("/v1beta/models", base));
      expect(list.status).toBe(401);
      expect(seen).toHaveLength(1);
    });
  });

  test("streaming without alt=sse is one streamed JSON array", async () => {
    await withServer(async base => {
      const res = await post(base, "/v1beta/models/fx/m1:streamGenerateContent", request());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const array = JSON.parse(await res.text()) as Record<string, any>[];
      expect(Array.isArray(array)).toBe(true);
      expect(textOf(array)).toBe("Hello");
      expect(array.at(-1)).toMatchObject({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5 } });
    });
  });

  test("buffered generateContent answers on /v1beta and on /v1 with an encoded model", async () => {
    await withServer(async base => {
      for (const path of ["/v1beta/models/fx/m1:generateContent", "/v1/models/fx%2Fm1:generateContent"]) {
        const res = await post(base, path, request());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
          modelVersion: "fx/m1",
        });
      }
      expect(seen.map(call => call.body.stream)).toEqual([false, false]);
      await Bun.sleep(20);
      expect(newRows()).toHaveLength(2);
    });
  });

  test("a streamed tool call arrives as one complete functionCall part", async () => {
    mode = "tools";
    await withServer(async base => {
      const tools = [{ functionDeclarations: [{ name: "lookup", description: "find", parameters: { type: "OBJECT", properties: { q: { type: "STRING" } } } }] }];
      const records = await sseRecords(await post(base, "/v1beta/models/fx/m1:streamGenerateContent?alt=sse", request({ tools })));
      const calls = records.flatMap(record => record.candidates?.[0]?.content?.parts ?? []).filter((part: Record<string, unknown>) => part.functionCall);
      expect(calls).toEqual([{ functionCall: { id: "call_fixture", name: "lookup", args: { q: "x" } } }]);
      expect(records.at(-1)).toMatchObject({ candidates: [{ finishReason: "STOP" }] });
      expect(seen[0]!.body.tools).toEqual([{ type: "function", function: { name: "lookup", description: "find", parameters: { type: "object", properties: { q: { type: "string" } } } } }]);
    });
  });

  test("bad input and unknown models are Gemini errors before any send", async () => {
    await withServer(async base => {
      const badJson = await post(base, "/v1beta/models/fx/m1:generateContent", "{not json");
      expect(badJson.status).toBe(400);
      expect(await badJson.json()).toMatchObject({ error: { code: 400, status: "INVALID_ARGUMENT" } });
      const badShape = await post(base, "/v1beta/models/fx/m1:generateContent", { contents: "hi" });
      expect(badShape.status).toBe(400);
      const unknown = await post(base, "/v1beta/models/off/m1:generateContent", request());
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: 404, status: "NOT_FOUND" } });
      expect(seen).toHaveLength(0);
      expect(newRows()).toHaveLength(3);
    });
  });

  test("an upstream refusal keeps its status with a fixed message", async () => {
    mode = "error400";
    await withServer(async base => {
      const res = await post(base, "/v1beta/models/fx/m1:generateContent", request());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 400, message: "request rejected", status: "INVALID_ARGUMENT" } });
    });
  });

  test("unsupported methods answer 501 and wrong HTTP methods 405", async () => {
    await withServer(async base => {
      for (const method of ["countTokens", "embedContent", "batchEmbedContents"]) {
        const res = await post(base, `/v1beta/models/fx/m1:${method}`, {});
        expect(res.status).toBe(501);
        expect(await res.json()).toMatchObject({ error: { code: 501, status: "UNIMPLEMENTED" } });
      }
      const wrong = await fetch(new URL("/v1beta/models/fx/m1:generateContent", base), { headers: googKey });
      expect(wrong.status).toBe(405);
      expect(wrong.headers.get("allow")).toBe("POST");
      expect(seen).toHaveLength(0);
    });
  });

  test("OpenCodex's own /v1/models is untouched", async () => {
    await withServer(async base => {
      const res = await fetch(new URL("/v1/models", base), { headers: { authorization: "Bearer " + DATA_TOKEN } });
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty("models");
    });
  });
});
