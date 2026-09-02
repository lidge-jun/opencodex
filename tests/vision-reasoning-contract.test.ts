import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleConfigCommand } from "../src/cli/config-command";
import { handleManagementAPI } from "../src/server/management-api";
import { listManagementModelRows } from "../src/server/management/model-rows";
import {
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../src/codex/model-entitlements";
import type { OcxConfig } from "../src/types";
import { resolveOpenAiVisionModel } from "../src/vision";
import { ManagementRequest as Request } from "./helpers/management-auth";
import { removeTreeWithRetry } from "./helpers/remove-tree";

async function getVision(config: OcxConfig): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(new Request(url), url, config);
  if (!response) throw new Error("sidecar settings route did not handle request");
  return response;
}

async function putVision(config: OcxConfig, vision: Record<string, unknown>): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vision }),
    }),
    url,
    config,
  );
  if (!response) throw new Error("sidecar settings route did not handle request");
  return response;
}

function validCliConfig(visionSidecar: Record<string, unknown>): Record<string, unknown> {
  return {
    port: 10100,
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.com/v1",
      },
    },
    visionSidecar,
  };
}

/**
 * Maintainer takeover regression coverage for #1002.
 *
 * These contracts intentionally live above the GUI: capability metadata must be present on the
 * management model rows, and the management boundary must never persist a reasoning rung a known
 * native vision model cannot serve.
 */
