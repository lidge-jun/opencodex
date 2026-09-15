import { expect, spyOn, test } from "bun:test";
import { ManagementRequest as Request } from "./management-auth";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { providerEditorConfigDTO, providerManagementConfigError } from "../../src/server/auth-cors";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { catalogConvergenceFactory } from "./catalog-convergence";

/** Keep registration inside the caller's existing isolated-home and cleanup hooks. */
export function registerSideChatCacheManagementCases(
  TEST_DIR: string,
  canonicalDirect: OcxProviderConfig,
): void {
  test("canonical side-chat cache option is a validated operator overlay", () => {
    for (const codexAccountMode of ["pool", "direct"] as const) {
      for (const enabled of [true, false]) {
        expect(providerManagementConfigError("openai", { ...canonicalDirect, codexAccountMode,
          experimentalCodexSideChatCache: enabled })).toBeNull();
      }
    }
    for (const invalid of [null, "true", 1, {}, []]) {
      expect(providerManagementConfigError("openai", { ...canonicalDirect, experimentalCodexSideChatCache: invalid }))
        .toBe("provider openai experimentalCodexSideChatCache must be a boolean");
    }
    expect(providerManagementConfigError("custom", { adapter: "openai-responses", baseUrl: "https://api.example.test/v1",
      experimentalCodexSideChatCache: true })).toBe("experimentalCodexSideChatCache is valid only for provider openai");
    for (const transport of [{ baseUrl: "https://other.example.test" }, { apiKey: "fixture-key" }, { authMode: "key" }]) {
      expect(providerManagementConfigError("openai", { ...canonicalDirect, experimentalCodexSideChatCache: true, ...transport }))
        .toContain("canonical built-in provider seed");
    }
  });

  test("side-chat cache can be toggled and round-tripped through management PATCH and PUT", async () => {
    process.env.OPENCODEX_HOME = TEST_DIR;
    const live: OcxConfig = { port: 0, defaultProvider: "openai", openaiProviderTierVersion: 2,
      providers: { openai: { ...canonicalDirect, experimentalCodexSideChatCache: true } } };
    saveConfig(live);
    const destination = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    const send = async (method: string, body: unknown) => {
      const request = new Request("http://127.0.0.1/api/providers?name=openai", {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return handleManagementAPI(request, new URL(request.url), live, { createManagementConvergeCodex: catalogConvergenceFactory() });
    };
    try {
      const disabled = await send("PATCH", { experimentalCodexSideChatCache: false });
      expect({ status: disabled?.status, body: await disabled?.json() }).toMatchObject({ status: 200 });
      expect(loadConfig().providers.openai.experimentalCodexSideChatCache).toBe(false);
      const baseline = providerEditorConfigDTO(loadConfig());
      const next = structuredClone(baseline);
      next.providers.openai.experimentalCodexSideChatCache = true;
      const enabled = await send("PUT", { baseline, next });
      expect(enabled?.status).toBe(200);
      expect(loadConfig().providers.openai.experimentalCodexSideChatCache).toBe(true);
      const retained = await send("PATCH", { annotateEmptyToolOutputs: true });
      expect(retained?.status).toBe(200);
      expect(loadConfig().providers.openai.experimentalCodexSideChatCache).toBe(true);
      const invalid = await send("PATCH", { experimentalCodexSideChatCache: "false" });
      expect(invalid?.status).toBe(400);
      expect(loadConfig().providers.openai.experimentalCodexSideChatCache).toBe(true);
      const cleared = await send("PATCH", { experimentalCodexSideChatCache: null });
      expect(cleared?.status).toBe(200);
      expect(loadConfig().providers.openai.experimentalCodexSideChatCache).toBeUndefined();
    } finally { destination.mockRestore(); }
  });

  test("provider management permits snapshot repair only on canonical OpenAI forward seeds", () => {
    for (const mode of ["pool", "direct"] as const) {
      expect(providerManagementConfigError("openai", {
        ...canonicalDirect,
        codexAccountMode: mode,
        responsesSnapshotRepair: true,
      })).toBeNull();
    }

    expect(providerManagementConfigError("openai", {
      ...canonicalDirect,
      responsesSnapshotRepair: { enabled: true },
    })).toBe("provider openai responsesSnapshotRepair must be a boolean");

    expect(providerManagementConfigError("openai", {
      ...canonicalDirect,
      responsesSnapshotRepair: true,
      noVisionModels: ["gpt-5.6"],
    })).toContain("canonical built-in provider seed");
  });
}
