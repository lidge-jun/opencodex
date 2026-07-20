import { describe, expect, test } from "bun:test";
import {
  QWEN_CLOUD_BASE_URL_CHOICES,
  QWEN_CLOUD_PAYG_BASE_URL,
  QWEN_CLOUD_TOKEN_PLAN_BASE_URL,
  matchBaseUrlChoice,
} from "../src/providers/base-url-choices";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { deriveProviderPresets } from "../src/providers/derive";

describe("qwen-cloud endpoint choices", () => {
  test("registry defaults to token plan and exposes payg + custom choices", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "qwen-cloud");
    expect(entry).toBeDefined();
    expect(entry!.baseUrl).toBe(QWEN_CLOUD_TOKEN_PLAN_BASE_URL);
    expect(entry!.allowBaseUrlOverride).toBe(true);
    expect(entry!.baseUrlChoices?.map(c => c.id)).toEqual(["token-plan", "payg", "custom"]);
    expect(entry!.baseUrlChoices).toEqual([...QWEN_CLOUD_BASE_URL_CHOICES]);
  });

  test("presets API projection includes baseUrlChoices", () => {
    const preset = deriveProviderPresets().find(p => p.id === "qwen-cloud");
    expect(preset?.baseUrl).toBe(QWEN_CLOUD_TOKEN_PLAN_BASE_URL);
    expect(preset?.baseUrlChoices?.map(c => c.id)).toEqual(["token-plan", "payg", "custom"]);
    const payg = preset?.baseUrlChoices?.find(c => c.id === "payg");
    expect(payg?.baseUrl).toBe(QWEN_CLOUD_PAYG_BASE_URL);
    expect(preset?.baseUrlChoices?.find(c => c.id === "custom")?.baseUrl).toBeUndefined();
  });

  test("matchBaseUrlChoice maps known hosts and falls back to custom", () => {
    expect(matchBaseUrlChoice(QWEN_CLOUD_BASE_URL_CHOICES, QWEN_CLOUD_TOKEN_PLAN_BASE_URL)).toBe("token-plan");
    expect(matchBaseUrlChoice(QWEN_CLOUD_BASE_URL_CHOICES, QWEN_CLOUD_PAYG_BASE_URL + "/")).toBe("payg");
    expect(matchBaseUrlChoice(QWEN_CLOUD_BASE_URL_CHOICES, "https://example.com/v1")).toBe("custom");
  });
});
