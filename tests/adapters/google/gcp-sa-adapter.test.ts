import { afterEach, describe, expect, test } from "bun:test";
import {
  GCP_CREDENTIAL_MARKER_PREFIX,
  setActiveGcpCredentialMarker,
  __resetVertexTokenCache,
} from "../../../src/lib/gcp-adc";
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
  setActiveGcpCredentialMarker(undefined);
  setProviderKeychainEntryFactoryForTests(null);
});

describe("vertex adapter with a gcp-sa marker key", () => {
  test("marker does not take the x-goog-api-key fast path — ADC branch runs", async () => {
    const serviceAccount = JSON.stringify({
      type: "service_account",
      client_email: "svc@example.test",
      private_key: "not-a-real-key-for-this-test",
      private_key_id: "k1",
    });
    // The keychain entry exists (the real exchange would sign a real key); this test asserts the
    // ROUTE: the marker must reach the ADC branch, not the API-key fast path. We can prove that
    // without a valid key because the fast path returns a URL on aiplatform host WITHOUT a project
    // while the ADC branch throws on signing before any request.
    setProviderKeychainEntryFactoryForTests((service, account) => ({
      getPassword: () => (account === "p/mk1" ? serviceAccount : null),
      setPassword: () => {},
      deletePassword: () => true,
    }));
    setActiveGcpCredentialMarker(`${GCP_CREDENTIAL_MARKER_PREFIX}p/mk1`);
    const provider = { adapter: "google", baseUrl: "https://x", googleMode: "vertex", apiKey: `${GCP_CREDENTIAL_MARKER_PREFIX}p/mk1`, project: "proj-1", location: "global" } as OcxProviderConfig;
    // The ADC branch needs a valid RSA key to sign — it will throw on importKey, NOT send
    // x-goog-api-key. Any throw (even a signing one) proves the fast path was skipped; an
    // x-goog-api-key request would have returned successfully with the marker as the key.
    await expect(createGoogleAdapter(provider).buildRequest(parsed())).rejects.toThrow();
  });
});
