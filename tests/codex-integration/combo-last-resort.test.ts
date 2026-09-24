// #5691: an explicit last-resort cooldown policy for failover combos.
//
// Without it, a *brief* cooldown on a preferred target makes the ordinary
// selector fall straight through to a target the operator marked emergency-only.
// The policy says: when a normal target is merely cooling and we could wait it
// out inside the combo's existing wait budget, wait — do not dispatch the
// last resort yet.
//
// The property that matters more than the feature is the one in
// `TestThePolicyNeverCausesAnOutage` below: a policy that could keep a
// last-resort target ineligible when every normal target is genuinely gone
// would convert a fallback into an outage, which is strictly worse than the
// premature routing it exists to prevent.
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  clearComboSelectionState,
  clearComboTargetCooldowns,
  coolComboTarget,
  pickComboTargetWithWait,
} from "../../src/combos";
import type { OcxConfig } from "../../src/types/config";

function config(overrides: Record<string, unknown> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
      c: { adapter: "openai-chat", baseUrl: "https://c.example/v1", apiKey: "kc", models: ["m3"] },
    },
    combos: {
      free: {
        strategy: "failover",
        cooldownWaitPolicy: "before-last-resort",
        waitForCooldownMs: 10_000,
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
          { provider: "c", model: "m3", lastResort: true },
        ],
        ...overrides,
      },
    },
  } as unknown as OcxConfig;
}

const NOW = 1_000_000;
const noSleep = async () => {};

beforeEach(() => {
  clearComboTargetCooldowns();
  clearComboSelectionState();
});

describe("last-resort cooldown policy", () => {
  test("a healthy normal target is picked, as before", async () => {
    const cfg = config();
    const pick = await pickComboTargetWithWait(cfg, "free", {
      waitForCooldownMs: 10_000, now: NOW, sleep: noSleep,
    });
    expect(pick?.target.provider).toBe("a");
  });

  test("a brief cooldown on the preferred target waits instead of taking the last resort", async () => {
    const cfg = config();
    const targets = cfg.combos!.free!.targets;
    coolComboTarget("free", targets[0]!, { now: NOW, cooldownMs: 3_000 });
    coolComboTarget("free", targets[1]!, { now: NOW, cooldownMs: 4_000 });

    const sleeps: number[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pick = await pickComboTargetWithWait(cfg, "free", {
        waitForCooldownMs: 10_000, now: NOW,
        sleep: async (ms: number) => { sleeps.push(ms); },
      });
      expect(sleeps).toEqual([3_000]);
      expect(pick?.target.provider).toBe("a");
      expect(pick?.target.provider).not.toBe("c");
    } finally {
      warn.mockRestore();
    }
  });

  test("without the policy the last resort is taken immediately, as today", async () => {
    const cfg = config({ cooldownWaitPolicy: undefined });
    const targets = cfg.combos!.free!.targets;
    coolComboTarget("free", targets[0]!, { now: NOW, cooldownMs: 3_000 });
    coolComboTarget("free", targets[1]!, { now: NOW, cooldownMs: 4_000 });

    const sleeps: number[] = [];
    const pick = await pickComboTargetWithWait(cfg, "free", {
      waitForCooldownMs: 10_000, now: NOW,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    expect(sleeps).toEqual([]);
    expect(pick?.target.provider).toBe("c");
  });
});

describe("the policy never causes an outage", () => {
  test("every normal target cooling beyond the wait budget releases the last resort", async () => {
    const cfg = config();
    const targets = cfg.combos!.free!.targets;
    coolComboTarget("free", targets[0]!, { now: NOW, cooldownMs: 600_000 });
    coolComboTarget("free", targets[1]!, { now: NOW, cooldownMs: 600_000 });

    const sleeps: number[] = [];
    const pick = await pickComboTargetWithWait(cfg, "free", {
      waitForCooldownMs: 10_000, now: NOW,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    expect(sleeps).toEqual([]);
    expect(pick?.target.provider).toBe("c");
  });

  test("every normal target excluded releases the last resort", async () => {
    const cfg = config();
    const pick = await pickComboTargetWithWait(cfg, "free", {
      waitForCooldownMs: 10_000, now: NOW, sleep: noSleep,
      exclude: ["a/m1", "b/m2"],
    });
    expect(pick?.target.provider).toBe("c");
  });

  test("every normal target ruled out by the caller releases the last resort", async () => {
    const cfg = config();
    const pick = await pickComboTargetWithWait(cfg, "free", {
      waitForCooldownMs: 10_000, now: NOW, sleep: noSleep,
      eligible: target => target.provider === "c",
    });
    expect(pick?.target.provider).toBe("c");
  });

  test("a combo of only last-resort targets still dispatches", async () => {
    // Degenerate, but an operator can write it, and "defer the last resort
    // until a normal target is available" must not mean "never dispatch".
    const cfg = config({
      targets: [{ provider: "c", model: "m3", lastResort: true }],
    });
    const pick = await pickComboTargetWithWait(cfg, "free", {
      waitForCooldownMs: 10_000, now: NOW, sleep: noSleep,
    });
    expect(pick?.target.provider).toBe("c");
  });

  test("the deferral never waits on the last-resort target's own cooldown", async () => {
    // The deferral wait exists to give a *normal* target time to recover. If
    // the last-resort target were in that waitable set, a short cooldown on it
    // would make the request sleep on behalf of the very target the policy is
    // trying not to use yet.
    //
    // The ordinary wait below the policy branch may still wait for it, and
    // should: once no normal target is reachable, the last resort is the only
    // candidate, and a one-second cooldown on it is worth waiting out. The
    // assertion is therefore about which branch does the waiting, not whether
    // any wait happens.
    const cfg = config();
    const targets = cfg.combos!.free!.targets;
    coolComboTarget("free", targets[0]!, { now: NOW, cooldownMs: 600_000 });
    coolComboTarget("free", targets[1]!, { now: NOW, cooldownMs: 600_000 });
    coolComboTarget("free", targets[2]!, { now: NOW, cooldownMs: 1_000 });

    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((message: string) => {
      warnings.push(String(message));
    });
    try {
      await pickComboTargetWithWait(cfg, "free", {
        waitForCooldownMs: 10_000, now: NOW, sleep: noSleep,
      });
      expect(warnings.some(line => line.includes("deferring last resort"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("a zero wait budget still releases the last resort rather than failing", async () => {
    const cfg = config({ waitForCooldownMs: 0 });
    const targets = cfg.combos!.free!.targets;
    coolComboTarget("free", targets[0]!, { now: NOW, cooldownMs: 3_000 });
    coolComboTarget("free", targets[1]!, { now: NOW, cooldownMs: 3_000 });

    const pick = await pickComboTargetWithWait(cfg, "free", {
      waitForCooldownMs: 0, now: NOW, sleep: noSleep,
    });
    expect(pick?.target.provider).toBe("c");
  });
});
