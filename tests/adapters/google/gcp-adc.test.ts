import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVertexAccessToken, getVertexAccessTokenWithAuthority, __resetVertexTokenCache } from "../../../src/lib/gcp-adc";
import { createGoogleAdapter } from "../../../src/adapters/google";
import { providerManagementConfigError, safeConfigDTO } from "../../../src/server/auth-cors";
import { providerApiKeySelectionIsCurrent } from "../../../src/providers/api-key-selection";
import { routedProviderConfig } from "../../../src/providers/routed-config";
import { loadConfig, saveConfig } from "../../../src/config";
import { handleChatCompletions } from "../../../src/server/chat-completions";
import { handleResponses } from "../../../src/server/responses";
import { handleManagementAPI } from "../../../src/server/management-api";
import { resolveWireProtocolOverride } from "../../../src/server/adapter-resolve";
import { openAIChatTransport } from "../../../src/adapters/openai-chat/wire";
import * as proxyEnv from "../../../src/lib/proxy-env";
import * as destinationPolicy from "../../../src/lib/destination-policy";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { ManagementRequest } from "../../helpers/management-auth";
import { catalogConvergenceFactory } from "../../helpers/catalog-convergence";
import { setProviderKeychainEntryFactoryForTests } from "../../../src/providers/key-store";
import { registerUpstreamRewriter } from "../../../src/plugins/upstream-hooks";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { STATE_STORE_REGISTRATIONS } from "../../../src/lib/state-store-registrations";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
let tmp: string;
let saPath: string;
let realFetch: typeof fetch;
let prevEnv: Record<string, string | undefined> = {};
let oauthCalls = 0;
let lastBody = "";

function parsed(modelId = "gemini-3-pro"): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    context: { messages: [{ role: "user", content: "hi" }], systemPrompt: [], tools: [] },
    options: {},
  } as unknown as OcxParsedRequest;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "ocx-gcp-adc-"));
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)!.join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  saPath = join(tmp, "sa.json");
  writeFileSync(saPath, JSON.stringify({ type: "service_account", client_email: "svc@example.test", private_key: pem, private_key_id: "k1" }));
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url === OAUTH_TOKEN_URL) {
      oauthCalls++;
      lastBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ access_token: "vertex-tok", expires_in: 3600, token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  removeTreeWithRetry(tmp);
});

afterEach(() => {
  __resetVertexTokenCache();
  for (const k of VERTEX_ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k];
  }
  prevEnv = {};
  oauthCalls = 0;
});

const VERTEX_ENV_KEYS = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "CLOUDSDK_CONFIG"];

// Start every case from a clean Vertex environment; afterEach restores the caller's values.
beforeEach(() => {
  for (const k of VERTEX_ENV_KEYS) {
    if (!(k in prevEnv)) prevEnv[k] = process.env[k];
    delete process.env[k];
  }
});

function setEnv(k: string, v: string): void {
  if (!(k in prevEnv)) prevEnv[k] = process.env[k];
  process.env[k] = v;
}

