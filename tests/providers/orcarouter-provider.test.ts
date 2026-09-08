import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogHintsFromModelsApiItem } from "../../src/codex/catalog/provider-fetch";
import { providerDestinationConfigError } from "../../src/lib/destination-policy";
import {
  forceRefreshOAuthAccessSnapshot,
  getValidAccessTokenSnapshot,
  OAUTH_PROVIDERS,
  upsertOAuthProvider,
} from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS } from "../../src/oauth/key-providers";
import {
  normalizeOrcaRouterBaseUrl,
  OrcaRouterOAuthFlow,
  orcaRouterAuthBaseUrl,
  orcaRouterInferenceBaseUrl,
  refreshOrcaRouterKey,
} from "../../src/oauth/orcarouter";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import {
  extractProviderModelItems,
  providerModelDiscoverySpecError,
  resolveProviderModelDiscovery,
  resolveProviderModelDiscoveryUrl,
} from "../../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import type { OcxConfig } from "../../src/types";
import { en } from "../../gui/src/i18n/en";
import { interpolate, type TFn } from "../../gui/src/i18n/shared";
import { formatProviderDisplayName, providerIconSrc } from "../../gui/src/provider-icons";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const englishT: TFn = (key, vars) => interpolate(en[key], vars);
const originEnvNames = ["ORCAROUTER_BASE_URL", "ORCAROUTER_API_BASE_URL", "ORCAROUTER_AUTH_BASE_URL"] as const;
const originalOrigins = originEnvNames.map(name => process.env[name]);

beforeEach(() => {
  for (const name of originEnvNames) delete process.env[name];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  originEnvNames.forEach((name, index) => {
    const value = originalOrigins[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
});

function registryEntry(id: "orcarouter" | "orcarouter-oauth") {
  const entry = PROVIDER_REGISTRY.find(row => row.id === id);
  if (!entry) throw new Error(`missing ${id} registry entry`);
  return entry;
}

/** Keep the callback listener and PKCE exchange real; replace only the upstream response. */
async function exchangeThroughCallback(payload: unknown) {
  const abort = new AbortController();
  const callbackDone = Promise.withResolvers<void>();
  let exchanges = 0;
  let challenge: string | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("https://www.orcarouter.ai/api/v1/auth/keys");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.code).toBe("callback-test-code");
    expect(body.code_challenge_method).toBe("S256");
    expect(createHash("sha256").update(String(body.code_verifier)).digest("base64url"))
      .toBe(challenge);
    exchanges++;
    return Response.json(payload);
  }) as typeof fetch;
  const flow = new OrcaRouterOAuthFlow({
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
    onAuth: ({ url }) => {
      void (async () => {
        const auth = new URL(url);
        challenge = auth.searchParams.get("code_challenge");
        expect(auth.searchParams.get("scope")).toBe("api");
        const callback = new URL(auth.searchParams.get("callback_url")!);
        expect(callback.hostname).toBe("127.0.0.1");
        callback.search = new URLSearchParams({ code: "callback-test-code", state: "wrong-state" }).toString();
        const rejected = await originalFetch(callback);
        expect(rejected.status).toBe(400);
        await rejected.text();
        expect(exchanges).toBe(0);
        callback.searchParams.set("state", auth.searchParams.get("state")!);
        const accepted = await originalFetch(callback);
        expect(accepted.status).toBe(200);
        await accepted.text();
      })().then(callbackDone.resolve, callbackDone.reject);
    },
  });
  // Observe a rejected exchange immediately, while the callback HTTP response drains.
  const login = flow.login().then(
    credential => ({ ok: true as const, credential }),
    error => ({ ok: false as const, error }),
  );
  try {
    const [result] = await Promise.all([login, callbackDone.promise]);
    expect(exchanges).toBe(1);
    if (!result.ok) throw result.error;
    return result.credential;
  } finally {
    abort.abort();
    await login;
  }
}

