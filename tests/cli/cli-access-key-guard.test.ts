import { afterEach, expect, test, spyOn } from "bun:test";
import { Readable, PassThrough } from "node:stream";
import { withSelectedDataKey, withDataCommandSignals, readBoundedDataJson, type DataClientDeps } from "../../src/cli/access-data-client";
import { handleSelectedKeyTest } from "../../src/cli/access-data-plane";
import { readSecretBytes } from "../../src/cli/runtime-api";
import type { OcxClientConnectionConfig } from "../../src/types";

function deps(input = Readable.from([Buffer.from("key")])): DataClientDeps {
  return { stdinImpl: input, readClientConnectionState: () => ({ kind: "disconnected" }),
    findLiveProxy: async () => ({ port: 12345, hostname: "127.0.0.1", pid: 123, source: "runtime" }) };
}
for (const value of ["", " ", " key", "key ", "key\n\n", "key\r", "k\ney", "key\t", "é", "한글", "\ufeffkey", "key\x7f", "x".repeat(4097)]) {
  test(`rejects unsafe secret bytes (${JSON.stringify(value).slice(0, 35)}) before operation`, async () => {
    let called = false;
    const d = deps(Readable.from([Buffer.from(value)]));
    await expect(withSelectedDataKey(d, new AbortController().signal, async () => { called = true; })).rejects.toThrow();
    expect(called).toBe(false);
    expect(d.stdinImpl!.listenerCount("data")).toBe(0);
  });
}
for (const value of ["key", "key\n", "key\r\n", "!key~", "key with space", "x".repeat(4096)]) {
  test(`preserves supported exact key (${value.length} bytes)`, async () => {
    const buffer = Buffer.from(value);
    const d = deps(Readable.from([buffer]));
    const result = await withSelectedDataKey(d, new AbortController().signal, async ({ key }) => key);
    expect(result).toBe(value.replace(/\r?\n$/, ""));
    expect(buffer.every(value => value === 0)).toBe(true);
  });
}
test("fatal UTF-8 refuses rather than replacement-decoding", async () => {
  const d = deps(Readable.from([Buffer.from([0xc3, 0x28])]));
  await expect(withSelectedDataKey(d, new AbortController().signal, async () => { throw new Error("called"); })).rejects.toThrow("valid UTF-8");
});
test("TTY refuses without adding input listeners", async () => {
  const stream = new PassThrough();
  const d = deps(stream); d.stdinImpl!.isTTY = true;
  await expect(withSelectedDataKey(d, new AbortController().signal, async () => 1)).rejects.toThrow("Pipe");
  expect(stream.listenerCount("data")).toBe(0); stream.destroy();
});
test("baseUrl alone cannot bypass identity discovery", async () => {
  const d = { ...deps(), baseUrl: "https://other.test", findLiveProxy: async () => null };
  await expect(withSelectedDataKey(d, new AbortController().signal, async () => 1)).rejects.toThrow();
});
for (const kind of ["invalid", "mismatched"] as const) test(`${kind} enrollment never falls back`, async () => {
  const d = deps(); let calls = 0;
  d.readClientConnectionState = () => ({ kind, reason: "private" });
  d.findLiveProxy = async () => { calls++; return null; };
  await expect(withSelectedDataKey(d, new AbortController().signal, async () => 1)).rejects.toThrow();
  expect(calls).toBe(0);
});
test("client listener without enrollment refuses", async () => {
  const d = deps(); d.findLiveProxy = async () => ({ port: 12345, pid: 1, role: "client", source: "runtime" });
  await expect(withSelectedDataKey(d, new AbortController().signal, async () => 1)).rejects.toThrow();
});
test("connected target uses normalized enrollment and full snapshot guard only", async () => {
  const connection: OcxClientConnectionConfig = { serverUrl: "https://hub.example.test/v1/", managementUrl: "https://hub.example.test", managementTransport: "direct", selectedClients: [], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "fixture-id", tokenFingerprint: "fixture-fingerprint", protocolVersion: 1, connectedAt: "2026-01-01T00:00:00.000Z" };
  const d = deps(); let guards = 0;
  d.readClientConnectionState = () => ({ kind: "connected", value: connection });
  d.assertClientConnectionUnchanged = expected => { expect(expected).toEqual(connection); guards++; };
  d.findLiveProxy = async () => { throw new Error("must not discover local"); };
  const result = await withSelectedDataKey(d, new AbortController().signal, async ({ target, key }) => { await target.assertCurrent(); return [target.origin, key]; });
  expect(result).toEqual(["https://hub.example.test", "key"]); expect(guards).toBe(3);
});
test("enrollment appearing during stdin refuses before operation", async () => {
  const stream = new PassThrough(); const d = deps(stream); let changed = false;
  d.readClientConnectionState = () => changed ? { kind: "invalid", reason: "changed" } : { kind: "disconnected" };
  stream.on("newListener", event => { if (event === "data") queueMicrotask(() => { changed = true; stream.end("key"); }); });
  await expect(withSelectedDataKey(d, new AbortController().signal, async () => 1)).rejects.toThrow();
  stream.destroy();
});
for (const field of ["pid", "port", "hostname", "role"] as const) test(`local ${field} drift stops operation`, async () => {
  let count = 0; const d = deps();
  d.findLiveProxy = async () => ({ port: 12345, hostname: "127.0.0.1", pid: 1, source: "runtime", ...(++count >= 3 ? { [field]: field === "pid" ? 2 : field === "port" ? 23456 : field === "role" ? "client" : "localhost" } : {}) });
  await expect(withSelectedDataKey(d, new AbortController().signal, async () => 1)).rejects.toThrow();
});
test("readSecretBytes cancellation wipes source chunks and detaches listeners", async () => {
  const input = new PassThrough(); const controller = new AbortController(); const bytes = Buffer.from("fixture-secret");
  const pending = readSecretBytes({ stdinImpl: input, stdinSignal: controller.signal }, "key");
  input.write(bytes); controller.abort();
  await expect(pending).rejects.toThrow();
  expect([...bytes]).toEqual(new Array(bytes.length).fill(0));
  for (const event of ["data", "end", "error"]) expect(input.listenerCount(event)).toBe(0);
  expect(input.destroyed).toBe(false); input.destroy();
});
test("pre-aborted byte reader adds no listeners", async () => {
  const input = new PassThrough(); const controller = new AbortController(); controller.abort();
  await expect(readSecretBytes({ stdinImpl: input, stdinSignal: controller.signal }, "key")).rejects.toThrow();
  expect(input.listenerCount("data")).toBe(0); input.destroy();
});
test("legacy byte reader still reads and wipes normally without signal", async () => {
  const source = Buffer.from("ordinary\n");
  const result = await readSecretBytes({ stdinImpl: Readable.from([source]) }, "key");
  expect(new TextDecoder().decode(result)).toBe("ordinary\n"); expect(source.every(byte => byte === 0)).toBe(true); result.fill(0);
});
for (const event of ["SIGINT", "SIGTERM"] as const) test(`${event} returns its numeric exit and removes listeners`, async () => {
  const before = process.listenerCount(event);
  const code = await withDataCommandSignals({}, async signal => { process.emit(event); signal.throwIfAborted(); return 0; });
  expect(code).toBe(event === "SIGINT" ? 130 : 143); expect(process.listenerCount(event)).toBe(before);
});
test("external cancellation during input leaves no late operation", async () => {
  const input = new PassThrough(); const d = deps(input); const controller = new AbortController(); d.signal = controller.signal;
  input.on("newListener", event => { if (event === "data") queueMicrotask(() => controller.abort()); });
  expect(await withDataCommandSignals(d, signal => withSelectedDataKey(d, signal, async () => { throw new Error("late work"); }))).toBe(130);
  expect(input.listenerCount("data")).toBe(0); expect(input.isPaused()).toBe(true); input.destroy();
});
test("bounded JSON rejects oversized body and releases its lock", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("12345")); }, cancel() { cancelled = true; } });
  await expect(readBoundedDataJson(new Response(body), { maxBytes: 4, signal: new AbortController().signal })).rejects.toThrow();
  expect(cancelled).toBe(true); expect(body.locked).toBe(false);
});
test("bounded JSON accepts exact bytes and rejects invalid UTF8", async () => {
  expect(await readBoundedDataJson(new Response("null"), { maxBytes: 4, signal: new AbortController().signal })).toBeNull();
  await expect(readBoundedDataJson(new Response(new Uint8Array([0xc3, 0x28])), { maxBytes: 4, signal: new AbortController().signal })).rejects.toThrow();
});
test("input timeout is operational exit 1 and versioned not-run report", async () => {
  const output: string[] = []; const errors: string[] = [];
  const out = spyOn(console, "log").mockImplementation(v => { output.push(String(v)); });
  const err = spyOn(console, "error").mockImplementation(v => { errors.push(String(v)); });
  const stream = new PassThrough();
  try {
    expect(await handleSelectedKeyTest(["m", "--api-key-stdin", "--json"], { ...deps(stream), stdinTimeoutMs: 1 })).toBe(1);
    expect(JSON.parse(output[0]!).control.outcome).toBe("not_run"); expect(stream.listenerCount("data")).toBe(0);
  } finally { out.mockRestore(); err.mockRestore(); stream.destroy(); }
});
