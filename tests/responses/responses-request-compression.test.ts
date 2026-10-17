import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { gunzipSync, gzipSync, zstdDecompressSync } from "node:zlib";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { applyProxyEnvWith } from "../../src/config/proxy-env";
import { setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import { OutboundCredentialRegistry, setOutboundCredentialRegistryForTests } from "../../src/lib/outbound-credential-registry";
import { registerUpstreamRewriter, resetUpstreamRewritersForTests } from "../../src/plugins/upstream-hooks";
import { providerFetch, sendWithConnectionPolicy } from "../../src/server/responses/fetch-helpers";
import {
  bindUpstreamRequestCompressionConfig,
  compressUpstreamRequestBody,
  currentUpstreamRequestCompression,
  resolveUpstreamRequestCompression,
  setUpstreamRequestCompressionForTests,
} from "../../src/server/responses/request-compression";
import type { OcxConfig } from "../../src/types";

const endpoint = "https://chatgpt.com/backend-api/codex/responses";
type Mode = "off" | "gzip" | "zstd";

function bind(mode: Mode | undefined): { upstreamRequestCompression?: Mode } {
  const config = mode === undefined ? {} : { upstreamRequestCompression: mode };
  bindUpstreamRequestCompressionConfig(config);
  return config;
}

function captureFetch() {
  const calls: { input: Parameters<typeof fetch>[0]; init?: RequestInit }[] = [];
  const execute = (async (input, init) => {
    calls.push({ input, init });
    return new Response("ok");
  }) as typeof fetch;
  return { calls, execute };
}

function sentHeaders(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

function decode(encoding: string | null, body: unknown): string {
  const bytes = Buffer.from(body as Uint8Array);
  if (encoding === "gzip") return gunzipSync(bytes).toString("utf8");
  if (encoding === "zstd") return zstdDecompressSync(bytes).toString("utf8");
  throw new Error(`unexpected encoding ${encoding}`);
}

const json = (chars: number) => JSON.stringify({ input: "a".repeat(chars) });

afterEach(() => {
  bindUpstreamRequestCompressionConfig(null);
  setUpstreamRequestCompressionForTests({ compressor: null, maxBodyBytes: null });
  resetUpstreamRewritersForTests();
});

describe("upstreamRequestCompression config", () => {
  test("only an explicit codec enables it; a malformed hand edit parses to identity", () => {
    expect(resolveUpstreamRequestCompression(undefined)).toBe("off");
    expect(resolveUpstreamRequestCompression("brotli")).toBe("off");
    expect(resolveUpstreamRequestCompression("zstd")).toBe("zstd");
    const field = configSchema.shape.upstreamRequestCompression;
    expect(field.parse("brotli")).toBeUndefined();
    expect(field.parse(7)).toBeUndefined();
    expect(field.parse("gzip")).toBe("gzip");
    expect(field.parse(undefined)).toBeUndefined();
  });

  test("live writes and imports refuse an unknown codec instead of silently dropping it", () => {
    for (const value of ["off", "gzip", "zstd", undefined]) {
      expect(validateConfigCandidate({ ...getDefaultConfig(), upstreamRequestCompression: value as never }).ok).toBe(true);
    }
    for (const value of ["brotli", "GZIP", 1, null, true]) {
      const result = validateConfigCandidate({ ...getDefaultConfig(), upstreamRequestCompression: value as never });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("upstreamRequestCompression");
    }
  });

  test("the running server's config object is installed at startup and read per send", async () => {
    const config = { providers: {} } as unknown as OcxConfig;
    setLiveStateStoreConfig(config);
    const capture = captureFetch();
    const body = json(4096);

    await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body });
    expect(capture.calls[0]!.init?.body).toBe(body);

    // Live reconciliation mutates this same object; no rebinding happens or is needed.
    config.upstreamRequestCompression = "zstd";
    // A detached config (catalog sync calls applyProxyEnv with one) must not take the binding over.
    applyProxyEnvWith({ upstreamRequestCompression: "off", providers: {} } as unknown as OcxConfig);
    await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body });
    expect(sentHeaders(capture.calls[1]!.init).get("content-encoding")).toBe("zstd");
    expect(decode("zstd", capture.calls[1]!.init?.body)).toBe(body);
    expect(currentUpstreamRequestCompression()).toBe("zstd");
  });
});

