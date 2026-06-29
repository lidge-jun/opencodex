import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVertexAccessToken, __resetVertexTokenCache } from "../src/lib/gcp-adc";
import { createGoogleAdapter } from "../src/adapters/google";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

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
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  __resetVertexTokenCache();
  for (const k of ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"]) {
    if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k];
  }
  prevEnv = {};
  oauthCalls = 0;
});

function setEnv(k: string, v: string): void {
  prevEnv[k] = process.env[k];
  process.env[k] = v;
}

describe("gcp-adc resolver", () => {
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

  test("concurrent callers share one in-flight token fetch", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const [a, b, c] = await Promise.all([getVertexAccessToken(), getVertexAccessToken(), getVertexAccessToken()]);
    expect([a, b, c]).toEqual(["vertex-tok", "vertex-tok", "vertex-tok"]);
    expect(oauthCalls).toBe(1);
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

  test("vertex + ADC -> regional host + Authorization Bearer", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const provider = { adapter: "google", baseUrl: "https://x", googleMode: "vertex", project: "proj-1", location: "us-central1" } as OcxProviderConfig;
    const req = await createGoogleAdapter(provider).buildRequest(parsed());
    expect(req.url).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse");
    expect(req.headers["Authorization"]).toBe("Bearer vertex-tok");
  });

  test("vertex + ADC + location global -> global aiplatform host", async () => {
    setEnv("GOOGLE_APPLICATION_CREDENTIALS", saPath);
    const provider = { adapter: "google", baseUrl: "https://x", googleMode: "vertex", project: "proj-1", location: "global" } as OcxProviderConfig;
    const req = await createGoogleAdapter(provider).buildRequest(parsed());
    expect(req.url).toBe("https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/publishers/google/models/gemini-3-pro:streamGenerateContent?alt=sse");
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
