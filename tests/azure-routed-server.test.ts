import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../src/server/responses/core";
import { AZURE_IDENTITY_UNAVAILABLE_ERROR, __resetAzureCredentialCache, setAzureCredentialFactoryForTests } from "../src/lib/azure-identity";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetAzureCredentialCache();
});

function config(provider: Record<string, unknown>): OcxConfig {
  return {
    port: 0,
    defaultProvider: "azure-test",
    providers: { "azure-test": provider },
  } as OcxConfig;
}

function request(model = "azure-test/gpt-4o"): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: "hello", stream: false }),
  });
}

describe("Azure identity routed response path", () => {
  test("resolves through the adapter and sends one Bearer without API-key headers", async () => {
    let seenHeaders!: Headers;
    setAzureCredentialFactoryForTests(() => ({ getToken: async () => ({ token: "routed-token" }) }));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return Response.json({ id: "resp_1", object: "response", created_at: 1, status: "completed", model: "gpt-4o", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    }) as typeof fetch;
    const response = await handleResponses(request(), config({
      adapter: "azure-openai",
      baseUrl: "https://resource.openai.azure.com/openai",
      azureCredential: { type: "default-azure-credential" },
    }), { model: "", provider: "" }, {});
    expect(response.status).toBe(200);
    expect(seenHeaders.get("authorization")).toBe("Bearer routed-token");
    expect(seenHeaders.get("api-key")).toBeNull();
    expect(seenHeaders.get("x-api-key")).toBeNull();
  });

  test("keeps ordinary Azure API-key mode fail-closed when the key is absent", async () => {
    await expect(handleResponses(request(), config({
      adapter: "azure-openai",
      baseUrl: "https://resource.openai.azure.com/openai",
    }), { model: "", provider: "" }, {})).rejects.toThrow("requires a non-empty apiKey");
  });

  test("keeps routed identity failures stable and redacted", async () => {
    setAzureCredentialFactoryForTests(() => ({
      getToken: async () => { throw new Error("AggregateAuthenticationError tenant-secret token-secret"); },
    }));
    const error = await handleResponses(request(), config({
      adapter: "azure-openai",
      baseUrl: "https://resource.openai.azure.com/openai",
      azureCredential: { type: "default-azure-credential" },
    }), { model: "", provider: "" }, {}).catch(value => value as Error);
    expect(error.message).toBe(AZURE_IDENTITY_UNAVAILABLE_ERROR);
    expect(error.message).not.toContain("tenant-secret");
    expect(error.message).not.toContain("token-secret");
  });
});
