import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClientConfig, LOOPBACK_API_KEY_PLACEHOLDER, OPENCODE_PROVIDER_ID, type PiGeneratedConfig,
} from "../../src/clients/config-export";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { drainAndShutdown } from "../../src/server/lifecycle";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { streamFromText } from "../helpers/sse-stream";

/** Synthetic upstream credential for the fake upstream; never a real key. */
const UPSTREAM_FIXTURE_KEY = "omo-upstream-fixture-key";

/**
 * Wire contract: @mariozechner/pi-ai 0.57.1, a9cedccdde77e9d765303463d8a6cd11c58f7a7f.
 * https://github.com/badlogic/pi-mono/blob/a9cedccdde77e9d765303463d8a6cd11c58f7a7f/packages/ai/src/providers/openai-responses.ts
 * https://github.com/badlogic/pi-mono/blob/a9cedccdde77e9d765303463d8a6cd11c58f7a7f/packages/ai/src/providers/openai-responses-shared.ts
 * buildParams sends full input, store:false and include:["reasoning.encrypted_content"].
 * processResponsesStream serializes the complete reasoning item as thinkingSignature;
 * convertResponsesMessages parses it back, then emits function_call + function_call_output.
 * pi-ai always streams; the JSON row additionally covers ocx's nonstream ingress contract.
 * This models the source-verified wire shape; it does not launch the senpi executable.
 */
type Item = Record<string, unknown>;
type WireResponse = { id: string; output: Item[] };

const reasoning = {
  type: "reasoning", id: "rs_omo_fixture", summary: [{ type: "summary_text", text: "Look up the fixture value." }],
  encrypted_content: "omo-fixture-opaque-reasoning",
};
const call = {
  type: "function_call", id: "fc_omo_fixture", call_id: "call_omo_fixture", name: "lookup",
  arguments: '{"key":"fixture"}', status: "completed",
};
const answer = {
  type: "message", id: "msg_omo_fixture", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "The fixture value is 42.", annotations: [] }],
};

