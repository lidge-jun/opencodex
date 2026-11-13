import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoogleAdapter } from "../../../src/adapters/google";
import { __resetVertexTokenCache } from "../../../src/lib/gcp-adc";
import {
  collectVertexPublisherModelPages,
  extractGoogleNativeModelItems,
  resolveObservedVertexDiscoveryAuth,
  resolveObservedVertexDiscoveryToken,
  resolveVertexDiscoveryAuth,
  resolveVertexDiscoveryToken,
  VERTEX_DISCOVERY_MAX_PAGES,
  vertexDiscoveryAuthIsCurrent,
} from "../../../src/providers/google-vertex-model-discovery";
import { setProviderKeychainEntryFactoryForTests } from "../../../src/providers/key-store";
import { getProviderRegistryEntry } from "../../../src/providers/registry";
import { routedProviderConfig } from "../../../src/providers/routed-config";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { gatherRoutedModels } from "../../../src/codex/catalog";
import { clearModelCache } from "../../../src/codex/model-cache";
import { withStubbedProviderFetch } from "../../helpers/catalog-provider-fetch";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ENV_KEYS = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "CLOUDSDK_CONFIG"];
const UNREADABLE_REFERENCES = ["keychain:missing-fixture", "${MISSING_VERTEX_TEST_KEY}", "$MISSING_VERTEX_TEST_KEY", "keychain:"];

let tmp: string;
let saPath: string;
const realFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};
let tokenCalls = 0;

function vertex(extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "google", googleMode: "vertex", authMode: "key", baseUrl: "https://aiplatform.googleapis.com", ...extra } as OcxProviderConfig;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "ocx-vertex-discovery-"));
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  saPath = join(tmp, "sa.json");
  writeFileSync(saPath, JSON.stringify({ type: "service_account", client_email: "svc@example.test", private_key: pem, private_key_id: "k1" }));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetVertexTokenCache();
  setProviderKeychainEntryFactoryForTests(null);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  tokenCalls = 0;
});

afterAll(() => removeTreeWithRetry(tmp));

/** Ambient credentials present: a GOOGLE_CLOUD_API_KEY and a host ADC service account that would mint a token. */
function withAmbientCredentials(): void {
  process.env.GOOGLE_CLOUD_API_KEY = "ambient-env-key";
  process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
  process.env.CLOUDSDK_CONFIG = join(tmp, "no-gcloud");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url === OAUTH_TOKEN_URL) {
      tokenCalls++;
      return Response.json({ access_token: "ambient-adc-token", expires_in: 3600, token_type: "Bearer" });
    }
    return new Response("unexpected", { status: 404 });
  }) as typeof fetch;
}

describe("Vertex discovery credential selection", () => {
  test("an unreadable explicit key reference fails closed instead of using ambient credentials", async () => {
    withAmbientCredentials();
    setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => null, setPassword: () => {}, deletePassword: () => true }));
    for (const apiKey of UNREADABLE_REFERENCES) {
      const provider = vertex({ apiKey });
      expect(resolveObservedVertexDiscoveryToken(provider)).toBeUndefined();
      expect(await resolveVertexDiscoveryToken(provider)).toBeUndefined();
      // Inference rejects the same reference, so discovery and requests agree on the boundary.
      expect(() => routedProviderConfig("google-vertex", provider)).toThrow();
    }
    expect(tokenCalls).toBe(0);
  });

  test("the same references use their own key once readable, and no reference keeps the ambient chain", async () => {
    withAmbientCredentials();
    setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => "keychain-vertex-key", setPassword: () => {}, deletePassword: () => true }));
    expect(await resolveVertexDiscoveryToken(vertex({ apiKey: "keychain:google-vertex" }))).toBe("keychain-vertex-key");
    process.env.MISSING_VERTEX_TEST_KEY = "env-ref-key";
    try {
      expect(await resolveVertexDiscoveryToken(vertex({ apiKey: "$MISSING_VERTEX_TEST_KEY" }))).toBe("env-ref-key");
    } finally {
      delete process.env.MISSING_VERTEX_TEST_KEY;
    }
    expect(await resolveVertexDiscoveryToken(vertex())).toBe("ambient-env-key");
    delete process.env.GOOGLE_CLOUD_API_KEY;
    expect(await resolveVertexDiscoveryToken(vertex())).toBe("ambient-adc-token");
    expect(tokenCalls).toBe(1);
  });

  test("ADC resolution honours the discovery deadline", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
    process.env.CLOUDSDK_CONFIG = join(tmp, "no-gcloud");
    delete process.env.GOOGLE_CLOUD_API_KEY;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      tokenCalls++;
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const started = Date.now();
    expect(await resolveVertexDiscoveryToken(vertex(), AbortSignal.timeout(50))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(tokenCalls).toBeGreaterThan(0);
  });
});

