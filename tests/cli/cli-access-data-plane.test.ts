import { afterEach, expect, test, spyOn } from "bun:test";
import { Readable } from "node:stream";
import { handleSelectedKeyTest, type SelectedKeyTestDeps } from "../../src/cli/access-data-plane";
import { handleAccessCommand } from "../../src/cli/access";
import { projectModelResponse, type DataProtocol } from "../../src/cli/access-data-response";

const logs: string[] = [], errors: string[] = [];
let out = spyOn(console, "log").mockImplementation((value: unknown) => { logs.push(String(value)); });
let err = spyOn(console, "error").mockImplementation((value: unknown) => { errors.push(String(value)); });
afterEach(() => { logs.length = 0; errors.length = 0; });
const key = "chosen.$[secret]";
const native = { error: { message: "opencodex API key required", type: "authentication_error", code: "invalid_api_key" } };
function success(protocol: DataProtocol): unknown {
  const text = `OK ${key} ${key}`;
  if (protocol === "chat") return { object: "chat.completion", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, secret: key };
  if (protocol === "responses") return { object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, secret: key };
  return { type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 2 }, secret: key };
}
function deps(fetcher: typeof fetch, value = key): SelectedKeyTestDeps {
  return { stdinImpl: Readable.from([Buffer.from(value)]), readClientConnectionState: () => ({ kind: "disconnected" }),
    findLiveProxy: async () => ({ port: 12345, hostname: "127.0.0.1", pid: 123, source: "runtime" }), fetchImpl: fetcher };
}
for (const protocol of ["chat", "responses", "messages"] as const) {
  test(`selected ${protocol} sends literal credentialless control then exactly one dedicated 16-token request`, async () => {
    const seen: RequestInit[] = [];
    const d = deps((async (url, init) => {
      expect(String(url)).toBe(`http://127.0.0.1:12345${protocol === "chat" ? "/v1/chat/completions" : `/v1/${protocol}`}`);
      seen.push(init!);
      return Response.json(seen.length === 1 ? native : success(protocol), { status: seen.length === 1 ? 401 : 200 });
    }) as typeof fetch);
    expect(await handleAccessCommand(["test", "fixture-model", `--protocol=${protocol}`, "--api-key-stdin", "--json"], d)).toBe(0);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.body).toBe("{");
    expect([...new Headers(seen[0]!.headers)]).toEqual([["accept", "application/json"], ["content-type", "application/json"]]);
    expect([...new Headers(seen[1]!.headers)]).toEqual([["accept", "application/json"], ["content-type", "application/json"], ["x-opencodex-api-key", key]]);
    for (const item of seen) { expect(item.redirect).toBe("error"); expect(item.credentials).toBe("omit"); }
    const body = JSON.parse(String(seen[1]!.body));
    expect(body[protocol === "responses" ? "max_output_tokens" : "max_tokens"]).toBe(16);
    const report = JSON.parse(logs[0]!);
    expect(report.control).toEqual({ outcome: "credential_required", status: 401 });
    expect(report.request).toEqual({ outcome: "succeeded", status: 200 });
    expect(report.response.text).toEqual(["OK [redacted] [redacted]"]);
    expect(logs.join("")).not.toContain(key);
    expect(errors).toEqual([]);
  });
}
for (const body of [{}, { error: { ...native.error, message: "different" } }, { error: { ...native.error, code: ["invalid_api_key"] } }, { error: { ...native.error, type: ["authentication_error"] } }]) {
  test("non-native 401 never sends inference", async () => {
    let count = 0;
    expect(await handleSelectedKeyTest(["x", "--api-key-stdin", "--json"], deps((async () => { count++; return Response.json(body, { status: 401 }); }) as typeof fetch))).toBe(1);
    expect(count).toBe(1);
    expect(JSON.parse(logs[0]!).request.outcome).toBe("not_run");
  });
}
for (const status of [200, 400, 403, 500]) test(`control ${status} unavailable`, async () => {
  let count = 0;
  expect(await handleSelectedKeyTest(["x", "--api-key-stdin"], deps((async () => { count++; return Response.json(native, { status }); }) as typeof fetch))).toBe(1);
  expect(count).toBe(1);
});
for (const protocol of ["chat", "responses", "messages"] as const) test(`${protocol} unsupported payload and unsafe usage rejected`, () => {
  for (const raw of [{}, [], { error: "bad" }, { ...success(protocol) as object, usage: { input_tokens: -1, prompt_tokens: -1 } }, { ...success(protocol) as object, usage: { input_tokens: "2", prompt_tokens: "2" } }]) {
    expect(() => projectModelResponse(raw, protocol, key)).toThrow();
  }
});
test("limited outputs, empty text, and usage omission are preserved", () => {
  const row = projectModelResponse({ object: "chat.completion", choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }] }, "chat", key);
  expect(row).toEqual({ protocol: "chat", text: [""], completion: "limited" });
  expect(() => projectModelResponse({ object: "chat.completion", choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "content_filter" }] }, "chat", key)).toThrow();
});
test("raw error and hostile metadata never enter JSON or stderr", async () => {
  let count = 0;
  const d = deps((async () => ++count === 1 ? Response.json(native, { status: 401 }) : Response.json({ error: key, token: key }, { status: 401 })) as typeof fetch);
  expect(await handleSelectedKeyTest(["x", "--api-key-stdin", "--json"], d)).toBe(1);
  expect(JSON.parse(logs[0]!).request).toEqual({ outcome: "failed", status: 401 });
  expect(logs.join("") + errors.join("")).not.toContain(key);
});
for (const argv of [["x", "--api-key-stdin=secret"], ["x", "--api-key-stdin", "--api-key-stdin"], ["x", "--api-key-stdin", "--json", "--json"], ["x", "--api-key-stdin", "--protocol=no"]]) {
  test("invalid explicit mode cannot fall into legacy dispatch", async () => {
    let count = 0;
    expect(await handleAccessCommand(["test", ...argv], deps((async () => { count++; throw new Error(); }) as typeof fetch))).toBe(2);
    expect(count).toBe(0); expect(logs).toEqual([]); expect(errors.join("")).not.toContain("secret");
  });
}
test("missing model response remains unsupported rather than success", async () => {
  let count = 0;
  expect(await handleSelectedKeyTest(["x", "--api-key-stdin", "--json"], deps((async () => Response.json(++count === 1 ? native : {}, { status: count === 1 ? 401 : 200 })) as typeof fetch))).toBe(1);
  expect(JSON.parse(logs[0]!).request.outcome).toBe("unsupported_response");
});
// Restore spies when this module's tests finish, including multi-file invocations.
import { afterAll } from "bun:test";
afterAll(() => { out.mockRestore(); err.mockRestore(); });
test("Responses content-filter and refusal blocks never become limited success", () => {
  const raw = success("responses") as Record<string, unknown>;
  expect(() => projectModelResponse({ ...raw, status: "incomplete", incomplete_details: { reason: "content_filter" } }, "responses", key)).toThrow();
  expect(() => projectModelResponse({ ...raw, output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] }, "responses", key)).toThrow();
});
for (const at of [1, 2]) test(`HTTP redirect during request ${at} reaches no second endpoint`, async () => {
  let calls = 0, foreign = 0;
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { foreign++; return Response.json({}); } });
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { calls++; return calls === at ? Response.redirect(destination.url, 307) : Response.json(native, { status: 401 }); } });
  try {
    const d = deps(fetch); d.findLiveProxy = async () => ({ port: source.port!, hostname: "127.0.0.1", pid: 1, source: "runtime" });
    expect(await handleSelectedKeyTest(["x", "--api-key-stdin", "--json"], d)).toBe(1);
    expect(calls).toBe(at); expect(foreign).toBe(0);
  } finally { await source.stop(true); await destination.stop(true); }
});
for (const at of [1, 2]) for (const where of ["headers", "body"] as const) test(`total deadline owns ${where} wait in request ${at}`, async () => {
  let calls = 0, cancelled = false;
  const d = deps((async (_url, init) => {
    calls++;
    if (calls !== at) return Response.json(native, { status: 401 });
    if (where === "headers") return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { cancelled = true; reject(new Error("raw secret " + key)); }, { once: true });
    });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"')); }, cancel() { cancelled = true; } }), { status: at === 1 ? 401 : 200 });
  }) as typeof fetch);
  d.controlTimeoutMs = 5; d.requestTimeoutMs = 5;
  expect(await handleSelectedKeyTest(["x", "--api-key-stdin", "--json"], d)).toBe(1);
  expect(calls).toBe(at); expect(cancelled).toBe(true);
  expect(logs.join("") + errors.join("")).not.toContain(key);
});
for (const at of [1, 2]) test(`external abort during request ${at} yields no late output or inference`, async () => {
  const controller = new AbortController(); let calls = 0;
  const d = deps((async (_url, init) => {
    calls++;
    if (calls !== at) return Response.json(native, { status: 401 });
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("private")), { once: true });
      controller.abort();
    });
  }) as typeof fetch); d.signal = controller.signal;
  expect(await handleSelectedKeyTest(["x", "--api-key-stdin", "--json"], d)).toBe(130);
  expect(calls).toBe(at); expect(logs).toEqual([]); expect(errors).toEqual([]);
});
for (const at of [1, 2]) test(`observed identity drift after request ${at} cannot report success`, async () => {
  let calls = 0, drift = false;
  const d = deps((async () => { calls++; drift = calls === at; return Response.json(calls === 1 ? native : success("chat"), { status: calls === 1 ? 401 : 200 }); }) as typeof fetch);
  d.findLiveProxy = async () => ({ port: 12345, hostname: "127.0.0.1", pid: drift ? 2 : 1, source: "runtime" });
  expect(await handleSelectedKeyTest(["x", "--api-key-stdin", "--json"], d)).toBe(1);
  expect(calls).toBe(at); expect(JSON.parse(logs[0]!).request.outcome).not.toBe("succeeded");
});
for (const body of ["<html>private</html>", "{", " ".repeat(4097), new Uint8Array([0xc3, 0x28])]) test("malformed or oversized control refuses inference", async () => {
  let calls = 0;
  expect(await handleSelectedKeyTest(["x", "--api-key-stdin", "--json"], deps((async () => { calls++; return new Response(body, { status: 401 }); }) as typeof fetch))).toBe(1);
  expect(calls).toBe(1); expect(JSON.parse(logs[0]!).control.outcome).toBe("unavailable");
});
test("a native Messages and Hub-link OpenAI refusal both advance", async () => {
  for (const control of [{ type: "error", error: { message: native.error.message, type: native.error.type } }, native]) {
    let count = 0;
    expect(await handleSelectedKeyTest(["x", "--protocol=messages", "--api-key-stdin", "--json"], deps((async () => Response.json(++count === 1 ? control : success("messages"), { status: count === 1 ? 401 : 200 })) as typeof fetch))).toBe(0);
    expect(count).toBe(2);
  }
});
test("keyed body cap rejects a large response without exposing content", async () => {
  let count = 0;
  expect(await handleSelectedKeyTest(["x", "--api-key-stdin", "--json"], deps((async () => ++count === 1 ? Response.json(native, { status: 401 }) : new Response("x".repeat(2 * 1024 * 1024 + 1))) as typeof fetch))).toBe(1);
  expect(JSON.parse(logs[0]!).request.outcome).toBe("failed");
});
test("human response text cannot execute terminal controls", async () => {
  let count = 0;
  const payload = { object: "chat.completion", choices: [{ message: { role: "assistant", content: `\x1b[31m${key}` }, finish_reason: "stop" }] };
  expect(await handleSelectedKeyTest(["x", "--api-key-stdin"], deps((async () => Response.json(++count === 1 ? native : payload, { status: count === 1 ? 401 : 200 })) as typeof fetch))).toBe(0);
  expect(logs.join("")).not.toContain("\x1b"); expect(logs.join("")).toContain("\\x1b[31m[redacted]");
});
test("cancellation while consuming a body cancels it and emits no report", async () => {
  const controller = new AbortController(); let cancelled = false;
  const d = deps((async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('{"error":')); queueMicrotask(() => controller.abort()); },
    cancel() { cancelled = true; },
  }), { status: 401 })) as typeof fetch); d.signal = controller.signal;
  expect(await handleSelectedKeyTest(["x", "--api-key-stdin", "--json"], d)).toBe(130);
  expect(cancelled).toBe(true); expect(logs).toEqual([]); expect(errors).toEqual([]);
});
