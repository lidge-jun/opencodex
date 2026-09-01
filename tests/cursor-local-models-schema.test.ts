import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { nativeReasoningEfforts } from "../src/codex/catalog";
import {
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../src/codex/model-entitlements";
import { startServer } from "../src/server";
import {
  modelCapabilityFields,
  OPENAI_FAMILY_API_TYPES,
  OPENCODEX_MODEL_API_TYPES,
} from "../src/server/models-capabilities";
import type { OcxConfig } from "../src/types";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";

// Cursor's local-agent runtime ("Private Inference" build) only enables its reasoning-effort
// control when a GET /v1/models row carries api_types (+ optional capabilities). These cases
// start a real server and read the raw OpenAI-shape list, like the Grok discovery tests.
setDefaultTimeout(SERVER_BUDGET_MS);

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

function capabilityConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "kimi",
    providers: {
      kimi: {
        adapter: "openai-chat",
        baseUrl: "https://kimi.test/v1",
        liveModels: false,
        models: ["k3", "kimi-for-coding"],
        modelReasoningEfforts: {
          k3: ["low", "high", "max"],
          "kimi-for-coding": [],
        },
        modelDefaultReasoningEfforts: { k3: "high" },
        modelContextWindows: { k3: 200000 },
        modelInputModalities: { k3: ["text", "image"] },
      },
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        liveModels: false,
      },
    },
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-cursor-local-schema-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  resetCodexModelEntitlementCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("modelCapabilityFields", () => {
  test("api_types keeps an OpenAI-family member so Cursor never routes to the Messages wire alone", () => {
    expect(OPENCODEX_MODEL_API_TYPES.some(type => OPENAI_FAMILY_API_TYPES.has(type))).toBe(true);
  });

  test("empty input yields only the constant capabilities", () => {
    const fields = modelCapabilityFields({});
    expect(fields.api_types).toEqual(OPENCODEX_MODEL_API_TYPES);
    expect(fields.capabilities).toEqual({
      supports_tool_use: true,
      supports_streaming: true,
      supports_reasoning: false,
    });
    expect("context_length" in fields.capabilities).toBe(false);
    expect("supports_vision" in fields.capabilities).toBe(false);
    expect("reasoning_effort" in fields.capabilities).toBe(false);
  });

  test("non-positive context and text-only modalities are reported honestly", () => {
    const fields = modelCapabilityFields({ contextWindow: 0, inputModalities: ["text"], reasoningEfforts: ["", "low"] });
    expect("context_length" in fields.capabilities).toBe(false);
    expect(fields.capabilities.supports_vision).toBe(false);
    expect(fields.capabilities.reasoning_effort).toEqual(["low"]);
    expect(fields.capabilities.supports_reasoning).toBe(true);
  });
});

describe("raw /v1/models list advertises Cursor local-agent capabilities", () => {
  test("routed rows carry api_types and capabilities derived from provider config", async () => {
    seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol"]);
    saveConfig(capabilityConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { data: Array<Record<string, unknown>> };

      const k3 = body.data.find(m => m.id === "kimi/k3");
      expect(k3).toBeDefined();
      expect(k3!.api_types).toEqual(["chat_completions", "responses", "anthropic_messages"]);
      expect(k3!.capabilities).toEqual({
        context_length: 200000,
        supports_tool_use: true,
        supports_streaming: true,
        supports_reasoning: true,
        supports_vision: true,
        reasoning_effort: ["low", "high", "max"],
      });
      // Grok Build's discovery fields stay untouched next to the new keys.
      expect(k3!.supports_reasoning_effort).toBe(true);
      expect(k3!.reasoning_effort).toBe("high");

      const plain = body.data.find(m => m.id === "kimi/kimi-for-coding");
      expect(plain).toBeDefined();
      expect(plain!.api_types).toEqual(["chat_completions", "responses", "anthropic_messages"]);
      const plainCaps = plain!.capabilities as Record<string, unknown>;
      expect(plainCaps.supports_reasoning).toBe(false);
      expect("reasoning_effort" in plainCaps).toBe(false);

      const sol = body.data.find(m => m.id === "gpt-5.6-sol");
      expect(sol).toBeDefined();
      expect(sol!.api_types).toEqual(["chat_completions", "responses", "anthropic_messages"]);
      const solCaps = sol!.capabilities as Record<string, unknown>;
      expect(solCaps.reasoning_effort).toEqual(nativeReasoningEfforts("gpt-5.6-sol"));
      expect(typeof solCaps.context_length).toBe("number");
      expect(solCaps.context_length as number).toBeGreaterThan(0);
      expect(solCaps.supports_vision).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});
