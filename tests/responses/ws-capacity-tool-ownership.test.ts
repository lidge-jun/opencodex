import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import {
  codexWebSocketAdmissionMetrics, MAX_TRACKED_CODEX_WEBSOCKETS, tryReserveCodexWebSocket,
} from "../../src/codex/websocket-registry";
import type { AdmissionReservation } from "../../src/lib/admission";
import { runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import { clearRequestLogsForTests } from "../../src/server/request-log";
import { setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import type { WsData } from "../../src/server/ws-bridge";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome, type TempHome } from "../helpers/temp-home";

type Frame = Record<string, any>;
type Handler = ReturnType<typeof createWebsocketHandler>;
type Client = { ws: ServerWebSocket<WsData>; handler: Handler; sent: Frame[]; closed: number[] };
const originalFetch = globalThis.fetch;
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const clients: Client[] = [];
const extraLeases: AdmissionReservation<ServerWebSocket<WsData>>[] = [];
const finishBusy: Array<() => void> = [];
let home: TempHome;
let releaseSpendHome: () => void;
let savedProxy: Record<string, string | undefined>;
let upstream: (body: Frame, url: URL) => Response;
let outbound: Frame[];

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("WebSocket tool ownership fixture did not settle");
    await Bun.sleep(1);
  }
}

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  home = createTempHome("ocx-ws-tool-ownership-");
  releaseSpendHome = acquireOwnedSpendHome();
  savedProxy = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  outbound = [];
  upstream = () => { throw new Error("Unexpected upstream request in tool ownership fixture"); };
  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Frame;
    outbound.push(body);
    return upstream(body, new URL(input instanceof Request ? input.url : String(input)));
  }) as typeof fetch;
  clearRequestLogsForTests();
  expect(codexWebSocketAdmissionMetrics().active).toBe(0);
});

afterEach(async () => {
  try {
    for (const client of clients) client.ws.close(1000, "fixture teardown");
    await until(() => clients.every(({ ws }) => !ws.data.cancel && !ws.data.nativeControl));
  } finally {
    for (const finish of finishBusy.splice(0)) finish();
    for (const lease of extraLeases.splice(0)) lease.release();
    clients.length = 0;
    clearComboSelectionState();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    try {
      runOptionalShutdownHooks();
    } finally {
      try { releaseSpendHome(); }
      finally {
        setRelayPlatformForTests(undefined);
        globalThis.fetch = originalFetch;
        for (const key of proxyKeys) {
          if (savedProxy[key] === undefined) delete process.env[key];
          else process.env[key] = savedProxy[key];
        }
        home.remove();
      }
    }
  }
  expect(codexWebSocketAdmissionMetrics().active).toBe(0);
});

function config(baseUrl = "https://api.x.ai/v1", injectXSearch = false): OcxConfig {
  return { port: 0, defaultProvider: "fixture", websockets: true, providers: { fixture: {
    adapter: "openai-responses", baseUrl, authMode: "key", apiKey: "fixture-tool-ownership-key", upstreamWebsocket: false,
    ...(injectXSearch ? { xaiResponsesXSearch: true, supportsOpenAiWebSearchToolFields: false } : {}),
  } } } as OcxConfig;
}

function client(settings = config()): Client {
  const lease = tryReserveCodexWebSocket();
  expect(lease).not.toBeNull();
  const handler = createWebsocketHandler({ config: settings, deps: {} } as ServeOptionsContext);
  const sent: Frame[] = [];
  const closed: number[] = [];
  let state = 1;
  const ws = {
    data: { admissionLease: lease!, headers: new Headers({ "thread-id": `tool-ownership-${clients.length}` }) } as WsData,
    get readyState() { return state; },
    getBufferedAmount: () => 0,
    send(text: string) { sent.push(JSON.parse(text)); return 1; },
    close(code = 1000, reason = "") {
      if (state === 3) return;
      state = 3;
      closed.push(code);
      handler.close(ws, code, reason);
    },
  } as unknown as ServerWebSocket<WsData>;
  handler.open(ws);
  const result = { ws, handler, sent, closed };
  clients.push(result);
  return result;
}

async function turn(target: Client, fields: Frame): Promise<Frame[]> {
  const start = target.sent.length;
  target.handler.message(target.ws, JSON.stringify({ type: "response.create", model: "fixture/grok-4.6", input: "fixture input", ...fields }));
  await until(() => target.sent.slice(start).some(frame => frame.type === "error" || frame.type === "response.completed")
    && !target.ws.data.cancel && !target.ws.data.nativeControl);
  const frames = target.sent.slice(start);
  expect(frames.filter(frame => frame.type === "error")).toEqual([]);
  expect(frames.at(-1)).toMatchObject({ type: "response.completed", response: { status: "completed" } });
  return frames;
}

function fillBusyAndReserve(): AdmissionReservation<ServerWebSocket<WsData>> | null {
  while (codexWebSocketAdmissionMetrics().active < MAX_TRACKED_CODEX_WEBSOCKETS) {
    finishBusy.push(client().ws.data.responsesActivity!.beginTurn([]));
  }
  const lease = tryReserveCodexWebSocket();
  if (lease) extraLeases.push(lease);
  expect(codexWebSocketAdmissionMetrics().active).toBe(MAX_TRACKED_CODEX_WEBSOCKETS);
  return lease;
}

const hostedCall = { type: "custom_tool_call", id: "ctc_search", call_id: "xs_call-1",
  name: "x_keyword_search", input: "{}", status: "completed" };
const clientTool = { type: "function", name: "x_keyword_search", parameters: { type: "object", properties: {} } };

