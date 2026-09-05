import { describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, readConfigDiagnostics } from "../../src/config";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let requestedScope: string | undefined;
let getTokenCalls = 0;
let credentialError: Error | undefined;
mock.module("@azure/identity", () => ({
  DefaultAzureCredential: class {
    async getToken(scope: string) {
      getTokenCalls += 1;
      requestedScope = scope;
      if (credentialError) throw credentialError;
      return { token: "entra-access-token", expiresOnTimestamp: Date.now() + 3_600_000 };
    }
  },
}));

const { createAzureAdapter: createAzureAdapterProduction } = await import("../../src/adapters/azure");
const { resolveModelsAuthToken } = await import("../../src/oauth");
const { fetchProviderModels } = await import("../../src/codex/catalog/provider-fetch");
const { clearModelCache } = await import("../../src/codex/model-cache");

const createAzureAdapter = (...args: Parameters<typeof createAzureAdapterProduction>) =>
  withTestTranslatorBudget(createAzureAdapterProduction(...args));

const parsed: OcxParsedRequest = {
  modelId: "gpt-5.5",
  context: { messages: [] },
  stream: true,
  options: {},
  _rawBody: { model: "gpt-5.5", input: [], stream: true },
};

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "azure-openai",
    baseUrl: "https://myres.openai.azure.com/openai",
    apiKey: "azure-key",
    ...overrides,
  };
}

