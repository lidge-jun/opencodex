import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { loadConfig, readConfigDiagnostics, validateConfigCandidate } from "../../src/config";
import { resolveApiAuth, safeConfigDTO } from "../../src/server/auth-cors";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const SOURCE = "claude-haiku-5-5";
const TARGET = "anthropic-alternate/reduced";
const SUBSCRIPTION = "Bearer sk-ant-oat01-fixture";
const NOW = 1_800_000_000_000;
const UPSTREAM_HEADERS = {
  "anthropic-ratelimit-unified-7d-utilization": "0.95",
  "anthropic-ratelimit-unified-7d-reset": String(NOW / 1000 + 3600),
};
const MESSAGE = {
  id: "msg_fixture", type: "message", role: "assistant", model: SOURCE,
  content: [{ type: "text", text: "response" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
const SSE = [
  { type: "message_start", message: { ...MESSAGE, content: [], stop_reason: null } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "response" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");

type Seen = {
  model: string; auth: string | null; apiKey: string | null; priority: string | null; stream: boolean;
  thread?: unknown;
};
let home: TempHome;
let servers: ReturnType<typeof Bun.serve>[];
let releaseSpendHome: (() => void) | undefined;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;

beforeEach(() => {
  home = createTempHome("ocx-reserve-");
  servers = [];
  clock = spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(async () => {
  clock.mockRestore();
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  for (const server of servers) await server.stop(true);
  home.remove();
});

function upstream(quota?: HeadersInit) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const { model, stream, thread } = await req.json() as { model: string; stream: boolean; thread?: unknown };
      seen.push({ model, stream, thread, auth: req.headers.get("authorization"), apiKey: req.headers.get("x-api-key"), priority: req.headers.get("x-ocx-priority") });
      return stream
        ? new Response(SSE, { headers: { "content-type": "text/event-stream" } })
        : Response.json(MESSAGE, { headers: quota });
    },
  });
  servers.push(server);
  return { url: server.url.origin, seen };
}

const provider = (baseUrl: string, model: string) => ({
  adapter: "anthropic" as const, baseUrl, authMode: "key" as const, allowPrivateNetwork: true,
  apiKey: "fixture-managed-credential", models: [model],
});

const CONFIG_BASE = { port: 10100, defaultProvider: "source", providers: { source: provider("https://source.example", SOURCE) } };
const POLICY = { enabled: true, soft: 0.6, hard: 0.8, targets: [TARGET] };

function loadedConfig(settings: Record<string, unknown> = {}) {
  writeFileSync(home.path("config.json"), JSON.stringify({ ...CONFIG_BASE, ...settings }));
  return loadConfig();
}

function setup(managedMessagesNative = true, policy: Record<string, unknown> = POLICY, quota: HeadersInit = UPSTREAM_HEADERS) {
  const native = upstream(quota);
  const managed = upstream();
  const target = upstream();
  const config = loadedConfig({
    providers: { source: { ...provider(managed.url, SOURCE), defaultModel: SOURCE }, "anthropic-alternate": provider(target.url, "reduced") },
    claudeCode: { anthropicBaseUrl: native.url },
    protocols: { rollout: { managedMessagesNative } },
    subscriptionReserve: policy,
  });
  releaseSpendHome = acquireOwnedSpendHome();
  return { config, native, managed, target };
}

async function send(config: OcxConfig, opts: {
  authorization?: string; priority?: string; model?: string; admissionKey?: string; thread?: Record<string, string>;
} = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.authorization) headers.set("authorization", opts.authorization);
  if (opts.priority) headers.set("x-ocx-priority", opts.priority);
  if (opts.admissionKey) headers.set("x-opencodex-api-key", opts.admissionKey);
  if (opts.thread) headers.set("anthropic-beta", "message-threads-2026-08-12");
  const log: RequestLogContext = { model: "", provider: "" };
  const req = new Request("http://localhost/v1/messages", {
    method: "POST", headers, body: JSON.stringify({
      model: opts.model ?? SOURCE, max_tokens: 16, messages: [{ role: "user", content: "fixture" }], stream: false,
      ...(opts.thread ? { thread: opts.thread } : {}),
    }),
  });
  const admission = opts.admissionKey ? resolveApiAuth(req, config) : undefined;
  if (opts.admissionKey) expect(admission?.kind).toBe("configured");
  const res = await handleClaudeMessages(req, config, log, admission
    ? { requestId: crypto.randomUUID(), start: Date.now(), admission } : undefined);
  const body = await res.json();
  expect({ status: res.status, error: body.error }).toEqual({ status: 200, error: undefined });
  return { body, log };
}

test("the policy loads from config.json and appears in diagnostics and the management config view", () => {
  const config = loadedConfig({ subscriptionReserve: POLICY });
  expect(config.subscriptionReserve).toEqual(POLICY);
  expect(readConfigDiagnostics().config).toMatchObject({ subscriptionReserve: POLICY });
  expect(safeConfigDTO(config)).toMatchObject({ subscriptionReserve: POLICY });
});

test.each([
  { enabled: "true" },
  { soft: 0 },
  { hard: 1.1 },
  { soft: 0.9 },
  { soft: 0.8, hard: 0.4 },
  { targets: ["/model", "provider/", "bare-model", "provider/*"] },
  { unknown: true },
])("invalid policy %j is rejected on writes and disabled on disk without dropping other fields", subscriptionReserve => {
  const raw = { ...CONFIG_BASE, port: 12345, subscriptionReserve };
  expect(validateConfigCandidate(raw)).toMatchObject({ ok: false, error: expect.stringContaining("subscriptionReserve") });
  expect(loadedConfig(raw).subscriptionReserve).toBeUndefined();
  expect(loadConfig().port).toBe(12345);
});

test("an absent opt-in ignores the legacy policy file", async () => {
  const { config, native, target } = setup(true, { targets: [TARGET] });
  writeFileSync(home.path("subscription-reserve.json"), JSON.stringify(POLICY));
  await send(config, { authorization: SUBSCRIPTION });
  await send(config, { authorization: SUBSCRIPTION, priority: "background" });
  expect(native.seen.map(received => received.model)).toEqual([SOURCE, SOURCE]);
  expect(target.seen).toHaveLength(0);
});

test.each([true, false])("native-eligible background traffic resolves the qualified target with managed-native rollout %s", async on => {
  const { config, native, managed, target } = setup(on);
  await send(config, { authorization: SUBSCRIPTION });
  const { log } = await send(config, { authorization: SUBSCRIPTION, priority: " Background " });
  expect(log.routeDecision?.selected).toMatchObject({ provider: "anthropic-alternate", model: "reduced", reason: "explicit-provider-namespace" });
  expect(native.seen).toHaveLength(1);
  expect(managed.seen).toHaveLength(0);
  expect(target.seen).toHaveLength(1);
  expect(target.seen[0]).toMatchObject({ model: "reduced", stream: !on, auth: null, apiKey: "fixture-managed-credential", priority: null });
});

test("unmarked Haiku and short tool-less turns stay interactive at hard reserve", async () => {
  const { config, native, target } = setup();
  await send(config, { authorization: SUBSCRIPTION });
  await send(config, { authorization: SUBSCRIPTION, model: "claude-sonnet-5-5" });
  await send(config, { authorization: SUBSCRIPTION, priority: "interactive" });
  await send(config, { authorization: SUBSCRIPTION, priority: "background, interactive" });
  expect(native.seen.map(received => [received.model, received.priority]))
    .toEqual([[SOURCE, null], ["claude-sonnet-5-5", null], [SOURCE, null], [SOURCE, null]]);
  expect(target.seen).toHaveLength(0);
});

test("managed traffic ignores native quota evidence even while fresh, and native steering expires before a future reset", async () => {
  const { config, native, managed, target } = setup();
  await send(config, { authorization: SUBSCRIPTION });
  await send(config, { priority: "background" });
  clock.mockReturnValue(NOW + 31 * 60_000);
  config.claudeCode!.nativePassthrough = false;
  await send(config, { authorization: SUBSCRIPTION, priority: "background" });
  config.claudeCode!.nativePassthrough = true;
  await send(config, { authorization: SUBSCRIPTION, priority: "background" });
  expect(native.seen.map(received => received.model)).toEqual([SOURCE, SOURCE]);
  expect(managed.seen.map(received => received.model)).toEqual([SOURCE, SOURCE]);
  expect(target.seen).toHaveLength(0);
});

test("fresh quota evidence is isolated by caller credential", async () => {
  const { config, native, target } = setup();
  await send(config, { authorization: SUBSCRIPTION });
  await send(config, { authorization: `${SUBSCRIPTION}-other`, priority: "background" });
  expect(native.seen).toHaveLength(2);
  expect(target.seen).toHaveLength(0);
});

test("the default soft tier selects the first available concrete route", async () => {
  const { config, native, managed, target } = setup(true, {
    enabled: true, targets: ["absent/reduced", TARGET],
  }, { ...UPSTREAM_HEADERS, "anthropic-ratelimit-unified-7d-utilization": "0.60" });
  await send(config, { authorization: SUBSCRIPTION });
  await send(config, { authorization: SUBSCRIPTION, priority: "background" });
  expect(native.seen).toHaveLength(1);
  expect(managed.seen).toHaveLength(0);
  expect(target.seen.map(received => received.model)).toEqual(["reduced"]);
});

test.each([
  { label: "the second target", allowedModel: TARGET, steered: true },
  { label: "neither target", allowedModel: "unrelated", steered: false },
])("a background request honors a key scoped to $label", async ({ allowedModel, steered }) => {
  const { config, native, managed, target } = setup(true, { ...POLICY, targets: [`source/${SOURCE}`, TARGET] });
  const admissionKey = "fixture-reserve-admission";
  config.hostname = "0.0.0.0";
  config.apiKeys = [{ id: "reserve-fixture", name: "reserve", key: admissionKey, createdAt: new Date(NOW).toISOString(),
    allowedProviders: ["source", "anthropic-alternate"], allowedModels: [allowedModel] }];

  await send(config, { authorization: SUBSCRIPTION, admissionKey });
  await send(config, { authorization: SUBSCRIPTION, admissionKey, priority: "background" });
  expect(managed.seen).toHaveLength(0);
  expect(target.seen.map(received => received.model)).toEqual(steered ? ["reduced"] : []);
  expect(native.seen.map(received => received.model)).toEqual(steered ? [SOURCE] : [SOURCE, SOURCE]);
  expect(native.seen.at(-1)?.auth).toBe(SUBSCRIPTION);
});

test("a background message-thread continuation stays on its upstream subscription at hard reserve", async () => {
  const { config, native, target } = setup();
  const thread = { type: "continue", previous_message_id: "msg_fixture" };
  await send(config, { authorization: SUBSCRIPTION });
  await send(config, { authorization: SUBSCRIPTION, priority: "background", thread });
  expect(native.seen).toHaveLength(2);
  expect(native.seen[1]).toMatchObject({ model: SOURCE, auth: SUBSCRIPTION, thread });
  expect(target.seen).toHaveLength(0);
});

test.each([
  { policy: { ...POLICY, targets: [] }, observation: UPSTREAM_HEADERS },
  { policy: POLICY, observation: { ...UPSTREAM_HEADERS, "anthropic-ratelimit-unified-7d-utilization": "0.55" } },
  { policy: POLICY, observation: { ...UPSTREAM_HEADERS, "anthropic-ratelimit-unified-7d-reset": String(NOW / 1000 + 1) } },
])("empty targets, utilization below soft, or a reset window preserves the subscription route", async ({ policy, observation }) => {
  const { config, native, target } = setup(true, policy, observation);
  await send(config, { authorization: SUBSCRIPTION });
  clock.mockReturnValue(NOW + 1000);
  await send(config, { authorization: SUBSCRIPTION, priority: "background" });
  expect(native.seen).toHaveLength(2);
  expect(target.seen).toHaveLength(0);
});
