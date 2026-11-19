import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { interactionsRetainedStoreSnapshot } from "../../src/server/gemini-interactions-store";

const DATA_TOKEN = "ocx_data_interactionsfixture";
const ADMIN_TOKEN = "admin-secret-for-interactions";
const PROVIDER_KEY = "provider-fixture-key";
const saved = { home: process.env.OPENCODEX_HOME, data: process.env.OPENCODEX_API_AUTH_TOKEN, admin: process.env.OPENCODEX_ADMIN_AUTH_TOKEN };
let home = "";
let mode: "text" | "tools" | "error400" | "reasoning" | "oversize" = "text";
let seen: { auth: string | null; url: string; headers: Headers; body: Record<string, unknown> }[] = [];
let upstream: ReturnType<typeof Bun.serve>;

const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
  "data: " + JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "m1", choices, ...extra }) + "\n\n";

beforeAll(() => {
  upstream = Bun.serve({ port: 0, async fetch(req) {
    if (req.method === "GET") return Response.json({ object: "list", data: [{ id: "m1", object: "model" }] });
    const body = await req.json() as Record<string, unknown>;
    seen.push({ auth: req.headers.get("authorization"), url: req.url, headers: req.headers, body });
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
    if (mode === "oversize") {
      for (let i = 0; i < 3; i++) frames.push(chunk([{ index: 0, delta: { content: "x".repeat(256 * 1024) } }]));
      frames.push(chunk([{ index: 0, delta: { content: "tail" } }]));
    }
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
  test.each(["/v1beta/interactions", "/v1/interactions"])("%s keeps ACP turn labels out of provider requests", async path => {
    const metadata = JSON.stringify({ request_kind: "memory" });
    const labels = { "x-openai-memgen-request": "true", "x-codex-turn-metadata": metadata };
    await withServer(async base => {
      const response = await post(base, path, {
        model: "fx/m1", input: "hi", client_metadata: { "x-codex-turn-metadata": metadata },
      }, { ...googKey, ...labels });
      expect(response.status).toBe(200);
      await response.text();
      expect(seen).toHaveLength(1);
      for (const name of Object.keys(labels)) expect(seen[0]!.headers.has(name)).toBe(false);
      expect(seen[0]!.body).not.toHaveProperty("client_metadata");
    });
  });

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
      expect(newRows()).toHaveLength(5);
    });
  });

  test("caller safety_settings is a typed 400 through both aliases before any send", async () => {
    await withServer(async base => {
      for (const prefix of ["/v1beta", "/v1"]) {
        const res = await post(base, prefix + "/interactions", { model: "fx/m1", input: "hi", safety_settings: [] });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: { code: 400, message: "safety_settings is not supported", status: "INVALID_ARGUMENT" } });
      }
      expect(seen).toHaveLength(0);
    });
  });

  test("an unknown previous_interaction_id is a Google 404 before any send", async () => {
    await withServer(async base => {
      const res = await post(base, "/v1beta/interactions", { model: "fx/m1", previous_interaction_id: "ocx-int-0", input: [{ type: "function_result", call_id: "c9", result: "ok" }] });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 404, message: "interaction not found", status: "NOT_FOUND" } });
      expect(seen).toHaveLength(0);
    });
  });

  test("stored-interaction routes are owned: Google 404 for unknown ids, 405 otherwise", async () => {
    await withServer(async base => {
      for (const prefix of ["/v1beta", "/v1"]) {
        for (const method of ["GET", "DELETE"]) {
          const res = await fetch(new URL(prefix + "/interactions/ocx-int-0123", base), { method, headers: googKey });
          expect(res.status).toBe(404);
          expect(await res.json()).toEqual({ error: { code: 404, message: "interaction not found", status: "NOT_FOUND" } });
        }
        const cancel = await post(base, prefix + "/interactions/ocx-int-0123/cancel", {});
        expect(cancel.status).toBe(404);
        expect(await cancel.json()).toMatchObject({ error: { code: 404, status: "NOT_FOUND" } });
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


describe("Gemini Interactions state", () => {
  const OTHER_KEY = "ocx_data_interactions_other";
  const withOtherKey = () => saveConfig({ ...config(true), apiKeys: [{ id: "other", name: "other", key: OTHER_KEY, createdAt: "2026-11-15T00:00:00Z" }] } as OcxConfig);

  test("previous_interaction_id continues the stored history with this turn's system_instruction only", async () => {
    await withServer(async base => {
      const first = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "my name is Phil", system_instruction: "first rules" })).json() as Record<string, any>;
      const second = await post(base, "/v1beta/interactions", { model: "fx/m1", input: "what is my name?", previous_interaction_id: first.id, system_instruction: "second rules" });
      expect(second.status).toBe(200);
      expect(second.headers.get("x-opencodex-interaction-stored")).toBe("true");
      expect(seen[1]!.body.messages).toEqual([
        { role: "system", content: "second rules" },
        { role: "user", content: "my name is Phil" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "what is my name?" },
      ]);
    });
  });

  test("a chained tool result needs no repeated function_call", async () => {
    mode = "tools";
    await withServer(async base => {
      const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } }];
      const first = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "find x", tools })).json() as Record<string, any>;
      expect(first.status).toBe("requires_action");
      mode = "text";
      const second = await post(base, "/v1beta/interactions", { model: "fx/m1", tools, previous_interaction_id: first.id, input: [{ type: "function_result", call_id: "call_fixture", name: "lookup", result: "found" }] });
      expect(second.status).toBe(200);
      expect(seen[1]!.body.messages).toEqual([
        { role: "user", content: "find x" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
        { role: "tool", tool_call_id: "call_fixture", content: "found" },
      ]);
      const unknown = await post(base, "/v1beta/interactions", { model: "fx/m1", previous_interaction_id: first.id, input: [{ type: "function_result", call_id: "call_other", result: "x" }] });
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ error: { message: "unmatched function_result" } });
    });
  });

  test("GET returns the stored interaction with its input; DELETE removes it", async () => {
    await withServer(async base => {
      const created = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "hi" })).json() as Record<string, any>;
      const got = await fetch(new URL("/v1/interactions/" + created.id, base), { headers: googKey });
      expect(got.status).toBe(200);
      expect(await got.json()).toMatchObject({
        id: created.id, object: "interaction", status: "completed",
        steps: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }, { type: "model_output", content: [{ type: "text", text: "Hello" }] }],
      });
      const cancel = await post(base, "/v1beta/interactions/" + created.id + "/cancel", {});
      expect(cancel.status).toBe(400);
      const deleted = await fetch(new URL("/v1beta/interactions/" + created.id, base), { method: "DELETE", headers: googKey });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({});
      expect((await fetch(new URL("/v1beta/interactions/" + created.id, base), { headers: googKey })).status).toBe(404);
      const chained = await post(base, "/v1beta/interactions", { model: "fx/m1", input: "again", previous_interaction_id: created.id });
      expect(chained.status).toBe(404);
      expect(seen).toHaveLength(1);
    });
  });

  test("a streamed turn is stored after it settles", async () => {
    await withServer(async base => {
      const records = await events(await post(base, "/v1beta/interactions", { model: "fx/m1", input: "hi", stream: true }));
      const id = records[0]!.interaction.id as string;
      const got = await fetch(new URL("/v1beta/interactions/" + id, base), { headers: googKey });
      expect(got.status).toBe(200);
      expect(await got.json()).toMatchObject({ id, status: "completed", steps: [{ type: "user_input" }, { type: "model_output", content: [{ type: "text", text: "Hello" }] }] });
    });
  });

  test("an answer exceeding the live store allowance finishes SSE without storing a partial turn", async () => {
    mode = "oversize";
    saveConfig({ ...config(), maxInboundBodyBytes: 1024 * 1024 });
    await withServer(async base => {
      const path = "/v1beta/interactions";
      const res = await post(base, path, { model: "fx/m1", input: "hi", stream: true });
      const records = await events(res);
      const text = records.flatMap(record => record.delta?.type === "text" ? [record.delta.text as string] : []).join("");
      expect(text).toBe("Hello" + "x".repeat(768 * 1024) + "tail");
      expect(records.at(-1)).toMatchObject({ event_type: "interaction.completed", interaction: { status: "completed" } });
      expect((await fetch(new URL(path + "/" + records[0]!.interaction.id, base), { headers: googKey })).status).toBe(404);
    });
  });

  test("store:false is served but not kept", async () => {
    await withServer(async base => {
      const created = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "hi", store: false })).json() as Record<string, any>;
      expect((await fetch(new URL("/v1beta/interactions/" + created.id, base), { headers: googKey })).status).toBe(404);
      expect((await post(base, "/v1beta/interactions", { model: "fx/m1", input: "again", previous_interaction_id: created.id })).status).toBe(404);
    });
  });

  test("interaction resources and chain misses are never cacheable under either key header", async () => {
    withOtherKey();
    await withServer(async base => {
      for (const prefix of ["/v1beta", "/v1"]) {
        for (const header of ["x-goog-api-key", "x-opencodex-api-key"]) {
          const path = prefix + "/interactions";
          const owner = { [header]: DATA_TOKEN };
          const other = { [header]: OTHER_KEY };
          const created = await post(base, path, { model: "fx/m1", input: "private" }, owner);
          const { id } = await created.json() as { id: string };
          const resource = new URL(path + "/" + id, base);
          const noStore = async (res: Response, status: number) => {
            expect(res.status).toBe(status);
            expect(res.headers.get("cache-control")).toBe("no-store");
            if (!res.bodyUsed) await res.text();
          };
          await noStore(created, 200);
          await noStore(await fetch(resource), 401);
          await noStore(await fetch(resource, { headers: owner }), 200);
          await noStore(await fetch(resource, { headers: other }), 404);
          await noStore(await post(base, resource.pathname + "/cancel", {}, owner), 400);
          await noStore(await post(base, resource.pathname + "/cancel", {}, other), 404);
          await noStore(await post(base, path, { model: "fx/m1", input: "again", previous_interaction_id: id }, other), 404);
          await noStore(await fetch(resource, { method: "DELETE", headers: other }), 404);
          await noStore(await fetch(resource, { method: "DELETE", headers: owner }), 200);
          await noStore(await fetch(resource, { headers: owner }), 404);
        }
      }
    });
  });

  test("another data key cannot read, continue or delete an interaction", async () => {
    withOtherKey();
    await withServer(async base => {
      const created = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "secret" })).json() as Record<string, any>;
      const other = { "x-goog-api-key": OTHER_KEY };
      expect((await fetch(new URL("/v1beta/interactions/" + created.id, base), { headers: other })).status).toBe(404);
      expect((await fetch(new URL("/v1beta/interactions/" + created.id, base), { method: "DELETE", headers: other })).status).toBe(404);
      expect((await post(base, "/v1beta/interactions", { model: "fx/m1", input: "x", previous_interaction_id: created.id }, other)).status).toBe(404);
      expect((await fetch(new URL("/v1beta/interactions/" + created.id, base), { headers: googKey })).status).toBe(200);
    });
  });
});


