import { describe, expect, test } from "bun:test";
import { buildProviderWorkspace, isFreeProvider, providerTier, type WorkspaceItem } from "../../gui/src/provider-workspace/catalog";
import { bucketPresets, presetTier, type CatalogPreset } from "../../gui/src/components/provider-catalog/provider-presets";
import { isSubscriptionCliProvider } from "../../gui/src/provider-workspace/subscription-cli";
import { authModeLabel } from "../../gui/src/components/provider-workspace/ProviderRail";
import { providerAuthSurface } from "../../gui/src/provider-workspace/auth";
import { en } from "../../gui/src/i18n/en";
import { DICTS } from "../../gui/src/i18n/catalogs";
import { interpolate, type TFn } from "../../gui/src/i18n/shared";

/**
 * `claude-cli` is keyless because the signed-in Claude Code CLI owns the account and bills the
 * subscription, not because it is free. The dashboard reads `keyOptional` as free pricing, which
 * filed it under the Free tab with a Free badge. These pin it to the paid API group everywhere
 * the dashboard groups by pricing, and pin the warning copy in every locale.
 */

// The row as /api/provider-presets derives it from src/providers/registry/entries-extended.ts.
const CLAUDE_CLI: CatalogPreset = {
  id: "claude-cli",
  label: "Claude Code CLI (subscription)",
  adapter: "claude-cli",
  baseUrl: "https://api.anthropic.com",
  auth: "key",
  keyOptional: true,
};

const englishT: TFn = (key, vars) => interpolate(en[key], vars);

describe("subscription CLI grouping", () => {
  test("the adapter, not the provider id, identifies a subscription CLI row", () => {
    expect(isSubscriptionCliProvider({ adapter: "claude-cli" })).toBe(true);
    expect(isSubscriptionCliProvider({ adapter: " claude-cli " })).toBe(true);
    expect(isSubscriptionCliProvider({ adapter: "anthropic" })).toBe(false);
    expect(isSubscriptionCliProvider({ adapter: "openai-chat" })).toBe(false);
    expect(isSubscriptionCliProvider({})).toBe(false);
  });

  test("claude-cli is paid while an ordinary keyless row stays free", () => {
    const row = { adapter: "claude-cli", baseUrl: CLAUDE_CLI.baseUrl, authMode: "key", keyOptional: true };
    expect(isFreeProvider(row)).toBe(false);
    expect(providerTier("claude-cli", row)).toBe("paid");
    expect(isFreeProvider({ adapter: "openai-chat", baseUrl: "https://api.example.com/v1", keyOptional: true })).toBe(true);
  });

  test("the add-provider catalog lists claude-cli under Paid and nowhere else", () => {
    const keylessFree: CatalogPreset = { id: "keyless", label: "Keyless", adapter: "openai-chat", baseUrl: "https://api.example.com/v1", auth: "key", keyOptional: true };
    const buckets = bucketPresets([CLAUDE_CLI, keylessFree]);
    expect(presetTier(CLAUDE_CLI)).toBe("paid");
    expect(buckets.paid.map(p => p.id)).toEqual(["claude-cli"]);
    expect(buckets.free.map(p => p.id)).toEqual(["keyless"]);
    expect(buckets.accounts).toEqual([]);
    expect(buckets.local).toEqual([]);
  });

  test("the configured row stays ready, is tagged paid and is labelled as a subscription CLI", () => {
    const sections = buildProviderWorkspace({
      "claude-cli": { adapter: "claude-cli", baseUrl: CLAUDE_CLI.baseUrl, authMode: "key", keyOptional: true },
    });
    const item = sections.ready.find(p => p.name === "claude-cli") as WorkspaceItem;
    expect(item.tier).toBe("paid");
    expect(authModeLabel(item, englishT)).toBe(en["modal.badge.subscriptionCli"]);
    expect(authModeLabel({ ...item, adapter: "anthropic" }, englishT)).toBe(en["modal.badge.apiKey"]);
  });

  // `keyOptional` is enriched from the registry only for the canonical `claude-cli` name. A
  // renamed or hand-authored row using the adapter arrives without it and must still be ready,
  // paid, labelled, and free of key prompts, because the transport never reads a key.
  test("a custom-named claude-cli row without keyOptional is ready and offers no key prompt", () => {
    const custom = { adapter: "claude-cli", baseUrl: CLAUDE_CLI.baseUrl, authMode: "key" };
    const sections = buildProviderWorkspace({ "my-claude": custom });
    expect(sections.needsSetup).toEqual([]);
    const item = sections.ready.find(p => p.name === "my-claude") as WorkspaceItem;
    expect(item).toBeDefined();
    expect(item.keyOptional).toBeUndefined();
    expect(item.tier).toBe("paid");
    expect(isFreeProvider(item)).toBe(false);
    expect(authModeLabel(item, englishT)).toBe(en["modal.badge.subscriptionCli"]);
    expect(providerAuthSurface(item)).toBeNull();

    // A hand-authored row with no authMode at all is the same row.
    expect(providerAuthSurface({ name: "bare", adapter: "claude-cli", baseUrl: CLAUDE_CLI.baseUrl })).toBeNull();
    expect(buildProviderWorkspace({ bare: { adapter: "claude-cli", baseUrl: CLAUDE_CLI.baseUrl } }).ready.map(p => p.name)).toEqual(["bare"]);

    // A key saved on it by other means keeps the surface so it can be removed.
    expect(providerAuthSurface({ ...item, hasApiKey: true })).toBe("api-keys");
    // Contrast: the same shape on a key adapter still needs setup and prompts for a key.
    const keyRow = { adapter: "anthropic", baseUrl: CLAUDE_CLI.baseUrl, authMode: "key" };
    expect(buildProviderWorkspace({ "my-anthropic": keyRow }).needsSetup.map(p => p.name)).toEqual(["my-anthropic"]);
    expect(providerAuthSurface({ name: "my-anthropic", ...keyRow })).toBe("api-keys");
  });
});

describe("subscription CLI warning copy", () => {
  const keys = ["modal.badge.subscriptionCli", "modal.subscriptionCliTitle", "modal.subscriptionCliWarning"] as const;

  test("every locale translates the badge, title and warning", () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      for (const key of keys) {
        expect(dict[key]?.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
        if (locale !== "en") expect(dict[key], `${locale} ${key}`).not.toBe(en[key]);
      }
    }
  });

  test("every warning keeps the CLI chip and names the API-key provider", () => {
    for (const [locale, dict] of Object.entries(DICTS)) {
      const warning = dict["modal.subscriptionCliWarning"];
      expect(warning.split("{cmd}").length, locale).toBe(2);
      expect(warning, locale).toContain("{apiProvider}");
      expect(warning, locale).toContain("Claude Code");
    }
  });
});
