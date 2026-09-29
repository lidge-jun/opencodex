import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { effortRowId } from "../../src/server/effort-row";
import { clearHealthHistoryCacheForTests } from "../../src/routing/health";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const upstreamServers: Array<ReturnType<typeof Bun.serve>> = [];
let releaseSpendHome: (() => void) | undefined;
let testHome: TempHome;

beforeEach(() => {
  testHome = createTempHome("ocx-droid-reasoning-default-");
});

afterEach(() => {
  for (const server of upstreamServers.splice(0)) server.stop(true);
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearHealthHistoryCacheForTests();
  closeRequestHistoryIndex();
  testHome.remove();
});

function upstream() {
  const captured: Array<{ path: string; headers: Headers; body: Record<string, unknown> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as Record<string, unknown>;
      captured.push({ path: new URL(req.url).pathname, headers: new Headers(req.headers), body });
      if (body.stream === true) {
        return new Response([
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({
        id: "chatcmpl_mock",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  upstreamServers.push(server);
  return { captured, baseUrl: `${server.url}v1` };
}

function failingUpstream() {
  const captured: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      captured.push({ headers: new Headers(req.headers), body: await req.json() as Record<string, unknown> });
      return Response.json({
        error: { type: "server_error", code: "upstream_server_error", message: "busy" },
      }, { status: 500 });
    },
  });
  upstreamServers.push(server);
  return { captured, baseUrl: `${server.url}v1` };
}

async function send(
  lane: "native" | "translated",
  headers: Record<string, string>,
  extraBody: Record<string, unknown> = {},
  policy: { pin?: string; cap?: string; modelEfforts?: string[]; omitProviderLadder?: boolean; syntheticEffortRows?: boolean } = {},
  requestModel = "mock/model",
) {
  releaseSpendHome ??= acquireOwnedSpendHome();
  const mock = upstream();
  const provider: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: mock.baseUrl,
    apiKey: "fixture",
    allowPrivateNetwork: true,
    ...(policy.pin ? { modelPinnedReasoningEfforts: { model: policy.pin } } : {}),
    ...(!policy.omitProviderLadder ? { reasoningEfforts: ["none", "minimal", "low", "medium", "high"] } : {}),
    ...(policy.modelEfforts ? { modelReasoningEfforts: { model: policy.modelEfforts } } : {}),
  };
  const config = {
    defaultProvider: "mock",
    providers: { mock: provider },
    ...(policy.syntheticEffortRows ? { cursorEffortRows: true } : {}),
    ...(policy.cap ? { effortCap: policy.cap } : {}),
  } as OcxConfig;
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: requestModel,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      ...(lane === "translated" ? { store: true } : {}),
      ...extraBody,
    }),
  }), config, { model: "", provider: "" });
  await response.text();
  expect(response.status).toBe(200);
  expect(mock.captured).toHaveLength(1);
  return mock.captured[0]!;
}

