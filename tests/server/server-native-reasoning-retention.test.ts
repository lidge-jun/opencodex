import { describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { ConfigWritePublishedError } from "../../src/config/persist-unlocked";
import { configRebaseDeletionKeys } from "../../src/config/rebase-provenance";
import { handleNativeReasoningRetentionRoutes } from "../../src/server/management/native-reasoning-retention-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "../helpers/management-auth";

const off = { modelSwitch: false, accountSwitch: false };

function harness(saveError?: Error) {
  const config = getDefaultConfig();
  const saved: OcxConfig[] = [];
  async function call(method: string, body?: unknown, rawBody?: string, pathname = "/api/native-reasoning-retention") {
    const url = new URL(`http://localhost${pathname}`);
    return handleNativeReasoningRetentionRoutes({
      url, req: new Request(url, { method, ...(method === "GET" ? {} : {
        headers: { "content-type": "application/json" }, body: rawBody ?? JSON.stringify(body),
      }) }),
      config, version: "test", deps: { saveConfigPreservingClaudeCode: (candidate: OcxConfig) => {
        saved.push(structuredClone(candidate));
        if (saveError) throw saveError;
      } },
    } as unknown as ManagementContext);
  }
  return { config, saved, call };
}

describe("native reasoning retention management routes", () => {
  test("management dispatch mounts both methods and persists the same live policy", async () => {
    const config = getDefaultConfig();
    const saves: OcxConfig[] = [];
    const deps = { saveConfigPreservingClaudeCode: (candidate: OcxConfig) => saves.push(structuredClone(candidate)) };
    const url = new URL("http://127.0.0.1:10100/api/native-reasoning-retention");
    const get = await handleManagementAPI(new ManagementRequest(url), url, config, deps);
    expect(get?.status).toBe(200);
    expect(await get!.json()).toEqual(off);
    const put = await handleManagementAPI(new ManagementRequest(url, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelSwitch: true }),
    }), url, config, deps);
    expect(put?.status).toBe(200);
    expect(await put!.json()).toEqual({ modelSwitch: true, accountSwitch: false });
    expect(saves).toHaveLength(1);
    expect(saves[0]?.nativeReasoningRetention).toEqual({ modelSwitch: true });
  });

  test("GET returns resolved defaults and never persists", async () => {
    const h = harness();
    const response = await h.call("GET");
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual(off);
    h.config.nativeReasoningRetention = { accountSwitch: true };
    expect(await (await h.call("GET"))!.json()).toEqual({ modelSwitch: false, accountSwitch: true });
    expect(h.saved).toHaveLength(0);
  });

  test("PUT preserves omitted fields and changes no routing or account settings", async () => {
    const h = harness();
    const original = structuredClone(h.config);
    expect((await h.call("PUT", { modelSwitch: true }))?.status).toBe(200);
    expect(h.config.nativeReasoningRetention).toEqual({ modelSwitch: true });
    const response = await h.call("PUT", { accountSwitch: true });
    expect(await response!.json()).toEqual({ modelSwitch: true, accountSwitch: true });
    expect((await h.call("PUT", { modelSwitch: false }))?.status).toBe(200);
    expect(h.config.nativeReasoningRetention).toEqual({ modelSwitch: false, accountSwitch: true });
    const { nativeReasoningRetention: _policy, ...rest } = h.config;
    expect(rest).toEqual(original);
    expect(h.saved).toHaveLength(3);
  });

  test("empty partial PUT preserves policy; null explicitly resets the entire block", async () => {
    const h = harness();
    h.config.nativeReasoningRetention = { modelSwitch: true, accountSwitch: true };
    expect(await (await h.call("PUT", {}))!.json()).toEqual({ modelSwitch: true, accountSwitch: true });
    const reset = await h.call("PUT", null);
    expect(reset?.status).toBe(200);
    expect(await reset!.json()).toEqual(off);
    expect(h.config.nativeReasoningRetention).toBeUndefined();
    expect(configRebaseDeletionKeys(h.config).has("nativeReasoningRetention")).toBe(true);
    expect(h.saved).toHaveLength(2);
  });

  test("invalid fields, types and JSON reject before mutation or save", async () => {
    const h = harness();
    h.config.nativeReasoningRetention = { modelSwitch: true };
    const original = structuredClone(h.config);
    for (const body of [[], true, "on", { modelSwitch: "true" }, { accountSwitch: null },
      { modelSwitch: false, accountSwitch: 1 }, { modelSwitch: false, endpointSwitch: true }]) {
      expect((await h.call("PUT", body))?.status).toBe(400);
      expect(h.config).toEqual(original);
    }
    expect((await h.call("PUT", undefined, "{"))?.status).toBe(400);
    expect((await h.call("PUT", undefined, ""))?.status).toBe(400);
    expect(h.config).toEqual(original);
    expect(h.saved).toHaveLength(0);
  });

  test("failed saves restore both the previous field and deletion intent", async () => {
    const h = harness(new Error("fixture-save-failed"));
    const original = { modelSwitch: true, accountSwitch: true };
    h.config.nativeReasoningRetention = original;
    await expect(h.call("PUT", null)).rejects.toThrow("fixture-save-failed");
    expect(h.config.nativeReasoningRetention).toBe(original);
    expect(configRebaseDeletionKeys(h.config).has("nativeReasoningRetention")).toBe(false);
    await expect(h.call("PUT", { modelSwitch: false })).rejects.toThrow("fixture-save-failed");
    expect(h.config.nativeReasoningRetention).toBe(original);
  });

  test("save failure preserves an absent field; publication failures keep committed policy", async () => {
    const failed = harness(new Error("fixture-save-failed"));
    await expect(failed.call("PUT", { modelSwitch: true })).rejects.toThrow("fixture-save-failed");
    expect(Object.hasOwn(failed.config, "nativeReasoningRetention")).toBe(false);
    const published = harness(new ConfigWritePublishedError(new Error("fixture-bookkeeping-failed")));
    await expect(published.call("PUT", { modelSwitch: true })).rejects.toBeInstanceOf(ConfigWritePublishedError);
    expect(published.config.nativeReasoningRetention).toEqual({ modelSwitch: true });
  });

  test("unrelated paths and unsupported methods fall through", async () => {
    const h = harness();
    expect(await h.call("POST", {})).toBeNull();
    expect(await h.call("GET", undefined, undefined, "/api/native-reasoning-retention-extra")).toBeNull();
    expect(h.saved).toHaveLength(0);
  });
});
