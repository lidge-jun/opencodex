import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { earliestQuotaResetAt, pickComboTarget } from "../../src/combos";
import { clearCachedProviderQuotas, setCachedProviderQuotaForTests } from "../../src/providers/quota-routing-cache";
import type { OcxConfig } from "../../src/types";

// reset-window ranks a target by the quota windows that gate it. A model-scoped window of
// another family says nothing about when this target's model regains capacity.
const now = 100_000;
const config = {
  port: 10100,
  defaultProvider: "a",
  providers: {
    a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["claude-opus-4-5"] },
    b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
  },
  combos: {
    ranked: {
      strategy: "reset-window",
      targets: [
        { provider: "a", model: "claude-opus-4-5" },
        { provider: "b", model: "m2" },
      ],
    },
  },
} as unknown as OcxConfig;

beforeEach(() => { clearCachedProviderQuotas(); });
afterEach(() => { clearCachedProviderQuotas(); });

describe("reset-window ranking with model-scoped windows", () => {
  test("another family's scoped window does not rank this target", () => {
    // Provider a only has a Sonnet-scoped window resetting in one minute; its Opus target has no
    // applicable reset, so provider b's known reset in ten minutes ranks first.
    setCachedProviderQuotaForTests("a", {
      customWindows: [{ label: "Sonnet", scope: "model", percent: 10, resetAt: now + 60_000 }],
      updatedAt: now,
    });
    setCachedProviderQuotaForTests("b", { updatedAt: now, weeklyResetAt: now + 600_000 });
    expect(pickComboTarget(config, "ranked", { now })?.target.provider).toBe("b");
  });

  test("this family's scoped window and unscoped windows still rank", () => {
    setCachedProviderQuotaForTests("a", {
      customWindows: [{ label: "Opus", scope: "model", percent: 10, resetAt: now + 60_000 }],
      updatedAt: now,
    });
    setCachedProviderQuotaForTests("b", { updatedAt: now, weeklyResetAt: now + 600_000 });
    expect(pickComboTarget(config, "ranked", { now })?.target.provider).toBe("a");
    expect(earliestQuotaResetAt({
      updatedAt: now,
      customWindows: [{ label: "Gem", percent: 10, resetAt: now + 5_000 }],
    }, now, () => true)).toBe(now + 5_000);
  });
});
