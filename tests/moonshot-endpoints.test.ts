import { describe, expect, test } from "bun:test";
import {
  MOONSHOT_BASE_URL_CHOICES,
  MOONSHOT_CN_BASE_URL,
  MOONSHOT_INTL_BASE_URL,
  matchBaseUrlChoice,
} from "../src/providers/base-url-choices";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { deriveProviderPresets } from "../src/providers/derive";

describe("moonshot endpoint choices", () => {
  test("registry defaults to international and exposes china + custom choices", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "moonshot");
    expect(entry).toBeDefined();
    expect(entry!.baseUrl).toBe(MOONSHOT_INTL_BASE_URL);
    expect(entry!.allowBaseUrlOverride).toBe(true);
    expect(entry!.baseUrlChoices?.map(c => c.id)).toEqual(["international", "china", "custom"]);
    expect(entry!.baseUrlChoices).toEqual([...MOONSHOT_BASE_URL_CHOICES]);
  });

  test("presets API projection includes moonshot baseUrlChoices", () => {
    const preset = deriveProviderPresets().find(p => p.id === "moonshot");
    expect(preset?.baseUrl).toBe(MOONSHOT_INTL_BASE_URL);
    expect(preset?.baseUrlChoices?.map(c => c.id)).toEqual(["international", "china", "custom"]);
    expect(preset?.baseUrlChoices?.find(c => c.id === "china")?.baseUrl).toBe(MOONSHOT_CN_BASE_URL);
    expect(preset?.baseUrlChoices?.find(c => c.id === "custom")?.baseUrl).toBeUndefined();
  });

  test("matchBaseUrlChoice maps known hosts and falls back to custom", () => {
    expect(matchBaseUrlChoice(MOONSHOT_BASE_URL_CHOICES, MOONSHOT_INTL_BASE_URL)).toBe("international");
    expect(matchBaseUrlChoice(MOONSHOT_BASE_URL_CHOICES, MOONSHOT_CN_BASE_URL + "/")).toBe("china");
    expect(matchBaseUrlChoice(MOONSHOT_BASE_URL_CHOICES, "https://example.com/v1")).toBe("custom");
  });
});
