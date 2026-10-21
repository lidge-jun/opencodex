import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { createServeOptions, type ServeOptionsContext } from "../../src/server/index/serve-options";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { setRelayPlatformForTests } from "../../src/server/responses/passthrough-delivery";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import { cacheDiagnosticPath } from "../../src/usage/cache-diagnostic";
import { readUsageEntries } from "../../src/usage/log";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const ENV = [...PROXY_ENV, "OPENCODEX_HOME", "OPENCODEX_CACHE_DEBUG"];
const realFetch = globalThis.fetch;
const realWebSocket = globalThis.WebSocket;
const encoder = new TextEncoder();
const outputText = "HTTP fixture 中文😀 output";
let saved: Record<string, string | undefined>;
let home: string;
let release: () => void;
let upstreamResponse: () => Response;
let upstreamSends: number;
let outbound: Record<string, unknown>;

// Linux auto and the explicit tee pin exercise the HTTP tee path; the narrow platform
// seam reaches the real Darwin eager opt-in without changing process.platform or storage.
const paths = [
  { name: "auto HTTP", mode: "auto", platform: "linux" },
  { name: "legacy-tee HTTP", mode: "legacy-tee", platform: "linux" },
  { name: "eager-relay HTTP", mode: "eager-relay", platform: "darwin" },
] as const;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
  for (const name of PROXY_ENV) delete process.env[name];
  home = mkdtempSync(join(tmpdir(), "cache-telemetry-http-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_CACHE_DEBUG = "1";
  upstreamSends = 0;
  outbound = {};
  upstreamResponse = () => { throw new Error("HTTP fixture was not configured"); };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    // No original fetch fallback exists: unexpected URLs fail before any network I/O.
    expect(url).toBe("https://cache-http-fixture.invalid/v1/responses");
    expect(init?.method).toBe("POST");
    outbound = JSON.parse(String(init?.body));
    upstreamSends++;
    return upstreamResponse();
  }) as typeof fetch;
  globalThis.WebSocket = class {
    constructor() { throw new Error("HTTP fixture must not open an upstream WebSocket"); }
  } as unknown as typeof WebSocket;
  clearRequestLogsForTests();
  release = acquireOwnedSpendHome();
});

afterEach(() => {
  release();
  globalThis.fetch = realFetch;
  globalThis.WebSocket = realWebSocket;
  setRelayPlatformForTests(undefined);
  clearRequestLogsForTests();
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  removeTreeWithRetry(home);
});

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("HTTP cache fixture did not settle within 2s")), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function finalLog() {
  const deadline = Date.now() + 2_000;
  while (getRequestLogEntries().length === 0 && Date.now() < deadline) await Bun.sleep(2);
  expect(upstreamSends).toBe(1);
  expect(getRequestLogEntries()).toHaveLength(1);
  expect(readUsageEntries()).toHaveLength(1);
  return getRequestLogEntries()[0]!;
}

async function entry(path: typeof paths[number], stream = true): Promise<Response> {
  setRelayPlatformForTests(path.platform);
  const config = { port: 0, bind: "127.0.0.1", defaultProvider: "http-fixture", streamMode: path.mode,
    providers: { "http-fixture": { adapter: "openai-responses", baseUrl: "https://cache-http-fixture.invalid/v1",
      apiKey: "fixture-not-a-real-key", authMode: "key" } },
  } as OcxConfig;
  const context = {
    config, deps: {}, ingressForServer: () => "public", packageTreeIntegrity: { status: () => ({ ok: true }) },
    runAdmittedHttpTurn: async (_req: Request, _policy: unknown,
      work: (lease: NonNullable<ReturnType<typeof tryAdmitTurn>>) => Promise<Response>) => {
      const lease = tryAdmitTurn();
      if (!lease) throw new Error("HTTP fixture turn admission refused");
      try { return await work(lease); } finally { lease.release(); }
    },
  } as unknown as ServeOptionsContext;
  const response = await bounded(createServeOptions(context).fetch(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "session-id": "fixture-private-session" },
    body: JSON.stringify({ model: "http-fixture/cache-fixture-model", input: "fixture-private-prompt", stream }),
  }), { timeout() {}, requestIP: () => ({ address: "127.0.0.1" }) } as never));
  expect(response.status).toBe(200);
  expect(outbound.stream).toBe(stream);
  return response;
}

