import { expect, test } from "bun:test";
import {
  beginInjection, injectionConfig, installInjectionFixture, advertiseInjection, savedResult,
  acknowledgeInjection, completeInjection, continuationFrame, waitForInjection, InjectionSocket, fallbackCalls,
  type Frame,
} from "../helpers/native-injection-fixture";
import { NativeInjectionChannel } from "../../src/server/responses/native-injection";
import { NativeInjectionReplay } from "../../src/server/responses/native-injection-replay";
import { NativeSteeringChannel } from "../../src/server/responses/native-steering";
import { nativeResponseControlMode } from "../../src/server/responses/native-response-control";
import { nativeSavedResults, nativeResultFingerprint, nativeToolRequirement, nativeResultMatches,
  MAX_NATIVE_RESULT_PARTS } from "../../src/server/responses/native-tool-results";
import { nativeResponseOutput } from "../../src/server/responses/native-response-output";
import { MAX_NATIVE_INJECTION_BYTES } from "../../src/server/responses/native-injection-protocol";

installInjectionFixture();

const rich = () => [
  { type: "input_text", text: "fixture result", prompt_cache_breakpoint: { mode: "explicit" } },
  { type: "input_image", file_id: "file-fixture-image", detail: "original" },
  { type: "input_file", filename: "fixture.txt", file_data: "Zml4dHVyZQ==", detail: "low" },
];
const customCall = (extra: Frame = {}) => ({ type: "custom_tool_call", id: "custom-item", call_id: "custom-call", name: "custom", input: "fixture", ...extra });
const approvalCall = (extra: Frame = {}) => ({ type: "mcp_approval_request", id: "approval-item", name: "read", server_label: "fixture", arguments: "{}", ...extra });
const customResult = (extra: Frame = {}) => ({ type: "custom_tool_call_output", call_id: "custom-call", output: rich(), ...extra });
const approvalResult = (approve: boolean) => ({ type: "mcp_approval_response", approval_request_id: "approval-item", approve, reason: "caller decision" });
function emitItem(socket: InjectionSocket, item: Frame, index: number) {
  socket.emit({ type: "response.output_item.added", output_index: index, item });
  socket.emit({ type: "response.output_item.done", output_index: index, item });
}
function unit() {
  const sent: Frame[] = [];
  const remembered: Frame[] = [];
  const channel = new NativeInjectionChannel({ multi_agent: { enabled: true } });
  channel.replayFactory = () => new NativeInjectionReplay([], (input, response) => remembered.push({ input: structuredClone(input), response: structuredClone(response) }));
  const detach = channel.attach(frame => sent.push(structuredClone(frame)), () => {});
  channel.observe({ type: "response.created", response: { id: "r1" } });
  const item = (value: Frame, index = 0) => {
    channel.observe({ type: "response.output_item.added", output_index: index, item: value });
    channel.observe({ type: "response.output_item.done", output_index: index, item: value });
  };
  const terminal = () => channel.observe({ type: "response.completed", response: { id: "r1", output: [] } });
  return { channel, detach, sent, remembered, item, terminal };
}

const outputs = ["", [], [{ type: "input_text", text: "" }], rich(),
  [{ type: "input_image", image_url: "https://example.invalid/fixture.png", detail: "auto" }],
  [{ type: "input_file", file_id: "file-fixture" }],
  [{ type: "input_file", file_url: "https://example.invalid/fixture.pdf", detail: "high" }]];
for (const type of ["function_call_output", "custom_tool_call_output"]) {
  test.each(outputs.map((output, i) => [i, output] as const))(`${type} continuation shape %s is lossless`, (_, output) => {
    const value = [{ type, call_id: "call", output }];
    expect(nativeSavedResults(value)).toEqual(value);
  });
}
const invalidResults = [null, {}, [], [{ role: "system", content: "no" }],
  [customResult({ output: [null] })], [customResult({ output: [{ type: "output_text", text: "no" }] })],
  [customResult({ output: [{ type: "input_image", image_url: "a", file_id: "b", detail: "auto" }] })],
  [customResult({ output: [{ type: "input_image", file_id: "a", detail: "invented" }] })],
  [customResult({ output: [{ type: "input_file", file_data: "YQ==" }] })],
  [customResult({ output: [{ type: "input_file", file_url: "a", detail: "original" }] })],
  [customResult({ output: [{ type: "input_file", file_id: "a", file_url: "b" }] })],
  [customResult({ output: [{ type: "input_text", text: "a", extra: true }] })],
  [customResult({ output: [{ type: "input_text", text: "a", prompt_cache_breakpoint: { mode: "other" } }] })],
  [customResult({ output: Array.from({ length: MAX_NATIVE_RESULT_PARTS + 1 }, () => ({ type: "input_text", text: "" })) })],
  [customResult({ caller: { type: "program", caller_id: "x", extra: true } })],
  [customResult(), customResult()], [customResult({ call_id: "bad\nidentity" })],
  [{ type: "mcp_approval_response", approval_request_id: "approval-item" }],
  [{ ...approvalResult(true), approve: "true" }],
  [{ type: "multi_agent_call_output", call_id: "server-call", output: "no" }]];