describe("vision reasoning capability contracts", () => {
  test("native management rows expose vision-safe reasoning ladders", async () => {
    // This contract is about the effort ladders themselves; Sol/Luna are account-gated,
    // so confirm a roster or their rows would be filtered before the ladder is read.
    seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol", "gpt-5.6-luna"]);
    const config: OcxConfig = { port: 10100, defaultProvider: "none", providers: {} };
    const rows = await listManagementModelRows(config);
    const efforts = (id: string) => (rows.find(row => row.native === true && row.id === id) as
      | { reasoningEfforts?: string[] }
      | undefined)?.reasoningEfforts;

    expect(efforts("gpt-5.4-mini")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(efforts("gpt-5.6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(efforts("gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(efforts("gpt-5.6-sol")).not.toContain("ultra");
  });

  test("management GET reports the effective default model and effort for stale configs", async () => {
    for (const model of [undefined, ""] as const) {
      const config = {
        port: 10100,
        defaultProvider: "none",
        providers: {},
        visionSidecar: { ...(model === undefined ? {} : { model }), reasoning: "max" },
      } as OcxConfig;
      const response = await getVision(config);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        vision: { model: "gpt-5.4-mini", reasoning: "xhigh" },
      });
      // Reads report effective execution state without mutating a hand-edited config in memory.
      expect(config.visionSidecar?.reasoning).toBe("max");
    }
  });

  test("management normalizes native model/effort pairs on every relevant partial update", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), "ocx-vision-reasoning-contract-"));
    process.env.OPENCODEX_HOME = isolatedHome;

    try {
      const direct = { port: 10100, defaultProvider: "none", providers: {} } as OcxConfig;
      let response = await putVision(direct, { model: "gpt-5.4-mini", reasoning: "max" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        vision: { model: "gpt-5.4-mini", reasoning: "xhigh" },
      });
      expect(direct.visionSidecar?.reasoning).toBe("xhigh");

      const reasoningOnly = {
        port: 10100,
        defaultProvider: "none",
        providers: {},
        visionSidecar: { model: "gpt-5.4-mini", reasoning: "low" },
      } as OcxConfig;
      response = await putVision(reasoningOnly, { reasoning: "max" });
      expect(response.status).toBe(200);
      expect(reasoningOnly.visionSidecar?.reasoning).toBe("xhigh");

      const unsetModel = {
        port: 10100,
        defaultProvider: "none",
        providers: {},
        visionSidecar: { reasoning: "low" },
      } as OcxConfig;
      response = await putVision(unsetModel, { reasoning: "max" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        vision: { model: "gpt-5.4-mini", reasoning: "xhigh" },
      });
      expect(unsetModel.visionSidecar?.model).toBeUndefined();
      expect(unsetModel.visionSidecar?.reasoning).toBe("xhigh");

      const modelOnly = {
        port: 10100,
        defaultProvider: "none",
        providers: {},
        visionSidecar: { model: "gpt-5.6-luna", reasoning: "max" },
      } as OcxConfig;
      response = await putVision(modelOnly, { model: "gpt-5.4-mini" });
      expect(response.status).toBe(200);
      expect(modelOnly.visionSidecar).toMatchObject({ model: "gpt-5.4-mini", reasoning: "xhigh" });

      const reset = {
        port: 10100,
        defaultProvider: "none",
        providers: {},
        visionSidecar: { model: "gpt-5.4-mini", reasoning: "max" },
      } as OcxConfig;
      response = await putVision(reset, { model: "" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        vision: { model: "gpt-5.4-mini", reasoning: "xhigh" },
      });
      expect(reset.visionSidecar?.model).toBeUndefined();
      expect(reset.visionSidecar?.reasoning).toBe("xhigh");

      const custom = { port: 10100, defaultProvider: "none", providers: {} } as OcxConfig;
      response = await putVision(custom, { model: "custom-vision", reasoning: "max" });
      expect(response.status).toBe(200);
      expect(custom.visionSidecar).toMatchObject({ model: "custom-vision", reasoning: "max" });
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(isolatedHome);
    }
  });

  test("CLI import normalizes reasoning against omitted and blank runtime model defaults", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), "ocx-vision-reasoning-cli-"));
    process.env.OPENCODEX_HOME = isolatedHome;
    const importPath = join(isolatedHome, "import.json");

    try {
      writeFileSync(importPath, JSON.stringify(validCliConfig({ reasoning: "max" })));
      expect(await handleConfigCommand(["import", importPath, "--yes", "--json"])).toBe(0);
      let persisted = JSON.parse(readFileSync(join(isolatedHome, "config.json"), "utf8"));
      expect(persisted.visionSidecar).toMatchObject({ reasoning: "xhigh" });
      expect(persisted.visionSidecar.model).toBeUndefined();

      writeFileSync(importPath, JSON.stringify(validCliConfig({ model: "", reasoning: "max" })));
      expect(await handleConfigCommand(["import", importPath, "--yes", "--json"])).toBe(0);
      persisted = JSON.parse(readFileSync(join(isolatedHome, "config.json"), "utf8"));
      expect(persisted.visionSidecar).toMatchObject({ model: "", reasoning: "xhigh" });
      expect(resolveOpenAiVisionModel({ visionSidecar: persisted.visionSidecar })).toBe("gpt-5.4-mini");
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(isolatedHome);
    }
  });

  test("invalid effort is rejected without mutation and unrelated patches preserve reasoning", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const isolatedHome = mkdtempSync(join(tmpdir(), "ocx-vision-reasoning-invalid-"));
    process.env.OPENCODEX_HOME = isolatedHome;
    const config = {
      port: 10100,
      defaultProvider: "none",
      providers: {},
      visionSidecar: { model: "gpt-5.4-mini", reasoning: "high", maxDescriptionsPerTurn: 8 },
    } as OcxConfig;

    try {
      let response = await putVision(config, { reasoning: "ultra" });
      expect(response.status).toBe(400);
      expect(config.visionSidecar).toMatchObject({ model: "gpt-5.4-mini", reasoning: "high" });

      response = await putVision(config, { maxDescriptionsPerTurn: 4 });
      expect(response.status).toBe(200);
      expect(config.visionSidecar).toMatchObject({
        model: "gpt-5.4-mini",
        reasoning: "high",
        maxDescriptionsPerTurn: 4,
      });
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(isolatedHome);
      resetCodexModelEntitlementCacheForTests();
    }
  });
});