test.each([false, true])("completed xAI hosted search is reclaimable; route-injected declaration=%s", async injected => {
  const target = client(config(injected ? "https://cli-chat-proxy.grok.com/v1" : "https://api.x.ai/v1", injected));
  upstream = () => Response.json({ id: "resp_hosted", status: "completed", output: [hostedCall] });
  const frames = await turn(target, { tools: injected
    ? [{ type: "web_search", external_web_access: true }]
    : [{ type: "x_search" }] });
  expect(outbound).toHaveLength(1);
  expect(outbound[0].tools.some((tool: Frame) => tool.type === "x_search")).toBe(true);
  expect(frames.find(frame => frame.type === "response.output_item.done")?.item).toMatchObject(hostedCall);
  expect(fillBusyAndReserve()).not.toBeNull();
  expect(target.closed).toEqual([1001]);
  expect(clients.slice(1).every(other => other.ws.readyState === 1)).toBe(true);
});

test.each([
  ["https://api.x.ai/v1", false],
  ["https://provider.example/v1", true],
] as const)("declared client custom tool remains protected at %s; x_search declaration=%s", async (baseUrl, declareHosted) => {
  const target = client(config(baseUrl));
  upstream = () => Response.json({ id: "resp_client", status: "completed", output: [hostedCall] });
  const frames = await turn(target, { tools: [clientTool, ...(declareHosted ? [{ type: "x_search" }] : [])] });
  expect(frames.find(frame => frame.type === "response.output_item.done")?.item).toMatchObject(hostedCall);
  expect(fillBusyAndReserve()).toBeNull();
  expect(target.closed).toEqual([]);
});

function toolStream(id: string, call: Frame, includeCreated: boolean): Response {
  const frames = [
    ...(includeCreated ? [{ type: "response.created", response: { id, status: "in_progress", output: [] } }] : []),
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: { id, status: "completed", output: [call] } },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
}

test.each([false, true])("a reused call ID on an ordinary next turn stays protected; response.created=%s", async includeCreated => {
  const target = client(config("https://provider.example/v1"));
  const tools = [{ type: "function", name: "fixture_tool", parameters: { type: "object", properties: {} } }];
  const firstCall = { type: "function_call", id: "fc_first", call_id: "call_0", name: "fixture_tool", arguments: '{"step":1}' };
  const nextCall = { ...firstCall, id: "fc_next", arguments: '{"step":2}' };
  upstream = () => toolStream("resp_first", firstCall, true);
  await turn(target, { tools });
  expect(target.ws.data.responsesActivity!.idle).toBe(false);
  upstream = () => toolStream("resp_next", nextCall, includeCreated);
  const frames = await turn(target, { tools, input: [{ type: "function_call_output", call_id: "call_0", output: "first result" }] });
  expect(outbound).toHaveLength(2);
  expect(frames.some(frame => frame.type === "response.created")).toBe(includeCreated);
  expect(frames.find(frame => frame.type === "response.output_item.done")?.item).toMatchObject(nextCall);
  expect(fillBusyAndReserve()).toBeNull();
  expect(target.closed).toEqual([]);
});

function twoProviderConfig(): OcxConfig {
  const settings = config();
  settings.providers.ordinary = config("https://provider.example/v1").providers.fixture!;
  return settings;
}

test("switching provider on the same socket does not retain the prior turn's hosted authorization", async () => {
  const target = client(twoProviderConfig());
  const hosts: string[] = [];
  upstream = (_body, url) => {
    hosts.push(url.host);
    return Response.json({ id: `resp_switch_${hosts.length}`, status: "completed", output: [hostedCall] });
  };
  await turn(target, { tools: [{ type: "x_search" }] });
  expect(target.ws.data.responsesActivity!.idle).toBe(true);
  const frames = await turn(target, { model: "ordinary/fixture-model", tools: [clientTool, { type: "x_search" }] });
  expect(hosts).toEqual(["api.x.ai", "provider.example"]);
  expect(frames.find(frame => frame.type === "response.output_item.done")?.item).toMatchObject(hostedCall);
  expect(fillBusyAndReserve()).toBeNull();
  expect(target.closed).toEqual([]);
});

test.each([
  ["darwin", false], ["darwin", true], ["win32", false], ["win32", true],
] as const)("combo fallback uses the final response's tool ownership; relay=%s hosted final=%s", async (platform, hostedFinal) => {
  // Exercise the eager Windows relay without changing filesystem/platform identity.
  setRelayPlatformForTests(platform);
  const settings = twoProviderConfig();
  const targets = [{ provider: "fixture", model: "grok-4.6" }, { provider: "ordinary", model: "fixture-model" }];
  if (hostedFinal) targets.reverse();
  settings.combos = { ownership: { strategy: "failover", targets } };
  const target = client(settings);
  const hosts: string[] = [];
  upstream = (_body, url) => {
    hosts.push(url.host);
    if (hosts.length === 1) {
      const response = { id: "resp_failed", status: "failed", output: [],
        error: { type: "server_error", code: "upstream_server_error", message: "fixture first target unavailable" } };
      return new Response(`data: ${JSON.stringify({ type: "response.failed", response })}\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    }
    return toolStream("resp_fallback", hostedCall, true);
  };
  const frames = await turn(target, { model: "combo/ownership", tools: [clientTool, { type: "x_search" }] });
  expect(hosts).toEqual(hostedFinal ? ["provider.example", "api.x.ai"] : ["api.x.ai", "provider.example"]);
  expect(outbound).toHaveLength(2);
  expect(frames.find(frame => frame.type === "response.output_item.done")?.item).toMatchObject(hostedCall);
  const replacement = fillBusyAndReserve();
  if (hostedFinal) {
    expect(replacement).not.toBeNull();
    expect(target.closed).toEqual([1001]);
  } else {
    expect(replacement).toBeNull();
    expect(target.closed).toEqual([]);
  }
});
