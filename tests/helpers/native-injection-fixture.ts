import { afterEach, beforeEach, expect } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { OcxConfig } from "../../src/types";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import type { WsData } from "../../src/server/ws-bridge";
import { clearRequestLogsForTests } from "../../src/server/request-log";
import { runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import { acquireOwnedSpendHome } from "./owned-spend-home";

// The websocket handler dispatches through the real request path, so it reaches the shared spend
// journal and needs the writer lease startServer would have taken. Without it the turn is refused
// and the symptom is the fixture's own wait timing out, which names nothing.
let releaseSpendHome: (() => void) | undefined;
// Every synthetic client this fixture opens, so teardown can close them before the lease is
// given back rather than leaving a handler mid-turn against a journal nobody owns.
const clients: Array<ServerWebSocket<WsData>> = [];

export type Frame = Record<string, any>;
const realSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedProxy: Record<string, string | undefined>;
export let fallbackCalls = 0;
let nextId = 0;

/** In-process upstream: all model traffic remains synthetic and network attempts fail. */
export class InjectionSocket extends EventTarget {
  static OPEN = 1;
  static all: InjectionSocket[] = [];
  readyState = 0;
  frames: Frame[] = [];
  readonly root = `inject-${++nextId}`;
  throwOnInject = false;
  constructor(readonly url: string, readonly options: { headers: Record<string, string> }) {
    super(); InjectionSocket.all.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }
  send(text: string) {
    const frame = JSON.parse(text);
    if (frame.type === "response.inject" && this.throwOnInject) throw new Error("fixture send failure");
    this.frames.push(frame);
    if (this.frames.length === 1) queueMicrotask(() => this.emit({ type: "response.created", response: { id: this.root, status: "in_progress", output: [] } }));
  }
  emit(frame: Frame) {
    const lane = this.frames[0]?.stream_id;
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ...(lane !== undefined ? { stream_id: lane } : {}), ...frame }) }));
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
/** Public API and subscription fixtures have distinct, never-live credentials. */
export const injectionConfig = (api = false): OcxConfig => ({ port: 0, defaultProvider: api ? "api" : "openai", websockets: true, codexNativeInjection: true,
  providers: api
    ? { api: { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-public-key", upstreamWebsocket: true, headers: { "openai-beta": "fixture_beta=v1" } } }
    : { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } },
} as OcxConfig);
export const waitForInjection = async (condition: () => boolean) => {
  for (let i = 0; i < 1000; i++) { if (condition()) return; await Bun.sleep(1); }
  throw new Error("injection fixture condition timed out");
};
export function injectionClient(fields: Frame = {}, settings = injectionConfig(), credential = "test") {
  releaseSpendHome ??= acquireOwnedSpendHome();
  const handler = createWebsocketHandler({ config: settings, deps: {} } as ServeOptionsContext);
  const sent: Frame[] = [];
  const ws = { readyState: 1, data: { headers: new Headers({ authorization: `Bearer ${credential}`, "thread-id": `injection-fixture-${++nextId}`, "openai-beta": "fixture_beta=v1" }) } as WsData,
    send: (text: string) => { sent.push(JSON.parse(text)); return 1; }, close() { handler.close(ws, 1000, "fixture close"); },
  } as unknown as ServerWebSocket<WsData>;
  const send = (frame: Frame) => handler.message(ws, JSON.stringify(frame));
  clients.push(ws);
  send({ type: "response.create", model: settings.defaultProvider === "api" ? "api/gpt-5.6-sol" : "gpt-5.6-sol", input: "initial", multi_agent: { enabled: true },
    tools: [{ type: "function", name: "get_value", parameters: { type: "object", properties: {} } }], ...fields });
  return { ws, sent, send, handler };
}
export async function beginInjection(fields: Frame = {}, settings = injectionConfig(), credential = "test") {
  const client = injectionClient(fields, settings, credential);
  await waitForInjection(() => client.sent.some(frame => frame.type === "response.created"));
  const socket = InjectionSocket.all.at(-1)!;
  expect(socket).toBeDefined();
  return { ...client, socket, id: socket.root };
}
/** A saved-result continuation must restate the settings the opening frame pinned. */
export function continuationFrame(fields: Frame, api = false): Frame {
  return {
    model: api ? "api/gpt-5.6-sol" : "gpt-5.6-sol",
    multi_agent: { enabled: true },
    tools: [{ type: "function", name: "get_value", parameters: { type: "object", properties: {} } }],
    ...fields,
  };
}
export function advertiseInjection(socket: InjectionSocket, call = "call-1", index = 0) {
  const item = { id: `item-${call}`, type: "function_call", call_id: call, name: "get_value", arguments: "{}" };
  socket.emit({ type: "response.output_item.added", output_index: index, item });
  socket.emit({ type: "response.output_item.done", output_index: index, item });
  return item;
}
export const savedResult = (call = "call-1", output = "saved result") => ({ type: "function_call_output", call_id: call, output });
export function completeInjection(socket: InjectionSocket, extra: Frame = {}, id = socket.root) {
  socket.emit({ type: "response.completed", response: { id, status: "completed", output: [], ...extra } });
}
export function acknowledgeInjection(socket: InjectionSocket, sequence = 100, id = socket.root) {
  socket.emit({ type: "response.inject.created", response_id: id, sequence_number: sequence });
}
export function installInjectionFixture() {
  beforeEach(() => {
    nextId = 0; fallbackCalls = 0;
    savedProxy = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
    for (const key of proxyKeys) delete process.env[key];
    globalThis.WebSocket = InjectionSocket as unknown as typeof WebSocket;
    globalThis.fetch = (async () => { fallbackCalls++; throw new Error("network disabled in injection fixture"); }) as typeof fetch;
    clearRequestLogsForTests();
  });
  afterEach(async () => {
    // handler.close only STARTS the pump cancellation. Waiting for the socket to drop its stream
    // cancel and its native control is what proves the turn finished accounting; releasing the
    // lease before that leaves a reader settling against a journal nobody owns.
    //
    // The rest runs even when that wait gives up, and the failure still propagates. A wait that
    // expired is NOT evidence the turn settled: it means this fixture could not prove it, and
    // the case should say so while still handing back the lease and the globals it replaced.
    let failure: unknown;
    const note = (error: unknown): void => { failure ??= error; };
    try {
      // Every client gets its close and its wait even after an earlier one gave up. Stopping at
      // the first failure left the rest open for the next case to inherit.
      for (const client of clients.splice(0)) {
        // Separate guards: close() runs the production handler, so a throw there would otherwise
        // skip this client's completion wait as well as its own failure.
        try { client.close(); } catch (error) { note(error); }
        try {
          await waitForInjection(() => client.data.cancel === undefined && client.data.nativeControl === undefined);
        } catch (error) { note(error); }
      }
      for (const socket of InjectionSocket.all) {
        try { socket.close(); } catch (error) { note(error); }
      }
      InjectionSocket.all = [];
      try { runOptionalShutdownHooks(); } catch (error) { note(error); }
      // The release itself can throw, and it used to take the global restore down with it.
      try { releaseSpendHome?.(); } catch (error) { note(error); } finally { releaseSpendHome = undefined; }
    } finally {
      globalThis.WebSocket = realSocket; globalThis.fetch = realFetch;
      for (const key of proxyKeys) { delete process.env[key]; if (savedProxy[key] !== undefined) process.env[key] = savedProxy[key]; }
    }
    if (failure !== undefined) throw failure;
  });
}