function responseFixture(turn: number, stream: boolean): Response {
  const output = turn === 1 ? [reasoning, call] : [answer];
  const response = {
    id: `resp_omo_${turn}`, object: "response", status: "completed", model: "omo-fixture",
    output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  if (!stream) return Response.json(response);
  const events: Item[] = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }];
  output.forEach((item, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item });
    events.push({ type: "response.output_item.done", output_index, item });
  });
  events.push({ type: "response.completed", response });
  return new Response(streamFromText(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function readResponse(response: Response, stream: boolean): Promise<WireResponse> {
  expect(response.status).toBe(200);
  if (!stream) {
    expect(response.headers.get("content-type")).toContain("application/json");
    return await response.json() as WireResponse;
  }
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const events = (await response.text()).split("\n")
    .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(line => JSON.parse(line.slice(6)));
  expect(events.some(event => event.type === "response.failed" || event.type === "error")).toBe(false);
  // pi-ai records reasoning signatures on output_item.done, not just response.completed.
  expect(events.filter(event => event.type === "response.output_item.done").map(event => event.item))
    .toEqual(events.find(event => event.type === "response.completed")?.response.output);
  const completed = events.find(event => event.type === "response.completed");
  expect(completed).toBeDefined();
  return completed.response;
}

describe("omo Responses export: stateless reasoning/tool continuity over loopback (#7431)", () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof startServer>;
  let home: string;
  let codexHome: ReturnType<typeof installIsolatedCodexHome>;
  const priorHome = process.env.OPENCODEX_HOME;
  const captured: Array<{ path: string; authorization: string | null; body: Record<string, unknown> }> = [];
  let exported: PiGeneratedConfig["providers"][string];

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-omo-responses-"));
    process.env.OPENCODEX_HOME = home;
    codexHome = installIsolatedCodexHome("ocx-omo-responses-codex-");
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/models") return Response.json({ data: [{ id: "omo-fixture" }] });
        if (path !== "/v1/responses") return new Response("unexpected upstream path", { status: 404 });
        const body = await request.json() as Record<string, unknown>;
        captured.push({ path, authorization: request.headers.get("authorization"), body });
        return responseFixture((body.input as Item[]).some(item => item.type === "function_call_output") ? 2 : 1, body.stream === true);
      },
    });
    const config: OcxConfig = {
      port: 0, hostname: "127.0.0.1", defaultProvider: "fixture",
      omoClientExport: { api: "openai-responses" },
      providers: { fixture: {
        adapter: "openai-responses", baseUrl: `${upstream.url.origin}/v1`, allowPrivateNetwork: true,
        authMode: "key", apiKey: UPSTREAM_FIXTURE_KEY, models: ["omo-fixture"], upstreamWebsocket: false,
      } },
    };
    saveConfig(config);
    proxy = startServer(0);
    exported = (buildClientConfig("omo", {
      config, baseUrl: `${proxy.url.origin}/v1`,
      // A reasoning ladder is what makes the Pi exporter mark the model as reasoning-capable.
      models: [{ namespaced: "fixture/omo-fixture", provider: "fixture", id: "omo-fixture", reasoningEfforts: ["low", "medium", "high"] }],
    }) as PiGeneratedConfig).providers[OPENCODE_PROVIDER_ID]!;
  });

  afterAll(async () => {
    try {
      if (proxy) await drainAndShutdown(proxy, 5_000);
    } finally {
      if (upstream) await upstream.stop(true);
      if (codexHome) { codexHome.restoreEnvironment(); codexHome.removeAfterDrain(); }
      if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = priorHome;
      if (home) removeTreeWithRetry(home);
    }
  });

  for (const stream of [false, true]) {
    test(`exported placeholder admits two tool turns and preserves reasoning (${stream ? "SSE" : "JSON"})`, async () => {
      expect(exported.api).toBe("openai-responses");
      expect(exported.apiKey).toBe(LOOPBACK_API_KEY_PLACEHOLDER);
      const entry = exported.models[0]!;
      const model = entry.id;
      // pi-ai sends reasoning/include only for a reasoning model, with the effort its level map names.
      expect(entry.reasoning).toBe(true);
      const effort = entry.thinkingLevelMap?.medium;
      expect(effort).toBe("medium");
      const mark = captured.length;
      const user = { role: "user", content: [{ type: "input_text", text: "Look up the fixture value." }] };
      const send = (input: Item[]) => fetch(`${exported.baseUrl}/responses`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${exported.apiKey}` },
        body: JSON.stringify({ model, stream, store: false,
          ...(entry.reasoning ? { include: ["reasoning.encrypted_content"], reasoning: { effort, summary: "auto" } } : {}), input,
          tools: [{ type: "function", name: "lookup", description: "Look up a fixture value", strict: null,
            parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }],
        }),
      });
      const first = await readResponse(await send([user]), stream);
      expect(first.output).toEqual([reasoning, call]);
      // Match thinkingSignature restoration and function-call reconstruction in pi-ai.
      const thinkingSignature = JSON.stringify(first.output[0]);
      const returnedCall = first.output[1]!;
      const replayedCall = { type: "function_call", id: returnedCall.id, call_id: returnedCall.call_id,
        name: returnedCall.name, arguments: JSON.stringify(JSON.parse(returnedCall.arguments as string)) };
      const result = { type: "function_call_output", call_id: returnedCall.call_id, output: "42" };
      const second = await readResponse(await send([user, JSON.parse(thinkingSignature), replayedCall, result]), stream);
      expect(second.output).toEqual([answer]);
      const turns = captured.slice(mark);
      expect(turns).toHaveLength(2);
      for (const turn of turns) {
        expect(turn.path).toBe("/v1/responses");
        expect(turn.authorization).toBe(`Bearer ${UPSTREAM_FIXTURE_KEY}`);
        expect(turn.body.model).toBe("omo-fixture");
        expect(turn.body.store).toBe(false);
        expect(turn.body.previous_response_id).toBeUndefined();
        expect(turn.body.include).toContain("reasoning.encrypted_content");
      }
      expect(turns[0]!.body.input).toEqual([user]);
      // store:false strips server-side item ids (stripItemIdsWhenUnstored), while
      // retaining the complete reasoning payload and call_id that links the tool result.
      const { id: _reasoningId, ...unstoredReasoning } = reasoning;
      const { id: _callId, ...unstoredCall } = replayedCall;
      expect(turns[1]!.body.input).toEqual([user, unstoredReasoning, unstoredCall, result]);
    });
  }
});
