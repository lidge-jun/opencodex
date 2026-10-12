import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync, truncateSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import { handleAccessAudioCommand, type AccessAudioDeps } from "../../src/cli/access-audio";
import { handleAccessCommand } from "../../src/cli/access";
import { readAudioFile } from "../../src/cli/access-audio-input";
import { resolveAudioAdmission } from "../../src/server/audio-upstream";
import { handleAudioTranscriptions } from "../../src/server/audio-transcriptions";
import { resolveAudioClient } from "../../src/server/audio-client";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const KEY = "ocx_data_audio_cli_synthetic";
const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
let root: string;
let file: string;
let stdout: ReturnType<typeof spyOn<typeof console, "log">>;
let stderr: ReturnType<typeof spyOn<typeof console, "error">>;
const servers: ReturnType<typeof Bun.serve>[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-cli-audio-"));
  file = join(root, "sample.wav");
  writeFileSync(file, new Uint8Array([82, 73, 70, 70]));
  process.env.OPENCODEX_HOME = root;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  stdout = spyOn(console, "log").mockImplementation(() => {});
  stderr = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  globalThis.fetch = originalFetch;
  stdout.mockRestore(); stderr.mockRestore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN; else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
  removeTreeWithRetry(root);
});
function args(path = file, model = "gpt-4o-transcribe") { return ["transcribe", path, "--model", model, "--api-key-stdin", "--json"]; }
function deps(extra: AccessAudioDeps = {}, key: string | Uint8Array = KEY): AccessAudioDeps {
  return {
    readClientConnectionState: () => ({ kind: "disconnected" }),
    findLiveProxy: async () => ({ port: 19001, pid: 1, hostname: "127.0.0.1", source: "runtime" }),
    stdinImpl: Readable.from([typeof key === "string" ? Buffer.from(key) : key]),
    ...extra,
  };
}
function output(): string { return stdout.mock.calls.map(row => row.join(" ")).join("\n"); }
function errors(): string { return stderr.mock.calls.map(row => row.join(" ")).join("\n"); }
function fetcher(run: (request: Request, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => run(new Request(input, init), init)) as typeof fetch;
}
function config(keys = true): OcxConfig {
  return {
    port: 0, hostname: "127.0.0.1", defaultProvider: "openai-apikey",
    providers: { "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "synthetic-upstream", authMode: "key" } },
    apiKeys: keys ? [{ id: "audio", name: "audio", key: KEY, createdAt: "2026-10-01T00:00:00Z" }] : [],
  } as OcxConfig;
}

describe("audio transcription command", () => {
  test("public access entrypoint returns the audio exit and output", async () => {
    expect(await handleAccessCommand(["audio", ...args()], deps({ fetchImpl: fetcher(() => Response.json({ text: "public" })) }))).toBe(0);
    expect(JSON.parse(output())).toEqual({ text: "public" });
    stdout.mockClear();
    expect(await handleAccessCommand(["audio", ...args()], deps({ fetchImpl: fetcher(() => new Response(null, { status: 401 })) }))).toBe(1);
    expect(output()).toBe("");
  });
  test("header deadline aborts exactly one upload request", async () => {
    let requests = 0, aborted = false;
    const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      return await new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error(KEY)); }, { once: true });
      });
    }) as typeof fetch;
    expect(await handleAccessAudioCommand(args(), deps({ audioHttpTimeoutMs: 10, fetchImpl: transport }))).toBe(1);
    expect(requests).toBe(1); expect(aborted).toBe(true); expect(output() + errors()).not.toContain(KEY);
  });
  test("input timeout and cancellation leave stdin reusable and without listeners", async () => {
    const input = new PassThrough();
    expect(await handleAccessAudioCommand(args(), deps({ stdinImpl: input, stdinTimeoutMs: 10 }))).toBe(1);
    for (const name of ["data", "end", "error"]) expect(input.listenerCount(name)).toBe(0);
    expect(input.destroyed).toBe(false); expect(input.isPaused()).toBe(true);
    input.destroy();
  });
  test.each([
    ["transcribe"], ["transcribe", "x", "--model", "other", "--api-key-stdin"],
    ["live-check", "--model", " ", "--api-key-stdin"],
    ["live-check", "--model", "live", "--api-key-stdin=secret"],
    ["live-check", "--model", "live", "--api-key-stdin", "--api-key-stdin"],
    ["live-check", "--model", "live", "--api-key-stdin", "--json", "--json"],
    ["live-check", "--model", "live", "--model=other", "--api-key-stdin"],
    ["live-check", "--model", "live", "--api-key-stdin", "--base-url", "https://example.invalid"],
  ].map(argv => ({ argv })))("invalid grammar causes no discovery/input/transport", async ({ argv }) => {
    let effects = 0;
    const input = new PassThrough();
    expect(await handleAccessAudioCommand(argv, deps({ stdinImpl: input, findLiveProxy: async () => { effects++; return null; } }))).toBe(2);
    expect(effects).toBe(0); expect(input.listenerCount("data")).toBe(0); expect(output()).toBe("");
    expect(errors()).not.toContain("secret"); input.destroy();
  });
  test.each(["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"])("exact multipart and key redaction for %s", async model => {
    let calls = 0;
    const code = await handleAccessAudioCommand(args(file, model), deps({ fetchImpl: fetcher(async (request, init) => {
      calls++;
      expect(request.url).toBe("http://127.0.0.1:19001/v1/audio/transcriptions");
      expect(request.method).toBe("POST"); expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("error");
      expect(request.headers.get("x-opencodex-api-key")).toBe(KEY);
      expect([...request.headers.keys()].sort()).toEqual(["content-type", "x-opencodex-api-key"]);
      const form = await request.formData();
      expect([...form.keys()]).toEqual(["file", "model", "response_format"]);
      expect(form.get("model")).toBe(model); expect(form.get("response_format")).toBe("json");
      const upload = form.get("file") as File;
      expect(upload.name).toBe("audio.wav"); expect([...new Uint8Array(await upload.arrayBuffer())]).toEqual([82, 73, 70, 70]);
      return Response.json({ text: `hello ${KEY} ${KEY}`, key: KEY, internal: "omit" });
    }) }));
    expect(code).toBe(0); expect(calls).toBe(1);
    expect(JSON.parse(output())).toEqual({ text: "hello [redacted] [redacted]" }); expect(errors()).toBe("");
  });
  test("empty transcript is usable and human output escapes controls", async () => {
    expect(await handleAccessAudioCommand(args(), deps({ fetchImpl: fetcher(() => Response.json({ text: "" })) }))).toBe(0);
    expect(JSON.parse(output())).toEqual({ text: "" }); stdout.mockClear();
    expect(await handleAccessAudioCommand(args().filter(x => x !== "--json"), deps({ fetchImpl: fetcher(() => Response.json({ text: "hi\x1b[31m\n" })) }))).toBe(0);
    expect(output()).toBe("hi\\x1b[31m\\x0a");
  });
  test.each(["", " ", " a", "a ", "a\nb", "a\rb", "a\t", "é", "한", "a".repeat(4097)])("invalid key is refused before data request", async key => {
    let requests = 0, sockets = 0;
    expect(await handleAccessAudioCommand(args(), deps({ fetchImpl: fetcher(() => { requests++; return Response.json({ text: "bad" }); }) }, key))).toBe(2);
    expect(requests).toBe(0); expect(output()).toBe("");
    expect(await handleAccessAudioCommand(["live-check", "--model", "live", "--api-key-stdin"], deps({ audioSocket: () => { sockets++; throw new Error("must not construct"); } }, key))).toBe(2);
    expect(sockets).toBe(0);
  });
  test.each([KEY + "\n", KEY + "\r\n", "! internal ~"])("accepted key retains its exact value", async key => {
    expect(await handleAccessAudioCommand(args(), deps({ fetchImpl: fetcher(request => {
      expect(request.headers.get("x-opencodex-api-key")).toBe(key.replace(/\r?\n$/, ""));
      return Response.json({ text: "ok" });
    }) }, key))).toBe(0);
  });
  test("invalid UTF-8 cannot reach data transport", async () => {
    let calls = 0;
    expect(await handleAccessAudioCommand(args(), deps({ fetchImpl: fetcher(() => { calls++; return Response.json({ text: "" }); }) }, new Uint8Array([0xff])))).toBe(2);
    expect(calls).toBe(0);
  });
  test.each([null, [], { text: null }, { text: 1 }, { error: KEY }].map(body => ({ body })))("malformed successful DTO fails without raw output", async ({ body }) => {
    expect(await handleAccessAudioCommand(args(), deps({ fetchImpl: fetcher(() => Response.json(body)) }))).toBe(1);
    expect(output()).toBe(""); expect(errors()).not.toContain(KEY);
  });
  test.each([401, 403, 429, 500])("HTTP %i cancels error body without disclosure or retry", async status => {
    let calls = 0, canceled = false;
    expect(await handleAccessAudioCommand(args(), deps({ fetchImpl: fetcher(() => {
      calls++; return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(KEY)); }, cancel() { canceled = true; } }), { status });
    }) }))).toBe(1);
    expect(calls).toBe(1); expect(canceled).toBe(true); expect(output()).toBe(""); expect(errors()).not.toContain(KEY);
  });
  test("response byte cap cancels oversized body", async () => {
    let canceled = false;
    expect(await handleAccessAudioCommand(args(), deps({ fetchImpl: fetcher(() => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { canceled = true; },
    }))) }))).toBe(1);
    expect(canceled).toBe(true); expect(output()).toBe("");
  });
  test("response body deadline includes read, not only headers", async () => {
    let canceled = false;
    expect(await handleAccessAudioCommand(args(), deps({ audioHttpTimeoutMs: 20, fetchImpl: fetcher(() => new Response(new ReadableStream({ cancel() { canceled = true; } }))) }))).toBe(1);
    expect(canceled).toBe(true); expect(output()).toBe("");
  });
  test("abort during response consumption cleans listeners and returns 130", async () => {
    const controller = new AbortController(); let canceled = false;
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    expect(await handleAccessAudioCommand(args(), deps({ signal: controller.signal, fetchImpl: fetcher(() => new Response(new ReadableStream({
      pull() { controller.abort(); }, cancel() { canceled = true; },
    }))) }))).toBe(130);
    expect(canceled).toBe(true); expect(output()).toBe(""); expect(errors()).toBe("");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
  test("HTTP redirect never forwards the chosen key", async () => {
    let destinationRequests = 0;
    const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { destinationRequests++; return Response.json({ text: KEY }); } }); servers.push(destination);
    const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(destination.url, 307); } }); servers.push(source);
    expect(await handleAccessAudioCommand(args(), deps({ fetchImpl: originalFetch, findLiveProxy: async () => ({ port: source.port!, hostname: "127.0.0.1", pid: 1, source: "runtime" }) }))).toBe(1);
    expect(destinationRequests).toBe(0); expect(output()).toBe(""); expect(errors()).not.toContain(KEY);
  });
  test.each(["valid", "wrong", "zero"])("real admission plus transcription handler: %s", async scenario => {
    let providerCalls = 0, requests = 0;
    const cfg = config(scenario !== "zero");
    globalThis.fetch = fetcher(async request => {
      providerCalls++;
      expect(request.url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-upstream");
      expect(request.headers.has("x-opencodex-api-key")).toBe(false);
      const body = await request.formData(); expect(body.get("model")).toBe("gpt-4o-transcribe");
      return Response.json({ text: `real handler ${KEY}`, omitted: KEY });
    });
    const code = await handleAccessAudioCommand(args(), deps({ fetchImpl: fetcher(async request => {
      requests++;
      const admission = resolveAudioAdmission(request.headers, cfg);
      if (!admission) return new Response(null, { status: 401 });
      return handleAudioTranscriptions(request, cfg, { model: "unknown", provider: "unknown" } as RequestLogContext, admission);
    }) }, scenario === "wrong" ? "synthetic-wrong" : KEY));
    expect(requests).toBe(1); expect(providerCalls).toBe(scenario === "valid" ? 1 : 0);
    expect(code).toBe(scenario === "valid" ? 0 : 1);
    if (scenario === "valid") expect(JSON.parse(output())).toEqual({ text: "real handler [redacted]" });
    else expect(output()).toBe("");
  });
  test("real live admission round-trips the accepted ASCII carrier", () => {
    const request = new Request("http://localhost/v1/live", { headers: { upgrade: "websocket", "sec-websocket-protocol": `opencodex-audio, opencodex-key.${Buffer.from(KEY).toString("base64url")}` } });
    const result = resolveAudioClient(request, config(), true);
    expect(result).not.toBeInstanceOf(Response);
    expect(result && !(result instanceof Response) ? result.admission.kind : null).toBe("configured");
  });
});