function publisher(...ids: string[]): Array<{ name: string }> {
  return ids.map(id => ({ name: `publishers/google/models/${id}` }));
}

describe("Vertex discovery rows", () => {
  test("SKUs without function calling are not published, by tool support rather than the gemini- prefix", () => {
    const result = extractGoogleNativeModelItems("google-vertex", vertex(), { publisherModels: publisher(
      "gemini-3.1-flash-lite-image",
      "gemini-3.1-flash-image",
      "gemini-3-pro-image",
      "gemini-2.5-flash-image",
      "gemini-9-flash-image-preview",
      "gemini-3.1-flash-lite",
      "gemini-4-hydrogen",
    ) }, 100);
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.items.map(item => item.id)).toEqual(["gemini-3.1-flash-lite", "gemini-4-hydrogen"]);
  });

  test("advertised efforts are the registry ladder the adapter serializes", async () => {
    const ladders = getProviderRegistryEntry("google-vertex")?.modelReasoningEfforts ?? {};
    const result = extractGoogleNativeModelItems("google-vertex", vertex({ apiKey: "literal-key" }),
      { publisherModels: publisher("gemini-4-hydrogen", "gemini-4-carbon", "gemini-3-pro") }, 100);
    const items = result?.ok ? result.items : [];
    const byId = new Map(items.map(item => [item.id, item]));
    expect(byId.get("gemini-4-hydrogen")?.reasoning_efforts).toEqual([...ladders["gemini-4-hydrogen"]!]);
    expect(byId.get("gemini-4-carbon")?.reasoning_efforts).toEqual([...ladders["gemini-4-carbon"]!]);
    expect(ladders["gemini-3-pro"]).toBeUndefined();
    expect(byId.get("gemini-3-pro")?.reasoning_efforts).toBeUndefined();

    const adapter = createGoogleAdapter(routedProviderConfig("google-vertex", vertex({ apiKey: "literal-key", project: "p", location: "global" })));
    const request = (modelId: string, effort: string): OcxParsedRequest => ({
      modelId, stream: false, context: { messages: [{ role: "user", content: "hi" }], systemPrompt: [], tools: [] },
      options: { reasoning: effort },
    } as unknown as OcxParsedRequest);
    const thinking = async (modelId: string, effort: string) =>
      JSON.parse((await adapter.buildRequest(request(modelId, effort))).body).generationConfig?.thinkingConfig;
    expect(await thinking("gemini-4-hydrogen", "xhigh")).toEqual({ thinkingLevel: "xhigh" });
    expect(await thinking("gemini-3-pro", "high")).toBeUndefined();
  });
});

