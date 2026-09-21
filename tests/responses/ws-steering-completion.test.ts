import { expect, test } from "bun:test";
import { NativeSteeringChannel } from "../../src/server/responses/native-steering";
import { createSteeringSettingsNormalizer } from "../../src/server/responses/native-steering-policy";
import { validSteeringSettings } from "../../src/server/responses/native-steering-settings";
import { nativeResponseControlEligible } from "../../src/server/responses/native-response-control";
import { beginInjection, injectionConfig, installInjectionFixture, waitForInjection, InjectionSocket,
  advertiseInjection, savedResult, type Frame } from "../helpers/native-injection-fixture";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";

installInjectionFixture();
const config = (api = false) => ({ ...injectionConfig(api), codexNativeSteering: true });
const begin = (api = false, fields: Frame = {}, settings = config(api)) =>
  beginInjection({ multi_agent: { enabled: false }, reasoning: { effort: "low" }, ...fields }, settings);
function accept(socket: InjectionSocket, id: string, number = 1) {
  socket.emit({ type: "response.steer.accepted", steer: { id: `steer-${number}`, previous_response_id: id } });
}
function pending(socket: InjectionSocket, id: string, number = 1) {
  const call = advertiseInjection(socket, `call-${number}`);
  socket.emit({ type: "response.completed", response: { id, status: "completed", output: [call] } });
  socket.emit({ type: "response.steer.pending", steer: { id: `steer-${number}`, previous_response_id: id },
    reason: "waiting_for_required_input", required_input: [{ type: "function_call_output", call_id: `call-${number}` }] });
}

test("public API steering uses only its explicit API-key route and preserves its beta tokens", async () => {
  const c = await begin(true);
  c.send({ type: "response.steer", previous_response_id: c.id, input: "new constraint" });
  expect(c.socket.frames.at(-1)?.type).toBe("response.steer");
  expect(c.socket.url).toBe("wss://api.openai.com/v1/responses");
  expect(c.socket.options.headers.authorization).toBe("Bearer fixture-public-key");
  expect(c.socket.options.headers["chatgpt-account-id"]).toBeUndefined();
  expect(c.socket.options.headers["openai-beta"]).toContain("fixture_beta=v1");
  expect(c.socket.options.headers["openai-beta"]).not.toContain("responses_multi_agent");
  accept(c.socket, c.id);
  c.socket.emit({ type: "response.incomplete", response: { id: c.id, output: [], incomplete_details: { reason: "steered" } } });
  c.socket.emit({ type: "response.created", response: { id: "successor", previous_response_id: c.id } });
  c.socket.emit({ type: "response.completed", response: { id: "successor", status: "completed", output: [] } });
  await waitForInjection(() => !c.ws.data.nativeControl);
  expect(InjectionSocket.all).toHaveLength(1);
  expect(c.socket.frames).toHaveLength(2);
});

for (const api of [false, true]) test(`explicit settings survive two same-socket continuations (${api ? "API" : "subscription"})`, async () => {
  const c = await begin(api);
  c.send({ type: "response.steer", previous_response_id: c.id, input: "update" });
  accept(c.socket, c.id); pending(c.socket, c.id);
  const override = { reasoning: { effort: "high", summary: "detailed" }, text: { verbosity: "low", format: { type: "json_object" } },
    ...(api ? { max_output_tokens: 256 } : {}) };
  c.send({ type: "response.create", previous_response_id: c.id, input: [savedResult()], ...override });
  await waitForInjection(() => c.socket.frames.length === 3);
  expect(c.socket.frames[2]).toMatchObject(override);
  expect(c.socket.frames[2].model).toBe("gpt-5.6-sol");
  expect(c.socket.frames[2].previous_response_id).toBe(c.id);
  c.socket.emit({ type: "response.created", response: { id: "second", previous_response_id: c.id } });
  c.send({ type: "response.steer", previous_response_id: "second", input: "another update" });
  accept(c.socket, "second", 2); pending(c.socket, "second", 2);
  c.send({ type: "response.create", previous_response_id: "second", input: [savedResult("call-2")] });
  await waitForInjection(() => c.socket.frames.length === 5);
  expect(c.socket.frames[4]).toMatchObject(override);
  expect(InjectionSocket.all).toHaveLength(1);
});

test("provider-pinned effort still wins over an explicit continuation override", async () => {
  const settings = config(); settings.providers.openai.pinnedReasoningEffort = "low";
  const c = await begin(false, {}, settings);
  c.send({ type: "response.steer", previous_response_id: c.id, input: "update" });
  accept(c.socket, c.id); pending(c.socket, c.id);
  c.send({ type: "response.create", previous_response_id: c.id, input: [savedResult()], reasoning: { effort: "high" } });
  await waitForInjection(() => c.socket.frames.length === 3);
  expect(c.socket.frames[2].reasoning.effort).toBe("low");
});

test("an unsupported subscription output limit fails before reservation, allowing correction", async () => {
  const c = await begin();
  c.send({ type: "response.steer", previous_response_id: c.id, input: "update" }); accept(c.socket, c.id); pending(c.socket, c.id);
  c.send({ type: "response.create", previous_response_id: c.id, input: [savedResult()], max_output_tokens: 50 });
  expect(c.sent.at(-1)?.error.code).toBe("steering_settings_unsupported");
  expect(c.socket.frames).toHaveLength(2);
  c.send({ type: "response.create", previous_response_id: c.id, input: [savedResult()], reasoning: { effort: "medium" } });
  await waitForInjection(() => c.socket.frames.length === 3);
  expect(c.socket.frames[2].reasoning.effort).toBe("medium");
});

