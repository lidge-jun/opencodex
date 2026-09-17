import { expect, test } from "bun:test";
import {
  installInjectionFixture, beginInjection, injectionClient, injectionConfig, InjectionSocket,
  advertiseInjection, completeInjection, acknowledgeInjection, continuationFrame, savedResult, waitForInjection, fallbackCalls,
} from "../helpers/native-injection-fixture";
import { configSchema } from "../../src/config/schema/config-schema";
import { getRequestLogEntries } from "../../src/server/request-log";
import { createNativeSteeringLogObserver } from "../../src/server/responses/native-steering-log";
import { NativeInjectionChannel } from "../../src/server/responses/native-injection";
import { MAX_NATIVE_INJECTIONS, MAX_NATIVE_INJECTION_BYTES, injectionResults } from "../../src/server/responses/native-injection-protocol";
import { nativeResponseControlEligible } from "../../src/server/responses/native-response-control";
import { NativeInjectionReplay } from "../../src/server/responses/native-injection-replay";
import type { RequestLogContext } from "../../src/server/request-log";

installInjectionFixture();

test("injection configuration is default-off, invalid values fail closed, and explicit opt-in survives parsing", () => {
  const config = injectionConfig();
  expect(configSchema.parse(config).codexNativeInjection).toBe(true);
  expect(configSchema.parse({ ...config, codexNativeInjection: "true" }).codexNativeInjection).toBe(false);
  delete config.codexNativeInjection;
  expect(configSchema.parse(config).codexNativeInjection).not.toBe(true);
});