describe("Vertex publisherModels pagination", () => {
  const limits = { maxModels: 2_000, maxResponseBytes: 4 * 1024 * 1024 };
  const firstUrl = "https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=300";

  function pages(map: Record<string, unknown>, seen: string[] = []) {
    return async (url: string): Promise<Response> => {
      const token = new URL(url).searchParams.get("pageToken") ?? "";
      seen.push(token);
      const page = map[token];
      return page === undefined ? new Response("gone", { status: 500 }) : Response.json(page);
    };
  }

  test("follows nextPageToken and merges every page", async () => {
    const seen: string[] = [];
    const listing = await collectVertexPublisherModelPages(firstUrl, { publisherModels: publisher("gemini-a"), nextPageToken: "t1" }, limits, pages({
      t1: { publisherModels: publisher("gemini-b"), nextPageToken: "t2" },
      t2: { publisherModels: publisher("gemini-c") },
    }, seen));
    expect(seen).toEqual(["t1", "t2"]);
    expect(listing).toEqual({ ok: true, value: { publisherModels: publisher("gemini-a", "gemini-b", "gemini-c") } });
  });

  test("a single page passes through unchanged", async () => {
    const first = { publisherModels: publisher("gemini-a") };
    const listing = await collectVertexPublisherModelPages(firstUrl, first, limits, () => { throw new Error("no request expected"); });
    expect(listing).toEqual({ ok: true, value: first });
  });

  test("an empty Vertex page continues, while a non-Vertex follow-up envelope is not read as the last page", async () => {
    const empty = await collectVertexPublisherModelPages(firstUrl, { publisherModels: publisher("gemini-a"), nextPageToken: "t1" }, limits,
      pages({ t1: { nextPageToken: "t2" }, t2: {} }));
    expect(empty).toEqual({ ok: true, value: { publisherModels: publisher("gemini-a") } });
    for (const page of [{ data: [{ id: "gemini-b" }] }, { error: { code: 500 } }, [{ name: "x" }]]) {
      const listing = await collectVertexPublisherModelPages(firstUrl, { publisherModels: publisher("gemini-a"), nextPageToken: "t1" }, limits,
        pages({ t1: page }));
      expect(listing).toMatchObject({ ok: false, reason: "incomplete" });
    }
  });

  test("the byte ceiling counts the bytes read for page one, and the caller's deadline bounds every page", async () => {
    const small = { publisherModels: publisher("gemini-b") };
    const pageBytes = new TextEncoder().encode(JSON.stringify(small)).byteLength;
    const fits = await collectVertexPublisherModelPages(firstUrl, { publisherModels: [], nextPageToken: "t1" },
      { ...limits, maxResponseBytes: pageBytes + 100, firstPageBytes: 50 }, pages({ t1: small }));
    expect(fits.ok).toBe(true);
    const over = await collectVertexPublisherModelPages(firstUrl, { publisherModels: [], nextPageToken: "t1" },
      { ...limits, maxResponseBytes: pageBytes + 100, firstPageBytes: 150 }, pages({ t1: small }));
    expect(over.ok).toBe(false);

    const expired = AbortSignal.abort();
    let pageSignal: AbortSignal | undefined;
    const late = await collectVertexPublisherModelPages(firstUrl, { publisherModels: [], nextPageToken: "t1" }, { ...limits, signal: expired },
      async (_url, signal) => { pageSignal = signal; signal.throwIfAborted(); return Response.json(small); });
    expect(pageSignal).toBe(expired);
    expect(late).toMatchObject({ ok: false, diagnostic: expect.stringContaining("time budget") });
  });

  test("an unfinished walk is reported incomplete, never published as the whole roster", async () => {
    const endless: Record<string, unknown> = {};
    for (let page = 1; page <= VERTEX_DISCOVERY_MAX_PAGES + 2; page++) {
      endless[`t${page}`] = { publisherModels: publisher(`gemini-${page}`), nextPageToken: `t${page + 1}` };
    }
    const seen: string[] = [];
    const capped = await collectVertexPublisherModelPages(firstUrl, { publisherModels: [], nextPageToken: "t1" }, limits, pages(endless, seen));
    expect(capped.ok).toBe(false);
    expect(seen).toHaveLength(VERTEX_DISCOVERY_MAX_PAGES - 1);

    const failed = await collectVertexPublisherModelPages(firstUrl, { publisherModels: [], nextPageToken: "t1" }, limits, pages({}));
    expect(failed).toMatchObject({ ok: false, reason: "incomplete" });

    const loop = await collectVertexPublisherModelPages(firstUrl, { publisherModels: [], nextPageToken: "t1" }, limits,
      pages({ t1: { publisherModels: [], nextPageToken: "t1" } }));
    expect(loop.ok).toBe(false);

    const rows = await collectVertexPublisherModelPages(firstUrl, { publisherModels: publisher("gemini-a", "gemini-b"), nextPageToken: "t1" },
      { ...limits, maxModels: 2 }, pages({ t1: { publisherModels: publisher("gemini-c") } }));
    expect(rows.ok).toBe(false);

    const big = { publisherModels: publisher(...Array.from({ length: 50 }, (_, i) => `gemini-${i}`)) };
    const bytes = await collectVertexPublisherModelPages(firstUrl, { publisherModels: [], nextPageToken: "t1" },
      { ...limits, maxResponseBytes: 600 }, pages({ t1: big }));
    expect(bytes.ok).toBe(false);
  });
});

