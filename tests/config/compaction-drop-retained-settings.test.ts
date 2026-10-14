import { describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { handleConfigRoutes } from "../../src/server/management/config-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

function harness(failSave = false) {
  const config = getDefaultConfig();
  let saves = 0;
  const call = async (body: unknown) => {
    const url = new URL("http://localhost/api/settings");
    return handleConfigRoutes({
      url, req: new Request(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      config, version: "test", deps: { saveConfigPreservingClaudeCode: (_c: OcxConfig) => {
        saves++; if (failSave) throw new Error("fixture-save-failed");
      } },
    } as unknown as ManagementContext);
  };
  return { config, call, saves: () => saves };
}

describe("compactionDropRetainedRequests settings", () => {
  test("absent is off and a malformed hand edit degrades to off", () => {
    expect(getDefaultConfig().compactionDropRetainedRequests).toBeUndefined();
    expect(configSchema.parse({ ...getDefaultConfig(), compactionDropRetainedRequests: "yes" }).compactionDropRetainedRequests).toBeUndefined();
    expect(configSchema.parse({ ...getDefaultConfig(), compactionDropRetainedRequests: true }).compactionDropRetainedRequests).toBe(true);
  });

  test("on persists true, off deletes the key, and neither touches compaction routing or login mode", async () => {
    const h = harness();
    h.config.compactionRouting = { model: "original/manual" };
    const on = await h.call({ compactionDropRetainedRequests: true });
    expect(on?.status).toBe(200);
    expect(h.config.compactionDropRetainedRequests).toBe(true);
    expect((await on!.json() as Record<string, unknown>).compactionDropRetainedRequests).toBe(true);
    expect(h.config.compactionRouting).toEqual({ model: "original/manual" });
    expect(h.config.codexClientCompaction).toBeUndefined();
    const off = await h.call({ compactionDropRetainedRequests: false });
    expect(off?.status).toBe(200);
    expect(Object.hasOwn(h.config, "compactionDropRetainedRequests")).toBe(false);
    expect((await off!.json() as Record<string, unknown>).compactionDropRetainedRequests).toBe(false);
    expect(h.saves()).toBe(2);
  });

  test("a non-boolean value is rejected before persistence", async () => {
    const h = harness();
    expect((await h.call({ compactionDropRetainedRequests: "on" }))?.status).toBe(400);
    expect(h.saves()).toBe(0);
    expect(h.config.compactionDropRetainedRequests).toBeUndefined();
  });

  test("a save failure restores the prior value", async () => {
    const h = harness(true);
    await expect(h.call({ compactionDropRetainedRequests: true })).rejects.toThrow("fixture-save-failed");
    expect(Object.hasOwn(h.config, "compactionDropRetainedRequests")).toBe(false);
  });
});
