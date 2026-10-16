import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAzureAdapter as createAzureAdapterProduction } from "../../src/adapters/azure";
import { getConfigPath, loadConfig, readConfigDiagnostics } from "../../src/config";
import { providerEditorConfigDTO, providerManagementConfigError } from "../../src/server/auth-cors";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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

  test("raises small positive budgets only when an Azure floor is configured", async () => {
    const adapter = createAzureAdapter(provider({ minMaxOutputTokens: 16 }));
    for (const value of [1, 10, 15, 16, 32]) {
      const request = await adapter.buildRequest({
        ...parsed,
        _rawBody: { ...parsed._rawBody, max_output_tokens: value },
      });
      expect(JSON.parse(request.body).max_output_tokens).toBe(Math.max(value, 16));
    }
  });

  test("keeps the caller budget when the Azure floor is absent", async () => {
    const request = await createAzureAdapter(provider()).buildRequest({
      ...parsed,
      _rawBody: { ...parsed._rawBody, max_output_tokens: 1 },
    });
    expect(JSON.parse(request.body).max_output_tokens).toBe(1);
  });

  test("preserves the caller-owned request and unrelated payload fields", async () => {
    const input = [{ role: "user", content: "hello" }];
    const raw = { model: "gpt-5.5", input, stream: true, max_output_tokens: 1, temperature: 0.7 };
    const original = structuredClone(raw);
    const request = await createAzureAdapter(provider({ minMaxOutputTokens: 16 })).buildRequest({
      ...parsed, _rawBody: raw,
    });
    expect(raw).toEqual(original);
    expect(raw.input).toBe(input);
    const body = JSON.parse(request.body);
    expect(body.input).toEqual(input);
    expect(body.temperature).toBe(0.7);
    expect(body.max_output_tokens).toBe(16);
  });

  test("ignores invalid floors on direct adapter construction", async () => {
    for (const floor of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const request = await createAzureAdapter(provider({ minMaxOutputTokens: floor })).buildRequest({
        ...parsed, _rawBody: { ...parsed._rawBody, max_output_tokens: 1 },
      });
      expect(JSON.parse(request.body).max_output_tokens).toBe(1);
    }
  });

  test("validates the floor at the management boundary and exposes it as an editor field", () => {
    expect(providerManagementConfigError("azure", provider({ minMaxOutputTokens: 16 }))).toBeNull();
    for (const floor of [0, -1, 1.5, "16", null]) {
      expect(providerManagementConfigError("azure", {
        ...provider(), minMaxOutputTokens: floor,
      })).toContain("minMaxOutputTokens");
    }
    const dto = providerEditorConfigDTO({
      port: 10100, defaultProvider: "azure", providers: { azure: provider({ minMaxOutputTokens: 16 }) },
    });
    expect(dto.providers.azure.minMaxOutputTokens).toBe(16);
  });

  test("does not invent an output budget when the request omits it", async () => {
    const request = await createAzureAdapter(provider({ minMaxOutputTokens: 16 })).buildRequest(parsed);
    expect(JSON.parse(request.body).max_output_tokens).toBeUndefined();
  });

  test("does not repair invalid caller output budgets", async () => {
    const adapter = createAzureAdapter(provider({ minMaxOutputTokens: 16 }));
    for (const value of [0, -1, 1.5, "1", null]) {
      const request = await adapter.buildRequest({
        ...parsed,
        _rawBody: { ...parsed._rawBody, max_output_tokens: value },
      });
      expect(JSON.parse(request.body).max_output_tokens).toEqual(value);
    }
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

  test("rejects missing and blank API keys", async () => {
    for (const apiKey of [undefined, "", "   "]) {
      await expect(createAzureAdapter(provider({ apiKey })).buildRequest(parsed))
        .rejects.toThrow("azure-openai requires a non-empty apiKey");
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

  test("validates the opt-in floor in disk configuration", () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const testDir = mkdtempSync(join(tmpdir(), "ocx-azure-floor-"));
    process.env.OPENCODEX_HOME = testDir;
    try {
      for (const floor of [16, 0, -1, 1.5, "16", null]) {
        writeFileSync(getConfigPath(), JSON.stringify({
          port: 10100,
          providers: { azure: provider({ minMaxOutputTokens: floor as number }) },
          defaultProvider: "azure",
        }));
        const diagnostics = readConfigDiagnostics();
        if (floor === 16) {
          expect(diagnostics.error).toBeNull();
          expect(loadConfig().providers.azure.minMaxOutputTokens).toBe(16);
        } else {
          expect(diagnostics.error).toContain("providers.azure.minMaxOutputTokens");
        }
      }
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (existsSync(testDir)) removeTreeWithRetry(testDir);
    }
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