describe("Vertex discovery credential parity with inference", () => {
  const parsedRequest = { modelId: "gemini-4-hydrogen", stream: false,
    context: { messages: [{ role: "user", content: "hi" }], systemPrompt: [], tools: [] }, options: {} } as unknown as OcxParsedRequest;

  /** The credential an inference request for this row actually carries, or undefined when it refuses. */
  async function inferenceCredential(provider: OcxProviderConfig): Promise<string | undefined> {
    try {
      const request = await createGoogleAdapter(routedProviderConfig("parity-vertex", provider)).buildRequest(parsedRequest);
      const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
      return headers["x-goog-api-key"] ?? headers.authorization?.replace(/^Bearer /, "");
    } catch {
      return undefined;
    }
  }

  test("discovery sends exactly the credential inference sends, or nothing when inference refuses", async () => {
    const markerCredential = JSON.parse(readFileSync(saPath, "utf8")) as Record<string, unknown>;
    const keychain: Record<string, string> = {
      padded: "  keychain-padded-key  ",
      "marker-ref": "gcp-sa:svc-account",
      "svc-account": JSON.stringify({ ...markerCredential, client_email: "marker@example.test" }),
    };
    setProviderKeychainEntryFactoryForTests((_service, account) => ({
      getPassword: () => keychain[account] ?? null, setPassword: () => {}, deletePassword: () => true,
    }));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
    process.env.CLOUDSDK_CONFIG = join(tmp, "no-gcloud");
    process.env.VERTEX_PARITY_MARKER = "gcp-sa:svc-account";
    process.env.VERTEX_PARITY_PADDED = " env-reference-key ";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url !== OAUTH_TOKEN_URL) return new Response("unexpected", { status: 404 });
      const assertion = new URLSearchParams(String(init?.body ?? "")).get("assertion") ?? "";
      const issuer = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString("utf8")).iss;
      return Response.json({ access_token: `token-for-${issuer}`, expires_in: 3600, token_type: "Bearer" });
    }) as typeof fetch;

    const keys: Array<string | undefined> = [
      "literal-key", " padded-literal ", " N/A ", "N/A", "<your key>", undefined, "",
      "keychain:padded", "keychain:missing", "keychain:", "keychain:marker-ref",
      "$VERTEX_PARITY_MARKER", "${VERTEX_PARITY_PADDED}", "$VERTEX_PARITY_UNSET",
      "gcp-sa:svc-account", "gcp-sa:",
    ];
    try {
      for (const ambient of ["ambient-env-key", undefined]) {
        if (ambient) process.env.GOOGLE_CLOUD_API_KEY = ambient; else delete process.env.GOOGLE_CLOUD_API_KEY;
        for (const apiKey of keys) {
          const provider = vertex({ project: "parity-project", location: "global", ...(apiKey === undefined ? {} : { apiKey }) });
          __resetVertexTokenCache();
          const expected = await inferenceCredential(provider);
          __resetVertexTokenCache();
          expect({ apiKey, ambient, credential: await resolveVertexDiscoveryToken(provider) })
            .toEqual({ apiKey, ambient, credential: expected });
        }
      }
      // The matrix reaches every outcome: a key, both ADC identities, and a refusal.
      expect(await resolveVertexDiscoveryToken(vertex({ apiKey: "$VERTEX_PARITY_MARKER" }))).toBe("token-for-marker@example.test");
      expect(await resolveVertexDiscoveryToken(vertex())).toBe("token-for-svc@example.test");
      expect(await resolveVertexDiscoveryToken(vertex({ apiKey: " N/A " }))).toBe(" N/A ");
      expect(await resolveVertexDiscoveryToken(vertex({ apiKey: "keychain:missing" }))).toBeUndefined();
    } finally {
      delete process.env.VERTEX_PARITY_MARKER;
      delete process.env.VERTEX_PARITY_PADDED;
    }
  });
});