describe("OrcaRouter dual authentication", () => {
  test("keeps API-key and PKCE account login as explicit first-class choices", () => {
    const key = registryEntry("orcarouter");
    const oauth = registryEntry("orcarouter-oauth");
    expect(key).toMatchObject({
      authKind: "key",
      adapter: "openai-chat",
      baseUrl: "https://api.orcarouter.ai/v1",
      liveModels: true,
      apiKeyValidation: "unknown",
    });
    expect(oauth).toMatchObject({
      authKind: "oauth",
      adapter: "openai-chat",
      baseUrl: "https://api.orcarouter.ai/v1",
      liveModels: true,
      allowBaseUrlOverride: true,
    });
    for (const entry of [key, oauth]) {
      expect(entry.models).toContain("openai/gpt-5.5");
      expect(entry.models).toContain("orcarouter/auto");
      expect(entry.modelReasoningEfforts?.["openai/gpt-5.5"])
        .toEqual(["low", "medium", "high", "xhigh"]);
      expect(entry.modelReasoningEfforts?.["deepseek/deepseek-v4-pro"]).toBeArray();
    }
    expect(KEY_LOGIN_PROVIDERS.orcarouter).toBeDefined();
    expect(OAUTH_PROVIDERS["orcarouter-oauth"]).toBeDefined();
    expect(deriveProviderPresets().find(row => row.id === "orcarouter")).toMatchObject({ auth: "key" });
    expect(deriveProviderPresets().find(row => row.id === "orcarouter-oauth")).toMatchObject({ auth: "oauth" });
    expect(formatProviderDisplayName("orcarouter", englishT)).toBe("OrcaRouter - API");
    expect(formatProviderDisplayName("orcarouter-oauth", englishT)).toBe("OrcaRouter - Auth");
    expect(providerIconSrc("orcarouter")).toBe("/provider-icons/orcarouter.svg");
    expect(providerIconSrc("orcarouter-oauth")).toBe("/provider-icons/orcarouter.svg");
  });

  test("discovers the live chat catalog with bounded declarative filtering", () => {
    const entry = registryEntry("orcarouter");
    expect(providerModelDiscoverySpecError(entry.modelDiscovery!)).toBeNull();
    expect(entry.models).toContain("openai/gpt-5.5");
    expect(entry.models).toContain("orcarouter/auto");
    const seed = providerConfigSeed(entry);
    const discovery = resolveProviderModelDiscovery("orcarouter", seed);
    expect(resolveProviderModelDiscoveryUrl(
      "orcarouter",
      seed,
      seed.baseUrl,
      `${seed.baseUrl}/models`,
    )).toBe("https://api.orcarouter.ai/v1/models?capability=chat");

    const result = extractProviderModelItems({
      data: [
        { id: "vendor/text", supported_endpoint_types: ["openai"], architecture: { input_modalities: ["text"] } },
        { id: "vendor/vision", supported_endpoint_types: ["openai-response"], architecture: { input_modalities: ["text", "image"] } },
        { id: "vendor/image", supported_endpoint_types: ["image-generation"] },
        { id: "vendor/rerank", supported_endpoint_types: ["jina-rerank", "openai"] },
        { id: "vendor/unknown", supported_endpoint_types: null },
      ],
    }, discovery);
    expect(result).toMatchObject({
      ok: true,
      rawCount: 5,
      items: [
        { id: "vendor/text" },
        { id: "vendor/vision" },
      ],
    });
  });

  test("maps OrcaRouter architecture.input_modalities into Codex-safe attachment metadata", () => {
    expect(catalogHintsFromModelsApiItem("orcarouter", {
      id: "vendor/vision",
      architecture: { input_modalities: ["file", "image", "text", "video"] },
    })).toEqual({ inputModalities: ["image", "text"] });
    expect(catalogHintsFromModelsApiItem("orcarouter", {
      id: "vendor/text",
      architecture: { input_modalities: ["text"] },
    })).toEqual({ inputModalities: ["text"] });
  });

  test("builds S256 authorization and exchanges at /api/v1/auth/keys without leaking secrets", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ key: "sk-orca-local-test", user_id: "user-42", scope: "api" });
    }) as typeof fetch;

    const flow = new OrcaRouterOAuthFlow({});
    const authorization = await flow.generateAuthUrl("state-42", "http://127.0.0.1:51733/callback");
    const url = new URL(authorization.url);
    expect(url.origin + url.pathname).toBe("https://www.orcarouter.ai/auth");
    expect(url.searchParams.get("callback_url")).toBe("http://127.0.0.1:51733/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-42");
    expect(url.searchParams.get("app_name")).toBe("OpenCodex");
    expect(url.searchParams.get("scope")).toBe("api");

    const credential = await flow.exchangeToken("single-use-code", "state-42", "ignored");
    expect(requestUrl).toBe("https://www.orcarouter.ai/api/v1/auth/keys");
    expect(requestBody).toMatchObject({
      code: "single-use-code",
      code_challenge_method: "S256",
    });
    const verifier = String(requestBody.code_verifier);
    expect(createHash("sha256").update(verifier).digest("base64url"))
      .toBe(url.searchParams.get("code_challenge"));
    expect(authorization.url).not.toContain(verifier);
    expect(credential).toEqual({
      access: "sk-orca-local-test",
      refresh: "sk-orca-local-test",
      expires: Number.MAX_SAFE_INTEGER,
      accountId: "user-42",
      source: "oauth",
    });

    const secretErrorBody = ["sk", "orca", "should-not-leak", verifier].join("-");
    globalThis.fetch = (async () => new Response(secretErrorBody, { status: 403 })) as typeof fetch;
    let message = "";
    try {
      await flow.exchangeToken("used-code", "state-42", "ignored");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("OrcaRouter key exchange failed with HTTP 403");
    expect(message).not.toContain(secretErrorBody);
    expect(message).not.toContain(verifier);
  });

  test("completes the real callback with documented key/user_id and no response scope", async () => {
    expect(await exchangeThroughCallback({ key: "sk-orca-callback-test", user_id: 123 })).toEqual({
      access: "sk-orca-callback-test",
      refresh: "sk-orca-callback-test",
      expires: Number.MAX_SAFE_INTEGER,
      accountId: "123",
      source: "oauth",
    });
  });

  test("completes the real callback with an explicit api scope and string identity", async () => {
    expect(await exchangeThroughCallback({ key: "sk-orca-callback-test", user_id: "user-42", scope: "api" }))
      .toMatchObject({ accountId: "user-42", source: "oauth" });
  });

  test.each(["admin", "api read", "", null, false, ["api"]].map(scope => [scope]))(
    "rejects an explicitly invalid response scope %j through the real callback",
    async scope => {
      await expect(exchangeThroughCallback({ key: "sk-orca-callback-test", user_id: 123, scope }))
        .rejects.toThrow("did not grant the required api scope");
    },
  );

  test.each([
    ["missing", undefined], ["null", null], ["blank", "  "], ["fractional", 1.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["object", {}],
    ["too long", "u".repeat(257)], ["control character", "user\x00id"],
  ])("rejects %s user identity even when scope is omitted", async (_name, user_id) => {
    await expect(exchangeThroughCallback({ key: "sk-orca-callback-test", user_id }))
      .rejects.toThrow("did not return a valid user id");
  });

  test.each([
    ["missing", undefined], ["non-string", 123], ["wrong prefix", "invalid-key"],
    ["too long", "sk-orca-" + "k".repeat(4089)], ["newline", "sk-orca-test\r\nkey"],
  ])("rejects %s API key even when scope is omitted", async (_name, key) => {
    await expect(exchangeThroughCallback({ key, user_id: 123 }))
      .rejects.toThrow("did not return a valid API key");
  });

  test.each([null, [], "invalid"].map(payload => [payload]))("rejects malformed exchange payload %j", async payload => {
    await expect(exchangeThroughCallback(payload)).rejects.toThrow("returned an invalid response");
  });

  test("splits the public auth and inference origins while preserving one-origin self-hosting", async () => {
    expect(orcaRouterAuthBaseUrl()).toBe("https://www.orcarouter.ai");
    expect(orcaRouterInferenceBaseUrl()).toBe("https://api.orcarouter.ai/v1");
    expect(normalizeOrcaRouterBaseUrl("https://router.example/v1/")).toBe("https://router.example");
    expect(orcaRouterInferenceBaseUrl("http://127.0.0.1:9999")).toBe("http://127.0.0.1:9999/v1");
    expect(() => normalizeOrcaRouterBaseUrl("http://router.example")).toThrow("must use HTTPS");
    expect(() => normalizeOrcaRouterBaseUrl("https://router.example/prefix")).toThrow("empty or /v1");
    const secret = "do-not-echo-this-password";
    let malformedMessage = "";
    try {
      normalizeOrcaRouterBaseUrl(`https://user:${secret}@`);
    } catch (error) {
      malformedMessage = error instanceof Error ? error.message : String(error);
    }
    expect(malformedMessage).toBe("OrcaRouter base URL is invalid");
    expect(malformedMessage).not.toContain(secret);

    const flow = new OrcaRouterOAuthFlow({}, { baseUrl: "https://router.example/v1" });
    const authorization = await flow.generateAuthUrl("state", "http://127.0.0.1:1/callback");
    expect(new URL(authorization.url).origin).toBe("https://router.example");

    const splitFlow = new OrcaRouterOAuthFlow({}, {
      baseUrl: "https://api.router.example/v1",
      authBaseUrl: "https://login.router.example",
    });
    const splitAuthorization = await splitFlow.generateAuthUrl("state", "http://127.0.0.1:1/callback");
    expect(new URL(splitAuthorization.url).origin).toBe("https://login.router.example");
  });

  test("preserves a configured self-hosted origin when account login publishes the provider", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "orcarouter-oauth",
      providers: {
        "orcarouter-oauth": {
          adapter: "openai-chat",
          baseUrl: "https://router.example/v1/",
          authMode: "oauth",
        },
      },
    };
    upsertOAuthProvider(config, "orcarouter-oauth");
    expect(config.providers["orcarouter-oauth"]).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://router.example/v1",
      authMode: "oauth",
      liveModels: true,
    });
  });

  test.each([true, false, undefined])(
    "preserves explicit loopback private-network consent %j through login upsert",
    allowPrivateNetwork => {
      process.env.ORCAROUTER_BASE_URL = "http://127.0.0.1:9999";
      const config: OcxConfig = {
        port: 10100,
        defaultProvider: "orcarouter-oauth",
        providers: {
          "orcarouter-oauth": {
            adapter: "openai-chat",
            baseUrl: "http://127.0.0.1:9999/v1",
            authMode: "oauth",
            ...(allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork }),
          },
        },
      };
      upsertOAuthProvider(config, "orcarouter-oauth");
      const provider = config.providers["orcarouter-oauth"]!;
      expect(provider).toMatchObject({ baseUrl: "http://127.0.0.1:9999/v1", authMode: "oauth", liveModels: true });
      expect(provider.allowPrivateNetwork).toBe(allowPrivateNetwork);
      const error = providerDestinationConfigError("orcarouter-oauth", provider);
      if (allowPrivateNetwork === true) expect(error).toBeNull();
      else expect(error).toContain("baseUrl must use https");
    },
  );

  test("does not grant loopback consent when first login creates the provider row", () => {
    process.env.ORCAROUTER_BASE_URL = "http://127.0.0.1:9999";
    const config: OcxConfig = { port: 10100, defaultProvider: "orcarouter-oauth", providers: {} };
    upsertOAuthProvider(config, "orcarouter-oauth");
    const provider = config.providers["orcarouter-oauth"]!;
    expect(provider.baseUrl).toBe("http://127.0.0.1:9999/v1");
    expect(provider.allowPrivateNetwork).toBeUndefined();
    expect(providerDestinationConfigError("orcarouter-oauth", provider)).toContain("baseUrl must use https");
  });

  test("treats an upstream-rejected durable key as terminal instead of inventing a refresh grant", async () => {
    await expect(refreshOrcaRouterKey("bad-key")).rejects.toThrow("reconnect");
    await expect(refreshOrcaRouterKey("sk-orca-existing-key"))
      .rejects.toThrow("invalid_grant");
  });

  test("generation-safely marks a rejected durable key as requiring a new login", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const testHome = mkdtempSync(join(tmpdir(), "ocx-orcarouter-401-"));
    process.env.OPENCODEX_HOME = testHome;
    try {
      await saveCredential("orcarouter-oauth", {
        access: "sk-orca-revoked-key",
        refresh: "sk-orca-revoked-key",
        expires: Number.MAX_SAFE_INTEGER,
        accountId: "user-42",
        source: "oauth",
      });
      const rejected = await getValidAccessTokenSnapshot("orcarouter-oauth");

      await expect(forceRefreshOAuthAccessSnapshot(rejected)).rejects.toThrow("Not logged in");
      const account = getAccountSet("orcarouter-oauth")?.accounts
        .find(candidate => candidate.id === rejected.accountId);
      expect(account?.needsReauth).toBe(true);
      expect(account?.credential.access).toBe("sk-orca-revoked-key");
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(testHome);
    }
  });
});
