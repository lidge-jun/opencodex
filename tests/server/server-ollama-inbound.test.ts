import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const DATA_TOKEN = "ocx_data_ollamafixture";
const ADMIN_TOKEN = "admin-secret-for-ollama";
const PROVIDER_KEY = "provider-fixture-key";
const saved = { home: process.env.OPENCODEX_HOME, data: process.env.OPENCODEX_API_AUTH_TOKEN, admin: process.env.OPENCODEX_ADMIN_AUTH_TOKEN };
let home = "";
let mode: "text" | "tools" | "length" | "filter" | "unknown" | "error400" = "text";
let seen: { auth: string | null; body: Record<string, unknown> }[] = [];
let upstream: ReturnType<typeof Bun.serve>;

const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
  "data: " + JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "m1", choices, ...extra }) + "\n\n";

function finishFor(m: typeof mode): string {
  return m === "tools" ? "tool_calls" : m === "length" ? "length" : m === "filter" ? "content_filter" : m === "unknown" ? "mystery" : "stop";
}

beforeAll(() => {
  upstream = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as Record<string, unknown>;
    seen.push({ auth: req.headers.get("authorization"), body });
    if (mode === "error400") return Response.json({ error: { message: "fixture upstream rejected the request", type: "invalid_request_error" } }, { status: 400 });
    const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
    const toolCall = { id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } };
    if (body.stream !== true) {
      const message = mode === "tools" ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: "Hello" };
      return Response.json({ id: "chatcmpl-fixture", object: "chat.completion", created: 1, model: "m1", choices: [{ index: 0, message, finish_reason: finishFor(mode) }], usage });
    }
    const frames = mode === "tools"
      ? [chunk([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] } }])]
      : [chunk([{ index: 0, delta: { role: "assistant", content: "Hel" } }]), chunk([{ index: 0, delta: { content: "lo" } }])];
    frames.push(chunk([{ index: 0, delta: {}, finish_reason: finishFor(mode) }]), chunk([], { usage }), "data: [DONE]\n\n");
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
    providers: { fx: { adapter: "openai-chat", baseUrl: upstream.url.origin + "/v1", authMode: "key", apiKey: PROVIDER_KEY, allowPrivateNetwork: true, models: ["m1"] } },
  } as OcxConfig;
}

// The spend ledger binds one state directory per process, so the whole file shares one home.
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-ollama-inbound-"));
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

