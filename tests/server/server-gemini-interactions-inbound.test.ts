import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const DATA_TOKEN = "ocx_data_interactionsfixture";
const ADMIN_TOKEN = "admin-secret-for-interactions";
const PROVIDER_KEY = "provider-fixture-key";
const saved = { home: process.env.OPENCODEX_HOME, data: process.env.OPENCODEX_API_AUTH_TOKEN, admin: process.env.OPENCODEX_ADMIN_AUTH_TOKEN };
let home = "";
let mode: "text" | "tools" | "error400" | "reasoning" = "text";
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
      : mode === "reasoning"
        ? [chunk([{ index: 0, delta: { role: "assistant", reasoning_content: "think" } }]), chunk([{ index: 0, delta: { content: "Hello" } }])]
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
  home = mkdtempSync(join(tmpdir(), "ocx-gemini-interactions-"));
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
const events = async (res: Response) => (await res.text()).split("\n\n").filter(Boolean).map(frame => {
  const [eventLine, dataLine] = frame.split("\n");
  expect(eventLine!.startsWith("event: ")).toBe(true);
  expect(dataLine!.startsWith("data: ")).toBe(true);
  const data = JSON.parse(dataLine!.slice("data: ".length)) as Record<string, any>;
  expect(data.event_type).toBe(eventLine!.slice("event: ".length));
  return data;
});