describe("gcp-adc resolver", () => {
  test("ADC rotation during schema repair preserves the repaired replay", async () => {
    const replacementPath = join(tmp, "repair-replacement.json");
    writeFileSync(replacementPath, JSON.stringify({ type: "authorized_user", client_id: "fixture", client_secret: "fixture", refresh_token: "fixture" }));
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key", googleMode: "vertex", project: "demo-project", location: "global" } as OcxProviderConfig;
    const config = { port: 0, defaultProvider: "google-vertex", providers: { "google-vertex": provider } } as OcxConfig;
    const releaseOwner = acquireOwnedSpendHome();
    saveConfig(config);
    const priorFetch = globalThis.fetch;
    const bodies: string[] = [];
    const authorizations: Array<string | null> = [];
    let tokens = 0;
    globalThis.fetch = (async (input, init) => {
      if (String(input) === OAUTH_TOKEN_URL) return Response.json({ access_token: `fixture-${++tokens}`, expires_in: 3600 });
      bodies.push(String(init?.body));
      authorizations.push(new Headers(init?.headers).get("authorization"));
      if (bodies.length === 1) setEnv("GOOGLE_APPLICATION_CREDENTIALS", replacementPath);
      return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "tools.0.custom.input_schema: JSON schema is invalid" } }, { status: 400 });
    }) as typeof fetch;
    Object.assign(provider, { fetch: globalThis.fetch });
    const configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => globalThis.fetch(input, init));
    try {
      const request = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        model: "google-vertex/gemini-3-pro", messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "fixture", parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } } } } }], stream: false,
      }) });
      await handleChatCompletions(request, config, { model: "", provider: "" });
      expect(tokens).toBe(2);
      expect(bodies).toHaveLength(2);
      expect(authorizations).toEqual(["Bearer fixture-1", "Bearer fixture-2"]);
      expect(bodies[1]).not.toBe(bodies[0]);
    } finally {
      configuredFetch.mockRestore();
      globalThis.fetch = priorFetch;
      releaseOwner();
    }
  });

  test("unresolved explicit Vertex key references do not fall back to host credentials", () => {
    setEnv("GOOGLE_CLOUD_API_KEY", "fixture-host-key");
    setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => null, setPassword: () => {}, deletePassword: () => true }));
    try {
      for (const apiKey of ["keychain:missing-fixture", "${MISSING_VERTEX_TEST_KEY}"]) {
        const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key", googleMode: "vertex", apiKey } as OcxProviderConfig;
        expect(() => routedProviderConfig("google-vertex", provider)).toThrow();
      }
    } finally {
      setProviderKeychainEntryFactoryForTests(null);
    }
  });

  test("Vertex forward auth cannot silently use proxy host credentials", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "forward", googleMode: "vertex", project: "demo-project", location: "global" } as OcxProviderConfig;
    await expect(createGoogleAdapter(provider).buildRequest(parsed())).rejects.toThrow();
    expect(oauthCalls).toBe(0);
  });
  test("dashboard exposes only a non-secret Vertex credential kind", () => {
    const vertex = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex" } as const;
    const config = { port: 0, defaultProvider: "ambient", providers: {
      ambient: { ...vertex }, marker: { ...vertex, apiKey: "gcp-sa:fixture-marker" },
      placeholder: { ...vertex, apiKey: "N/A" }, key: { ...vertex, apiKey: "fixture-key" },
      "google-vertex": { adapter: "openai-chat", baseUrl: "https://legacy.example/v1", apiKey: "gcp-sa:fixture-marker" },
    } } as OcxConfig;
    const dto = safeConfigDTO(config) as { providers: Record<string, Record<string, unknown>> };
    expect(dto.providers.ambient?.vertexCredentialKind).toBe("ambient");
    expect(dto.providers.marker?.vertexCredentialKind).toBe("marker");
    expect(dto.providers.placeholder?.vertexCredentialKind).toBe("ambient");
    expect(dto.providers.key?.vertexCredentialKind).toBe("api-key");
    expect(dto.providers["google-vertex"]?.vertexCredentialKind).toBe("marker");
    expect(JSON.stringify(dto)).not.toContain("fixture-marker");
    expect(JSON.stringify(dto)).not.toContain("fixture-key");
  });
  test("ambient Vertex API key never becomes a non-Google wire credential", () => {
    setEnv("GOOGLE_CLOUD_API_KEY", "fixture-ambient-key");
    const provider = { adapter: "google", baseUrl: "https://external.example/v1", authMode: "key", googleMode: "vertex",
      modelAdapters: { "example-model": "openai-chat" } } as OcxProviderConfig;
    const routed = routedProviderConfig("custom-vertex", provider);
    const wire = resolveWireProtocolOverride("custom-vertex", "example-model", routed, "chat");
    expect(wire.adapter).toBe("openai-chat");
    expect(wire.apiKey).toBeUndefined();
    expect(() => openAIChatTransport(wire)).toThrow("requires a non-empty credential");
  });

  test("a Vertex credential marker is never sent as a non-Google wire credential", () => {
    const provider = { adapter: "google", baseUrl: "https://external.example/v1", authMode: "key", googleMode: "vertex", apiKey: "gcp-sa:fixture-account",
      modelAdapters: { "example-model": "openai-chat" } } as OcxProviderConfig;
    const wire = resolveWireProtocolOverride("custom-vertex", "example-model", routedProviderConfig("custom-vertex", provider), "chat");
    expect(wire.adapter).toBe("openai-chat");
    expect(wire.apiKey).toBeUndefined();
    expect(() => openAIChatTransport(wire)).toThrow("requires a non-empty credential");
  });

  for (const inbound of ["chat", "responses"] as const) {
    test(`ambient Vertex key does not reach an overridden ${inbound} transport`, async () => {
      setEnv("GOOGLE_CLOUD_API_KEY", "fixture-ambient-key");
      const provider = { adapter: "google", baseUrl: "https://external.example/v1", authMode: "key", googleMode: "vertex",
        modelAdapters: { "example-model": "openai-chat" } } as OcxProviderConfig;
      const config = { port: 0, defaultProvider: "custom-vertex", providers: { "custom-vertex": provider } } as OcxConfig;
      const releaseOwner = acquireOwnedSpendHome();
      saveConfig(config);
      const priorFetch = globalThis.fetch;
      const sent: string[] = [];
      globalThis.fetch = (async (input, init) => {
        sent.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json({});
      }) as typeof fetch;
      Object.assign(provider, { fetch: globalThis.fetch });
      const configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => globalThis.fetch(input, init));
      try {
        const body = inbound === "chat"
          ? { model: "custom-vertex/example-model", messages: [{ role: "user", content: "hello" }], stream: false }
          : { model: "custom-vertex/example-model", input: "hello", stream: false };
        const request = new Request(`http://localhost/v1/${inbound === "chat" ? "chat/completions" : "responses"}`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const response = inbound === "chat" ? await handleChatCompletions(request, config, { model: "", provider: "" })
          : await handleResponses(request, config, { model: "", provider: "" });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(sent).toEqual([]);
      } finally {
        configuredFetch.mockRestore();
        globalThis.fetch = priorFetch;
        releaseOwner();
      }
    });
  }

  test("an ADC source switch during token exchange never returns the previous bearer", async () => {
    const firstPath = join(tmp, "adc-first.json");
    const secondPath = join(tmp, "adc-second.json");
    const credential = { type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "fixture-refresh" };
    writeFileSync(firstPath, JSON.stringify(credential));
    writeFileSync(secondPath, JSON.stringify({ ...credential, refresh_token: "other-fixture-refresh" }));
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", firstPath);
    let release!: (response: Response) => void;
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const fakeFetch = (async () => { started(); return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
    const pending = getVertexAccessToken({ fetch: fakeFetch });
    await requested;
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", secondPath);
    release(Response.json({ access_token: "old-fixture-token", expires_in: 3600 }));
    await expect(pending).rejects.toThrow();
  });

  for (const cancelled of ["first", "second"] as const) {
    test(`cancelling the ${cancelled} ADC waiter leaves the other refresh alive`, async () => {
      const file = join(tmp, `adc-cancel-${cancelled}.json`);
      writeFileSync(file, JSON.stringify({ type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "fixture-refresh" }));
      setEnv("GOOGLE_APPLICATION_CREDENTIALS", file);
      const firstController = new AbortController();
      const secondController = new AbortController();
      let release!: (response: Response) => void;
      let started!: () => void;
      const requested = new Promise<void>(resolve => { started = resolve; });
      const fakeFetch = (async (_input, init) => {
        started();
        return new Promise<Response>((resolve, reject) => {
          release = resolve;
          init?.signal?.addEventListener("abort", () => reject(new Error("fixture exchange aborted")), { once: true });
        });
      }) as typeof fetch;
      const first = getVertexAccessToken({ fetch: fakeFetch, signal: firstController.signal });
      void first.catch(() => {});
      await requested;
      const second = getVertexAccessToken({ fetch: fakeFetch, signal: secondController.signal });
      void second.catch(() => {});
      (cancelled === "first" ? firstController : secondController).abort();
      release(Response.json({ access_token: "fixture-shared-token", expires_in: 3600 }));
      await expect(cancelled === "first" ? first : second).rejects.toThrow();
      expect(await (cancelled === "first" ? second : first)).toBe("fixture-shared-token");
    });
  }

  test("a shared ADC retry uses a remaining authorized provider", async () => {
    const file = join(tmp, "adc-shared-authority.json");
    writeFileSync(file, JSON.stringify({ type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "fixture-refresh" }));
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", file);
    let firstValid = true;
    let release!: (response: Response) => void;
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const fakeFetch = (async () => {
      if (++calls === 1) { started(); return new Promise<Response>(resolve => { release = resolve; }); }
      return Response.json({ access_token: "fixture-shared-token", expires_in: 3600 });
    }) as typeof fetch;
    const first = getVertexAccessTokenWithAuthority({ fetch: fakeFetch, beforeSend: () => { if (!firstValid) throw new Error("first provider changed"); } });
    void first.catch(() => {});
    await requested;
    const second = getVertexAccessTokenWithAuthority({ fetch: fakeFetch, beforeSend: () => {} });
    firstValid = false;
    release(new Response(null, { status: 503 }));
    expect((await second).token).toBe("fixture-shared-token");
    await expect(first).rejects.toThrow("first provider changed");
    expect(calls).toBe(2);
  });

  test("ADC rotation during JWT signing prevents the old assertion from being sent", async () => {
    const replacement = join(tmp, "adc-after-signing.json");
    writeFileSync(replacement, JSON.stringify({ type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "fixture-refresh" }));
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const originalSign = globalThis.crypto.subtle.sign.bind(globalThis.crypto.subtle);
    const signing = spyOn(globalThis.crypto.subtle, "sign").mockImplementation(async (...args) => {
      const signature = await originalSign(...args);
      setEnv("GOOGLE_APPLICATION_CREDENTIALS", replacement);
      return signature;
    });
    let sent = 0;
    const fakeFetch = (async () => { sent++; return Response.json({ access_token: "fixture-old-token", expires_in: 3600 }); }) as typeof fetch;
    try {
      await expect(getVertexAccessToken({ fetch: fakeFetch })).rejects.toThrow();
      expect(sent).toBe(0);
    } finally {
      signing.mockRestore();
    }
  });

  test("an observed ADC A to B to A switch rejects the first A exchange", async () => {
    const firstPath = join(tmp, "adc-aba-a.json");
    const secondPath = join(tmp, "adc-aba-b.json");
    const credential = { type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "token-one" };
    writeFileSync(firstPath, JSON.stringify(credential));
    writeFileSync(secondPath, JSON.stringify({ ...credential, refresh_token: "token-two" }));
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", firstPath);
    let release!: (response: Response) => void;
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const fakeFetch = (async () => {
      if (++calls === 1) { started(); return new Promise<Response>(resolve => { release = resolve; }); }
      return Response.json({ access_token: "fixture-b", expires_in: 3600 });
    }) as typeof fetch;
    const old = getVertexAccessToken({ fetch: fakeFetch });
    await requested;
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", secondPath);
    expect(await getVertexAccessToken({ fetch: fakeFetch })).toBe("fixture-b");
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", firstPath);
    // Observing A again establishes a new generation before the old A exchange returns.
    const newer = getVertexAccessToken({ fetch: fakeFetch });
    release(Response.json({ access_token: "fixture-old-a", expires_in: 3600 }));
    await expect(old).rejects.toThrow();
    expect(await newer).not.toBe("fixture-old-a");
  });

  test("same-size ADC file replacement with preserved mtime invalidates the token", async () => {
    const file = join(tmp, "same-size-adc.json");
    const credential = { type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "token-one" };
    writeFileSync(file, JSON.stringify(credential));
    const initial = statSync(file);
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", file);
    let calls = 0;
    const fakeFetch = (async () => Response.json({ access_token: `fixture-${++calls}`, expires_in: 3600 })) as typeof fetch;
    expect(await getVertexAccessToken({ fetch: fakeFetch })).toBe("fixture-1");
    writeFileSync(file, JSON.stringify({ ...credential, refresh_token: "token-two" }));
    utimesSync(file, initial.atime, initial.mtime);
    expect(await getVertexAccessToken({ fetch: fakeFetch })).toBe("fixture-2");
  });

  test("replacing credentials behind the same marker invalidates the token", async () => {
    let credential = JSON.stringify({ type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "token-one" });
    setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => credential, setPassword: () => {}, deletePassword: () => true }));
    let calls = 0;
    const fakeFetch = (async () => Response.json({ access_token: `fixture-${++calls}`, expires_in: 3600 })) as typeof fetch;
    try {
      expect(await getVertexAccessToken({ markerAccount: "fixture-marker", fetch: fakeFetch })).toBe("fixture-1");
      credential = credential.replace("token-one", "token-two");
      expect(await getVertexAccessToken({ markerAccount: "fixture-marker", fetch: fakeFetch })).toBe("fixture-2");
    } finally {
      setProviderKeychainEntryFactoryForTests(null);
    }
  });
  test("keyless Vertex ADC remains valid through the physical-send selection check", () => {
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key", googleMode: "vertex", project: "demo-project", location: "global" } as OcxProviderConfig;
    const config = { port: 0, defaultProvider: "google-vertex", providers: { "google-vertex": provider } } as OcxConfig;
    const routed = routedProviderConfig("google-vertex", provider);
    expect(providerApiKeySelectionIsCurrent(config, "google-vertex", routed)).toBe(true);
    config.providers["google-vertex"] = { ...provider, project: "other-project" };
    expect(providerApiKeySelectionIsCurrent(config, "google-vertex", routed)).toBe(false);
  });

  test("Vertex selection detects adapter and model-wire changes before dispatch", () => {
    const provider = { adapter: "google", baseUrl: "https://external.example/v1", googleMode: "vertex", project: "demo-project", location: "global" } as OcxProviderConfig;
    const config = { port: 0, defaultProvider: "custom-vertex", providers: { "custom-vertex": provider } } as OcxConfig;
    const routed = routedProviderConfig("custom-vertex", provider);
    expect(providerApiKeySelectionIsCurrent(config, "custom-vertex", routed)).toBe(true);
    config.providers["custom-vertex"] = { ...provider, adapter: "openai-chat" };
    expect(providerApiKeySelectionIsCurrent(config, "custom-vertex", routed)).toBe(false);
    config.providers["custom-vertex"] = { ...provider, modelAdapters: { "example-model": "openai-chat" } };
    expect(providerApiKeySelectionIsCurrent(config, "custom-vertex", routed)).toBe(false);
  });

  test("an observed ambient key A to B to A invalidates the original selection", () => {
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key", googleMode: "vertex" } as OcxProviderConfig;
    const config = { port: 0, defaultProvider: "google-vertex", providers: { "google-vertex": provider } } as OcxConfig;
    setEnv("GOOGLE_CLOUD_API_KEY", "fixture-key-a");
    const first = routedProviderConfig("google-vertex", provider);
    setEnv("GOOGLE_CLOUD_API_KEY", "fixture-key-b");
    routedProviderConfig("google-vertex", provider);
    setEnv("GOOGLE_CLOUD_API_KEY", "fixture-key-a");
    routedProviderConfig("google-vertex", provider);
    expect(providerApiKeySelectionIsCurrent(config, "google-vertex", first)).toBe(false);
  });

  test("Vertex send-time selection detects environment key, project and location changes", () => {
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key", googleMode: "vertex" } as OcxProviderConfig;
    const config = { port: 0, defaultProvider: "google-vertex", providers: { "google-vertex": provider } } as OcxConfig;
    setEnv("GOOGLE_CLOUD_PROJECT", "project-one");
    setEnv("GOOGLE_CLOUD_LOCATION", "global");
    const adc = routedProviderConfig("google-vertex", provider);
    expect(providerApiKeySelectionIsCurrent(config, "google-vertex", adc)).toBe(true);
    setEnv("GOOGLE_CLOUD_PROJECT", "project-two");
    expect(providerApiKeySelectionIsCurrent(config, "google-vertex", adc)).toBe(false);
    const changedProject = routedProviderConfig("google-vertex", provider);
    setEnv("GOOGLE_CLOUD_LOCATION", "us-central1");
    expect(providerApiKeySelectionIsCurrent(config, "google-vertex", changedProject)).toBe(false);
    setEnv("GOOGLE_CLOUD_API_KEY", "fixture-env-key");
    expect(providerApiKeySelectionIsCurrent(config, "google-vertex", adc)).toBe(false);
    const key = routedProviderConfig("google-vertex", provider);
    expect(key.apiKey).toBeUndefined();
    expect(providerApiKeySelectionIsCurrent(config, "google-vertex", key)).toBe(true);
    setEnv("GOOGLE_CLOUD_API_KEY", "replacement-env-key");
    expect(providerApiKeySelectionIsCurrent(config, "google-vertex", key)).toBe(false);
    const placeholder = { ...provider, apiKey: "N/A" };
    config.providers["google-vertex"] = placeholder;
    const fallback = routedProviderConfig("google-vertex", placeholder);
    expect(fallback.apiKey).toBe("N/A");
    expect(providerApiKeySelectionIsCurrent(config, "google-vertex", fallback)).toBe(true);
    setEnv("GOOGLE_CLOUD_API_KEY", "third-env-key");
    expect(providerApiKeySelectionIsCurrent(config, "google-vertex", fallback)).toBe(false);
  });

  test("management saves and reloads a renamed keyless Vertex provider", async () => {
    const config = { port: 0, defaultProvider: "fixture", providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example/v1" },
    } } as OcxConfig;
    saveConfig(config);
    const destination = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    try {
      const request = new ManagementRequest("http://127.0.0.1/api/providers", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "my-vertex", provider: { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key", googleMode: "vertex", project: "demo-project", location: "global", defaultModel: "gemini-3-pro", liveModels: false } }) });
      const response = await handleManagementAPI(request, new URL(request.url), config, { createManagementConvergeCodex: catalogConvergenceFactory() });
      expect(response?.status).toBe(200);
      expect(loadConfig().providers["my-vertex"]).toMatchObject({ googleMode: "vertex", project: "demo-project", location: "global" });
      expect(loadConfig().providers["my-vertex"]?.apiKey).toBeUndefined();
      const read = new ManagementRequest("http://127.0.0.1/api/config");
      const readResponse = await handleManagementAPI(read, new URL(read.url), config, { createManagementConvergeCodex: catalogConvergenceFactory() });
      const dto = await readResponse!.json() as { providers: Record<string, Record<string, unknown>> };
      expect(dto.providers["my-vertex"]).toMatchObject({ googleMode: "vertex", project: "demo-project", location: "global", hasApiKey: false });
      expect(dto.providers["my-vertex"]).not.toHaveProperty("apiKey");
      const probe = new ManagementRequest("http://127.0.0.1/api/providers/test?name=my-vertex", { method: "POST" });
      const probeResponse = await handleManagementAPI(probe, new URL(probe.url), config, { createManagementConvergeCodex: catalogConvergenceFactory() });
      expect(await probeResponse!.json()).toMatchObject({ applicable: false, reason: "static_catalog" });
      const patch = new ManagementRequest("http://127.0.0.1/api/providers?name=my-vertex", { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: "new-project", location: "" }) });
      const patchResponse = await handleManagementAPI(patch, new URL(patch.url), config, { createManagementConvergeCodex: catalogConvergenceFactory() });
      expect(patchResponse?.status).toBe(200);
      expect(loadConfig().providers["my-vertex"]?.project).toBe("new-project");
      expect(loadConfig().providers["my-vertex"]?.location).toBeUndefined();
      const invalid = new ManagementRequest("http://127.0.0.1/api/providers?name=my-vertex", { method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: "invalid.example" }) });
      const invalidResponse = await handleManagementAPI(invalid, new URL(invalid.url), config, { createManagementConvergeCodex: catalogConvergenceFactory() });
      expect(invalidResponse?.status).toBe(400);
      expect(loadConfig().providers["my-vertex"]?.location).toBeUndefined();
    } finally {
      destination.mockRestore();
    }
  });

  test("a keyless Vertex provider sends a proxy chat request with ADC", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key", googleMode: "vertex", project: "demo-project", location: "global" } as OcxProviderConfig;
    const config = { port: 0, defaultProvider: "google-vertex", providers: { "google-vertex": provider } } as OcxConfig;
    const releaseOwner = acquireOwnedSpendHome();
    saveConfig(config);
    const priorFetch = globalThis.fetch;
    const sent: Array<{ url: string; authorization: string | null; apiKey: string | null }> = [];
    let tokenRequests = 0;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === OAUTH_TOKEN_URL) { tokenRequests++; return Response.json({ access_token: "vertex-tok", expires_in: 3600 }); }
      const headers = new Headers(init?.headers);
      sent.push({ url, authorization: headers.get("authorization"), apiKey: headers.get("x-goog-api-key") });
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }] })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    Object.assign(provider, { fetch: globalThis.fetch });
    const configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => globalThis.fetch(input, init));
    try {
      const request = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "google-vertex/gemini-3-pro", messages: [{ role: "user", content: "hello" }], stream: false }) });
      const logContext = { model: "", provider: "" };
      const response = await handleChatCompletions(request, config, logContext);
      if (response.status !== 200) throw new Error(`Proxy returned ${response.status}: ${await response.text()}`);
      expect(response.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(tokenRequests).toBe(1);
      expect(sent[0]).toMatchObject({ authorization: "Bearer vertex-tok", apiKey: null });
      expect(sent[0]!.url).toContain("/v1/projects/demo-project/locations/global/");
    } finally {
      configuredFetch.mockRestore();
      globalThis.fetch = priorFetch;
      releaseOwner();
    }
  });

  test("physical Vertex dispatch refuses a bearer whose ADC source changed after build", async () => {
    const replacementPath = join(tmp, "adc-after-build.json");
    writeFileSync(replacementPath, JSON.stringify({ type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "fixture-refresh" }));
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key", googleMode: "vertex", project: "demo-project", location: "global" } as OcxProviderConfig;
    const config = { port: 0, defaultProvider: "google-vertex", providers: { "google-vertex": provider } } as OcxConfig;
    const releaseOwner = acquireOwnedSpendHome();
    saveConfig(config);
    const priorFetch = globalThis.fetch;
    const sent: string[] = [];
    let tokens = 0;
    globalThis.fetch = (async (input, init) => {
      if (String(input) === OAUTH_TOKEN_URL) return Response.json({ access_token: `fixture-token-${++tokens}`, expires_in: 3600 });
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }] })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    Object.assign(provider, { fetch: globalThis.fetch });
    const configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => globalThis.fetch(input, init));
    let rotated = false;
    const unregister = registerUpstreamRewriter("fixture-adc-rotation", target => {
      if (target.url.includes("aiplatform.googleapis.com")) { rotated = true; setEnv("GOOGLE_APPLICATION_CREDENTIALS", replacementPath); }
    });
    try {
      const request = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "google-vertex/gemini-3-pro", messages: [{ role: "user", content: "hello" }], stream: false }) });
      await handleChatCompletions(request, config, { model: "", provider: "" });
      expect(tokens).toBeGreaterThanOrEqual(1);
      expect(rotated).toBe(true);
      expect(sent).not.toContain("Bearer fixture-token-1");
    } finally {
      unregister();
      configuredFetch.mockRestore();
      globalThis.fetch = priorFetch;
      releaseOwner();
    }
  });

  test("a changed model wire never rebuilds using the old Vertex policy", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const name = "custom-vertex";
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key", googleMode: "vertex", project: "demo-project", location: "global" } as OcxProviderConfig;
    const config = { port: 0, defaultProvider: name, providers: { [name]: provider } } as OcxConfig;
    const releaseOwner = acquireOwnedSpendHome();
    saveConfig(config);
    const priorFetch = globalThis.fetch;
    const sent: string[] = [];
    let changed = false;
    globalThis.fetch = (async (input, init) => {
      if (String(input) === OAUTH_TOKEN_URL) return Response.json({ access_token: "fixture-token", expires_in: 3600 });
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({});
    }) as typeof fetch;
    Object.assign(provider, { fetch: globalThis.fetch });
    const configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => globalThis.fetch(input, init));
    const unregister = registerUpstreamRewriter("fixture-model-wire-change", target => {
      if (!changed && target.url.includes("aiplatform.googleapis.com")) {
        changed = true;
        config.providers[name]!.modelAdapters = { "gemini-3-pro": "openai-chat" };
      }
    });
    try {
      const request = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `${name}/gemini-3-pro`, messages: [{ role: "user", content: "hello" }], stream: false }) });
      await handleChatCompletions(request, config, { model: "", provider: "" });
      expect(changed).toBe(true);
      expect(sent).not.toContain("Bearer fixture-token");
    } finally {
      unregister();
      configuredFetch.mockRestore();
      globalThis.fetch = priorFetch;
      releaseOwner();
    }
  });

  test("client cancellation detaches a token exchange started by a Vertex rebuild", async () => {
    const replacement = join(tmp, "adc-rebuild-cancel.json");
    writeFileSync(replacement, JSON.stringify({ type: "authorized_user", client_id: "fixture-client", client_secret: "fixture-secret", refresh_token: "fixture-refresh" }));
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key", googleMode: "vertex", project: "demo-project", location: "global" } as OcxProviderConfig;
    const config = { port: 0, defaultProvider: "google-vertex", providers: { "google-vertex": provider } } as OcxConfig;
    const releaseOwner = acquireOwnedSpendHome();
    saveConfig(config);
    const priorFetch = globalThis.fetch;
    let tokenCalls = 0;
    let tokenSignal: AbortSignal | null | undefined;
    let releaseToken!: (response: Response) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    globalThis.fetch = (async (input, init) => {
      if (String(input) === OAUTH_TOKEN_URL) {
        if (++tokenCalls === 1) return Response.json({ access_token: "fixture-first", expires_in: 3600 });
        tokenSignal = init?.signal;
        signalStarted();
        return new Promise<Response>(resolve => { releaseToken = resolve; });
      }
      return Response.json({});
    }) as typeof fetch;
    Object.assign(provider, { fetch: globalThis.fetch });
    const configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => globalThis.fetch(input, init));
    let rotated = false;
    const unregister = registerUpstreamRewriter("fixture-rebuild-cancel", target => {
      if (!rotated && target.url.includes("aiplatform.googleapis.com")) { rotated = true; setEnv("GOOGLE_APPLICATION_CREDENTIALS", replacement); }
    });
    const client = new AbortController();
    let pending: Promise<Response> | undefined;
    try {
      const request = new Request("http://localhost/v1/chat/completions", { method: "POST", signal: client.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "google-vertex/gemini-3-pro", messages: [{ role: "user", content: "hello" }], stream: false }) });
      pending = handleChatCompletions(request, config, { model: "", provider: "" });
      await started;
      client.abort();
      await Promise.resolve();
      expect(tokenSignal?.aborted).toBe(true);
    } finally {
      releaseToken?.(Response.json({ access_token: "fixture-second", expires_in: 3600 }));
      await pending?.catch(() => undefined);
      unregister();
      configuredFetch.mockRestore();
      globalThis.fetch = priorFetch;
      releaseOwner();
    }
  });

  for (const changed of ["ambient-key", "destination", "header", "provider-disabled"] as const) {
    test(`physical Vertex dispatch refuses a changed ${changed}`, async () => {
      setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
      if (changed === "ambient-key") setEnv("GOOGLE_CLOUD_API_KEY", "fixture-ambient-one");
      const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key", googleMode: "vertex", project: "demo-project", location: "global" } as OcxProviderConfig;
      const config = { port: 0, defaultProvider: "google-vertex", providers: { "google-vertex": provider } } as OcxConfig;
      const releaseOwner = acquireOwnedSpendHome();
      saveConfig(config);
      const priorFetch = globalThis.fetch;
      const sent: Array<{ url: string; key: string | null }> = [];
      let modified = false;
      globalThis.fetch = (async (input, init) => {
        if (String(input) === OAUTH_TOKEN_URL) return Response.json({ access_token: "fixture-token", expires_in: 3600 });
        sent.push({ url: String(input), key: new Headers(init?.headers).get("x-goog-api-key") });
        return Response.json({});
      }) as typeof fetch;
      Object.assign(provider, { fetch: globalThis.fetch });
      const configuredFetch = spyOn(proxyEnv, "configuredOutboundFetch").mockImplementation((input, init) => globalThis.fetch(input, init));
      const unregister = registerUpstreamRewriter("fixture-vertex-authority", target => {
        if (!target.url.includes("aiplatform.googleapis.com")) return;
        modified = true;
        if (changed === "ambient-key") setEnv("GOOGLE_CLOUD_API_KEY", "fixture-ambient-two");
        if (changed === "destination") target.url = "https://external.example/collect";
        if (changed === "header") target.headers.set("authorization", "Bearer replacement");
        if (changed === "provider-disabled") config.providers["google-vertex"]!.disabled = true;
      });
      try {
        const request = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "google-vertex/gemini-3-pro", messages: [{ role: "user", content: "hello" }], stream: false }) });
        await handleChatCompletions(request, config, { model: "", provider: "" });
        expect(modified).toBe(true);
        if (changed === "ambient-key") expect(sent.every(entry => entry.key !== "fixture-ambient-one")).toBe(true);
        else expect(sent).toEqual([]);
      } finally {
        unregister();
        configuredFetch.mockRestore();
        globalThis.fetch = priorFetch;
        releaseOwner();
      }
    });
  }
  test("service_account flow signs an RS256 JWT and returns the access token", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const tok = await getVertexAccessToken();
    expect(tok).toBe("vertex-tok");
    expect(oauthCalls).toBe(1);
    const params = new URLSearchParams(lastBody);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = params.get("assertion") ?? "";
    expect(assertion.split(".")).toHaveLength(3); // header.payload.signature
  });

  test("token is cached within the refresh skew (no second fetch)", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    await getVertexAccessToken();
    await getVertexAccessToken();
    expect(oauthCalls).toBe(1);
  });

  test("expired GCP ADC token is removed by the periodic sweep registration", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    await getVertexAccessToken();
    expect(oauthCalls).toBe(1);
    const registration = STATE_STORE_REGISTRATIONS.find(row => row.name === "gcp-adc")!;
    expect(registration.sweepExpired?.(Date.now() + 3_600_000)).toBe(1);
    await getVertexAccessToken();
    expect(oauthCalls).toBe(2);
  });

  test("concurrent callers share one in-flight token fetch", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const [a, b, c] = await Promise.all([getVertexAccessToken(), getVertexAccessToken(), getVertexAccessToken()]);
    expect([a, b, c]).toEqual(["vertex-tok", "vertex-tok", "vertex-tok"]);
    expect(oauthCalls).toBe(1);
  });

  test("CLOUDSDK_CONFIG redirects the user ADC lookup (authorized_user flow)", async () => {
    // The host shell may export GOOGLE_APPLICATION_CREDENTIALS; clear it so the
    // resolver falls through to the gcloud user ADC path under test.
    prevEnv.GOOGLE_APPLICATION_CREDENTIALS ??= process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const configDir = join(tmp, "cloudsdk-config");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "application_default_credentials.json"),
      JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "sec", refresh_token: "rtok" }),
    );
    setEnv("CLOUDSDK_CONFIG", configDir);
    const tok = await getVertexAccessToken();
    expect(tok).toBe("vertex-tok");
    const params = new URLSearchParams(lastBody);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rtok");
  });
});

