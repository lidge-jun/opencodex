import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  GEMINI_AI_STUDIO_PROVIDER,
  GEMINI_CODE_ASSIST_PROVIDER,
  discoverGeminiProject,
  geminiSubtypeForProvider,
  isGeminiOAuthSubtypeConfigured,
  refreshGeminiToken,
} from "../src/oauth/gemini-cli";
import { OAUTH_PROVIDERS, isPublicOAuthProvider } from "../src/oauth";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { deriveOAuthIds } from "../src/providers/derive";
import { geminiCliUserAgent } from "../src/adapters/client-fingerprint";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function routeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { calls };
}

describe("gemini oauth subtypes", () => {
  test("provider id maps to its subtype", () => {
    expect(geminiSubtypeForProvider(GEMINI_CODE_ASSIST_PROVIDER)).toBe("code-assist");
    expect(geminiSubtypeForProvider(GEMINI_AI_STUDIO_PROVIDER)).toBe("ai-studio");
  });

  test("code-assist is always configured; ai-studio needs operator client credentials", () => {
    expect(isGeminiOAuthSubtypeConfigured("code-assist")).toBe(true);
    // The built-in Gemini CLI client is not registered for the generative-language scopes, so
    // this subtype must fail closed rather than send a request Google rejects as restricted_client.
    const configured = isGeminiOAuthSubtypeConfigured("ai-studio");
    const hasOperatorClient = !!process.env.GEMINI_AI_STUDIO_OAUTH_CLIENT_ID?.trim()
      && !!process.env.GEMINI_AI_STUDIO_OAUTH_CLIENT_SECRET?.trim();
    expect(configured).toBe(hasOperatorClient);
  });

  test("both subtypes are registered as public OAuth providers derived from the registry", () => {
    for (const id of [GEMINI_CODE_ASSIST_PROVIDER, GEMINI_AI_STUDIO_PROVIDER]) {
      expect(OAUTH_PROVIDERS[id]).toBeDefined();
      expect(isPublicOAuthProvider(id)).toBe(true);
      // Registry-derived: without an authKind "oauth" entry, providerConfig/defaultModel are
      // undefined and the dashboard row would log in to nothing.
      expect(deriveOAuthIds()).toContain(id);
      expect(OAUTH_PROVIDERS[id]!.providerConfig).toBeDefined();
      expect(OAUTH_PROVIDERS[id]!.defaultModel).toBeTruthy();
    }
  });

  test("registry pins each subtype's googleMode and host", () => {
    const codeAssist = PROVIDER_REGISTRY.find(e => e.id === GEMINI_CODE_ASSIST_PROVIDER);
    expect(codeAssist?.googleMode).toBe("gemini-cli");
    expect(codeAssist?.baseUrl).toBe("https://cloudcode-pa.googleapis.com");
    const aiStudio = PROVIDER_REGISTRY.find(e => e.id === GEMINI_AI_STUDIO_PROVIDER);
    expect(aiStudio?.googleMode).toBe("ai-studio");
    expect(aiStudio?.baseUrl).toBe("https://generativelanguage.googleapis.com");
  });
});