function usage(cached?: number) {
  return { input_tokens: 100, output_tokens: 5,
    ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached } }) };
}

function terminal(rawUsage?: unknown) {
  return { id: "resp_http_fixture", object: "response", status: "completed", model: "cache-fixture-model",
    output: [{ id: "msg_http_fixture", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: outputText, annotations: [] }] }],
    ...(rawUsage === undefined ? {} : { usage: rawUsage }) };
}

function event(payload: unknown, multiline = false): string {
  const json = JSON.stringify(payload, null, multiline ? 2 : undefined);
  return `event: ${(payload as { type: string }).type}\r\n`
    + json.split("\n").map(line => `data: ${line}\r\n`).join("") + "\r\n";
}

function completed(rawUsage?: unknown, multiline = false): string {
  return event({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: outputText })
    + event({ type: "response.completed", response: terminal(rawUsage) }, multiline);
}

function fragmented(text: string): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  // Every byte of the first non-ASCII character is split, including the UTF-8 sequence.
  const unicode = bytes.findIndex(byte => byte >= 0x80);
  const cuts = [...new Set([0, unicode, unicode + 1, unicode + 2, unicode + 3,
    ...Array.from({ length: Math.ceil(bytes.length / 37) }, (_, index) => index * 37), bytes.length])]
    .filter(index => index >= 0 && index <= bytes.length).sort((a, b) => a - b);
  let index = 0;
  return new ReadableStream({ pull(controller) {
    if (index === cuts.length - 1) { controller.close(); return; }
    controller.enqueue(bytes.subarray(cuts[index]!, cuts[++index]!));
  } }, { highWaterMark: 0 });
}