test.each([false, true])("real handler sends saved results over the same connection (public API = %s)", async api => {
  const { socket, send, sent, ws, id } = await beginInjection({}, injectionConfig(api));
  const call = advertiseInjection(socket);
  const frame = { type: "response.inject", response_id: id, input: [savedResult()] };
  send(frame);
  expect(socket.frames[1]).toEqual(frame);
  acknowledgeInjection(socket);
  completeInjection(socket, { output: [call], usage: { input_tokens: 10, output_tokens: 5 } });
  await waitForInjection(() => !ws.data.nativeControl);
  expect(sent.some(event => event.type === "response.inject.created")).toBe(true);
  expect(sent.at(-1)?.type).toBe("response.completed");
  expect(InjectionSocket.all).toHaveLength(1); expect(fallbackCalls).toBe(0);
  expect(socket.options.headers.authorization).toBe(api ? "Bearer fixture-public-key" : "Bearer test");
  if (api) {
    expect(socket.url).toBe("wss://api.openai.com/v1/responses");
    expect(socket.options.headers["openai-beta"]).toContain("responses_multi_agent=v1");
    expect(socket.options.headers["openai-beta"]).toContain("fixture_beta=v1");
  } else expect(socket.options.headers["openai-beta"]).not.toContain("responses_multi_agent=v1");
  expect(socket.frames[0].multi_agent).toEqual({ enabled: true });
  expect(getRequestLogEntries().at(-1)?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
});

test("terminal before acknowledgement is relayed without dropping the late successful acknowledgement", async () => {
  const { socket, send, sent, ws, id } = await beginInjection();
  const call = advertiseInjection(socket);
  send({ type: "response.inject", response_id: id, input: [savedResult()] });
  completeInjection(socket, { output: [call] });
  await waitForInjection(() => sent.some(event => event.type === "response.completed"));
  expect(socket.readyState).toBe(1); expect(ws.data.nativeControl).toBeDefined();
  acknowledgeInjection(socket);
  await waitForInjection(() => !ws.data.nativeControl);
  expect(sent.at(-1)?.type).toBe("response.inject.created");
  expect(socket.readyState).toBe(3); expect(fallbackCalls).toBe(0);
});

test("asynchronous tool completion after the response terminal still reaches the original socket", async () => {
  const { socket, send, sent, ws, id } = await beginInjection();
  const call = advertiseInjection(socket);
  completeInjection(socket, { output: [call] });
  await waitForInjection(() => sent.some(event => event.type === "response.completed"));
  expect(socket.readyState).toBe(1);
  send({ type: "response.inject", response_id: id, input: [savedResult()] });
  expect(socket.frames[1]?.type).toBe("response.inject");
  acknowledgeInjection(socket);
  await waitForInjection(() => !ws.data.nativeControl);
  expect(sent.at(-1)?.type).toBe("response.inject.created");
});

test("completion rejection is preserved; only an explicit caller continuation resubmits the saved result", async () => {
  const { socket, send, sent, ws, id } = await beginInjection();
  const call = advertiseInjection(socket);
  const input = [savedResult()];
  send({ type: "response.inject", response_id: id, input });
  completeInjection(socket, { output: [call] });
  const failed = { type: "response.inject.failed", response_id: id, sequence_number: 100, input,
    error: { code: "response_already_completed", message: "upstream rejected completed response" } };
  socket.emit(failed);
  await waitForInjection(() => sent.some(event => event.type === failed.type));
  expect(sent.at(-1)).toEqual(failed); expect(socket.frames).toHaveLength(2);
  send(continuationFrame({ type: "response.create", previous_response_id: id, input: [savedResult("call-1", "changed output")] }));
  expect(sent.at(-1)?.error.code).toBe("invalid_injection"); expect(socket.frames).toHaveLength(2);
  const continuation = continuationFrame({ type: "response.create", previous_response_id: id, input });
  send(continuation); send(continuation);
  await waitForInjection(() => socket.frames.length === 3);
  expect(socket.frames[2].input).toEqual(input); expect(socket.frames[2].previous_response_id).toBe(id);
  expect(socket.frames[2].multi_agent.enabled).toBe(true);
  expect(sent.at(-1)?.error.code).toBe("injection_pending");
  socket.emit({ type: "response.created", response: { id: "successor", previous_response_id: id } });
  completeInjection(socket, {}, "successor");
  await waitForInjection(() => !ws.data.nativeControl);
  expect(InjectionSocket.all).toHaveLength(1); expect(fallbackCalls).toBe(0);
});

test("parallel tool results serialize by acknowledgement without losing caller order", async () => {
  const { socket, send, sent, ws, id } = await beginInjection();
  const calls = [advertiseInjection(socket), advertiseInjection(socket, "call-2", 1)];
  send({ type: "response.inject", response_id: id, input: [savedResult()] });
  send({ type: "response.inject", response_id: id, input: [savedResult("call-2")] });
  expect(socket.frames).toHaveLength(2);
  completeInjection(socket, { output: calls });
  acknowledgeInjection(socket);
  await waitForInjection(() => socket.frames.length === 3);
  expect(socket.frames[2].input).toEqual([savedResult("call-2")]);
  expect(ws.data.nativeControl).toBeDefined();
  acknowledgeInjection(socket, 101);
  await waitForInjection(() => !ws.data.nativeControl);
  expect(sent.filter(event => event.type === "response.inject.created")).toHaveLength(2);
});

test("duplicate results are refused both while pending and after successful acceptance", async () => {
  const { socket, send, sent, ws, id } = await beginInjection();
  const call = advertiseInjection(socket);
  const frame = { type: "response.inject", response_id: id, input: [savedResult()] };
  send(frame); send(frame);
  expect(sent.at(-1)?.error.code).toBe("duplicate_injection"); expect(socket.frames).toHaveLength(2);
  acknowledgeInjection(socket); send(frame);
  expect(sent.at(-1)?.error.code).toBe("duplicate_injection"); expect(socket.frames).toHaveLength(2);
  completeInjection(socket, { output: [call] });
  await waitForInjection(() => !ws.data.nativeControl);
});

test("different response, lane, unadvertised and hosted-tool results never reach upstream", async () => {
  const { socket, send, sent, ws, id } = await beginInjection({ stream_id: "lane-A" });
  advertiseInjection(socket);
  const base = { type: "response.inject", response_id: id, stream_id: "lane-A", input: [savedResult()] };
  for (const frame of [
    { ...base, response_id: "foreign" }, { ...base, stream_id: "lane-B" },
    { ...base, input: [savedResult("foreign-call")] },
    { ...base, input: [{ type: "multi_agent_call_output", call_id: "hosted", output: "no" }] },
    { ...base, input: [{ type: "message", role: "system", content: "no" }] },
  ]) { send(frame); expect(sent.at(-1)?.type).toBe("error"); }
  expect(socket.frames).toHaveLength(1);
  ws.close(); await waitForInjection(() => !ws.data.nativeControl);
});

test("two connections cannot inject results into each other's response or credentials", async () => {
  const a = await beginInjection({}, injectionConfig(), "fixture-account-A");
  const b = await beginInjection({}, injectionConfig(), "fixture-account-B");
  advertiseInjection(a.socket); advertiseInjection(b.socket);
  a.send({ type: "response.inject", response_id: b.id, input: [savedResult()] });
  expect(a.sent.at(-1)?.error.code).toBe("injection_response_mismatch");
  expect(a.socket.frames).toHaveLength(1); expect(b.socket.frames).toHaveLength(1);
  a.ws.close(); b.ws.close();
  await waitForInjection(() => !a.ws.data.nativeControl && !b.ws.data.nativeControl);
});

test.each(["disabled", "no-multi-agent", "warmup", "steering-only"])("unsupported %s does not silently discard an injection", async mode => {
  const cfg = injectionConfig();
  if (mode === "disabled" || mode === "steering-only") cfg.codexNativeInjection = false;
  if (mode === "steering-only") cfg.codexNativeSteering = true;
  const client = injectionClient(mode === "warmup" ? { generate: false } : mode === "no-multi-agent" ? { multi_agent: { enabled: false } } : {}, cfg);
  await waitForInjection(() => client.sent.some(event => event.type === "response.created"));
  client.send({ type: "response.inject", response_id: "unused", input: [savedResult()] });
  expect(client.sent.at(-1)?.error.code).toBe("injection_not_supported");
  expect(InjectionSocket.all.every(socket => socket.frames.length === 1)).toBe(true);
  client.ws.close();
});

test("a pending injection prevents a new create from cancelling the owned socket", async () => {
  const { socket, send, sent, ws, id } = await beginInjection();
  advertiseInjection(socket);
  send({ type: "response.inject", response_id: id, input: [savedResult()] });
  send({ type: "response.create", model: "different-model", input: "new work" });
  expect(sent.at(-1)?.error.code).toBe("injection_pending");
  expect(socket.readyState).toBe(1); expect(socket.frames).toHaveLength(2);
  ws.close(); await waitForInjection(() => !ws.data.nativeControl);
});

test("unknown delivery closes without HTTP fallback or resending the control", async () => {
  const { socket, send, sent, ws, id } = await beginInjection();
  advertiseInjection(socket); socket.throwOnInject = true;
  send({ type: "response.inject", response_id: id, input: [savedResult()] });
  await waitForInjection(() => !ws.data.nativeControl);
  expect(socket.readyState).toBe(3); expect(fallbackCalls).toBe(0);
  expect(InjectionSocket.all).toHaveLength(1);
  expect(sent.some(event => event.error?.message?.includes("unknown"))).toBe(true);
});

test("control failures are never sampled into the request log or counted as response usage", () => {
  const log = { model: "fixture", provider: "fixture" } as RequestLogContext;
  const inspect = createNativeSteeringLogObserver(log);
  inspect(JSON.stringify({ type: "response.inject.failed", input: [savedResult("call-1", "PRIVATE_TOOL_RESULT")], error: { code: "x", message: "PRIVATE_TOOL_RESULT" } }));
  expect(JSON.stringify(log)).not.toContain("PRIVATE_TOOL_RESULT");
  expect(log.usage).toBeUndefined(); expect(log.upstreamError).toBeUndefined();
});

test("accepted function results survive ordinary subsequent delta turns; no user message is invented", async () => {
  const { socket, send, sent, ws, id } = await beginInjection();
  const call = advertiseInjection(socket);
  send({ type: "response.inject", response_id: id, input: [savedResult("call-1", "accepted-result")] });
  acknowledgeInjection(socket); completeInjection(socket, { output: [call] });
  await waitForInjection(() => !ws.data.nativeControl);
  send({ type: "response.create", model: "gpt-5.6-sol", multi_agent: { enabled: true }, previous_response_id: id, input: "followup" });
  await waitForInjection(() => InjectionSocket.all.length === 2 && InjectionSocket.all[1].frames.length > 0);
  const next = InjectionSocket.all[1];
  const history = next.frames[0].input as Array<Record<string, unknown>>;
  expect(history.filter(item => item.type === "function_call_output")).toEqual([savedResult("call-1", "accepted-result")]);
  expect(history.findIndex(item => item.type === "function_call_output")).toBe(history.findIndex(item => item.type === "function_call") + 1);
  expect(JSON.stringify(history)).toContain("followup");
  completeInjection(next); await waitForInjection(() => !ws.data.nativeControl);
  expect(sent.at(-1)?.type).toBe("response.completed");
});

/** Unit owner fixture uses the same event contract without a network or application home. */
function unitChannel(deadlines = { ackMs: 90_000, toolMs: 1_800_000 }) {
  const sent: Array<Record<string, unknown>> = [];
  const failures: Error[] = [];
  const channel = new NativeInjectionChannel({ multi_agent: { enabled: true }, model: "fixture" }, 1000, deadlines);
  const detach = channel.attach(frame => sent.push(frame), error => failures.push(error));
  channel.observe({ type: "response.created", response: { id: "root" } });
  const advertise = (call: string, index = 0) => {
    const item = { id: `item-${call}`, type: "function_call", call_id: call, name: "fixture", arguments: "{}" };
    channel.observe({ type: "response.output_item.added", output_index: index, item });
    channel.observe({ type: "response.output_item.done", output_index: index, item });
  };
  return { channel, sent, failures, detach, advertise };
}

test("injection queue counts include the in-flight frame and refuse the next frame without sending it", () => {
  const { channel, advertise, sent, detach } = unitChannel();
  try {
    for (let i = 0; i <= MAX_NATIVE_INJECTIONS; i++) advertise(`c${i}`, i);
    for (let i = 0; i < MAX_NATIVE_INJECTIONS; i++) channel.inject({ type: "response.inject", response_id: "root", input: [savedResult(`c${i}`)] });
    expect(sent).toHaveLength(1);
    expect(() => channel.inject({ type: "response.inject", response_id: "root", input: [savedResult(`c${MAX_NATIVE_INJECTIONS}`)] })).toThrow("limit reached");
    expect(sent).toHaveLength(1);
  } finally { detach(); }
});

test("serialized-byte cap rejects oversized output before a physical send", () => {
  const { channel, advertise, sent, detach } = unitChannel();
  try {
    advertise("c");
    expect(() => channel.inject({ type: "response.inject", response_id: "root", input: [savedResult("c", "x".repeat(MAX_NATIVE_INJECTION_BYTES))] })).toThrow("byte limit");
    expect(sent).toHaveLength(0);
    channel.inject({ type: "response.inject", response_id: "root", input: [savedResult("c", "small")] });
    expect(sent).toHaveLength(1); // refusal did not consume the call's reservation
  } finally { detach(); }
});

test("ack deadline remains absolute even while unrelated valid output keeps arriving", async () => {
  const { channel, advertise, sent, failures, detach } = unitChannel({ ackMs: 20, toolMs: 1000 });
  try {
    advertise("c"); channel.inject({ type: "response.inject", response_id: "root", input: [savedResult("c")] });
    for (let i = 0; i < 10 && !failures.length; i++) {
      await Bun.sleep(5);
      if (!channel.ended) channel.observe({ type: "response.in_progress", response: { id: "root" } });
    }
    expect(failures).toHaveLength(1); expect(failures[0].message).toContain("delivery is unknown");
    expect(sent).toHaveLength(1); expect(channel.ended).toBe(true);
  } finally { detach(); }
});

test("waiting for an asynchronously computed result is bounded and does not execute the tool", async () => {
  const { channel, advertise, sent, failures, detach } = unitChannel({ ackMs: 1000, toolMs: 10 });
  try {
    advertise("c");
    expect(channel.observe({ type: "response.completed", response: { id: "root", status: "completed", output: [] } })).toBe(false);
    await waitForInjection(() => failures.length > 0);
    expect(sent).toHaveLength(0); expect(failures).toHaveLength(1);
  } finally { detach(); }
});

test.each([
  { type: "response.inject.created", response_id: "foreign", sequence_number: 10 },
  { type: "response.inject.created", response_id: "root", sequence_number: -1 },
  { type: "response.inject.created", response_id: "root" },
  { type: "response.inject.failed", response_id: "root", sequence_number: 10, input: [savedResult("c", "different")], error: { code: "response_already_completed" } },
])("unknown or mismatched acknowledgements are rejected without committing results", event => {
  const { channel, advertise, sent, detach } = unitChannel();
  try {
    advertise("c"); channel.inject({ type: "response.inject", response_id: "root", input: [savedResult("c")] });
    expect(() => channel.observe(event)).toThrow(); expect(sent).toHaveLength(1);
  } finally { detach(); }
});

test("a repeated acknowledgement cannot consume the next queued injection", async () => {
  const { channel, advertise, sent, detach } = unitChannel();
  try {
    advertise("c1"); advertise("c2", 1);
    for (const call of ["c1", "c2"]) channel.inject({ type: "response.inject", response_id: "root", input: [savedResult(call)] });
    const ack = { type: "response.inject.created", response_id: "root", sequence_number: 10 };
    channel.observe(ack); await Bun.sleep(0);
    expect(sent).toHaveLength(2);
    expect(() => channel.observe(ack)).toThrow("identity mismatch");
  } finally { detach(); }
});

test("submitted objects are copied so later caller mutation cannot alter a queued send", async () => {
  const { channel, advertise, sent, detach } = unitChannel();
  try {
    advertise("c1"); advertise("c2", 1);
    channel.inject({ type: "response.inject", response_id: "root", input: [savedResult("c1")] });
    const result = savedResult("c2", "original");
    channel.inject({ type: "response.inject", response_id: "root", input: [result] });
    result.output = "mutated";
    channel.observe({ type: "response.inject.created", response_id: "root", sequence_number: 10 });
    await Bun.sleep(0);
    expect(sent[1].input).toEqual([savedResult("c2", "original")]);
  } finally { detach(); }
});

test("batch results receive one acknowledgement and cannot reserve a call twice", () => {
  const { channel, advertise, sent, detach } = unitChannel();
  try {
    advertise("c1"); advertise("c2", 1);
    expect(() => channel.inject({ type: "response.inject", response_id: "root", input: [savedResult("c1"), savedResult("c1")] })).toThrow("exactly once");
    channel.inject({ type: "response.inject", response_id: "root", input: [savedResult("c1"), savedResult("c2")] });
    expect(sent).toHaveLength(1);
    channel.observe({ type: "response.inject.created", response_id: "root", sequence_number: 10 });
    expect(channel.observe({ type: "response.completed", response: { id: "root", status: "completed", output: [] } })).toBe(true);
  } finally { detach(); }
});

test("tool-result validation rejects empty arrays, privileged roles, extra fields and unsupported rich outputs", () => {
  for (const input of [[], "text", null, [savedResult("bad\n")], [{ ...savedResult(), role: "system" }], [{ ...savedResult(), output: [] }]]) {
    expect(() => injectionResults(input)).toThrow();
  }
});

test("public injection excludes custom gateways, forwarded auth and an unopted API provider", () => {
  const channel = new NativeInjectionChannel({ multi_agent: { enabled: true } });
  const provider = injectionConfig(true).providers.api;
  expect(nativeResponseControlEligible(provider, channel)).toBe(true);
  expect(nativeResponseControlEligible({ ...provider, baseUrl: "https://api.openai.com.attacker.invalid/v1" }, channel)).toBe(false);
  expect(nativeResponseControlEligible({ ...provider, baseUrl: "http://api.openai.com/v1" }, channel)).toBe(false);
  expect(nativeResponseControlEligible({ ...provider, upstreamWebsocket: false }, channel)).toBe(false);
  expect(nativeResponseControlEligible({ ...provider, authMode: "forward" }, channel)).toBe(false);
  expect(nativeResponseControlEligible(provider)).toBe(false);
});

test("injection mode refuses simultaneous steering instead of fabricating protocol equivalence", () => {
  const { channel, sent, detach } = unitChannel();
  try {
    expect(() => channel.steer({ type: "response.steer", previous_response_id: "root", input: "change plan" })).toThrow("injection-only");
    expect(sent).toHaveLength(0);
  } finally { detach(); }
});

test("replay stores only accepted outputs and does not duplicate results echoed by the backend", () => {
  const remembered: Array<{ input: unknown[]; response: Record<string, unknown> }> = [];
  const replay = new NativeInjectionReplay("original", (input, response) => remembered.push({ input, response }));
  const call = { type: "function_call", call_id: "c1" };
  const result = savedResult("c1", "accepted");
  replay.observe({ type: "response.created", response: { id: "r1" } });
  replay.submitted({ type: "response.inject", input: [result] });
  replay.observe({ type: "response.inject.created" });
  replay.observe({ type: "response.completed", response: { id: "r1", output: [call, result] } });
  expect(remembered[0].response.output).toEqual([call, result]);
  replay.dispose();
  const failed = new NativeInjectionReplay([], (input, response) => remembered.push({ input, response }));
  failed.observe({ type: "response.created", response: { id: "r2" } });
  failed.submitted({ type: "response.inject", input: [savedResult("c1", "REJECTED_CONTENT")] });
  failed.observe({ type: "response.inject.failed" });
  failed.observe({ type: "response.completed", response: { id: "r2", output: [call] } });
  expect(JSON.stringify(remembered)).not.toContain("REJECTED_CONTENT");
  failed.dispose();
});

test("a foreign acknowledgement closes the real exchange without exposing input or retrying", async () => {
  const { socket, send, sent, ws, id } = await beginInjection();
  advertiseInjection(socket);
  send({ type: "response.inject", response_id: id, input: [savedResult("call-1", "PRIVATE_FIXTURE_RESULT")] });
  acknowledgeInjection(socket, 100, "another-response");
  await waitForInjection(() => !ws.data.nativeControl);
  expect(socket.readyState).toBe(3);
  expect(InjectionSocket.all).toHaveLength(1); expect(fallbackCalls).toBe(0);
  expect(sent.some(event => event.type === "response.inject.created")).toBe(false);
  expect(JSON.stringify(sent)).not.toContain("PRIVATE_FIXTURE_RESULT");
});

test("downstream disconnect discards queued injection without a second physical send", async () => {
  const { socket, send, ws, handler, id } = await beginInjection();
  advertiseInjection(socket); advertiseInjection(socket, "call-2", 1);
  for (const call of ["call-1", "call-2"]) send({ type: "response.inject", response_id: id, input: [savedResult(call)] });
  handler.close(ws, 1000, "fixture disconnect");
  await waitForInjection(() => !ws.data.nativeControl);
  acknowledgeInjection(socket);
  await Bun.sleep(0);
  expect(socket.frames.filter(frame => frame.type === "response.inject")).toHaveLength(1);
  expect(socket.readyState).toBe(3); expect(fallbackCalls).toBe(0);
});

test("HTTP fallback never acquires injection ownership or replays a control frame", async () => {
  const config = injectionConfig(true);
  config.providers.api.upstreamWebsocket = false;
  const { send, sent, ws } = injectionClient({}, config);
  await waitForInjection(() => sent.some(event => event.type === "error"));
  const requests = fallbackCalls;
  send({ type: "response.inject", response_id: "unknown", input: [savedResult()] });
  expect(sent.at(-1)?.error.code).toBe("injection_not_supported");
  expect(fallbackCalls).toBe(requests); expect(InjectionSocket.all).toHaveLength(0);
  expect(ws.data.nativeControl).toBeUndefined();
});