describe("gemini code assist project discovery", () => {
  test("loadCodeAssist returns the project and sends the CLI User-Agent", async () => {
    let sawCliUa = false;
    routeFetch((url, init) => {
      if (url.includes(":loadCodeAssist")) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        // Must be the CLI client family, never `antigravity/ide/...`: the token was minted for
        // the Gemini CLI client and the header has to match it.
        sawCliUa = /^GeminiCLI\//.test(headers["User-Agent"] ?? "");
        return new Response(JSON.stringify({ cloudaicompanionProject: "proj-A" }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    expect(await discoverGeminiProject("tok")).toBe("proj-A");
    expect(sawCliUa).toBe(true);
  });

  test("extracts a project from the nested {id} shape", async () => {
    routeFetch(url => url.includes(":loadCodeAssist")
      ? new Response(JSON.stringify({ project: { id: "proj-nested" } }), { status: 200 })
      : new Response("no", { status: 404 }));
    expect(await discoverGeminiProject("tok")).toBe("proj-nested");
  });

  test("falls back to onboardUser and onboards into the default allowed tier", async () => {
    let onboardBody: string | undefined;
    let onboardCalls = 0;
    routeFetch((url, init) => {
      if (url.includes(":loadCodeAssist")) {
        return new Response(JSON.stringify({
          allowedTiers: [{ id: "legacy-tier" }, { id: "standard-tier", isDefault: true }],
        }), { status: 200 });
      }
      if (url.includes(":onboardUser")) {
        onboardCalls++;
        onboardBody = typeof init?.body === "string" ? init.body : undefined;
        if (onboardCalls === 1) return new Response(JSON.stringify({ done: false }), { status: 200 });
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: "proj-onboarded" } }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    expect(await discoverGeminiProject("tok")).toBe("proj-onboarded");
    // Sending a tier the account is not entitled to makes onboardUser fail closed, so the
    // advertised default must win over the free-tier fallback.
    expect(JSON.parse(onboardBody ?? "{}").tierId).toBe("standard-tier");
  });

  test("uses the free tier when loadCodeAssist advertises no default", async () => {
    let onboardBody: string | undefined;
    routeFetch((url, init) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes(":onboardUser")) {
        onboardBody = typeof init?.body === "string" ? init.body : undefined;
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: "p" } }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    await discoverGeminiProject("tok");
    expect(JSON.parse(onboardBody ?? "{}").tierId).toBe("free-tier");
  });

  test("gives up on a hard 4xx from onboardUser", async () => {
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes(":onboardUser")) return new Response("forbidden", { status: 403 });
      return new Response("no", { status: 404 });
    });
    expect(await discoverGeminiProject("tok")).toBeUndefined();
  });

  test("retries a transient 503 from onboardUser", async () => {
    let onboardCalls = 0;
    routeFetch((url) => {
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({}), { status: 200 });
      if (url.includes(":onboardUser")) {
        onboardCalls++;
        if (onboardCalls === 1) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ done: true, response: { cloudaicompanionProject: "proj-T" } }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    expect(await discoverGeminiProject("tok")).toBe("proj-T");
    expect(onboardCalls).toBe(2);
  });
});

describe("gemini refresh", () => {
  test("code-assist refresh keeps the refresh token and re-discovers the project", async () => {
    routeFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes(":loadCodeAssist")) return new Response(JSON.stringify({ cloudaicompanionProject: "proj-R" }), { status: 200 });
      return new Response("no", { status: 404 });
    });
    const issuedAt = 1_900_000_000_000;
    const nowSpy = spyOn(Date, "now").mockReturnValue(issuedAt);
    try {
      const cred = await refreshGeminiToken("refresh-tok", "code-assist");
      expect(cred.access).toBe("fresh-access");
      expect(cred.refresh).toBe("refresh-tok");
      expect(cred.projectId).toBe("proj-R");
      expect(cred.expires - issuedAt).toBe(55 * 60 * 1000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("code-assist refresh survives a project-discovery outage", async () => {
    routeFetch((url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600 }), { status: 200 });
      }
      // Discovery unavailable for this account: the token is still good, so refresh must not
      // fail the whole account. A hard 4xx (not a retryable 5xx) so onboarding gives up at once.
      return new Response("forbidden", { status: 403 });
    });
    const cred = await refreshGeminiToken("refresh-tok", "code-assist");
    expect(cred.access).toBe("fresh-access");
    expect(cred.projectId).toBeUndefined();
  });

  test("refresh failure carries status only, not the response body", async () => {
    routeFetch(url => url.includes("oauth2.googleapis.com/token")
      ? new Response("invalid_grant secret-detail", { status: 400 })
      : new Response("no", { status: 404 }));
    let caught: Error | undefined;
    try { await refreshGeminiToken("refresh-tok", "code-assist"); } catch (e) { caught = e as Error; }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("400");
    expect(caught!.message).not.toContain("secret-detail");
  });

  test("an empty refresh token is rejected before any network call", async () => {
    const { calls } = routeFetch(() => new Response("unexpected", { status: 500 }));
    await expect(refreshGeminiToken("", "code-assist")).rejects.toThrow(/refresh token/i);
    expect(calls).toEqual([]);
  });
});

function geminiCliProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "google",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    authMode: "oauth",
    googleMode: "gemini-cli",
    apiKey: "access-tok",
    project: "proj-X",
    defaultModel: "gemini-3.5-flash",
    models: ["gemini-3.5-flash"],
    ...overrides,
  } as OcxProviderConfig;
}

function parsedRequest(modelId = "gemini-3.5-flash", stream = false): OcxParsedRequest {
  return {
    modelId,
    stream,
    context: { messages: [{ role: "user", content: "hello world" }], systemPrompt: [], tools: [] },
    options: {},
  } as unknown as OcxParsedRequest;
}