function sse(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function assertEvidence(cached: number | undefined, usagePresent = true) {
  const row = getRequestLogEntries()[0]!;
  const persisted = readUsageEntries()[0]!;
  const provenance = cached === undefined ? "unknown" : "observed";
  expect(row.cacheProvenance).toBe(provenance);
  expect(persisted.cacheProvenance).toBe(provenance);
  expect(persisted.attempts).toHaveLength(1);
  expect(persisted.attempts![0]!.cacheProvenance).toBe(provenance);
  if (usagePresent) {
    for (const value of [row.usage, persisted.usage, persisted.attempts![0]!.usage]) {
      expect(value?.cacheTelemetry).toEqual({ source: "upstream", usagePresent: true,
        ...(cached === undefined ? {} : { read: cached }) });
    }
  } else {
    for (const value of [row.usage, persisted.usage, persisted.attempts![0]!.usage]) {
      expect(value?.cachedInputTokens).toBeUndefined();
      expect(value?.cacheReadInputTokens).toBeUndefined();
      if (value?.cacheTelemetry) expect(value.cacheTelemetry).toEqual({ source: "upstream", usagePresent: false });
    }
  }
  const debug = readFileSync(cacheDiagnosticPath(), "utf8");
  const diagnostic = JSON.parse(debug.trim().split("\n").at(-1)!);
  expect(diagnostic.cache.rawUpstream).toEqual({ observed: true, usagePresent, present: cached !== undefined,
    ...(cached === undefined ? {} : { value: cached }) });
  for (const privateValue of ["fixture-private-prompt", "fixture-private-session", "fixture-not-a-real-key", outputText]) {
    expect(debug).not.toContain(privateValue);
  }
}

describe("cache telemetry through actual upstream HTTP delivery", () => {
  for (const path of paths) {
    for (const cached of [0, undefined, 40]) {
      test(`${path.name}: fragmented multiline SSE retains ${cached ?? "missing"} raw cache evidence`, async () => {
        upstreamResponse = () => sse(fragmented(completed(usage(cached), true)));
        const client = await bounded((await entry(path)).text());
        expect(client).toContain(outputText);
        expect(client).toContain("response.completed");
        expect(client).not.toContain("cacheTelemetry");
        await finalLog();
        assertEvidence(cached);
      });

      test(`${path.name}: nonstream JSON retains ${cached ?? "missing"} raw cache evidence`, async () => {
        upstreamResponse = () => Response.json(terminal(usage(cached)));
        const client = await bounded((await entry(path, false)).text());
        expect(JSON.parse(client).output[0].content[0].text).toBe(outputText);
        expect(client).not.toContain("cacheTelemetry");
        await finalLog();
        assertEvidence(cached);
      });
    }

    test(`${path.name}: terminal without usage is an observed absence, not a measured zero`, async () => {
      upstreamResponse = () => sse(fragmented(completed()));
      const client = await bounded((await entry(path)).text());
      expect(client).not.toContain("cacheTelemetry");
      await finalLog();
      assertEvidence(undefined, false);
    });

    test(`${path.name}: a final absent usage clears an earlier frame's cache counter`, async () => {
      upstreamResponse = () => sse(fragmented(event({ type: "response.created", response: {
        id: "resp_http_fixture", status: "in_progress", output: [], usage: usage(40),
      } }) + completed()));
      expect(await bounded((await entry(path)).text())).not.toContain("cacheTelemetry");
      await finalLog();
      assertEvidence(undefined, false);
    });

    test(`${path.name}: slow client keeps the same upstream evidence`, async () => {
      upstreamResponse = () => sse(fragmented(completed(usage(0), true)));
      const reader = (await entry(path)).body!.getReader();
      // Let inspection finish while the client has not read even its first byte.
      await finalLog();
      assertEvidence(0);
      const client = await bounded((async () => {
        const decoder = new TextDecoder();
        let text = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return text + decoder.decode();
          text += decoder.decode(chunk.value, { stream: true });
          await Bun.sleep(2);
        }
      })());
      expect(client).toContain(outputText);
      expect(client).not.toContain("cacheTelemetry");
      await finalLog();
      assertEvidence(0);
    });

    test(`${path.name}: midstream error does not invent a raw usage observation`, async () => {
      let pulls = 0;
      upstreamResponse = () => sse(new ReadableStream({ pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode(event({ type: "response.output_text.delta", delta: outputText })));
        else controller.error(new Error("fixture upstream reset"));
      } }, { highWaterMark: 0 }));
      const client = await bounded((await entry(path)).text());
      expect(client).toContain("response.failed");
      expect(client).not.toContain("cacheTelemetry");
      const row = await finalLog();
      expect(row.cacheProvenance).toBe("unknown");
      expect(row.terminalStatus).toBe("failed");
      expect(readUsageEntries()[0]!.attempts?.[0]?.cacheProvenance).toBe("unknown");
      const raw = JSON.parse(readFileSync(cacheDiagnosticPath(), "utf8").trim()).cache.rawUpstream;
      expect(raw).toEqual({ observed: false, present: false });
    });

    test(`${path.name}: a real terminal received after client cancellation retains upstream zero`, async () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      upstreamResponse = () => sse(new ReadableStream({ start(value) {
        controller = value;
        controller.enqueue(encoder.encode(event({ type: "response.output_text.delta", delta: outputText })));
      } }, { highWaterMark: 0 }));
      const reader = (await entry(path)).body!.getReader();
      expect((await bounded(reader.read())).done).toBe(false);
      expect(getRequestLogEntries()).toHaveLength(0);
      await bounded(reader.cancel("fixture client closed"));
      controller.enqueue(encoder.encode(event({ type: "response.completed", response: terminal(usage(0)) })));
      controller.close();
      const row = await finalLog();
      expect(row.terminalStatus).toBe("completed");
      assertEvidence(0);
    });

    test(`${path.name}: cancelled client without a later terminal stays unknown`, async () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      upstreamResponse = () => sse(new ReadableStream({ start(value) {
        controller = value;
        controller.enqueue(encoder.encode(event({ type: "response.output_text.delta", delta: outputText })));
      } }, { highWaterMark: 0 }));
      const reader = (await entry(path)).body!.getReader();
      expect((await bounded(reader.read())).done).toBe(false);
      await bounded(reader.cancel("fixture client closed"));
      controller.close(); // Settle the drain without waiting for the production 15s deadline.
      const row = await finalLog();
      expect(row.closeReason).toBe("client_cancel");
      expect(row.cacheProvenance).toBe("unknown");
      expect(readUsageEntries()[0]!.attempts?.[0]?.cacheProvenance).toBe("unknown");
      const raw = JSON.parse(readFileSync(cacheDiagnosticPath(), "utf8").trim()).cache.rawUpstream;
      expect(raw).toEqual({ observed: false, present: false });
    });
  }
});
