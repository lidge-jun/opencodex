import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { nativeOpenAiContextTier, nativeReasoningEfforts } from "../src/codex/catalog";
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
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
        modelMaxOutputTokens: { k3: 64_000 },
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
  if (testHome) removeTreeWithRetry(testHome);
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
      output_modalities: ["text"],
      supports_tool_use: true,
      supports_streaming: true,
      supports_reasoning: false,
    });
    expect("context_length" in fields.capabilities).toBe(false);
    expect("input_modalities" in fields.capabilities).toBe(false);
    expect("supports_vision" in fields.capabilities).toBe(false);
    expect("reasoning_effort" in fields.capabilities).toBe(false);
  });

  test("non-positive context and text-only modalities are reported honestly", () => {
    const fields = modelCapabilityFields({ contextWindow: 0, inputModalities: ["text"], reasoningEfforts: ["", "low"] });
    expect("context_length" in fields.capabilities).toBe(false);
    // A fractional value below 1 floors to 0 and must be omitted, not emitted as 0.
    expect("context_length" in modelCapabilityFields({ contextWindow: 0.5 }).capabilities).toBe(false);
    expect(modelCapabilityFields({ contextWindow: 1.9 }).capabilities.context_length).toBe(1);
    expect(fields.capabilities.input_modalities).toEqual(["text"]);
    expect(fields.capabilities.supports_vision).toBe(false);
    expect(fields.capabilities.reasoning_effort).toEqual(["low"]);
    expect(fields.capabilities.supports_reasoning).toBe(true);
  });

  test("a larger opt-in window becomes context_length with the default window as the long-context threshold", () => {
    const tiered = modelCapabilityFields({ contextWindow: 272000, longContextWindow: 922000 });
    expect(tiered.capabilities.context_length).toBe(922000);
    expect(tiered.pricing).toEqual({ overrides: [{ min_prompt_tokens: 272000 }] });
    expect("long_context_threshold_tokens" in tiered).toBe(false);
    // Equal or smaller opt-in window: plain context_length, no pricing block.
    const flat = modelCapabilityFields({ contextWindow: 272000, longContextWindow: 272000 });
    expect(flat.capabilities.context_length).toBe(272000);
    expect("pricing" in flat).toBe(false);
    expect("long_context_threshold_tokens" in flat).toBe(false);
    expect("pricing" in modelCapabilityFields({ longContextWindow: 922000 })).toBe(false);
  });

  test("max output tokens are sanitized independently of reasoning", () => {
    expect(modelCapabilityFields({ maxOutputTokens: 128000 }).capabilities.max_output_tokens)
      .toBe(128000);
    expect("max_output_tokens" in modelCapabilityFields({ maxOutputTokens: 0 }).capabilities)
      .toBe(false);
    expect("max_output_tokens" in modelCapabilityFields({ maxOutputTokens: Number.MAX_SAFE_INTEGER + 2 }).capabilities)
      .toBe(false);
    expect(modelCapabilityFields({ maxOutputTokens: 1.9 }).capabilities.supports_reasoning)
      .toBe(false);
  });
});

describe("nativeOpenAiContextTier", () => {
  test("native GPT-5.6 carries the 272k/922k pair and other natives carry none", () => {
    expect(nativeOpenAiContextTier("gpt-5.6-sol")).toEqual({ defaultWindow: 272000, longWindow: 922000 });
    expect(nativeOpenAiContextTier("gpt-5.5")).toBeUndefined();
  });

  test("any user lever below the long window removes the tier; levers at or above it keep it", () => {
    expect(nativeOpenAiContextTier("gpt-5.6-sol", { cap: 500000 })).toBeUndefined();
    expect(nativeOpenAiContextTier("gpt-5.6-sol", { providerWindow: 400000 })).toBeUndefined();
    expect(nativeOpenAiContextTier("gpt-5.6-sol", { modelWindows: { "gpt-5.6-sol": 300000 } })).toBeUndefined();
    expect(nativeOpenAiContextTier("gpt-5.6-sol", { cap: 1050000, providerWindow: 922000 })).toEqual({ defaultWindow: 272000, longWindow: 922000 });
    // A window override for another slug does not touch this one.
    expect(nativeOpenAiContextTier("gpt-5.6-sol", { modelWindows: { "gpt-5.6-terra": 300000 } })).toEqual({ defaultWindow: 272000, longWindow: 922000 });
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
        max_output_tokens: 64_000,
        output_modalities: ["text"],
        input_modalities: ["text", "image"],
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
      expect("max_output_tokens" in plainCaps).toBe(false);

      const sol = body.data.find(m => m.id === "gpt-5.6-sol");
      expect(sol).toBeDefined();
      expect(sol!.api_types).toEqual(["chat_completions", "responses", "anthropic_messages"]);
      const solCaps = sol!.capabilities as Record<string, unknown>;
      expect(solCaps.output_modalities).toEqual(["text"]);
      expect(solCaps.reasoning_effort).toEqual(nativeReasoningEfforts("gpt-5.6-sol"));
      // Native GPT-5.6: 272k default window, 922k opt-in ceiling → Cursor Context selector.
      expect(solCaps.context_length).toBe(922000);
      expect(solCaps.max_output_tokens).toBe(128_000);
      expect(sol!.pricing).toEqual({ overrides: [{ min_prompt_tokens: 272000 }] });
      expect("long_context_threshold_tokens" in sol!).toBe(false);
      expect(solCaps.supports_vision).toBe(true);
      // Routed rows have no separate opt-in tier, so no pricing block.
      expect("pricing" in k3!).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("context_length is the effective window, not the provider cap, when the cap does not bite", async () => {
    const config = capabilityConfig();
    // Cap above k3's real window: contextWindow stays 200000 while contextCap records 350000.
    config.providerContextCaps = { kimi: 350000 };
    saveConfig(config);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      const k3 = body.data.find(m => m.id === "kimi/k3");
      expect(k3).toBeDefined();
      expect((k3!.capabilities as Record<string, unknown>).context_length).toBe(200000);
    } finally {
      await server.stop(true);
    }
  });
});
