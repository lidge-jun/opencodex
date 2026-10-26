import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../../../src/adapters/google";
import { vertexReplayModelKey } from "../../../src/adapters/google-vertex-endpoint";
import {
  __resetVertexApiKeyProjectCache,
  parseVertexProbeProjectNumber,
  resolveVertexApiKeyProject,
  VERTEX_PROBE_MAX_BYTES,
} from "../../../src/adapters/google-vertex-key-project";
import { markEgressTransparentExecutor } from "../../../src/lib/provider-egress";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import type { IncomingMeta } from "../../../src/adapters/base";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const PROBE = "https://aiplatform.googleapis.com/v1/publishers/google/models/ocx-project-probe:countTokens";
const notFound = (project: string) => JSON.stringify({
  error: {
    code: 404,
    message: `Publisher model \`projects/${project}/locations/asia-southeast1/publishers/google/models/ocx-project-probe\` was not found or your project does not have access to it.`,
    status: "NOT_FOUND",
  },
});

const realFetch = globalThis.fetch;
let probes: Array<{ url: string; key: string | null; redirect?: RequestRedirect; proxy?: string | false }> = [];
let projectByKey: Record<string, string> = {};
let probeStatus = 404;

beforeEach(() => {
  __resetVertexApiKeyProjectCache();
  probes = [];
  probeStatus = 404;
  projectByKey = { "key-a": "111111111111", "key-b": "222222222222" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const key = new Headers(init?.headers).get("x-goog-api-key");
    const proxy = (init as (RequestInit & { proxy?: string | false }) | undefined)?.proxy;
    probes.push({ url, key, redirect: init?.redirect, ...(proxy !== undefined ? { proxy } : {}) });
    if (url !== PROBE) return new Response("unexpected", { status: 500 });
    const project = key ? projectByKey[key] : undefined;
    return new Response(project && probeStatus === 404 ? notFound(project) : "denied", { status: probeStatus });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetVertexApiKeyProjectCache();
});

function parsed(modelId = "gemini-4-argon"): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    context: { messages: [{ role: "user", content: "hi" }], systemPrompt: [], tools: [] },
    options: {},
  } as unknown as OcxParsedRequest;
}

function incoming(overrides: Partial<IncomingMeta> = {}): IncomingMeta {
  return {
    headers: new Headers(),
    translatorBudget: createTranslatorBudget(),
    ...overrides,
  };
}

const vertex = (apiKey: string, extra: Partial<OcxProviderConfig> = {}) => ({
  adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", apiKey, project: "auto", ...extra,
}) as OcxProviderConfig;