for (const lane of ["native", "translated"] as const) {
  test(`${lane} Chat applies a Droid default before dispatch and consumes its header`, async () => {
    const sent = await send(lane, { "x-opencodex-droid-default-effort": "high" });
    expect(sent.body.reasoning_effort ?? (sent.body.reasoning as Record<string, unknown> | undefined)?.effort).toBe("high");
    expect(sent.headers.has("x-opencodex-droid-default-effort")).toBe(false);
    expect(sent.path).toBe("/v1/chat/completions");
    expect(sent.body.stream).toBe(lane === "translated");
  });

  test(`${lane} Chat leaves explicit effort values and invalid defaults alone`, async () => {
    const medium = await send(lane, { "x-opencodex-droid-default-effort": "high" }, { reasoning_effort: "medium" });
    expect(medium.body.reasoning_effort ?? (medium.body.reasoning as Record<string, unknown> | undefined)?.effort).toBe("medium");
    for (const explicit of [
      { reasoning_effort: null },
      { reasoning_effort: "not-a-canonical-effort" },
      { reasoning: { effort: "low" } },
    ]) {
      const baseline = await send(lane, {}, explicit);
      const withHeader = await send(lane, { "x-opencodex-droid-default-effort": "high" }, explicit);
      expect(withHeader.body).toEqual(baseline.body);
    }
    const baselineNone = await send(lane, {}, { reasoning_effort: "none" });
    const withHeaderNone = await send(lane, { "x-opencodex-droid-default-effort": "high" }, { reasoning_effort: "none" });
    expect(withHeaderNone.body).toEqual(baselineNone.body);
    const absent = await send(lane, { "x-opencodex-droid-default-effort": "not-valid" });
    expect(Object.hasOwn(absent.body, "reasoning_effort")).toBe(false);
    expect(Object.hasOwn(absent.body, "reasoning")).toBe(false);
    const noHeader = await send(lane, {});
    expect(Object.hasOwn(noHeader.body, "reasoning_effort")).toBe(false);
    expect(Object.hasOwn(noHeader.body, "reasoning")).toBe(false);
  });

  test(`${lane} Chat accepts declared minimal and none defaults`, async () => {
    for (const effort of ["minimal", "none"]) {
      const explicit = await send(lane, {}, { reasoning_effort: effort });
      const defaulted = await send(lane, { "x-opencodex-droid-default-effort": effort });
      expect(defaulted.body).toEqual(explicit.body);
      if (lane === "native") expect(defaulted.body.reasoning_effort).toBe(effort);
    }
  });

  test(`${lane} Chat applies a low model pin after the Droid high default`, async () => {
    const sent = await send(lane, { "x-opencodex-droid-default-effort": "high" }, {}, { pin: "low" });
    expect(sent.body.reasoning_effort ?? (sent.body.reasoning as Record<string, unknown> | undefined)?.effort).toBe("low");
  });

  test(`${lane} Chat uses the export fallback ladder when no ladder is configured`, async () => {
    const sent = await send(lane, { "x-opencodex-droid-default-effort": "high" }, {}, { omitProviderLadder: true });
    expect(sent.body.reasoning_effort ?? (sent.body.reasoning as Record<string, unknown> | undefined)?.effort).toBe("high");
  });

  test(`${lane} Chat respects an empty per-model ladder`, async () => {
    const sent = await send(lane, { "x-opencodex-droid-default-effort": "high" }, {}, { omitProviderLadder: true, modelEfforts: [] });
    expect(Object.hasOwn(sent.body, "reasoning_effort")).toBe(false);
    expect(Object.hasOwn(sent.body, "reasoning")).toBe(false);
  });

  test(`${lane} Chat ignores a Droid default outside the resolved namespaced model ladder`, async () => {
    const sent = await send(lane, { "x-opencodex-droid-default-effort": "high" }, {}, { modelEfforts: ["low"] });
    expect(Object.hasOwn(sent.body, "reasoning_effort")).toBe(false);
    expect(Object.hasOwn(sent.body, "reasoning")).toBe(false);
  });

  test(`${lane} Chat preserves an explicit effort even when outside the model ladder`, async () => {
    const extra = { reasoning_effort: "high" };
    const baseline = await send(lane, {}, extra, { modelEfforts: ["low"] });
    const withHeader = await send(lane, { "x-opencodex-droid-default-effort": "low" }, extra, { modelEfforts: ["low"] });
    expect(withHeader.body).toEqual(baseline.body);
  });

  test(`${lane} Chat applies a qualifying low effort cap after the Droid high default`, async () => {
    const tools = [
      { type: "function", function: { name: "spawn_agent", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "send_message", parameters: { type: "object", properties: {} } } },
    ];
    const sent = await send(lane, { "x-opencodex-droid-default-effort": "high" }, { tools }, { cap: "low" });
    expect(sent.body.reasoning_effort ?? (sent.body.reasoning as Record<string, unknown> | undefined)?.effort).toBe("low");
  });
}

