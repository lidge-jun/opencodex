import { describe, expect, test, vi } from "bun:test";
import { registerCodexLowQuotaProtection } from "../../src/codex/low-quota-protection";
import { observeCodexLowQuota } from "../../src/codex/low-quota-observer";
import type { OcxConfig } from "../../src/types/config";

describe("registerCodexLowQuotaProtection", () => {
  test("pauses account when threshold exceeded with action pause", async () => {
    const config: OcxConfig = {
      codexPool: {
        lowQuotaProtection: {
          enabled: true,
          threshold: 90,
          windows: { short: false, weekly: true },
          actions: { pause: true, notify: false },
        },
      },
      codexAccounts: [
        { id: "acc_1", plan: "team" } as any,
      ],
    } as any;

    const persist = vi.fn();
    const notify = vi.fn(async () => {});

    const cleanup = registerCodexLowQuotaProtection(config, { persist, notify });

    // Under threshold -> no action
    observeCodexLowQuota("acc_1", { weeklyPercent: 85 });
    expect(persist).not.toHaveBeenCalled();

    // Over threshold -> paused
    observeCodexLowQuota("acc_1", { weeklyPercent: 92 });
    expect(persist).toHaveBeenCalled();

    cleanup();
  });

  test("triggers notify action when threshold exceeded with action notify", async () => {
    const config: OcxConfig = {
      codexPool: {
        lowQuotaProtection: {
          enabled: true,
          threshold: 80,
          windows: { short: true, weekly: false },
          actions: { pause: false, notify: true },
        },
      },
      codexAccounts: [
        { id: "acc_2", plan: "team" } as any,
      ],
    } as any;

    const notify = vi.fn(async () => {});
    const persist = vi.fn();

    const cleanup = registerCodexLowQuotaProtection(config, { persist, notify });

    observeCodexLowQuota("acc_2", { shortPercent: 85 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        percentUsed: 85,
        threshold: 80,
        window: "short",
      })
    );

    cleanup();
  });
});
