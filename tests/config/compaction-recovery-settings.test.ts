import { describe, expect, test } from "bun:test";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { compactionRecoverySchema } from "../../src/config/schema/compaction-recovery";
import { handleConfigRoutes } from "../../src/server/management/config-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

const enabled = { enabled: true, model: "emergency/model", allowDevinInvalidArgument: true };
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

describe("compaction failure recovery settings", () => {
  test("absent is off; an explicit valid configuration survives parsing", () => {
    expect(getDefaultConfig().compactionRecovery).toBeUndefined();
    const result = validateConfigCandidate({ ...getDefaultConfig(), compactionRecovery: enabled });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.compactionRecovery).toEqual(enabled);
    expect(compactionRecoverySchema.parse({ enabled: false, model: "emergency/model" }).enabled).toBe(false);
  });
  test("invalid hand edits degrade to off but mutation validation rejects them", () => {
    for (const value of [{ ...enabled, retryCount: 99 }, { ...enabled, enabled: "true" }, { ...enabled, model: "" }, { ...enabled, model: "x\ny" }, { ...enabled, allowDevinInvalidArgument: 1 }]) {
      const input = { ...getDefaultConfig(), compactionRecovery: value };
      expect(configSchema.parse(input).compactionRecovery).toBeUndefined();
      expect(validateConfigCandidate(input).ok).toBe(false);
    }
  });
  test("management writes and clears recovery without toggling routing or login mode", async () => {
    const h = harness();
    h.config.compactionRouting = { model: "original/manual" };
    const res = await h.call({ compactionRecovery: enabled });
    expect(res?.status).toBe(200);
    expect(h.config.compactionRecovery).toEqual(enabled);
    expect(h.config.compactionRouting).toEqual({ model: "original/manual" });
    expect(h.config.codexDesktopAuthless).toBeUndefined();
    expect(h.config.codexClientCompaction).toBeUndefined();
    expect((await res!.json() as any).compactionRecovery).toEqual(enabled);
    expect((await h.call({ compactionRecovery: null }))?.status).toBe(200);
    expect(h.config.compactionRecovery).toBeUndefined();
    expect(h.saves()).toBe(2);
  });
  test("rejected management configuration never reaches persistence", async () => {
    const h = harness();
    expect((await h.call({ compactionRecovery: { ...enabled, enabled: 1 } }))?.status).toBe(400);
    expect(h.saves()).toBe(0);
    expect(h.config.compactionRecovery).toBeUndefined();
  });
  test("a save failure restores the prior recovery field", async () => {
    const h = harness(true);
    const original = { enabled: false, model: "kept/model" };
    h.config.compactionRecovery = original;
    await expect(h.call({ compactionRecovery: enabled })).rejects.toThrow("fixture-save-failed");
    expect(h.config.compactionRecovery).toEqual(original);
  });
});