test("Chat synthetic low effort row takes precedence over the Droid high default", async () => {
  const rowId = effortRowId("mock/model", "low");
  const sent = await send(
    "translated",
    { "x-opencodex-droid-default-effort": "high" },
    {},
    { omitProviderLadder: true, syntheticEffortRows: true },
    rowId,
  );
  expect(sent.body.reasoning?.effort ?? sent.body.reasoning_effort).toBe("low");
});

function sentEffort(captured: { body: Record<string, unknown> }) {
  return captured.body.reasoning_effort ?? (captured.body.reasoning as Record<string, unknown> | undefined)?.effort;
}

const fallbackProviders = (firstUrl: string, secondUrl: string) => ({
  first: {
    adapter: "openai-chat", baseUrl: firstUrl, apiKey: "fixture", models: ["m1"],
    allowPrivateNetwork: true, modelReasoningEfforts: { m1: ["low", "high"] },
    transientRetryOn5xx: { attempts: 1 },
  },
  second: {
    adapter: "openai-chat", baseUrl: secondUrl, apiKey: "fixture", models: ["m2"],
    allowPrivateNetwork: true, modelReasoningEfforts: { m2: ["low"] },
  },
});

async function sendFallback(config: OcxConfig, model: string, explicitEffort: boolean) {
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencodex-droid-default-effort": "high" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      ...(explicitEffort ? { reasoning_effort: "low" } : {}),
    }),
  }), config, { model: "", provider: "" });
  await response.text();
  expect(response.status).toBe(200);
}

function expectFallbackEfforts(
  first: { captured: Array<{ headers: Headers; body: Record<string, unknown> }> },
  second: { captured: Array<{ headers: Headers; body: Record<string, unknown> }> },
  explicitEffort: boolean,
) {
  expect(first.captured).toHaveLength(1);
  expect(second.captured).toHaveLength(1);
  expect(sentEffort(first.captured[0]!)).toBe(explicitEffort ? "low" : "high");
  expect(sentEffort(second.captured[0]!)).toBe(explicitEffort ? "low" : undefined);
  expect(first.captured[0]!.headers.has("x-opencodex-droid-default-effort")).toBe(false);
  expect(second.captured[0]!.headers.has("x-opencodex-droid-default-effort")).toBe(false);
}

for (const nativeChatCombos of [false, true]) {
  for (const explicitEffort of [false, true]) {
    test(`Chat validates ${explicitEffort ? "explicit effort before the" : "the"} Droid default per combo target (native=${nativeChatCombos})`, async () => {
      releaseSpendHome ??= acquireOwnedSpendHome();
      const first = failingUpstream();
      const second = upstream();
      const comboId = `fallback-${nativeChatCombos ? "native" : "bridge"}-${explicitEffort ? "explicit" : "default"}`;
      await sendFallback({
        defaultProvider: "first",
        providers: fallbackProviders(first.baseUrl, second.baseUrl),
        combos: {
          [comboId]: {
            strategy: "failover",
            targets: [{ provider: "first", model: "m1" }, { provider: "second", model: "m2" }],
          },
        },
        ...(nativeChatCombos ? { protocols: { rollout: { nativeChatCombos: true } } } : {}),
      } as OcxConfig, `combo/${comboId}`, explicitEffort);
      expectFallbackEfforts(first, second, explicitEffort);
      expect(first.captured[0]!.body.stream).toBe(!nativeChatCombos);
    });
  }
}

for (const explicitEffort of [false, true]) {
  test(`translated Chat validates ${explicitEffort ? "explicit effort before the" : "the"} Droid default per policy candidate`, async () => {
    releaseSpendHome ??= acquireOwnedSpendHome();
    const first = failingUpstream();
    const second = upstream();
    await sendFallback({
      defaultProvider: "first",
      providers: fallbackProviders(first.baseUrl, second.baseUrl),
      routingProfiles: {
        fallback: { candidates: [{ provider: "first", model: "m1" }, { provider: "second", model: "m2" }] },
      },
    } as OcxConfig, "policy/fallback", explicitEffort);
    expectFallbackEfforts(first, second, explicitEffort);
  });
}