for (const override of [
  { reasoning: { effort: "invented" } }, { reasoning: [] }, { reasoning: { injected: "no" } },
  { text: { verbosity: "huge" } }, { text: { format: { type: "json_schema", name: "invalid name", schema: {} } } },
  { max_output_tokens: 0 }, { max_output_tokens: 1.5 }, { stream_options: { include_usage: "yes" } },
]) test(`malformed generation override is rejected: ${JSON.stringify(override)}`, () => {
  expect(validSteeringSettings(override)).toBe(false);
});

for (const change of [{ model: "another-model" }, { tools: [] }, { service_tier: "priority" },
  { instructions: "replace policy" }, { multi_agent: { enabled: true } }, { conversation: "foreign" }]) {
  test(`immutable continuation setting stays pinned: ${Object.keys(change)[0]}`, async () => {
    const c = await begin();
    c.send({ type: "response.steer", previous_response_id: c.id, input: "update" }); accept(c.socket, c.id); pending(c.socket, c.id);
    c.send({ type: "response.create", previous_response_id: c.id, input: [savedResult()], ...change });
    expect(c.sent.at(-1)?.error.code).toBe("steering_settings_changed");
    expect(c.socket.frames).toHaveLength(2);
  });
}

test("normal policy retains subagent effort caps and configured capability exclusions", () => {
  const provider = { ...config().providers.openai, modelSupportsVerbosity: { "gpt-5.6-sol": false }, modelSupportsReasoningSummaries: { "gpt-5.6-sol": false } };
  const parsed = { modelId: "gpt-5.6-sol", options: {}, context: {}, _rawBody: {} } as unknown as OcxParsedRequest;
  const normalize = createSteeringSettingsNormalizer(parsed, { provider, modelId: parsed.modelId, providerName: "openai" },
    { ...config(), subagentEffortCap: "low" } as OcxConfig, new Headers({ "x-openai-subagent": "collab_spawn" }));
  const result = normalize({ reasoning: { effort: "high", summary: "detailed" }, text: { verbosity: "high", format: { type: "text" } } });
  expect(result.reasoning).toEqual({ effort: "low" });
  expect(result.text).toEqual({ format: { type: "text" } });
  expect(parsed._rawBody).toEqual({});
});

test("API effort mapping is the same as normal routed requests", () => {
  const provider = { ...config(true).providers.api, reasoningEfforts: ["low", "medium", "high"] };
  const parsed = { modelId: "gpt-5.6-sol", options: {}, context: {}, _rawBody: {} } as unknown as OcxParsedRequest;
  const normalize = createSteeringSettingsNormalizer(parsed, { provider, modelId: parsed.modelId, providerName: "api" }, config(true), new Headers());
  expect(normalize({ reasoning: { effort: "ultra" } }).reasoning).toEqual({ effort: "high" });
});

test("queued continuation owns a private copy of both result and settings", () => {
  const channel = new NativeSteeringChannel({ model: "fixture" });
  const sent: Frame[] = []; const detach = channel.attach(frame => sent.push(frame), () => {});
  try {
    channel.observe({ type: "response.created", response: { id: "r" } });
    channel.steer({ type: "response.steer", previous_response_id: "r", input: "update" });
    channel.observe({ type: "response.steer.accepted", steer: { id: "s", previous_response_id: "r" } });
    channel.observe({ type: "response.completed", response: { id: "r", output: [{ type: "function_call", call_id: "c" }] } });
    const frame = { type: "response.create", previous_response_id: "r", input: [savedResult("c")], reasoning: { effort: "high" } };
    channel.continue(frame); frame.reasoning.effort = "low"; frame.input[0].output = "modified";
    expect(sent[1].reasoning.effort).toBe("high"); expect(sent[1].input[0].output).toBe("saved result");
  } finally { detach(); }
});

for (const override of [{ upstreamWebsocket: false }, { baseUrl: "https://gateway.example/v1" }, { authMode: "forward" }, { adapter: "openai-chat" }] as Partial<OcxProviderConfig>[]) {
  test(`public API eligibility does not widen other routes: ${Object.keys(override)[0]}`, () => {
    const provider = { ...config(true).providers.api, ...override };
    expect(nativeResponseControlEligible(provider, new NativeSteeringChannel({}))).toBe(false);
  });
}

for (const [fields, flags, reason] of [
  [{ conversation: "fixture-conversation" }, {}, "Conversation-bound"],
  [{ context_management: [{ type: "compaction" }] }, {}, "compaction"],
  [{ multi_agent: { enabled: true } }, { codexNativeInjection: false }, "Multi-agent"],
  [{}, { codexNativeSteering: false }, "disabled"],
] as Array<[Frame, Frame, string]>) test(`handler explains unavailable steering without cancelling normal output: ${reason}`, async () => {
  const c = await begin(false, fields, { ...config(), ...flags });
  c.send({ type: "response.steer", previous_response_id: c.id, input: "update" });
  expect(c.sent.at(-1)?.error.code).toBe("steering_not_supported");
  expect(c.sent.at(-1)?.error.message).toContain(reason);
  expect(c.socket.frames).toHaveLength(1); expect(c.socket.readyState).toBe(1);
});
for (const value of ["sequential", "sequential_cutoff", "concurrent", "concurrent_cutoff"]) {
  test(`summary delivery uses the repository-owned wire enum: ${value}`, () => {
    expect(validSteeringSettings({ stream_options: { reasoning_summary_delivery: value, include_obfuscation: true } })).toBe(true);
  });
}
test("invented summary-delivery enum is refused", () => {
  expect(validSteeringSettings({ stream_options: { reasoning_summary_delivery: "buffered" } })).toBe(false);
});