describe("Vertex discovery credential stays bound to its selection", () => {
  test("a selection that changes during the ADC exchange discards the token, and send-time checks reject a mismatched header", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
    process.env.CLOUDSDK_CONFIG = join(tmp, "no-gcloud");
    delete process.env.GOOGLE_CLOUD_API_KEY;
    let release!: () => void;
    const exchangeStarted = new Promise<void>(resolveStarted => {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url !== OAUTH_TOKEN_URL) return new Response("unexpected", { status: 404 });
        resolveStarted();
        await new Promise<void>(resolveRelease => { release = resolveRelease; });
        return Response.json({ access_token: "host-adc-token", expires_in: 3600, token_type: "Bearer" });
      }) as typeof fetch;
    });
    const pending = resolveVertexDiscoveryAuth(vertex());
    await exchangeStarted;
    process.env.GOOGLE_CLOUD_API_KEY = "ambient-env-key";
    release();
    expect(await pending).toBeUndefined();

    __resetVertexTokenCache();
    delete process.env.GOOGLE_CLOUD_API_KEY;
    const adc = { token: "host-adc-token", kind: "adc" as const };
    expect(vertexDiscoveryAuthIsCurrent(vertex(), adc, { Authorization: "Bearer host-adc-token" })).toBe(true);
    expect(vertexDiscoveryAuthIsCurrent(vertex(), adc, { "x-goog-api-key": "host-adc-token" })).toBe(false);
    process.env.GOOGLE_CLOUD_API_KEY = "ambient-env-key";
    expect(vertexDiscoveryAuthIsCurrent(vertex(), adc, { Authorization: "Bearer host-adc-token" })).toBe(false);
    const key = { token: "ambient-env-key", kind: "api-key" as const };
    expect(vertexDiscoveryAuthIsCurrent(vertex(), key, { "X-Goog-Api-Key": "ambient-env-key" })).toBe(true);
    process.env.GOOGLE_CLOUD_API_KEY = "rotated-env-key";
    expect(vertexDiscoveryAuthIsCurrent(vertex(), key, { "x-goog-api-key": "ambient-env-key" })).toBe(false);
  });

  test("catalog discovery never sends an ADC token after the selection moved to an API key mid-exchange", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
    process.env.CLOUDSDK_CONFIG = join(tmp, "no-gcloud");
    delete process.env.GOOGLE_CLOUD_API_KEY;
    const vertexRequests: Array<Record<string, string>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === OAUTH_TOKEN_URL) {
        // The operator exports an API key while the token exchange is in flight.
        process.env.GOOGLE_CLOUD_API_KEY = "ambient-env-key";
        return Response.json({ access_token: "host-adc-token", expires_in: 3600, token_type: "Bearer" });
      }
      vertexRequests.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return Response.json({ publisherModels: [{ name: "publishers/google/models/gemini-4-hydrogen" }] });
    }) as typeof fetch;
    const config: OcxConfig = { providers: { "race-vertex": {
      adapter: "google", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com",
      project: "race-project", location: "global", liveModels: true, models: ["configured-only"],
    } } };
    await gatherRoutedModels(withStubbedProviderFetch(config));
    expect(JSON.stringify(vertexRequests)).not.toContain("host-adc-token");
    clearModelCache();
  });
});