describe("final HTTP send compression", () => {
  test("off or omitted sends exactly what it sent before, including the large-body UTF-8 buffer", async () => {
    for (const mode of [undefined, "off"] as const) {
      bind(mode);
      const capture = captureFetch();
      const small = json(4096);
      const large = JSON.stringify({ input: "é".repeat(600_000) });
      await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body: small });
      await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body: large });
      expect(capture.calls[0]!.init?.body).toBe(small);
      expect(sentHeaders(capture.calls[0]!.init).has("content-encoding")).toBe(false);
      const sentLarge = capture.calls[1]!.init?.body;
      expect(Buffer.isBuffer(sentLarge)).toBe(true);
      expect((sentLarge as Buffer).equals(Buffer.from(large, "utf8"))).toBe(true);
    }
  });

  for (const mode of ["gzip", "zstd"] as const) {
    test(`${mode} codes responses and compact bodies without touching the caller's init`, async () => {
      bind(mode);
      const capture = captureFetch();
      const body = JSON.stringify({ input: "é🦊 history ".repeat(2000) });
      const headers = { "content-type": "application/json", "content-length": "999", authorization: "Bearer test-token" };
      const headersBefore = structuredClone(headers);
      const signal = new AbortController().signal;
      const init: RequestInit = { method: "POST", body, headers, signal };

      await sendWithConnectionPolicy(capture.execute, endpoint, init);
      await sendWithConnectionPolicy(capture.execute, `${endpoint}/compact`, init);

      for (const call of capture.calls) {
        const sent = sentHeaders(call.init);
        expect(sent.get("content-encoding")).toBe(mode);
        expect(sent.has("content-length")).toBe(false);
        expect(sent.get("authorization")).toBe("Bearer test-token");
        expect(sent.get("content-type")).toBe("application/json");
        expect(call.init?.signal).toBe(signal);
        expect(decode(mode, call.init?.body)).toBe(body);
      }
      expect(init.body).toBe(body);
      expect(init.headers).toBe(headers);
      expect(headers).toEqual(headersBefore);
    });
  }

  test("the 1 KiB threshold counts UTF-8 bytes, not code units", async () => {
    bind("gzip");
    const capture = captureFetch();
    // "é" is two UTF-8 bytes: 510 of them plus the 4-byte wrapper is 1024 bytes in 514 code units.
    const atThreshold = `["${"é".repeat(510)}"]`;
    const belowThreshold = `["${"é".repeat(509)}a"]`;
    expect(Buffer.byteLength(atThreshold, "utf8")).toBe(1024);
    expect(Buffer.byteLength(belowThreshold, "utf8")).toBe(1023);
    await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body: atThreshold });
    await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body: belowThreshold });
    expect(sentHeaders(capture.calls[0]!.init).get("content-encoding")).toBe("gzip");
    expect(capture.calls[1]!.init?.body).toBe(belowThreshold);
  });

  test("ineligible sends keep their representation", async () => {
    bind("zstd");
    const capture = captureFetch();
    const body = json(4096);
    const bytes = new TextEncoder().encode(body);
    await sendWithConnectionPolicy(capture.execute, "https://api.openai.com/v1/responses", { method: "POST", body });
    await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body, headers: { "content-encoding": "gzip" } });
    await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body: bytes });
    setUpstreamRequestCompressionForTests({ maxBodyBytes: 2048 });
    await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body });

    expect(capture.calls[0]!.init?.body).toBe(body);
    expect(sentHeaders(capture.calls[0]!.init).has("content-encoding")).toBe(false);
    expect(capture.calls[1]!.init?.body).toBe(body);
    expect(sentHeaders(capture.calls[1]!.init).get("content-encoding")).toBe("gzip");
    expect(capture.calls[2]!.init?.body).toBe(bytes);
    expect(capture.calls[3]!.init?.body).toBe(body);
    expect(sentHeaders(capture.calls[3]!.init).has("content-encoding")).toBe(false);
  });

  test("a Request input with its own coding or body is left alone", async () => {
    bind("gzip");
    const capture = captureFetch();
    const body = json(4096);
    const coded = new Request(endpoint, { method: "POST", headers: { "content-encoding": "zstd" } });
    await sendWithConnectionPolicy(capture.execute, coded, { method: "POST", body });
    const owned = new Request(endpoint, { method: "POST", body });
    await sendWithConnectionPolicy(capture.execute, owned);
    expect(capture.calls[0]!.init?.body).toBe(body);
    expect(sentHeaders(capture.calls[0]!.init).get("content-encoding")).toBe("zstd");
    expect(capture.calls[1]!.init?.body).toBeUndefined();
    expect(sentHeaders(capture.calls[1]!.init).has("content-encoding")).toBe(false);
  });

  test("a nested pass and a rebuild compress once, receipt first, and only toward the canonical destination", async () => {
    bind("gzip");
    let compressions = 0;
    setUpstreamRequestCompressionForTests({ compressor: (_mode, bytes) => { compressions++; return gzipSync(bytes) as Buffer<ArrayBuffer>; } });
    const events: string[] = [];
    const capture = captureFetch();
    const recording = (async (input, init) => { events.push("executor"); return capture.execute(input, init); }) as typeof fetch;
    // Barely compressible, so the coded output stays above the threshold and a second pass would code it again.
    const body = JSON.stringify({ input: randomBytes(8192).toString("hex") });
    const toCanonical = providerFetch({ adapter: "openai-responses", baseUrl: "https://gateway.example/v1", fetch: recording }, undefined, {
      httpOnly: true,
      onPhysicalDispatch: () => events.push("receipt"),
      // Hands the send back through the boundary a second time, as a credential-revalidating override does.
      dispatchOverride: (_input, init, execute) => sendWithConnectionPolicy(execute, new URL(`${endpoint}/compact`), init),
    });
    await toCanonical("https://gateway.example/v1/responses", { method: "POST", body });
    expect(compressions).toBe(1);
    expect(events).toEqual(["receipt", "executor"]);
    const awayFromCanonical = providerFetch({ adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", fetch: capture.execute }, undefined, {
      httpOnly: true,
      dispatchOverride: (_input, init, execute) => execute("https://gateway.example/v1/responses", init),
    });
    await awayFromCanonical(endpoint, { method: "POST", body });
    expect(compressions).toBe(1);

    expect(capture.calls).toHaveLength(2);
    expect(sentHeaders(capture.calls[0]!.init).get("content-encoding")).toBe("gzip");
    expect(decode("gzip", capture.calls[0]!.init?.body)).toBe(body);
    expect(capture.calls[1]!.init?.body).toBe(body);
    expect(sentHeaders(capture.calls[1]!.init).has("content-encoding")).toBe(false);
  });

  test("a plugin rewrite away from chatgpt.com sends identity", async () => {
    bind("zstd");
    const capture = captureFetch();
    const body = json(4096);
    registerUpstreamRewriter("relay", target => { target.url = target.url.replace("https://chatgpt.com", "https://relay.example.net"); });
    await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body });
    resetUpstreamRewritersForTests();
    registerUpstreamRewriter("sidecar", target => { target.url = target.url.replace("https://chatgpt.com", "http://127.0.0.1:8787"); });
    await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body });
    for (const call of capture.calls) {
      expect(call.init?.body).toBe(body);
      expect(sentHeaders(call.init).has("content-encoding")).toBe(false);
    }
  });

  test("every retry derives its own coded bytes from the original string", async () => {
    bind("zstd");
    const capture = captureFetch();
    const body = json(4096);
    const init: RequestInit = { method: "POST", body };
    await sendWithConnectionPolicy(capture.execute, endpoint, init);
    await sendWithConnectionPolicy(capture.execute, endpoint, init);
    expect(capture.calls).toHaveLength(2);
    expect(capture.calls[0]!.init?.body).not.toBe(capture.calls[1]!.init?.body);
    for (const call of capture.calls) expect(decode("zstd", call.init?.body)).toBe(body);
  });

  test("a codec failure falls back to the identity send, silently, keeping the large-body buffer", async () => {
    bind("gzip");
    let attempts = 0;
    setUpstreamRequestCompressionForTests({ compressor: () => { attempts++; throw new Error("codec exploded"); } });
    const errors = spyOn(console, "error");
    const warnings = spyOn(console, "warn");
    try {
      const capture = captureFetch();
      const body = JSON.stringify({ input: "x".repeat(1024 * 1024) });
      await sendWithConnectionPolicy(capture.execute, endpoint, { method: "POST", body });
      expect(capture.calls).toHaveLength(1);
      expect(sentHeaders(capture.calls[0]!.init).has("content-encoding")).toBe(false);
      expect(attempts).toBe(1);
      const sent = capture.calls[0]!.init?.body;
      expect(Buffer.isBuffer(sent)).toBe(true);
      expect((sent as Buffer).equals(Buffer.from(body, "utf8"))).toBe(true);
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });

  test("the final coded headers still reach the outbound credential registry", async () => {
    bind("gzip");
    const remembered: Headers[] = [];
    class Capturing extends OutboundCredentialRegistry {
      override remember(headers: Headers): void {
        remembered.push(new Headers(headers));
        super.remember(headers);
      }
    }
    const restore = setOutboundCredentialRegistryForTests(new Capturing());
    try {
      const capture = captureFetch();
      await sendWithConnectionPolicy(capture.execute, endpoint, {
        method: "POST", body: json(4096), headers: { authorization: "Bearer test-token" },
      });
      expect(remembered).toHaveLength(1);
      expect(remembered[0]!.get("content-encoding")).toBe("gzip");
      expect(remembered[0]!.get("authorization")).toBe("Bearer test-token");
    } finally {
      restore();
    }
  });

  test("compressUpstreamRequestBody reports nothing for off", () => {
    expect(compressUpstreamRequestBody(endpoint, json(4096), new Headers(), "off")).toBeNull();
  });
});
