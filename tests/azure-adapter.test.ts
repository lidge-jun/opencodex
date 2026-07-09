import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAzureAdapter } from "../src/adapters/azure";
import { getConfigPath, loadConfig, readConfigDiagnostics } from "../src/config";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

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
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    }
  });
});