describe("vertex project auto", () => {
  test("parses the project number from Google's projectless NOT_FOUND body", () => {
    expect(parseVertexProbeProjectNumber(notFound("22932377871"))).toBe("22932377871");
    expect(parseVertexProbeProjectNumber("projects/my-project/locations/global")).toBeUndefined();
    expect(parseVertexProbeProjectNumber("no project here")).toBeUndefined();
  });

  test("each key in a pool reaches its own project on the global endpoint", async () => {
    const a = await createGoogleAdapter(vertex("key-a")).buildRequest(parsed(), incoming());
    const b = await createGoogleAdapter(vertex("key-b")).buildRequest(parsed(), incoming());
    expect(a.url).toBe("https://aiplatform.googleapis.com/v1/projects/111111111111/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
    expect(b.url).toBe("https://aiplatform.googleapis.com/v1/projects/222222222222/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
    expect(a.headers["x-goog-api-key"]).toBe("key-a");
    expect(b.headers["x-goog-api-key"]).toBe("key-b");
    expect(probes).toEqual([
      { url: PROBE, key: "key-a", redirect: "manual" },
      { url: PROBE, key: "key-b", redirect: "manual" },
    ]);
  });

  test("honors an explicit regional location", async () => {
    const req = await createGoogleAdapter(vertex("key-a", { location: "us" }))
      .buildRequest({ ...parsed(), stream: false } as OcxParsedRequest, incoming());
    expect(req.url).toBe("https://us-aiplatform.googleapis.com/v1/projects/111111111111/locations/us/publishers/google/models/gemini-4-argon:generateContent");
  });

  test("probes once per key, including concurrent first requests", async () => {
    await Promise.all([resolveVertexApiKeyProject("key-a"), resolveVertexApiKeyProject("key-a")]);
    await resolveVertexApiKeyProject("key-a");
    expect(probes.length).toBe(1);
  });

  for (const status of [401, 403, 429, 503]) {
    test(`a ${status} probe sends that request to express without caching`, async () => {
      probeStatus = status;
      const fallback = await createGoogleAdapter(vertex("key-a")).buildRequest(parsed(), incoming());
      expect(fallback.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
      expect(fallback.headers["x-goog-api-key"]).toBe("key-a");
      probeStatus = 404;
      const req = await createGoogleAdapter(vertex("key-a")).buildRequest(parsed(), incoming());
      expect(req.url).toContain("/projects/111111111111/locations/global/");
      expect(probes.length).toBe(2);
    });
  }

  test("a network failure during the probe also falls back to express", async () => {
    globalThis.fetch = (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    const req = await createGoogleAdapter(vertex("key-a")).buildRequest(parsed(), incoming());
    expect(req.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
  });

  test("rejects an oversized continuously-producing 404 body and cancels the stream", async () => {
    let streamCancelled = false;
    let chunksProduced = 0;
    const prefix = new TextEncoder().encode(notFound("111111111111"));
    const chunk = new Uint8Array(1024).fill(0x61);
    const infinite404 = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksProduced++;
        controller.enqueue(chunksProduced === 1 ? prefix : chunk);
      },
      cancel() {
        streamCancelled = true;
      },
    }), { status: 404 })) as unknown as typeof fetch;

    const project = await resolveVertexApiKeyProject("key-oversized", { fetch: infinite404 });
    expect(project).toBeUndefined();
    expect(streamCancelled).toBe(true);
    expect(chunksProduced * 1024).toBeGreaterThan(VERTEX_PROBE_MAX_BYTES);
    expect(chunksProduced).toBeLessThan(16);
  });

  test("rejects a stalled 404 body after the bounded-body deadline without caching", async () => {
    let streamCancelled = false;
    const prefix = new TextEncoder().encode(notFound("111111111111").slice(0, 80));
    const stalled404 = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix);
      },
      cancel() {
        streamCancelled = true;
      },
    }), { status: 404 })) as unknown as typeof fetch;

    const project = await resolveVertexApiKeyProject("key-stalled", { fetch: stalled404, timeoutMs: 40 });
    expect(project).toBeUndefined();
    expect(streamCancelled).toBe(true);
    // Subsequent call with a healthy probe still resolves (stalled attempt was not cached).
    const recovered = await resolveVertexApiKeyProject("key-a");
    expect(recovered).toBe("111111111111");
  });

  test("rejects a 404 body with invalid UTF-8 even if it contains a project pattern", async () => {
    const validAscii = new TextEncoder().encode(notFound("111111111111"));
    const corrupted = new Uint8Array(validAscii.byteLength + 2);
    corrupted.set(validAscii, 0);
    corrupted[validAscii.byteLength] = 0xff;
    corrupted[validAscii.byteLength + 1] = 0xfe;
    const badUtf8Fetch = (async () => new Response(corrupted, { status: 404 })) as unknown as typeof fetch;

    const project = await resolveVertexApiKeyProject("key-bad-utf8", { fetch: badUtf8Fetch });
    expect(project).toBeUndefined();
  });

  test("uses provider egress without consuming IncomingMeta.providerFetch admission hooks", async () => {
    let admissionHookCalls = 0;
    const admissionBoundFetch = (async () => {
      admissionHookCalls++;
      return new Response(notFound("444444444444"), { status: 404 });
    }) as unknown as typeof fetch;

    const viaProvider = await createGoogleAdapter(vertex("key-a"))
      .buildRequest(parsed(), incoming({ providerFetch: admissionBoundFetch }));
    expect(viaProvider.url).toContain("/projects/111111111111/locations/global/");
    expect(admissionHookCalls).toBe(0);
    expect(probes).toHaveLength(1);

    // When IncomingMeta omits providerFetch, the adapter synthesizes the provider's configured proxy route.
    let capturedProxy: string | false | undefined;
    const proxyAwareBase = markEgressTransparentExecutor((async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedProxy = (init as (RequestInit & { proxy?: string | false }) | undefined)?.proxy;
      return new Response(notFound("555555555555"), { status: 404 });
    }) as typeof fetch);

    const viaProxy = await createGoogleAdapter({
      ...vertex("key-proxied", { proxy: "http://proxy.example.test:8080" }),
      fetch: proxyAwareBase,
    } as OcxProviderConfig).buildRequest(parsed(), incoming());
    expect(viaProxy.url).toContain("/projects/555555555555/locations/global/");
    expect(capturedProxy).toBe("http://proxy.example.test:8080/");
  });

  test("abort-before-probe rejects immediately without sending a probe or inference", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Turn cancelled before probe", "AbortError");
    controller.abort(reason);

    let inferenceSent = false;
    const runTurn = async () => {
      const req = await createGoogleAdapter(vertex("key-a"))
        .buildRequest(parsed(), incoming({ abortSignal: controller.signal }));
      inferenceSent = Boolean(req);
    };

    await expect(runTurn()).rejects.toBe(reason);
    expect(probes).toEqual([]);
    expect(inferenceSent).toBe(false);
  });

  test("abort-during-probe detaches only the aborted waiter and cancels the probe when all waiters abort", async () => {
    let releaseProbe!: (res: Response) => void;
    let probeAborted = false;
    const slowFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => { probeAborted = true; }, { once: true });
      return new Promise<Response>((resolve, reject) => {
        releaseProbe = resolve;
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as unknown as typeof fetch;

    const waiter1 = new AbortController();
    const waiter2 = new AbortController();
    const reason1 = new DOMException("Waiter 1 cancelled", "AbortError");
    let waiter1SentInference = false;

    const p1 = createGoogleAdapter({ ...vertex("key-coalesced"), fetch: slowFetch } as OcxProviderConfig)
      .buildRequest(parsed(), incoming({ abortSignal: waiter1.signal }))
      .then(() => { waiter1SentInference = true; });
    const p2 = createGoogleAdapter({ ...vertex("key-coalesced"), fetch: slowFetch } as OcxProviderConfig)
      .buildRequest(parsed(), incoming({ abortSignal: waiter2.signal }));

    // Aborting waiter 1 rejects p1 immediately while leaving the shared probe alive for waiter 2.
    waiter1.abort(reason1);
    await expect(p1).rejects.toBe(reason1);
    expect(waiter1SentInference).toBe(false);
    expect(probeAborted).toBe(false);

    releaseProbe(new Response(notFound("666666666666"), { status: 404 }));
    const req2 = await p2;
    expect(req2.url).toContain("/projects/666666666666/locations/global/");

    // When every waiter aborts, the underlying probe fetch is aborted immediately.
    probeAborted = false;
    const soleWaiter = new AbortController();
    const soleReason = new DOMException("Sole waiter cancelled", "AbortError");
    const pSole = createGoogleAdapter({ ...vertex("key-sole"), fetch: slowFetch } as OcxProviderConfig)
      .buildRequest(parsed(), incoming({ abortSignal: soleWaiter.signal }));
    soleWaiter.abort(soleReason);
    await expect(pSole).rejects.toBe(soleReason);
    expect(probeAborted).toBe(true);

    // An immediate follow-up caller in the same tick starts a fresh probe rather than joining the aborted one.
    const pFollowUp = createGoogleAdapter({ ...vertex("key-sole"), fetch: slowFetch } as OcxProviderConfig)
      .buildRequest(parsed(), incoming());
    releaseProbe(new Response(notFound("777777777777"), { status: 404 }));
    const reqFollowUp = await pFollowUp;
    expect(reqFollowUp.url).toContain("/projects/777777777777/locations/global/");
  });

  test("a key rotated into the same provider resolves the new key's project", async () => {
    const provider = vertex("key-a");
    const first = await createGoogleAdapter(provider).buildRequest(parsed(), incoming());
    const rotated = await createGoogleAdapter({ ...provider, apiKey: "key-b" }).buildRequest(parsed(), incoming());
    expect(first.url).toContain("/projects/111111111111/");
    expect(rotated.url).toContain("/projects/222222222222/");
    expect(rotated.headers["x-goog-api-key"]).toBe("key-b");
  });

  test("resolved projects get per-project replay namespaces", () => {
    expect(vertexReplayModelKey({ kind: "project", project: "111111111111", location: "global" }, "gemini-4-argon"))
      .not.toBe(vertexReplayModelKey({ kind: "project", project: "222222222222", location: "global" }, "gemini-4-argon"));
    expect(vertexReplayModelKey({ kind: "project", project: "111111111111", location: "global" }, "gemini-4-argon"))
      .toBe("vertex:project:111111111111:global:gemini-4-argon");
  });

  test("an explicit project and a projectless key never probe", async () => {
    const explicit = await createGoogleAdapter(vertex("key-a", { project: "fixture-project" })).buildRequest(parsed(), incoming());
    expect(explicit.url).toContain("/projects/fixture-project/locations/global/");
    const express = await createGoogleAdapter(vertex("key-a", { project: undefined })).buildRequest(parsed(), incoming());
    expect(express.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
    expect(probes).toEqual([]);
  });

  test("accepts case-insensitive AUTO and honors a provider-scoped fetch", async () => {
    let customCalls = 0;
    const customFetch = (async () => {
      customCalls++;
      return new Response(notFound("333333333333"), { status: 404 });
    }) as unknown as typeof fetch;
    const req = await createGoogleAdapter({
      ...vertex("key-c", { project: "  Auto " }),
      fetch: customFetch,
    } as OcxProviderConfig).buildRequest(parsed(), incoming());
    expect(req.url).toContain("/projects/333333333333/locations/global/");
    expect(customCalls).toBe(1);
    expect(probes).toEqual([]);
  });

  test("ADC rejects auto instead of treating it as a project id", async () => {
    const adc = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", project: "auto", location: "global" } as OcxProviderConfig;
    const prevKey = process.env.GOOGLE_CLOUD_API_KEY;
    delete process.env.GOOGLE_CLOUD_API_KEY;
    try {
      await expect(createGoogleAdapter(adc).buildRequest(parsed(), incoming())).rejects.toThrow(/requires an API key/);
    } finally {
      if (prevKey !== undefined) process.env.GOOGLE_CLOUD_API_KEY = prevKey;
    }
    expect(probes).toEqual([]);
  });
});
