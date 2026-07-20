import { describe, expect, test } from "bun:test";
import {
  baseUrlForChoice,
  matchChoiceId,
  resolvedBaseUrlForChoice,
} from "../gui/src/base-url-choice";
import {
  QWEN_CLOUD_BASE_URL_CHOICES,
  QWEN_CLOUD_PAYG_BASE_URL,
  QWEN_CLOUD_TOKEN_PLAN_BASE_URL,
  matchBaseUrlChoice,
} from "../src/providers/base-url-choices";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { deriveProviderPresets } from "../src/providers/derive";

const CHOICES = [...QWEN_CLOUD_BASE_URL_CHOICES];

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

describe("gui base-url-choice helpers", () => {
  test("baseUrlForChoice writes known URLs and clears when entering custom from a preset", () => {
    expect(baseUrlForChoice(CHOICES, "token-plan", "")).toBe(QWEN_CLOUD_TOKEN_PLAN_BASE_URL);
    expect(baseUrlForChoice(CHOICES, "payg", QWEN_CLOUD_TOKEN_PLAN_BASE_URL)).toBe(QWEN_CLOUD_PAYG_BASE_URL);
    expect(baseUrlForChoice(CHOICES, "custom", QWEN_CLOUD_TOKEN_PLAN_BASE_URL)).toBe("");
    expect(baseUrlForChoice(CHOICES, "custom", "https://example.com/v1")).toBe("https://example.com/v1");
  });

  test("resolvedBaseUrlForChoice prefers the selected preset URL over stale custom text", () => {
    expect(resolvedBaseUrlForChoice(CHOICES, "payg", "https://stale.example/v1")).toBe(QWEN_CLOUD_PAYG_BASE_URL);
    expect(resolvedBaseUrlForChoice(CHOICES, "custom", "  https://example.com/v1  ")).toBe("https://example.com/v1");
    expect(resolvedBaseUrlForChoice(CHOICES, "custom", "   ")).toBe("");
  });

  test("matchChoiceId prefers custom when present and falls back to first choice otherwise", () => {
    expect(matchChoiceId(CHOICES, QWEN_CLOUD_TOKEN_PLAN_BASE_URL + "/")).toBe("token-plan");
    expect(matchChoiceId(CHOICES, "https://other/v1")).toBe("custom");
    expect(matchChoiceId([{ id: "token-plan", label: "Token", baseUrl: QWEN_CLOUD_TOKEN_PLAN_BASE_URL }], "https://other/v1")).toBe("token-plan");
  });
});