async function withServer(run: (base: URL) => Promise<void>): Promise<void> {
  const server = startServer(0);
  earlierRows = new Set(getRequestLogEntries().map(entry => entry.requestId));
  try { await run(server.url); } finally { await server.stop(true); }
}
const auth = { authorization: "Bearer " + DATA_TOKEN };
const post = (base: URL, path: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(new URL(path, base), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const ndjson = async (res: Response) => (await res.text()).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
const rowFor = (res: Response) => getRequestLogEntries().find(entry => entry.requestId === res.headers.get("x-opencodex-request-id"));
// startServer hydrates earlier rows from disk, so a test counts only the rows it wrote.
let earlierRows = new Set<string>();
const newRows = () => getRequestLogEntries().filter(entry => !earlierRows.has(entry.requestId));

describe("Ollama-compatible inbound routes", () => {
  test("version, tags and show answer with configured facts only", async () => {
    await withServer(async base => {
      const version = await fetch(new URL("/api/version", base), { headers: auth });
      expect(version.status).toBe(200);
      expect(typeof (await version.json() as { version: unknown }).version).toBe("string");
      const tags = await fetch(new URL("/api/tags", base), { headers: auth });
      expect(await tags.json()).toEqual({ models: [{ name: "fx/m1", model: "fx/m1" }] });
      const show = await post(base, "/api/show", { model: "fx/m1" });
      expect(show.status).toBe(200);
      expect(await show.json()).toEqual({ details: {}, model_info: {}, capabilities: ["completion"] });
      const unknown = await post(base, "/api/show", { model: "fx/absent-model" });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: "model not found" });
      expect((await post(base, "/api/show", { model: "fx/m1", modelfile: "x" })).status).toBe(400);
    });
  });

  test("admission reuses the data-plane gates and keeps management routes intact", async () => {
    saveConfig(config(true));
    await withServer(async base => {
      for (const path of ["/api/version", "/api/tags"]) {
        const res = await fetch(new URL(path, base));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "opencodex API key required" });
      }
      const unauthorized = await post(base, "/api/chat", { model: "fx/m1", messages: [{ role: "user", content: "hi" }] }, {});
      expect(unauthorized.status).toBe(401);
      expect(seen).toHaveLength(0);
      const managementKeyOnly = await post(base, "/api/chat", { model: "fx/m1", messages: [] }, { "x-opencodex-api-key": ADMIN_TOKEN });
      expect(managementKeyOnly.status).toBe(401);
      const wrongMethod = await fetch(new URL("/api/chat", base), { headers: auth });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("POST");
      expect(await wrongMethod.json()).toEqual({ error: "method GET not allowed" });
      const crossOrigin = await post(base, "/api/chat", { model: "fx/m1", messages: [] }, { ...auth, origin: "https://evil.example" });
      expect(crossOrigin.status).toBe(403);
      // Unknown /api/* still reaches the management boundary.
      expect((await fetch(new URL("/api/not-a-native-route", base))).status).toBe(401);
      const managed = await fetch(new URL("/api/not-a-native-route", base), { headers: { "x-opencodex-api-key": ADMIN_TOKEN } });
      expect(managed.status).toBe(404);
      expect(seen).toHaveLength(0);
    });
  });

  test("native preflight uses data-plane CORS, other /api preflight stays management", async () => {
    await withServer(async base => {
      const preflight = (path: string, origin: string) => fetch(new URL(path, base), { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
      expect((await preflight("/api/chat", "https://evil.example")).status).toBe(403);
      const local = await preflight("/api/chat", base.origin);
      expect(local.status).toBe(204);
    });
  });

  for (const kind of ["chat", "generate"] as const) {
    const request = (extra: Record<string, unknown> = {}) => kind === "chat"
      ? { model: "fx/m1", messages: [{ role: "user", content: "hi" }], ...extra }
      : { model: "fx/m1", prompt: "hi", ...extra };
    const text = (record: Record<string, unknown>) => kind === "chat" ? (record.message as { content?: string } | undefined)?.content : record.response;

    test(kind + " buffered returns one native record and logs one matching row", async () => {
      await withServer(async base => {
        const res = await post(base, "/api/" + kind, request({ stream: false }));
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        expect(text(body)).toBe("Hello");
        expect(body).toMatchObject({ model: "fx/m1", done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 2 });
        expect(seen).toHaveLength(1);
        expect(seen[0]!.auth).toBe("Bearer " + PROVIDER_KEY);
        expect(seen[0]!.body.stream).not.toBe(true);
        const row = rowFor(res);
        expect(row).toBeDefined();
        expect(row!.status).toBe(200);
        expect(newRows()).toHaveLength(1);
        expect(row!.attempts?.[0]?.sendCount).toBe(1);
      });
    });

    test(kind + " streams NDJSON with exactly one done record after usage", async () => {
      await withServer(async base => {
        const res = await post(base, "/api/" + kind, request());
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("application/x-ndjson");
        const lines = await ndjson(res);
        expect(lines.map(text).filter(Boolean).join("")).toBe("Hello");
        const done = lines.filter(line => line.done === true);
        expect(done).toHaveLength(1);
        expect(lines.at(-1)).toMatchObject({ done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 2 });
        expect(seen[0]!.body.stream).toBe(true);
        await Bun.sleep(20);
        expect(newRows()).toHaveLength(1);
        expect(rowFor(res)!.status).toBe(200);
      });
    });

    for (const finish of ["length", "filter", "unknown"] as const) {
      test(kind + " maps finish " + finish + " truthfully in both delivery modes", async () => {
        mode = finish;
        await withServer(async base => {
          const buffered = await post(base, "/api/" + kind, request({ stream: false }));
          const streamed = await post(base, "/api/" + kind, request());
          const lines = await ndjson(streamed);
          if (finish === "length") {
            expect(buffered.status).toBe(200);
            expect(await buffered.json()).toMatchObject({ done: true, done_reason: "length" });
            expect(lines.at(-1)).toMatchObject({ done: true, done_reason: "length" });
          } else {
            expect(buffered.status).toBe(502);
            expect(typeof (await buffered.json() as { error: unknown }).error).toBe("string");
            expect(lines.some(line => line.done === true)).toBe(false);
            expect(typeof lines.at(-1)!.error).toBe("string");
          }
          await Bun.sleep(20);
          const rows = newRows();
          expect(rows).toHaveLength(2);
          for (const row of rows) expect(row.status).toBe(finish === "length" ? 200 : 502);
        });
      });
    }

    test(kind + " upstream refusal keeps its status with a native error and one row", async () => {
      mode = "error400";
      await withServer(async base => {
        const res = await post(base, "/api/" + kind, request({ stream: false }));
        expect(res.status).toBe(400);
        // Upstream text is never forwarded; the status picks a fixed native message.
        expect(await res.json()).toEqual({ error: "request rejected" });
        expect(newRows()).toHaveLength(1);
        expect(rowFor(res)!.status).toBe(400);
      });
    });

    test(kind + " malformed input is a logged 400 before any send", async () => {
      await withServer(async base => {
        for (const body of ["{not json", JSON.stringify(request({ keep_alive: "5m" }))]) {
          const res = await post(base, "/api/" + kind, body);
          expect(res.status).toBe(400);
          expect(typeof (await res.json() as { error: unknown }).error).toBe("string");
          expect(rowFor(res)!.status).toBe(400);
        }
        expect(seen).toHaveLength(0);
      });
    });
  }

  test("chat refuses aggregate tool-call overflow before any upstream send", async () => {
    const calls = Array.from({ length: 1_025 }, (_, i) => ({ id: `call_${i}`, function: { name: "lookup", arguments: {} } }));
    await withServer(async base => {
      for (const stream of [false, true]) {
        const res = await post(base, "/api/chat", { model: "fx/m1", stream, messages: [
          { role: "assistant", content: "", tool_calls: calls.slice(0, 512) },
          { role: "assistant", content: "", tool_calls: calls.slice(512) },
        ] });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Too many tool calls" });
        expect(rowFor(res)!.status).toBe(400);
      }
      expect(seen).toHaveLength(0);
      expect(newRows()).toHaveLength(2);
    });
  });

  test("chat tools round trip with stable call ids", async () => {
    mode = "tools";
    await withServer(async base => {
      const tools = [{ type: "function", function: { name: "lookup", description: "find", parameters: { type: "object", properties: { q: { type: "string" } } } } }];
      const buffered = await post(base, "/api/chat", { model: "fx/m1", messages: [{ role: "user", content: "hi" }], tools, stream: false });
      expect(await buffered.json()).toMatchObject({ done: true, done_reason: "tool_calls", message: { tool_calls: [{ function: { name: "lookup", arguments: { q: "x" } } }] } });
      expect(seen[0]!.body.tools).toEqual(tools);
      const lines = await ndjson(await post(base, "/api/chat", { model: "fx/m1", messages: [{ role: "user", content: "hi" }], tools }));
      expect(lines.at(-1)).toMatchObject({ done: true, done_reason: "tool_calls" });
      expect(lines.some(line => JSON.stringify(line).includes("lookup"))).toBe(true);
      // A client that echoes the assistant message back unchanged continues the same call.
      const first = await (await post(base, "/api/chat", { model: "fx/m1", messages: [{ role: "user", content: "hi" }], tools, stream: false })).json() as { message: Record<string, unknown> };
      seen = [];
      const followUp = await post(base, "/api/chat", { model: "fx/m1", tools, stream: false, messages: [
        { role: "user", content: "hi" }, first.message, { role: "tool", tool_name: "lookup", content: "found" },
      ] });
      expect(followUp.status).toBe(200);
      await followUp.text();
      const sent = seen[0]!.body.messages as { tool_calls?: { id: string }[]; tool_call_id?: string }[];
      expect(sent[1]!.tool_calls![0]!.id).toBe("call_fixture");
      expect(sent[2]!.tool_call_id).toBe("call_fixture");
    });
  });

  test("images reach the provider as Chat image_url data URLs with exact bytes", async () => {
    await withServer(async base => {
      const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");
      const res = await post(base, "/api/chat", { model: "fx/m1", messages: [{ role: "user", content: "see", images: [image] }], stream: false });
      expect(res.status).toBe(200);
      const content = (seen[0]!.body.messages as { content: unknown }[])[0]!.content as { type: string; image_url?: { url: string } }[];
      const part = content.find(item => item.type === "image_url");
      expect(part?.image_url?.url.endsWith(";base64," + image)).toBe(true);
    });
  });
});