describe("Gemini Interactions inbound", () => {
  test("a buffered create on /v1beta and /v1 answers an Interaction and reaches the provider as Chat", async () => {
    await withServer(async base => {
      for (const path of ["/v1beta/interactions", "/v1/interactions"]) {
        const res = await post(base, path, { model: "fx/m1", input: "hi", system_instruction: "rules" });
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, any>;
        expect(body.id).toMatch(/^ocx-int-[0-9a-f]{32}$/);
        expect(body).toMatchObject({
          status: "completed", model: "fx/m1",
          steps: [{ type: "model_output", content: [{ type: "text", text: "Hello" }] }],
          usage: { total_input_tokens: 5, total_output_tokens: 2, total_tokens: 7 },
        });
      }
      expect(seen).toHaveLength(2);
      expect(seen[0]!.auth).toBe("Bearer " + PROVIDER_KEY);
      expect(seen[0]!.body).toMatchObject({ model: "m1", stream: false, messages: [{ role: "system", content: "rules" }, { role: "user", content: "hi" }] });
      expect(newRows()).toHaveLength(2);
    });
  });

  test("a streamed create speaks the Interactions SSE vocabulary", async () => {
    mode = "reasoning";
    saveConfig(config(true));
    await withServer(async base => {
      const res = await post(base, "/v1beta/interactions", { model: "fx/m1", input: "hi", stream: true });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const records = await events(res);
      expect(records.map(record => record.event_type)).toEqual([
        "interaction.created", "step.start", "step.delta", "step.stop", "step.start", "step.delta", "step.stop", "interaction.completed",
      ]);
      expect(records[2]).toMatchObject({ delta: { type: "thought_summary", content: { type: "text", text: "think" } } });
      expect(records[5]).toMatchObject({ delta: { type: "text", text: "Hello" } });
      expect(records.at(-1)).toMatchObject({ interaction: { status: "completed", usage: { total_input_tokens: 5, total_tokens: 7 } } });
      expect(records[0]!.interaction.id).toBe(records.at(-1)!.interaction.id);
      expect(seen[0]!.body).toMatchObject({ stream: true });
      expect(newRows()).toHaveLength(1);
      expect(newRows()[0]!.status).toBe(200);
    });
  });

  test("a tool turn requires action, streamed and buffered", async () => {
    mode = "tools";
    await withServer(async base => {
      const tools = [{ type: "function", name: "lookup", description: "find", parameters: { type: "object", properties: { q: { type: "string" } } } }];
      const buffered = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "x", tools })).json() as Record<string, any>;
      expect(buffered).toMatchObject({ status: "requires_action", steps: [{ type: "function_call", id: "call_fixture", name: "lookup", arguments: { q: "x" } }] });
      const records = await events(await post(base, "/v1beta/interactions", { model: "fx/m1", input: "x", tools, stream: true }));
      expect(records.filter(record => record.event_type === "step.start").map(record => record.step)).toEqual([{ type: "function_call", id: "call_fixture", name: "lookup", arguments: {} }]);
      expect(records.at(-1)).toMatchObject({ interaction: { status: "requires_action" } });
      expect(seen[0]!.body.tools).toEqual([{ type: "function", function: { name: "lookup", description: "find", parameters: { type: "object", properties: { q: { type: "string" } } } } }]);
    });
  });

  test("admission takes x-goog-api-key and answers Google-shaped 401 and 405", async () => {
    saveConfig(config(true));
    await withServer(async base => {
      const refused = await post(base, "/v1beta/interactions", { model: "fx/m1", input: "hi" }, {});
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: { code: 401, message: "opencodex API key required", status: "UNAUTHENTICATED" } });
      const byId = await fetch(new URL("/v1beta/interactions/ocx-int-0123", base));
      expect(byId.status).toBe(401);
      expect(await byId.json()).toMatchObject({ error: { code: 401, status: "UNAUTHENTICATED" } });
      const wrong = await fetch(new URL("/v1beta/interactions", base), { headers: googKey });
      expect(wrong.status).toBe(405);
      expect(wrong.headers.get("allow")).toBe("POST");
      expect(seen).toHaveLength(0);
    });
  });

  test("requests opencodex cannot honor are 400s before any send", async () => {
    await withServer(async base => {
      for (const body of [
        { model: "fx/m1", input: "hi", previous_interaction_id: "ocx-int-0" },
        { agent: "deep-research-preview-04-2026", input: "hi" },
        { model: "fx/m1", input: "hi", background: true },
        { model: "fx/m1", input: [{ type: "function_result", call_id: "c9", result: "ok" }] },
        { model: "fx/m1", input: "hi", tools: [{ type: "google_search" }] },
      ]) {
        const res = await post(base, "/v1beta/interactions", body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: { code: 400, status: "INVALID_ARGUMENT" } });
      }
      const unknown = await post(base, "/v1beta/interactions", { model: "off/m1", input: "hi" });
      expect(unknown.status).toBe(404);
      expect(seen).toHaveLength(0);
      expect(newRows()).toHaveLength(6);
    });
  });

  test("a chained tool result is refused for previous_interaction_id first", async () => {
    await withServer(async base => {
      const res = await post(base, "/v1beta/interactions", { model: "fx/m1", previous_interaction_id: "ocx-int-0", input: [{ type: "function_result", call_id: "c9", result: "ok" }] });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 400, message: "previous_interaction_id is not supported", status: "INVALID_ARGUMENT" } });
    });
  });

  test("stored-interaction routes are owned: Google 404 for get and delete, 501 for cancel, 405 otherwise", async () => {
    await withServer(async base => {
      for (const prefix of ["/v1beta", "/v1"]) {
        for (const method of ["GET", "DELETE"]) {
          const res = await fetch(new URL(prefix + "/interactions/ocx-int-0123", base), { method, headers: googKey });
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual({ error: { code: 404, message: "interaction not found", status: "NOT_FOUND" } });
        }
        const cancel = await post(base, prefix + "/interactions/ocx-int-0123/cancel", {});
        expect(cancel.status).toBe(501);
        expect(await cancel.json()).toMatchObject({ error: { code: 501, status: "UNIMPLEMENTED" } });
        const wrong = await post(base, prefix + "/interactions/ocx-int-0123", {});
        expect(wrong.status).toBe(405);
        expect(wrong.headers.get("allow")).toBe("GET, DELETE");
      }
      expect(seen).toHaveLength(0);
    });
  });

  test("the stream is readable from event_type alone, and ?key= admits", async () => {
    saveConfig(config(true));
    await withServer(async base => {
      const res = await post(base, "/v1beta/interactions?alt=sse&key=" + DATA_TOKEN, { model: "fx/m1", input: "hi", stream: true }, {});
      expect(res.status).toBe(200);
      const dataOnly = (await res.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Record<string, any>);
      expect(dataOnly[0]!.event_type).toBe("interaction.created");
      expect(dataOnly.at(-1)!.event_type).toBe("interaction.completed");
      expect(seen[0]!.url).not.toContain(DATA_TOKEN);
    });
  });

  test("an upstream refusal keeps its status with a fixed message", async () => {
    mode = "error400";
    await withServer(async base => {
      const res = await post(base, "/v1beta/interactions", { model: "fx/m1", input: "hi" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code: 400, message: "request rejected", status: "INVALID_ARGUMENT" } });
    });
  });
});

