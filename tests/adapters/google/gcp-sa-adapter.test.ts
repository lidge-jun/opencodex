import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { __resetVertexTokenCache } from "../../../src/lib/gcp-adc";
import { createGoogleAdapter } from "../../../src/adapters/google";
import { setProviderKeychainEntryFactoryForTests } from "../../../src/providers/key-store";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

function parsed(modelId = "gemini-3-pro"): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    context: { messages: [{ role: "user", content: "hi" }], systemPrompt: [], tools: [] },
    options: {},
  } as unknown as OcxParsedRequest;
}

afterEach(() => {
  __resetVertexTokenCache();
  setProviderKeychainEntryFactoryForTests(null);
});

describe("vertex adapter with a gcp-sa marker key", () => {
  test("marker resolves through the ADC branch (never the x-goog-api-key fast path)", async () => {
    // A real, signable RSA key so buildRequest reaches the actual signing step of the ADC branch.
    const kp = await globalViewGenerateKey();
    const pkcs8 = await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey);
    const b64 = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g)!.join("\n");
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
    const serviceAccount = JSON.stringify({ type: "service_account", client_email: "svc@example.test", private_key: pem, private_key_id: "k1" });

    // Stub fetch so the JWT exchange succeeds and NO network call carries x-goog-api-key.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })) as typeof fetch;

    // The marker in a keychain-backed store; the adapter passes its account to the ADC branch per
    // request (gcpCredentialMarkerAccount(provider.apiKey)) — no process-global registration.
    setProviderKeychainEntryFactoryForTests((service, account) => ({
      getPassword: () => (account === "p/mk1" ? serviceAccount : null),
      setPassword: () => {},
      deletePassword: () => true,
    }));
    const provider = {
      adapter: "google",
      baseUrl: "https://x",
      googleMode: "vertex",
      apiKey: "gcp-sa:p/mk1",
      project: "proj-1",
      location: "global",
    } as OcxProviderConfig;

    try {
      const req = await createGoogleAdapter(provider).buildRequest(parsed());
      // The produced request must NOT be the API-key fast path (which would carry the marker
      // itself as x-goog-api-key); it must be the ADC Bearer request.
      expect(req.url).toContain("/v1/projects/proj-1/locations/global/publishers/google/models/");
      expect(req.headers["x-goog-api-key"]).toBeUndefined();
      expect((req.headers["Authorization"] ?? "").startsWith("Bearer tok")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

async function globalViewGenerateKey(): Promise<CryptoKeyPair> {
  return globalThis.crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
}