test.each(invalidResults.map((value, i) => [i, value] as const))("invalid saved result %s is rejected", (_, value) => {
  expect(() => nativeSavedResults(value)).toThrow();
});

test("semantic comparison ignores object-key order but retains content-array order and caller", () => {
  const a = nativeSavedResults([customResult()])[0];
  const b = nativeSavedResults([{ output: rich().map(part => Object.fromEntries(Object.entries(part).reverse())), call_id: "custom-call", type: "custom_tool_call_output" }])[0];
  expect(nativeResultFingerprint(a)).toBe(nativeResultFingerprint(b));
  expect(nativeResultFingerprint(a)).not.toBe(nativeResultFingerprint(nativeSavedResults([customResult({ output: rich().reverse() })])[0]));
  expect(nativeResultFingerprint(a)).not.toBe(nativeResultFingerprint(nativeSavedResults([customResult({ caller: { type: "program", caller_id: "program" } })])[0]));
});

test.each([false, true])("rich/custom/approval continuation uses one original socket; API=%s", async api => {
  const { socket, send, sent, ws, id } = await beginInjection({}, injectionConfig(api));
  const func = advertiseInjection(socket);
  const custom = customCall(); const approval = approvalCall();
  emitItem(socket, custom, 1); emitItem(socket, approval, 2);
  completeInjection(socket, { output: [func, custom, approval] });
  await waitForInjection(() => sent.some(frame => frame.type === "response.completed"));
  expect(ws.data.nativeControl).toBeDefined();
  const frame = continuationFrame({ type: "response.create", previous_response_id: id,
    input: [savedResult("call-1", "text"), customResult(), approvalResult(false)] }, api);
  send(frame);
  await waitForInjection(() => socket.frames.length === 2);
  expect(socket.frames[1]).toMatchObject({ ...frame, model: "gpt-5.6-sol" });
  socket.emit({ type: "response.created", response: { id: "r2", previous_response_id: id, output: [] } });
  completeInjection(socket, {}, "r2");
  await waitForInjection(() => !ws.data.nativeControl);
  expect(InjectionSocket.all).toHaveLength(1); expect(fallbackCalls).toBe(0);
  expect(socket.options.headers.authorization).toBe(api ? "Bearer fixture-public-key" : "Bearer test");
  expect(sent.filter(frame => frame.type === "response.created")).toHaveLength(2);
});

test.each([false, true])("approval %s is caller-supplied, required and never defaulted", approve => {
  const x = unit();
  try {
    x.item(approvalCall()); x.terminal();
    expect(x.channel.ended).toBe(false); expect(x.sent).toEqual([]);
    expect(() => x.channel.continue({ type: "response.create", previous_response_id: "r1", multi_agent: { enabled: true }, input: [savedResult("approval-item")] })).toThrow();
    expect(x.sent).toEqual([]);
    expect(x.channel.continue({ type: "response.create", previous_response_id: "r1", multi_agent: { enabled: true }, input: [approvalResult(approve)] })).toBe(true);
    expect(x.sent[0].input).toEqual([approvalResult(approve)]);
  } finally { x.detach(); }
});

test("extended injection is refused before send and does not consume a call needed by continuation", async () => {
  const { socket, send, sent, id } = await beginInjection();
  const call = advertiseInjection(socket); const custom = customCall();
  emitItem(socket, custom, 1);
  send({ type: "response.inject", response_id: id, input: [savedResult(), customResult()] });
  expect(socket.frames).toHaveLength(1);
  expect(sent.at(-1)?.type).toBe("error");
  completeInjection(socket, { output: [call, custom] });
  send(continuationFrame({ type: "response.create", previous_response_id: id, input: [{ type: "function_call_output", call_id: "call-1", output: rich() }, customResult()] }));
  await waitForInjection(() => socket.frames.length === 2);
  expect(socket.frames[1].input[0].output).toEqual(rich());
  expect(fallbackCalls).toBe(0);
});