describe("Gemini Interactions state: ownership and chaining rules", () => {
  const KEY_A = "ocx_data_interactions_key_a";
  const KEY_B = "ocx_data_interactions_key_b";
  const keys = (cfg: OcxConfig) => ({ ...cfg, apiKeys: [
    { id: "a", name: "a", key: KEY_A, createdAt: "2026-11-15T00:00:00Z" },
    { id: "b", name: "b", key: KEY_B, createdAt: "2026-11-15T00:00:00Z" },
  ] }) as OcxConfig;

  test("on a loopback bind each presented key owns its interactions; a keyless caller sees none of them", async () => {
    saveConfig(keys(config()));
    await withServer(async base => {
      const created = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "mine" }, { "x-goog-api-key": KEY_A })).json() as Record<string, any>;
      const url = new URL("/v1beta/interactions/" + created.id, base);
      expect((await fetch(url, { headers: { "x-goog-api-key": KEY_A } })).status).toBe(200);
      expect((await fetch(url, { headers: { "x-goog-api-key": KEY_B } })).status).toBe(404);
      expect((await fetch(url)).status).toBe(404);
      expect((await post(base, "/v1beta/interactions/" + created.id + "/cancel", {}, { "x-goog-api-key": KEY_B })).status).toBe(404);
      const keyless = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "anyone" }, {})).json() as Record<string, any>;
      expect((await fetch(new URL("/v1beta/interactions/" + keyless.id, base))).status).toBe(200);
      expect((await fetch(new URL("/v1beta/interactions/" + keyless.id, base), { headers: { "x-goog-api-key": KEY_A } })).status).toBe(404);
    });
  });

  test("a stored answer reports x-opencodex-interaction-stored and exposes it to browsers", async () => {
    await withServer(async base => {
      const res = await post(base, "/v1beta/interactions", { model: "fx/m1", input: "hi" });
      expect(res.headers.get("x-opencodex-interaction-stored")).toBe("true");
      expect(res.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-opencodex-interaction-stored");
      const unstored = await post(base, "/v1beta/interactions", { model: "fx/m1", input: "hi", store: false });
      expect(unstored.headers.get("x-opencodex-interaction-stored")).toBeNull();
      expect((await res.json() as Record<string, any>).previous_interaction_id).toBeUndefined();
    });
  });

  test("a chained turn inherits no tools or generation_config and names its predecessor", async () => {
    await withServer(async base => {
      const first = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "a", tools: [{ type: "function", name: "f" }], generation_config: { temperature: 0.1 } })).json() as Record<string, any>;
      const second = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "b", previous_interaction_id: first.id })).json() as Record<string, any>;
      expect(seen[1]!.body.tools).toBeUndefined();
      expect(seen[1]!.body.temperature).toBeUndefined();
      expect(second.previous_interaction_id).toBe(first.id);
    });
  });

  test("results resolve only against the pending calls of the last turn, and only as the leading input", async () => {
    mode = "tools";
    await withServer(async base => {
      const tools = [{ type: "function", name: "lookup" }];
      const first = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "find", tools })).json() as Record<string, any>;
      const afterUser = await post(base, "/v1beta/interactions", { model: "fx/m1", previous_interaction_id: first.id, input: [
        { type: "user_input", content: [{ type: "text", text: "wait" }] },
        { type: "function_result", call_id: "call_fixture", result: "x" },
      ] });
      expect(afterUser.status).toBe(400);
      mode = "text";
      const answered = await (await post(base, "/v1beta/interactions", { model: "fx/m1", previous_interaction_id: first.id, input: [{ type: "function_result", call_id: "call_fixture", result: "x" }] })).json() as Record<string, any>;
      const stale = await post(base, "/v1beta/interactions", { model: "fx/m1", previous_interaction_id: answered.id, input: [{ type: "function_result", call_id: "call_fixture", result: "again" }] });
      expect(stale.status).toBe(400);
      expect(await stale.json()).toMatchObject({ error: { message: "unmatched function_result" } });
    });
  });

  test("a chain that resends the function_call does not duplicate it upstream", async () => {
    mode = "tools";
    await withServer(async base => {
      const first = await (await post(base, "/v1beta/interactions", { model: "fx/m1", input: "find", tools: [{ type: "function", name: "lookup" }] })).json() as Record<string, any>;
      mode = "text";
      const res = await post(base, "/v1beta/interactions", { model: "fx/m1", previous_interaction_id: first.id, input: [
        { type: "function_call", id: "call_fixture", name: "lookup", arguments: { q: "x" } },
        { type: "function_result", call_id: "call_fixture", result: "found" },
      ] });
      expect(res.status).toBe(200);
      const assistants = (seen[1]!.body.messages as Record<string, any>[]).filter(message => message.role === "assistant");
      expect(assistants).toHaveLength(1);
    });
  });

  test("a failed turn stores nothing", async () => {
    mode = "error400";
    await withServer(async base => {
      const before = interactionsRetainedStoreSnapshot().count;
      expect((await post(base, "/v1beta/interactions", { model: "fx/m1", input: "hi" })).status).toBe(400);
      expect((await post(base, "/v1beta/interactions", { model: "fx/m1", input: "hi", stream: true })).status).toBe(400);
      expect(interactionsRetainedStoreSnapshot().count).toBe(before);
    });
  });
});
