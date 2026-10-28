import { afterEach, describe, expect, test } from "bun:test";
import { configSchema } from "../../src/config/schema/config-schema";
import { loadCapabilityTable } from "../../src/codex/role-capability";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function config(capability?: Record<string, unknown>): OcxConfig {
  return { codexRoleCapability: configSchema.shape.codexRoleCapability.parse(capability) } as OcxConfig;
}

function observeRequests(analysisStatus = 401): string[] {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("https://artificialanalysis.ai/")) {
      return Response.json({ data: [{ name: "Fixture model", evaluations: { artificial_analysis_coding_index: 42 } }] }, { status: analysisStatus });
    }
    return new Response("fixture unavailable", { status: 503 });
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  return requests;
}

describe("role capability benchmark download consent", () => {
  test("omitted or false opt-in makes no Hugging Face request on the primary path", async () => {
    const requests = observeRequests();
    for (const setting of [undefined, {}, { huggingFace: { enabled: false } }]) {
      const table = await loadCapabilityTable(config(setting));
      expect(requests).toEqual([]);
      expect(table.domains).toEqual({});
      expect(table.fallbackReason).toContain("benchmark data was unavailable");
    }
  });

  test("disabled Hugging Face stays disabled after Artificial Analysis fails", async () => {
    const requests = observeRequests();
    for (const huggingFace of [undefined, { enabled: false }]) {
      const table = await loadCapabilityTable(config({ artificialAnalysis: { apiKey: "consent-failure-fixture" }, huggingFace }));
      expect(table.domains).toEqual({});
      expect(table.fallbackReason).toContain("Artificial Analysis could not be read");
      expect(table.fallbackReason).toContain("benchmark data was unavailable");
    }
    expect(requests).toEqual(Array(2).fill("https://artificialanalysis.ai/api/v2/data/llms/models"));
  });

  test("explicit opt-in fetches Hugging Face on primary and Artificial Analysis fallback paths", async () => {
    const requests = observeRequests();
    const enabled = { huggingFace: { enabled: true } };
    expect(config(enabled).codexRoleCapability).toEqual(enabled);
    await expect(loadCapabilityTable(config(enabled))).rejects.toThrow("HTTP 503");
    const primary = [...requests];
    expect(primary).toHaveLength(2);
    expect(primary.every(url => url.startsWith("https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/"))).toBe(true);
    requests.length = 0;
    await expect(loadCapabilityTable(config({ ...enabled, artificialAnalysis: { apiKey: "consent-opt-in-fixture" } }))).rejects.toThrow("HTTP 503");
    expect(requests).toEqual(["https://artificialanalysis.ai/api/v2/data/llms/models", ...primary]);
  });

  test("malformed opt-in never grants download consent", async () => {
    const requests = observeRequests();
    for (const enabled of ["true", 1, null]) {
      const table = await loadCapabilityTable(config({ huggingFace: { enabled } }));
      expect(table.domains).toEqual({});
      expect(table.fallbackReason).toContain("benchmark data was unavailable");
    }
    expect(requests).toEqual([]);
  });

  test("Artificial Analysis works with Hugging Face off and does not fall through", async () => {
    const requests = observeRequests(200);
    const table = await loadCapabilityTable(config({ artificialAnalysis: { apiKey: "consent-success-fixture" } }));
    expect(requests).toEqual(["https://artificialanalysis.ai/api/v2/data/llms/models"]);
    expect(table.source.name).toBe("Artificial Analysis");
    expect(table.domains.coding?.get("fixture-model")).toBe(42);
  });
});