describe("gemini-cli adapter envelope", () => {
  test("sends the CLI envelope and User-Agent, not the Antigravity IDE fingerprint", async () => {
    const built = await createGoogleAdapter(geminiCliProvider()).buildRequest(parsedRequest());
    expect(built.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:generateContent");
    expect(built.headers["Authorization"]).toBe("Bearer access-tok");
    expect(built.headers["User-Agent"]).toBe(geminiCliUserAgent());
    expect(built.headers["User-Agent"]).not.toContain("antigravity");

    const envelope = JSON.parse(built.body) as Record<string, unknown>;
    // The CLI envelope is exactly {model, project, request}. The Antigravity-only fields belong to
    // the IDE client family and would mismatch the client the CLI token was issued to.
    expect(Object.keys(envelope).toSorted()).toEqual(["model", "project", "request"]);
    expect(envelope.model).toBe("gemini-3.5-flash");
    expect(envelope.project).toBe("proj-X");
    expect(envelope.userAgent).toBeUndefined();
    expect(envelope.requestType).toBeUndefined();
    expect(envelope.requestId).toBeUndefined();
    expect((envelope.request as Record<string, unknown>).contents).toBeDefined();
  });

  test("sends the bare model id, not AI Studio's -tiered wire spelling", async () => {
    // `-tiered` is a direct Generative Language deployment quirk; CCA does not serve those ids.
    const built = await createGoogleAdapter(geminiCliProvider()).buildRequest(parsedRequest("gemini-3.6-flash"));
    expect((JSON.parse(built.body) as { model: string }).model).toBe("gemini-3.6-flash");
  });

  test("stream uses :streamGenerateContent?alt=sse", async () => {
    const built = await createGoogleAdapter(geminiCliProvider()).buildRequest(parsedRequest("gemini-3.5-flash", true));
    expect(built.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  });

  test("fails closed without a discovered Cloud Code Assist project", async () => {
    await expect(createGoogleAdapter(geminiCliProvider({ project: undefined })).buildRequest(parsedRequest()))
      .rejects.toThrow(/project/i);
  });

  test("fails closed without an OAuth token", async () => {
    await expect(createGoogleAdapter(geminiCliProvider({ apiKey: "" })).buildRequest(parsedRequest()))
      .rejects.toThrow(/token/i);
  });

  test("unwraps the CCA `response` wrapper like the Antigravity path does", async () => {
    const adapter = createGoogleAdapter(geminiCliProvider());
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      response: {
        candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
      },
    })));
    const text = (events as AdapterEvent[]).filter(e => e.type === "text_delta") as Extract<AdapterEvent, { type: "text_delta" }>[];
    expect(text.map(e => e.text).join("")).toBe("hello");
  });

  test("a payload missing the CCA wrapper is an error, not a silent empty turn", async () => {
    const adapter = createGoogleAdapter(geminiCliProvider());
    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "unwrapped" }] }, finishReason: "STOP" }],
    })));
    expect((events as AdapterEvent[]).some(e => e.type === "error" && /response wrapper/.test(e.message))).toBe(true);
  });
});

describe("gemini ai-studio oauth transport", () => {
  function aiStudioProvider(authMode: "oauth" | "key", apiKey: string): OcxProviderConfig {
    return {
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      authMode,
      googleMode: "ai-studio",
      apiKey,
    } as OcxProviderConfig;
  }

  test("an OAuth credential travels as a Bearer, never in x-goog-api-key", async () => {
    // The Generative Language API rejects a bearer token presented in the api-key header, so the
    // gemini-ai-studio subtype would be dead on arrival if it reused the API-key header.
    const built = await createGoogleAdapter(aiStudioProvider("oauth", "ya29.oauth-tok")).buildRequest(parsedRequest());
    expect(built.headers["Authorization"]).toBe("Bearer ya29.oauth-tok");
    expect(built.headers["x-goog-api-key"]).toBeUndefined();
    expect(built.url).toContain("/v1beta/models/gemini-3.5-flash:generateContent");
  });

  test("an API key still travels in x-goog-api-key", async () => {
    const built = await createGoogleAdapter(aiStudioProvider("key", "AIza-key")).buildRequest(parsedRequest());
    expect(built.headers["x-goog-api-key"]).toBe("AIza-key");
    expect(built.headers["Authorization"]).toBeUndefined();
  });
});