describe("google adapter vertex mode", () => {
  test("vertex + api key -> aiplatform host + x-goog-api-key (no ADC fetch)", async () => {
    const provider = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", googleMode: "vertex", apiKey: "real-key" } as OcxProviderConfig;
    const req = await createGoogleAdapter(provider).buildRequest(parsed());
    expect(req.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse");
    expect(req.headers["x-goog-api-key"]).toBe("real-key");
    expect(oauthCalls).toBe(0);
  });

  test("vertex API key honors an explicit project and global location without ADC", async () => {
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", apiKey: "fixture-key", project: "fixture-project", location: "global" } as OcxProviderConfig;
    const req = await createGoogleAdapter(provider).buildRequest(parsed("gemini-4-argon"));
    expect(req.url).toBe("https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
    expect(req.headers["x-goog-api-key"]).toBe("fixture-key");
    expect(req.headers.Authorization).toBeUndefined();
    expect(oauthCalls).toBe(0);
  });

  test("ambient project and location leave a projectless API key on express mode", async () => {
    setEnv("GOOGLE_CLOUD_PROJECT", "unrelated-gcloud-default");
    setEnv("GCLOUD_PROJECT", "unrelated-gcloud-default");
    setEnv("GOOGLE_CLOUD_LOCATION", "eu");
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", apiKey: "fixture-key" } as OcxProviderConfig;
    const req = await createGoogleAdapter(provider).buildRequest(parsed("gemini-4-argon"));
    expect(req.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
    expect(req.headers["x-goog-api-key"]).toBe("fixture-key");
    expect(oauthCalls).toBe(0);
  });

  test("a blank provider project is unset for API keys and ADC", async () => {
    const keyed = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", apiKey: "fixture-key", project: "   " } as OcxProviderConfig;
    const req = await createGoogleAdapter(keyed).buildRequest(parsed("gemini-4-argon"));
    expect(req.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    setEnv("GOOGLE_CLOUD_PROJECT", "env-proj");
    const adc = { adapter: "google", baseUrl: "https://x", googleMode: "vertex", project: " ", location: "global" } as OcxProviderConfig;
    const adcReq = await createGoogleAdapter(adc).buildRequest(parsed());
    expect(adcReq.url).toBe("https://aiplatform.googleapis.com/v1/projects/env-proj/locations/global/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse");
  });

  test("vertex API key project endpoint defaults to global and ignores ambient location", async () => {
    setEnv("GOOGLE_CLOUD_LOCATION", "us-central1");
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", apiKey: "fixture-key", project: "fixture-project" } as OcxProviderConfig;
    const req = await createGoogleAdapter(provider).buildRequest(parsed("gemini-4-argon"));
    expect(req.url).toBe("https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
  });

  test("vertex API key honors an explicit regional location and non-streaming method", async () => {
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", apiKey: "fixture-key", project: "fixture project", location: "us-central1" } as OcxProviderConfig;
    const req = await createGoogleAdapter(provider).buildRequest({ ...parsed("gemini-2.5-pro"), stream: false } as OcxParsedRequest);
    expect(req.url).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/fixture%20project/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent");
    expect(req.headers["x-goog-api-key"]).toBe("fixture-key");
    expect(req.headers.Authorization).toBeUndefined();
  });

  test("environment API key uses the configured provider project", async () => {
    setEnv("GOOGLE_CLOUD_API_KEY", "env-key");
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", project: "fixture-project", location: "eu" } as OcxProviderConfig;
    const req = await createGoogleAdapter(provider).buildRequest(parsed("gemini-4-argon"));
    expect(req.url).toBe("https://eu-aiplatform.googleapis.com/v1/projects/fixture-project/locations/eu/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
    expect(req.headers["x-goog-api-key"]).toBe("env-key");
    expect(oauthCalls).toBe(0);
  });

  test("vertex accepts dotted and versioned model ids unchanged", async () => {
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", apiKey: "fixture-key" } as OcxProviderConfig;
    for (const id of ["gemini-2.5-flash-lite", "gemini-3.6-flash", "gemini-x@001"]) {
      const req = await createGoogleAdapter(provider).buildRequest(parsed(id));
      expect(req.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/" + id + ":streamGenerateContent?alt=sse");
    }
  });

  test("vertex rejects model ids that escape the model path segment before any credential", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const providers = [
      { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", apiKey: "fixture-key" },
      { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", apiKey: "fixture-key", project: "fixture-project" },
      { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", project: "fixture-project", location: "global" },
    ] as OcxProviderConfig[];
    for (const provider of providers) {
      for (const id of ["a/b", "a?b", "a#b", "a\\b", "a%2Fb", "..", "gemini..x", ""]) {
        await expect(createGoogleAdapter(provider).buildRequest(parsed(id))).rejects.toThrow("Vertex AI model id must be a single path segment");
      }
    }
    expect(oauthCalls).toBe(0);
  });

  test("vertex API key validates project endpoint locations before sending credentials", async () => {
    const provider = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", apiKey: "fixture-key", project: "fixture-project", location: "attacker.example/capture" } as OcxProviderConfig;
    await expect(createGoogleAdapter(provider).buildRequest(parsed())).rejects.toThrow("Vertex AI location must be a single lowercase Google Cloud location label");
    expect(oauthCalls).toBe(0);
  });

  test("vertex + ADC -> regional host + Authorization Bearer", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const provider = { adapter: "google", baseUrl: "https://x", googleMode: "vertex", project: "proj-1", location: "us-central1" } as OcxProviderConfig;
    const req = await createGoogleAdapter(provider).buildRequest(parsed());
    expect(req.url).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse");
    expect(req.headers["Authorization"]).toBe("Bearer vertex-tok");
  });

  test("vertex + ADC keeps the environment project aliases and location fallback", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    setEnv("GOOGLE_CLOUD_LOCATION", "europe-west4");
    const provider = { adapter: "google", baseUrl: "https://x", googleMode: "vertex" } as OcxProviderConfig;
    setEnv("GOOGLE_CLOUD_PROJECT", "env-proj");
    let req = await createGoogleAdapter(provider).buildRequest(parsed());
    expect(req.url).toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/env-proj/locations/europe-west4/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse");
    expect(req.headers["Authorization"]).toBe("Bearer vertex-tok");
    delete process.env.GOOGLE_CLOUD_PROJECT;
    setEnv("GCLOUD_PROJECT", "alias-proj");
    req = await createGoogleAdapter(provider).buildRequest(parsed());
    expect(req.url).toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/alias-proj/locations/europe-west4/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse");
  });

  test("vertex + ADC still requires a project and a location", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const noProject = { adapter: "google", baseUrl: "https://x", googleMode: "vertex", location: "global" } as OcxProviderConfig;
    await expect(createGoogleAdapter(noProject).buildRequest(parsed())).rejects.toThrow("Vertex AI requires a project id");
    const noLocation = { adapter: "google", baseUrl: "https://x", googleMode: "vertex", project: "proj-1" } as OcxProviderConfig;
    await expect(createGoogleAdapter(noLocation).buildRequest(parsed())).rejects.toThrow("Vertex AI requires a location");
    expect(oauthCalls).toBe(0);
  });

  test("vertex + ADC + location global -> global aiplatform host", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const provider = { adapter: "google", baseUrl: "https://x", googleMode: "vertex", project: "proj-1", location: "global" } as OcxProviderConfig;
    const req = await createGoogleAdapter(provider).buildRequest(parsed());
    expect(req.url).toBe("https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse");
  });

  test("vertex + ADC rejects a location that can alter the request authority before fetching a token", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const provider = {
      adapter: "google",
      baseUrl: "https://x",
      googleMode: "vertex",
      project: "proj-1",
      location: "attacker.example:443/capture#",
    } as OcxProviderConfig;
    await expect(createGoogleAdapter(provider).buildRequest(parsed())).rejects.toThrow(
      "Vertex AI location must be a single lowercase Google Cloud location label",
    );
    expect(oauthCalls).toBe(0);
  });

  test("provider management rejects unsafe Vertex locations, including registry-backfilled mode", () => {
    const explicit = {
      adapter: "google",
      baseUrl: "https://aiplatform.googleapis.com",
      googleMode: "vertex",
      location: "attacker.example/path",
    } as OcxProviderConfig;
    expect(providerManagementConfigError("custom-vertex", explicit)).toContain(
      "Vertex AI location must be a single lowercase Google Cloud location label",
    );

    const registryBackfilled = {
      adapter: "google",
      baseUrl: "https://aiplatform.googleapis.com",
      location: "attacker.example/path",
    } as OcxProviderConfig;
    expect(providerManagementConfigError("google-vertex", registryBackfilled)).toContain(
      "Vertex AI location must be a single lowercase Google Cloud location label",
    );
  });

  test("provider management preserves legitimate Vertex locations", () => {
    for (const location of ["global", "us-central1", "europe-west4", "us"]) {
      const provider = {
        adapter: "google",
        baseUrl: "https://aiplatform.googleapis.com",
        googleMode: "vertex",
        location,
      } as OcxProviderConfig;
      expect(providerManagementConfigError("custom-vertex", provider)).toBeNull();
    }
  });

  test("ai-studio default mode is unchanged (no regression)", async () => {
    const provider = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "ai-key" } as OcxProviderConfig;
    const req = await createGoogleAdapter(provider).buildRequest(parsed());
    expect(req.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse");
    expect(req.headers["x-goog-api-key"]).toBe("ai-key");
    expect(oauthCalls).toBe(0);
  });
});

describe("gcp-adc token-exchange hardening", () => {
  // This block installs its own per-test flaky OAuth mock (the file-level mock always returns 200).
  test("retries a transient 503 then succeeds", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    __resetVertexTokenCache();
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === OAUTH_TOKEN_URL) {
        calls++;
        if (calls === 1) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ access_token: "tok-after-retry", expires_in: 3600 }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const tok = await getVertexAccessToken();
    expect(tok).toBe("tok-after-retry");
    expect(calls).toBe(2);
  });

  test("retries a thrown network error then succeeds", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    __resetVertexTokenCache();
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === OAUTH_TOKEN_URL) {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        return new Response(JSON.stringify({ access_token: "tok-net", expires_in: 3600 }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const tok = await getVertexAccessToken();
    expect(tok).toBe("tok-net");
    expect(calls).toBe(2);
  });

  test("fails fast on a non-retryable 400 and never leaks the response body", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    __resetVertexTokenCache();
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === OAUTH_TOKEN_URL) {
        calls++;
        return new Response("invalid_grant: secret-grant-detail", { status: 400 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    let caught: Error | undefined;
    try { await getVertexAccessToken(); } catch (e) { caught = e as Error; }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("400");
    expect(caught!.message).not.toContain("secret-grant-detail");
    expect(calls).toBe(1);
  });

  test("does not serve a cached token from a different ADC source after the source changes", async () => {
    __resetVertexTokenCache();
    // First resolve with the SA file → caches under source `gac:<saPath>`.
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    let tokenValue = "tok-source-A";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === OAUTH_TOKEN_URL) return new Response(JSON.stringify({ access_token: tokenValue, expires_in: 3600 }), { status: 200 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    expect(await getVertexAccessToken()).toBe("tok-source-A");
    // Change the source to a missing file: the stale cached token must NOT be returned; resolve fails.
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", join(tmp, "missing-adc.json"));
    let caught: Error | undefined;
    try { await getVertexAccessToken(); } catch (e) { caught = e as Error; }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("missing file");
  });

  test("invalidates the cached token when the SAME ADC file is rewritten in place", async () => {
    __resetVertexTokenCache();
    const saB = join(tmp, "rotated-sa.json");
    const { writeFileSync: wf } = await import("node:fs");
    // Reuse the existing SA PEM by copying the seeded SA file content.
    const original = (await import("node:fs")).readFileSync(saPath, "utf8");
    wf(saB, original);
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saB);
    let issued = "tok-before-rotation";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url === OAUTH_TOKEN_URL) return new Response(JSON.stringify({ access_token: issued, expires_in: 3600 }), { status: 200 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    expect(await getVertexAccessToken()).toBe("tok-before-rotation");
    // Rewrite the same path with new content + a newer mtime → cache key changes → re-resolves.
    await new Promise(r => setTimeout(r, 10));
    wf(saB, original + "\n");
    issued = "tok-after-rotation";
    expect(await getVertexAccessToken()).toBe("tok-after-rotation");
  });
});