test("accepted injection and unsent custom/approval results have separate completion state", async () => {
  const { socket, send, id, ws } = await beginInjection();
  const func = advertiseInjection(socket); const custom = customCall(); const approval = approvalCall();
  emitItem(socket, custom, 1); emitItem(socket, approval, 2);
  send({ type: "response.inject", response_id: id, input: [savedResult()] });
  acknowledgeInjection(socket); completeInjection(socket, { output: [func, custom, approval] });
  expect(ws.data.nativeControl).toBeDefined();
  send(continuationFrame({ type: "response.create", previous_response_id: id, input: [savedResult(), customResult(), approvalResult(true)] }));
  expect(socket.frames).toHaveLength(2);
  send(continuationFrame({ type: "response.create", previous_response_id: id, input: [customResult(), approvalResult(true)] }));
  await waitForInjection(() => socket.frames.length === 3);
  expect(socket.frames[2].input).toEqual([customResult(), approvalResult(true)]);
});

test("call type, program caller and foreign approval identity cannot be substituted", () => {
  const x = unit(); const origin = { type: "program", caller_id: "program-one" };
  try {
    x.item(customCall({ caller: origin, agent: { agent_name: "/root/a" } })); x.item(approvalCall(), 1); x.terminal();
    for (const bad of [savedResult("custom-call"), customResult(), customResult({ caller: { type: "program", caller_id: "program-two" } })]) {
      expect(() => x.channel.continue({ type: "response.create", previous_response_id: "r1", multi_agent: { enabled: true }, input: [bad, approvalResult(true)] })).toThrow();
    }
    expect(() => x.channel.continue({ type: "response.create", previous_response_id: "r1", multi_agent: { enabled: true }, input: [customResult({ caller: origin }), { ...approvalResult(false), approval_request_id: "foreign" }] })).toThrow();
    expect(x.sent).toEqual([]);
    expect(x.channel.continue({ type: "response.create", previous_response_id: "r1", multi_agent: { enabled: true }, input: [customResult({ caller: origin }), approvalResult(false)] })).toBe(true);
  } finally { x.detach(); }
});

test("a continuation that omits or changes a pinned setting fails closed", () => {
  const x = unit();
  try {
    x.item(customCall()); x.terminal();
    for (const frame of [
      { type: "response.create", previous_response_id: "r1", input: [customResult()] },
      { type: "response.create", previous_response_id: "r1", multi_agent: { enabled: false }, input: [customResult()] },
    ]) {
      try { x.channel.continue(frame); expect.unreachable(); }
      catch (error) { expect((error as { code?: string }).code).toBe("injection_settings_changed"); }
    }
    expect(x.sent).toEqual([]);
    expect(x.channel.continue({ type: "response.create", previous_response_id: "r1", multi_agent: { enabled: true }, input: [customResult()] })).toBe(true);
  } finally { x.detach(); }
});

test("identical ID spellings for a call and approval remain separate requirements", () => {
  const req = nativeToolRequirement(approvalCall())!;
  expect(nativeResultMatches(nativeSavedResults([savedResult("approval-item")])[0], req)).toBe(false);
  expect(nativeResultMatches(nativeSavedResults([approvalResult(false)])[0], req)).toBe(true);
});

test("same call ID reused by another agent or tool type fails closed", () => {
  const x = unit();
  try {
    x.item(customCall({ agent: { agent_name: "/root/a" } }));
    expect(() => x.item(customCall({ agent: { agent_name: "/root/b" } }), 1)).toThrow();
  } finally { x.detach(); }
});

test("oversized rich continuation is refused before send; original call remains available", () => {
  const x = unit();
  try {
    x.item(customCall()); x.terminal();
    expect(() => x.channel.continue({ type: "response.create", previous_response_id: "r1", multi_agent: { enabled: true }, input: [customResult({ output: [{ type: "input_text", text: "x".repeat(MAX_NATIVE_INJECTION_BYTES) }] })] })).toThrow();
    expect(x.sent).toEqual([]);
    expect(x.channel.continue({ type: "response.create", previous_response_id: "r1", multi_agent: { enabled: true }, input: [customResult()] })).toBe(true);
  } finally { x.detach(); }
});

test("continuation history is detached from later caller mutation", () => {
  const x = unit();
  try {
    x.item(customCall()); x.terminal();
    const input = [customResult()];
    x.channel.continue({ type: "response.create", previous_response_id: "r1", multi_agent: { enabled: true }, input });
    input[0].output[0].text = "changed";
    x.channel.observe({ type: "response.created", response: { id: "r2", previous_response_id: "r1" } });
    x.channel.observe({ type: "response.completed", response: { id: "r2", output: [] } });
    expect(x.sent[0].input[0].output[0].text).toBe("fixture result");
    expect(x.remembered.at(-1)?.input.at(-1)).toEqual(customResult());
  } finally { x.detach(); }
});