describe("Azure OpenAI adapter hardening", () => {
  test("uses the Azure API-key header and v1 Responses URL without api-version", async () => {
    const request = await createAzureAdapter(provider()).buildRequest(parsed);

    expect(request.url).toBe("https://myres.openai.azure.com/openai/v1/responses");
    expect(new URL(request.url).searchParams.has("api-version")).toBe(false);
    expect(request.headers["api-key"]).toBe("azure-key");
    expect(request.headers.Authorization).toBeUndefined();
  });

  test("uses DefaultAzureCredential when no API key is configured", async () => {
    requestedScope = undefined;

    const request = await createAzureAdapter(provider({ apiKey: undefined })).buildRequest(parsed);

    expect(request.headers.Authorization).toBe("Bearer entra-access-token");
    expect(request.headers["api-key"]).toBeUndefined();
    expect(requestedScope).toBe("https://cognitiveservices.azure.com/.default");
  });

  test("lowers the private image_gen namespace on the inherited API-key path", async () => {
    const request = await createAzureAdapter(provider()).buildRequest({
      ...parsed,
      _rawBody: {
        model: "gpt-5.5",
        input: [{
          type: "additional_tools",
          tools: [{
            type: "namespace",
            name: "image_gen",
            tools: [{ type: "function", name: "imagegen", parameters: {} }],
          }],
        }],
      },
    });
    const body = JSON.parse(request.body) as {
      input: Array<{ tools?: Array<{ type: string; name?: string }> }>;
    };

    expect(body.input[0]?.tools).toEqual([
      // parameters gains an object root on the way out (#745): the passthrough normalizer
      // runs on additional_tools too, so a schema declared as {} ships as {type:"object"}.
      // What this test is about is the namespace lowering in the name.
      { type: "function", name: "image_gen__imagegen", parameters: { type: "object" } },
    ]);
  });

  test("uses Entra ID when the API key is missing or blank", async () => {
    for (const apiKey of [undefined, "", "   "]) {
      const request = await createAzureAdapter(provider({ apiKey })).buildRequest(parsed);
      expect(request.headers.Authorization).toBe("Bearer entra-access-token");
      expect(request.headers["api-key"]).toBeUndefined();
    }
  });

  test("rejects an HTTP keyless URL before requesting an Entra token", async () => {
    requestedScope = undefined;
    const callsBeforeRequest = getTokenCalls;

    await expect(createAzureAdapter(provider({
      apiKey: undefined,
      baseUrl: "http://myres.openai.azure.com/openai",
    })).buildRequest(parsed)).rejects.toThrow("azure-openai keyless authentication requires HTTPS");

    expect(getTokenCalls).toBe(callsBeforeRequest);
    expect(requestedScope).toBeUndefined();
  });

  test("redacts DefaultAzureCredential error details", async () => {
    const previousCredentialError = credentialError;
    const previousRequestedScope = requestedScope;
    const sdkErrorDetail = "credential-chain diagnostic with tenant-specific details";
    credentialError = new Error(sdkErrorDetail);
    requestedScope = undefined;

    try {
      let thrown: unknown;
      try {
        await createAzureAdapter(provider({ apiKey: undefined })).buildRequest(parsed);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message)
        .toBe("azure-openai DefaultAzureCredential failed to acquire an access token");
      expect((thrown as Error).message).not.toContain(sdkErrorDetail);
      expect(requestedScope).toBe("https://cognitiveservices.azure.com/.default");
    } finally {
      credentialError = previousCredentialError;
      requestedScope = previousRequestedScope;
    }
  });

  test("uses Entra ID for live model discovery when the API key is missing", async () => {
    for (const apiKey of [undefined, "", "   "]) {
      expect(await resolveModelsAuthToken("azure-openai", provider({ apiKey })))
        .toBe("entra-access-token");
    }
  });

  test("fails softly and logs a safe diagnostic when Entra model discovery authentication fails", async () => {
    const previousCredentialError = credentialError;
    const sdkErrorDetail = "credential-chain diagnostic with tenant-specific details";
    const info = spyOn(console, "info").mockImplementation(() => {});
    credentialError = new Error(sdkErrorDetail);

    try {
      expect(await resolveModelsAuthToken("azure-openai", provider({ apiKey: undefined }))).toBeUndefined();

      expect(info).toHaveBeenCalledTimes(1);
      const diagnostic = String(info.mock.calls[0]?.[0] ?? "");
      expect(diagnostic).toContain("Azure Entra model-discovery authentication failed");
      expect(diagnostic).not.toContain(sdkErrorDetail);
    } finally {
      credentialError = previousCredentialError;
      info.mockRestore();
    }
  });

  test("HTTP model discovery rejects before acquiring an Entra token or fetching", async () => {
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    const info = spyOn(console, "info").mockImplementation(() => {});
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ data: [{ id: "should-not-load" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const before = getTokenCalls;
    const providerName = "azure-http-discovery-test";
    try {
      expect(await resolveModelsAuthToken(providerName, provider({
        baseUrl: "http://azure.example.test/v1",
        apiKey: undefined,
      }))).toBeUndefined();
      expect(getTokenCalls).toBe(before);

      const models = await fetchProviderModels(providerName, provider({
        baseUrl: "http://azure.example.test/v1",
        apiKey: undefined,
        models: ["configured-fallback"],
      }), 0);

      expect(models.map(model => model.id)).toEqual(["configured-fallback"]);
      expect(getTokenCalls).toBe(before);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      info.mockRestore();
      clearModelCache(providerName);
    }
  });

  test("rejects forward auth mode", async () => {
    await expect(createAzureAdapter(provider({ authMode: "forward" })).buildRequest(parsed))
      .rejects.toThrow("azure-openai does not support forward auth mode");
  });

  test("rejects an unresolved registry resource placeholder", async () => {
    await expect(createAzureAdapter(provider({
      baseUrl: "https://{resource}.openai.azure.com/openai",
    })).buildRequest(parsed)).rejects.toThrow(
      "azure-openai baseUrl contains unresolved {resource} — set your real resource URL",
    );
  });

  test("reports unresolved placeholders as non-fatal config diagnostics", () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const testDir = mkdtempSync(join(tmpdir(), "ocx-azure-diagnostics-"));
    process.env.OPENCODEX_HOME = testDir;

    try {
      writeFileSync(getConfigPath(), JSON.stringify({
        port: 10100,
        providers: {
          "azure-openai": provider({ baseUrl: "https://{resource}.openai.azure.com/openai" }),
        },
        defaultProvider: "azure-openai",
      }));

      const diagnostics = readConfigDiagnostics();

      expect(diagnostics.source).toBe("file");
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.warnings).toEqual([
        "providers.azure-openai.baseUrl contains unresolved {resource}; set the real provider URL",
      ]);
      expect(loadConfig().providers["azure-openai"].baseUrl).toBe("https://{resource}.openai.azure.com/openai");
      expect(readdirSync(testDir).filter(name => name.startsWith("config.json.invalid-"))).toHaveLength(0);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (existsSync(testDir)) removeTreeWithRetry(testDir);
    }
  });
});
