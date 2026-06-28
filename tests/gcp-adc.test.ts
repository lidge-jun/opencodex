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
  writeFileSync(saPath, JSON.stringify({ type: "service_account", client_email: "t@test.iam.gserviceaccount.com", private_key: pem, private_key_id: "k1" }));
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
