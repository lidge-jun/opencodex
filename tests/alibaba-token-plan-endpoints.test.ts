import { describe, expect, test } from "bun:test";
import {
  ALIBABA_TOKEN_PLAN_BASE_URL_CHOICES,
  ALIBABA_TOKEN_PLAN_BEIJING_BASE_URL,
  ALIBABA_TOKEN_PLAN_INTL_BASE_URL,
  matchBaseUrlChoice,
} from "../src/providers/base-url-choices";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { deriveProviderPresets } from "../src/providers/derive";

describe("alibaba-token-plan endpoint choices", () => {
  test("registry defaults to Beijing and exposes intl + custom choices", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "alibaba-token-plan");
    expect(entry).toBeDefined();
    expect(entry!.baseUrl).toBe(ALIBABA_TOKEN_PLAN_BEIJING_BASE_URL);
    expect(entry!.allowBaseUrlOverride).toBe(true);
    expect(entry!.baseUrlChoices?.map(c => c.id)).toEqual(["beijing", "intl", "custom"]);
    expect(entry!.baseUrlChoices).toEqual([...ALIBABA_TOKEN_PLAN_BASE_URL_CHOICES]);
  });

  test("presets API projection includes baseUrlChoices", () => {
    const preset = deriveProviderPresets().find(p => p.id === "alibaba-token-plan");
    expect(preset?.baseUrl).toBe(ALIBABA_TOKEN_PLAN_BEIJING_BASE_URL);
    expect(preset?.baseUrlChoices?.map(c => c.id)).toEqual(["beijing", "intl", "custom"]);
    const intl = preset?.baseUrlChoices?.find(c => c.id === "intl");
    expect(intl?.baseUrl).toBe(ALIBABA_TOKEN_PLAN_INTL_BASE_URL);
    expect(preset?.baseUrlChoices?.find(c => c.id === "custom")?.baseUrl).toBeUndefined();
  });

  test("matchBaseUrlChoice maps known hosts and falls back to custom", () => {
    expect(matchBaseUrlChoice(ALIBABA_TOKEN_PLAN_BASE_URL_CHOICES, ALIBABA_TOKEN_PLAN_BEIJING_BASE_URL)).toBe("beijing");
    expect(matchBaseUrlChoice(ALIBABA_TOKEN_PLAN_BASE_URL_CHOICES, ALIBABA_TOKEN_PLAN_INTL_BASE_URL + "/")).toBe("intl");
    expect(matchBaseUrlChoice(ALIBABA_TOKEN_PLAN_BASE_URL_CHOICES, "https://example.com/v1")).toBe("custom");
  });
});