const hosted = [
  { type: "multi_agent_call", id: "host-call", call_id: "server-call", action: "spawn_agent", arguments: "{}", agent: { agent_name: "/root" } },
  { type: "multi_agent_call_output", id: "host-result", call_id: "server-call", action: "spawn_agent", output: [{ type: "output_text", text: "fixture", annotations: [] }], agent: { agent_name: "/root" } },
  { type: "agent_message", id: "host-message", author: "/root/a", recipient: "/root", content: [{ type: "encrypted_content", encrypted_content: "opaque-fixture" }], agent: { agent_name: "/root" } },
];
test("hosted actions and encrypted messages survive wire relay and sparse terminal replay", async () => {
  const { socket, sent, send, ws, id } = await beginInjection();
  hosted.forEach((item, index) => emitItem(socket, item, index));
  send({ type: "response.inject", response_id: id, input: [savedResult("server-call")] });
  expect(socket.frames).toHaveLength(1);
  const message = { type: "message", id: "last-message", role: "assistant", content: [{ type: "output_text", text: "done", annotations: [] }] };
  emitItem(socket, message, 3); completeInjection(socket, { output: [message] });
  await waitForInjection(() => !ws.data.nativeControl);
  expect(sent.filter(frame => frame.type === "response.output_item.done").map(frame => frame.item)).toEqual([...hosted, message]);
  expect(fallbackCalls).toBe(0);
});
test("hosted sparse terminal items are retained in the committed continuation prefix", () => {
  const x = unit();
  try {
    hosted.forEach((item, index) => x.item(item, index)); x.item(customCall(), 3);
    x.channel.observe({ type: "response.completed", response: { id: "r1", output: [customCall()] } });
    x.channel.continue({ type: "response.create", previous_response_id: "r1", multi_agent: { enabled: true }, input: [customResult()] });
    x.channel.observe({ type: "response.created", response: { id: "r2", previous_response_id: "r1" } });
    x.channel.observe({ type: "response.completed", response: { id: "r2", output: [] } });
    expect(x.remembered.at(-1)?.input).toEqual([...hosted, customCall(), customResult()]);
  } finally { x.detach(); }
});
test("sparse terminal merge preserves hosted order and rejects contradictory identity/content", () => {
  const done = new Map(hosted.map((item, i) => [i, item]));
  expect(nativeResponseOutput(done, [structuredClone(hosted[2])])).toEqual(hosted);
  expect(() => nativeResponseOutput(done, [hosted[2], hosted[0]])).toThrow();
  expect(() => nativeResponseOutput(done, [{ ...hosted[0], action: "different" }])).toThrow();
  expect(() => nativeResponseOutput(done, [hosted[0], hosted[0]])).toThrow();
});

for (const injection of [false, true]) for (const steering of [false, true]) {
  test(`mode selection is exclusive; injection=${injection}, steering=${steering}`, () => {
    const flags = { codexNativeInjection: injection, codexNativeSteering: steering };
    expect(nativeResponseControlMode({ multi_agent: { enabled: true } }, flags)).toBe(injection ? "injection" : undefined);
    expect(nativeResponseControlMode({}, flags)).toBe(steering ? "steering" : undefined);
  });
}
test("direct steering construction cannot bypass the single-agent mode boundary", () => {
  expect(() => new NativeSteeringChannel({ multi_agent: { enabled: true } })).toThrow();
});
test("a completed injection turn may be followed by an explicit ordinary steering turn", async () => {
  const { socket, ws, send } = await beginInjection({}, { ...injectionConfig(), codexNativeSteering: true });
  completeInjection(socket); await waitForInjection(() => !ws.data.nativeControl);
  send({ type: "response.create", model: "gpt-5.6-sol", input: "new explicit turn" });
  await waitForInjection(() => InjectionSocket.all.length === 2);
  expect(ws.data.nativeControl).toBeInstanceOf(NativeSteeringChannel);
  expect(socket.frames).toHaveLength(1); expect(fallbackCalls).toBe(0);
});


test("an early same-parent rich continuation cannot escape to normal dispatch", async () => {
  const { socket, send, sent, id } = await beginInjection();
  emitItem(socket, customCall(), 0);
  send(continuationFrame({ type: "response.create", previous_response_id: id, input: [customResult()] }));
  expect(sent.at(-1)?.error.code).toBe("injection_pending");
  expect(socket.frames).toHaveLength(1); expect(InjectionSocket.all).toHaveLength(1);
  expect(fallbackCalls).toBe(0);
  completeInjection(socket, { output: [customCall()] });
  send(continuationFrame({ type: "response.create", previous_response_id: id, input: [customResult()] }));
  await waitForInjection(() => socket.frames.length === 2);
  expect(socket.frames[1].input).toEqual([customResult()]);
});