describe("bounded regular audio files", () => {
  test.skipIf(process.platform === "win32")("FIFO input is refused without blocking open", async () => {
    const fifo = join(root, "audio.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    let opens = 0;
    expect(await handleAccessAudioCommand(args(fifo), deps({ audioOpen: async () => { opens++; throw new Error("must not open FIFO"); } }))).toBe(2);
    expect(opens).toBe(0);
  });
  test("file swapped for a non-file after path stat is refused by fstat", async () => {
    expect(await handleAccessAudioCommand(args(), deps({ audioOpen: async () => open(root) }))).toBe(2);
  });
  test("late-open handle is closed after cancellation", async () => {
    const controller = new AbortController(); const handle = await open(file);
    let opened!: () => void, release!: () => void;
    const inOpen = new Promise<void>(r => { opened = r; });
    const delayed = new Promise<void>(r => { release = r; });
    const closed = spyOn(handle, "close");
    const result = handleAccessAudioCommand(args(), deps({ signal: controller.signal, audioOpen: async () => { opened(); await delayed; return handle; } }));
    await inOpen; controller.abort(); expect(await result).toBe(130);
    release(); await delayed; await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toHaveBeenCalledTimes(1); expect(output()).toBe("");
  });
  test.each([0, 25_000_001])("stat size %i fails before key input", async size => {
    truncateSync(file, size); const input = new PassThrough();
    expect(await handleAccessAudioCommand(args(), deps({ stdinImpl: input }))).toBe(2);
    expect(input.listenerCount("data")).toBe(0); expect(output()).toBe(""); input.destroy();
  });
  test("exact 25,000,000 boundary is accepted and filename is reduced", async () => {
    truncateSync(file, 25_000_000);
    const value = await readAudioFile(file, new AbortController().signal);
    expect(value.size).toBe(25_000_000); expect(value.name).toBe("audio.wav");
  });
  test("directory and device are refused", async () => {
    expect(await handleAccessAudioCommand(args(root), deps())).toBe(2);
    // POSIX stats /dev/null as a character device (usage refusal). Windows has no /dev; its NUL
    // device may not stat at all, which is a read failure. Either way nothing is read or sent.
    let requests = 0;
    const device = process.platform === "win32" ? "NUL" : "/dev/null";
    const code = await handleAccessAudioCommand(args(device), deps({ fetchImpl: fetcher(() => { requests++; return Response.json({ text: "" }); }) }));
    if (process.platform === "win32") expect([1, 2]).toContain(code);
    else expect(code).toBe(2);
    expect(requests).toBe(0);
  });
  test("growing file is bounded by actual reads, not the stale stat", async () => {
    expect(await handleAccessAudioCommand(args(), deps({ audioOpen: async (path, flags) => {
      const handle = await open(path, flags);
      const originalStat = handle.stat.bind(handle);
      handle.stat = (async () => {
        const before = await originalStat(); truncateSync(file, 25_000_001); return before;
      }) as typeof handle.stat;
      return handle;
    } }))).toBe(2);
  });
  test("late-open handle is closed after timeout and cannot read a key", async () => {
    const handle = await open(file); let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const closed = spyOn(handle, "close"); const input = new PassThrough();
    expect(await handleAccessAudioCommand(args(), deps({ stdinImpl: input, audioFileTimeoutMs: 10, audioOpen: async () => { await delayed; return handle; } }))).toBe(1);
    release(); await delayed; await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toHaveBeenCalledTimes(1); expect(input.listenerCount("data")).toBe(0); input.destroy();
  });
  test("abort during stat stops the operation before open/key work", async () => {
    const controller = new AbortController(); let opens = 0;
    expect(await handleAccessAudioCommand(args(), deps({ signal: controller.signal, audioStat: (async path => { controller.abort(); return stat(path); }) as typeof stat, audioOpen: async () => { opens++; return open(file); } }))).toBe(130);
    expect(opens).toBe(0); expect(output()).toBe(""); expect(errors()).toBe("");
  });
});

test("nonsettling response cancellation cannot retain a transcription after abort", async () => {
  const controller = new AbortController();
  const keyBytes = Buffer.from(KEY);
  const input = Readable.from([keyBytes]);
  const pause = spyOn(input, "pause");
  const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let entered!: () => void, release!: () => void;
  const atCancel = new Promise<void>(resolve => { entered = resolve; });
  const cancellation = new Promise<void>(resolve => { release = resolve; });
  let cancelCalls = 0;
  const operation = handleAccessAudioCommand(args(), deps({
    signal: controller.signal, stdinImpl: input, audioHttpTimeoutMs: 5,
    fetchImpl: fetcher(() => new Response(new ReadableStream({
      cancel() { cancelCalls++; entered(); return cancellation; },
    }), { status: 401 })),
  }));
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await atCancel;
    controller.abort();
    const outcome = await Promise.race([operation, new Promise<"pending">(resolve => { watchdog = setTimeout(() => resolve("pending"), 50); })]);
    expect(outcome).toBe(130);
    expect(cancelCalls).toBe(1);
    expect(pause).toHaveBeenCalled();
    for (const event of ["data", "end", "error"]) expect(input.listenerCount(event)).toBe(0);
    expect(keyBytes.every(byte => byte === 0)).toBe(true);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
    expect(output()).toBe(""); expect(errors()).toBe("");
  } finally {
    clearTimeout(watchdog); release(); await operation; pause.mockRestore();
  }
});
