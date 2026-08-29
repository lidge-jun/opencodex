import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../src/codex/model-entitlements";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";

// These cases start a real server and hit /v1/models. Keep the budget at the
// server class so a slow runner does not turn a discovery probe into a flake.
setDefaultTimeout(SERVER_BUDGET_MS);

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

function effortConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "kimi",
    providers: {
      kimi: {
        adapter: "openai-chat",
        baseUrl: "https://kimi.test/v1",
        // Configured tiers are the subject under test. Live discovery against
        // the fake host can hang on DNS long enough to blow Bun's 5s default
        // on Linux CI (shard 3), so keep the catalog pinned to config.
        liveModels: false,
        models: ["k3", "kimi-for-coding"],
        modelReasoningEfforts: {
          k3: ["low", "high", "max"],
          "kimi-for-coding": [],
        },
        modelDefaultReasoningEfforts: { k3: "high" },
      },
    },
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-grok-effort-list-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  resetCodexModelEntitlementCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("raw /v1/models list reasoning-effort advertisement (Grok Build discovery)", () => {
  test("HTTP /v1/models preserves native ultra for Grok discovery", async () => {
    seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    const config = effortConfig();
    config.providers.openai = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      liveModels: false,
    };
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      const k3 = body.data.find(m => m.id === "kimi/k3");
      expect(k3).toBeDefined();
      expect(k3!.supports_reasoning_effort).toBe(true);
      expect(k3!.reasoning_effort).toBe("high");
      expect(k3!.reasoning_efforts).toEqual([
        { value: "low", label: "Low Effort" },
        { value: "high", label: "High Effort", default: true },
        { value: "max", label: "Max Effort" },
      ]);
      // Native rows preserve the pinned per-model ladder and default. Sol and Terra include
      // ultra, while Luna intentionally ends at max, matching the canonical Codex catalog.
      const nativeExpectations = [
        {
          id: "gpt-5.6-sol",
          defaultEffort: "low",
          efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        {
          id: "gpt-5.6-terra",
          defaultEffort: "medium",
          efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        {
          id: "gpt-5.6-luna",
          defaultEffort: "medium",
          efforts: ["low", "medium", "high", "xhigh", "max"],
        },
      ];
      for (const expected of nativeExpectations) {
        const native = body.data.find(m => m.id === expected.id);
        expect(native).toBeDefined();
        expect(native!.supports_reasoning_effort).toBe(true);
        expect(native!.reasoning_effort).toBe(expected.defaultEffort);
        expect((native!.reasoning_efforts as Array<{ value: string }>).map(option => option.value))
          .toEqual(expected.efforts);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("models with an empty tier list advertise no effort fields", async () => {
    saveConfig(effortConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      const plain = body.data.find(m => m.id === "kimi/kimi-for-coding");
      expect(plain).toBeDefined();
      expect("supports_reasoning_effort" in plain!).toBe(false);
      expect("reasoning_effort" in plain!).toBe(false);
      expect("reasoning_efforts" in plain!).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("a ladder without a configured default uses the canonical medium default", async () => {
    const config = effortConfig();
    config.providers.kimi!.modelDefaultReasoningEfforts = {};
    config.providers.kimi!.modelReasoningEfforts = { k3: ["low", "medium", "high"] };
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      const k3 = body.data.find(m => m.id === "kimi/k3");
      expect(k3!.reasoning_effort).toBe("medium");
      const options = k3!.reasoning_efforts as Array<Record<string, unknown>>;
      expect(options[1]).toEqual({ value: "medium", label: "Medium Effort", default: true });
    } finally {
      await server.stop(true);
    }
  });

  test("an invalid configured default falls back with the canonical medium/high/first order", async () => {
    const config = effortConfig();
    config.providers.kimi!.modelDefaultReasoningEfforts = { k3: "medium" };
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      const k3 = body.data.find(m => m.id === "kimi/k3");
      // k3's ladder is low/high/max: no medium, so the canonical fallback picks high.
      expect(k3!.reasoning_effort).toBe("high");
      const options = k3!.reasoning_efforts as Array<Record<string, unknown>>;
      expect(options[1]).toEqual({ value: "high", label: "High Effort", default: true });
    } finally {
      await server.stop(true);
    }
  });

  test("falls back to the first tier when neither medium nor high is available", async () => {
    const config = effortConfig();
    config.providers.kimi!.models = [...(config.providers.kimi!.models ?? []), "custom-test"];
    config.providers.kimi!.modelReasoningEfforts = { "custom-test": ["low", "max"] };
    config.providers.kimi!.modelDefaultReasoningEfforts = { "custom-test": "medium" };
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      const model = body.data.find(m => m.id === "kimi/custom-test");
      expect(model!.reasoning_effort).toBe("low");
      expect(model!.reasoning_efforts).toEqual([
        { value: "low", label: "Low Effort", default: true },
        { value: "max", label: "Max Effort" },
      ]);
    } finally {
      await server.stop(true);
    }
  });
});
