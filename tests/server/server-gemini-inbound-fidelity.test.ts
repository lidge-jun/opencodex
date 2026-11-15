import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { rmSync } from "node:fs";
import { flushThoughtSignatureReplayForTests, resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";

const DATA_TOKEN = "ocx_data_geminifidelity";
const ADMIN_TOKEN = "admin-secret-for-gemini-fidelity";
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
    providers: { fx: { adapter: "openai-chat", baseUrl: upstream.url.origin + "/v1", authMode: "key", apiKey: PROVIDER_KEY, allowPrivateNetwork: true, models: ["m1"], modelContextWindows: { m1: 64000 }, modelMaxOutputTokens: { m1: 1024 } }, google: { adapter: "google", baseUrl: GEMINI_ORIGIN, authMode: "key", apiKey: "google-fixture-key", models: ["gemini-3-flash-preview"] }, off: { adapter: "openai-chat", baseUrl: "https://off.example/v1", authMode: "key", apiKey: "fixture", models: ["m1"], disabled: true } },
  } as OcxConfig;
}

// The spend ledger binds one state directory per process, so the whole file shares one home.
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-gemini-fidelity-"));
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

const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
const SIG = "CiQB0e2Kb7xQ9Zt0SignatureFixtureAAAA==";
let googleBodies: Record<string, any>[] = [];
let realFetch: typeof fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === GEMINI_ORIGIN && url.pathname.startsWith("/v1beta/models/")) {
      googleBodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      const payload = {
        candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "lookup", args: { q: "x" } }, thoughtSignature: SIG }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      };
      return url.searchParams.get("alt") === "sse"
        ? new Response("data: " + JSON.stringify(payload) + "\n\n", { headers: { "content-type": "text/event-stream" } })
        : Response.json(payload);
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => { googleBodies = []; });

const googKey = { "x-goog-api-key": DATA_TOKEN };
const post = (base: URL, path: string, body: unknown, headers: Record<string, string> = googKey) =>
  fetch(new URL(path, base), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const lookupTool = [{ functionDeclarations: [{ name: "lookup", parameters: { type: "OBJECT", properties: { q: { type: "STRING" } } } }] }];

describe("Gemini inbound fidelity", () => {
  test("a Gemini-3 thought signature survives a two-turn tool loop through a google route", async () => {
    await withServer(async base => {
      const first = await (await post(base, "/v1beta/models/google/gemini-3-flash-preview:generateContent", { contents: [{ role: "user", parts: [{ text: "look it up" }] }], tools: lookupTool })).json() as Record<string, any>;
      const callPart = first.candidates[0].content.parts.find((part: Record<string, any>) => part.functionCall);
      expect(callPart.thoughtSignature).toBe(SIG);
      // The proxy also remembers it server-side; forget that so the second turn proves the client echo.
      await flushThoughtSignatureReplayForTests();
      rmSync(join(home, "thought-signature-replay.json"), { force: true });
      resetThoughtSignatureReplayForTests();
      const second = await post(base, "/v1beta/models/google/gemini-3-flash-preview:generateContent", { tools: lookupTool, contents: [
        { role: "user", parts: [{ text: "look it up" }] },
        { role: "model", parts: [callPart] },
        { role: "user", parts: [{ functionResponse: { id: callPart.functionCall.id, name: "lookup", response: { result: "found" } } }] },
      ] });
      expect(second.status).toBe(200);
      const replayed = (googleBodies.at(-1)!.contents as Record<string, any>[]).flatMap(content => content.parts as Record<string, any>[]).find(part => part.functionCall);
      expect(replayed?.thoughtSignature).toBe(SIG);
    });
  });

  test("countTokens answers a local estimate for contents and generateContentRequest", async () => {
    await withServer(async base => {
      for (const body of [
        { contents: [{ role: "user", parts: [{ text: "hello there, how are you today?" }] }] },
        { generateContentRequest: { contents: [{ role: "user", parts: [{ text: "hello there, how are you today?" }] }] } },
      ]) {
        const res = await post(base, "/v1beta/models/fx/m1:countTokens", body);
        expect(res.status).toBe(200);
        const json = await res.json() as { totalTokens: number };
        expect(Number.isSafeInteger(json.totalTokens) && json.totalTokens > 0).toBe(true);
      }
      expect((await post(base, "/v1beta/models/fx/absent:countTokens", { contents: [] })).status).toBe(404);
      expect((await post(base, "/v1beta/models/fx/m1:countTokens", { contents: "x" })).status).toBe(400);
      expect((await post(base, "/v1beta/models/fx/m1:embedContent", {})).status).toBe(501);
      expect(seen).toHaveLength(0);
    });
  });

  test("model resources carry configured token limits and advertise countTokens", async () => {
    await withServer(async base => {
      const one = await (await fetch(new URL("/v1beta/models/fx/m1", base), { headers: googKey })).json() as Record<string, any>;
      expect(one).toMatchObject({ name: "models/fx/m1", inputTokenLimit: 64000, supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"] });
      // A configured output limit wins over generated metadata, and is reported when metadata has none.
      expect(one.outputTokenLimit).toBe(1024);
    });
  });

  test("a configured output limit wins over generated metadata", async () => {
    const lookup = async (base: URL) => (await (await fetch(new URL("/v1beta/models/google/gemini-3-flash-preview", base), { headers: googKey })).json() as Record<string, any>).outputTokenLimit;
    await withServer(async base => { expect(await lookup(base)).toBe(65536); });
    const configured = config();
    (configured.providers.google as { modelMaxOutputTokens?: Record<string, number> }).modelMaxOutputTokens = { "gemini-3-flash-preview": 2048 };
    saveConfig(configured);
    await withServer(async base => { expect(await lookup(base)).toBe(2048); });
  });

  test("an unknown /v1beta path is a JSON 404, never the dashboard page", async () => {
    await withServer(async base => {
      for (const path of ["/v1beta/unknown", "/v1beta/files/abc"]) {
        const res = await fetch(new URL(path, base), { headers: googKey });
        expect(res.status).toBe(404);
        expect(res.headers.get("content-type")).toContain("application/json");
      }
    });
  });

  test("$alt=sse streams SSE and a wrong method is a Google 405 with status UNIMPLEMENTED", async () => {
    await withServer(async base => {
      const res = await post(base, "/v1beta/models/fx/m1:streamGenerateContent?$alt=sse", { contents: [{ role: "user", parts: [{ text: "hi" }] }] });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      await res.text();
      const wrong = await fetch(new URL("/v1beta/models/fx/m1:generateContent", base), { headers: googKey });
      expect(wrong.status).toBe(405);
      expect(await wrong.json()).toMatchObject({ error: { code: 405, status: "UNIMPLEMENTED" } });
    });
  });
});