describe("Vertex discovery ADC token stays bound to the authority that minted it", () => {
  function tokenServer(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url !== OAUTH_TOKEN_URL) return new Response("unexpected", { status: 404 });
      const assertion = new URLSearchParams(String(init?.body ?? "")).get("assertion") ?? "";
      const issuer = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString("utf8")).iss;
      return Response.json({ access_token: `token-for-${issuer}`, expires_in: 3600, token_type: "Bearer" });
    }) as typeof fetch;
  }
  const serviceAccount = (email: string): string =>
    JSON.stringify({ ...JSON.parse(readFileSync(saPath, "utf8")), client_email: email });

  test("a replaced host ADC file or a credential replaced behind the same marker invalidates the token before send", async () => {
    const hostFile = join(tmp, "rotating-host.json");
    writeFileSync(hostFile, serviceAccount("host-a@example.test"));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = hostFile;
    process.env.CLOUDSDK_CONFIG = join(tmp, "no-gcloud");
    delete process.env.GOOGLE_CLOUD_API_KEY;
    tokenServer();
    const host = await resolveVertexDiscoveryAuth(vertex());
    expect(host?.token).toBe("token-for-host-a@example.test");
    const hostHeaders = { Authorization: `Bearer ${host!.token}` };
    expect(vertexDiscoveryAuthIsCurrent(vertex(), host!, hostHeaders)).toBe(true);
    writeFileSync(hostFile, serviceAccount("host-b@example.test"));
    expect(vertexDiscoveryAuthIsCurrent(vertex(), host!, hostHeaders)).toBe(false);

    const stored: Record<string, string> = { "rotating-marker": serviceAccount("marker-a@example.test") };
    setProviderKeychainEntryFactoryForTests((_service, account) => ({
      getPassword: () => stored[account] ?? null, setPassword: () => {}, deletePassword: () => true,
    }));
    const markerRow = vertex({ apiKey: "gcp-sa:rotating-marker" });
    const marker = await resolveVertexDiscoveryAuth(markerRow);
    expect(marker?.token).toBe("token-for-marker-a@example.test");
    const markerHeaders = { Authorization: `Bearer ${marker!.token}` };
    expect(vertexDiscoveryAuthIsCurrent(markerRow, marker!, markerHeaders)).toBe(true);
    stored["rotating-marker"] = serviceAccount("marker-b@example.test");
    expect(vertexDiscoveryAuthIsCurrent(markerRow, marker!, markerHeaders)).toBe(false);
  });

  test("an ADC file replaced between pages stops the walk before the next page is sent", async () => {
    const hostFile = join(tmp, "rotating-pages.json");
    writeFileSync(hostFile, serviceAccount("pages-a@example.test"));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = hostFile;
    process.env.CLOUDSDK_CONFIG = join(tmp, "no-gcloud");
    delete process.env.GOOGLE_CLOUD_API_KEY;
    const pageRequests: string[] = [];
    tokenServer();
    const tokens = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === OAUTH_TOKEN_URL) return tokens(input, init);
      pageRequests.push(new URL(url).searchParams.get("pageToken") ?? "first");
      // The host credential is replaced after page one is served.
      writeFileSync(hostFile, serviceAccount("pages-b@example.test"));
      return Response.json({ publisherModels: [{ name: "publishers/google/models/gemini-4-carbon" }], nextPageToken: "page-2" });
    }) as typeof fetch;
    const rows = await gatherRoutedModels(withStubbedProviderFetch({ providers: { "rotating-vertex": {
      adapter: "google", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com",
      project: "rotating-project", location: "global", liveModels: true, models: ["configured-only"],
    } } } as OcxConfig));
    expect(pageRequests).toEqual(["first"]);
    expect(rows.filter(row => row.provider === "rotating-vertex").map(row => row.id)).not.toContain("gemini-4-carbon");
    clearModelCache();
  });
});

describe("Vertex discovery ambient key stays bound to the generation it was read in", () => {
  test("GOOGLE_CLOUD_API_KEY changing A→B→A invalidates a key read as A, on the async and passive paths", async () => {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_CLOUD_API_KEY = "ambient-a";
    const resolved = await resolveVertexDiscoveryAuth(vertex());
    const passive = resolveObservedVertexDiscoveryAuth(vertex());
    const headers = { "x-goog-api-key": "ambient-a" };
    for (const auth of [resolved, passive]) {
      expect(auth).toMatchObject({ token: "ambient-a", kind: "api-key" });
      expect(vertexDiscoveryAuthIsCurrent(vertex(), auth!, headers)).toBe(true);
    }
    process.env.GOOGLE_CLOUD_API_KEY = "ambient-b";
    // Inference routes a request while B is set, observing B as the current ambient authority.
    routedProviderConfig("google-vertex", vertex({ project: "p", location: "global" }));
    process.env.GOOGLE_CLOUD_API_KEY = "ambient-a";
    for (const auth of [resolved, passive]) expect(vertexDiscoveryAuthIsCurrent(vertex(), auth!, headers)).toBe(false);
    // A configured literal key is not ambient authority and is unaffected by the variable.
    const literal = await resolveVertexDiscoveryAuth(vertex({ apiKey: "literal-key" }));
    process.env.GOOGLE_CLOUD_API_KEY = "ambient-b";
    expect(vertexDiscoveryAuthIsCurrent(vertex({ apiKey: "literal-key" }), literal!, { "x-goog-api-key": "literal-key" })).toBe(true);
  });
});

test("a token-only first Vertex page is an empty page whose token is followed", async () => {
  const seen: string[] = [];
  const listing = await collectVertexPublisherModelPages(
    "https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=300",
    { nextPageToken: "t1" },
    { maxModels: 2_000, maxResponseBytes: 4 * 1024 * 1024 },
    async url => {
      seen.push(new URL(url).searchParams.get("pageToken") ?? "");
      return Response.json({ publisherModels: [{ name: "publishers/google/models/gemini-4-hydrogen" }] });
    },
  );
  expect(seen).toEqual(["t1"]);
  expect(listing).toEqual({ ok: true, value: { publisherModels: [{ name: "publishers/google/models/gemini-4-hydrogen" }] } });
});
