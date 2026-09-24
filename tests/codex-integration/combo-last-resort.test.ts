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
  advanceComboAfterFailure,
  clearComboSelectionState,
  clearComboTargetCooldowns,
  coolComboTarget,
  pickComboTarget,
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

  test("a deferral wait and the ordinary wait share one budget", async () => {
    // Reported on #5736. `waitForCooldownMs` is a cap per *selection attempt*, so the two
    // waits inside one call must not each spend it. Here the normal target's cooldown ends
    // at 3s but it re-cools immediately, and the last resort frees at 9s: waiting 3s and
    // then a further 9s spends 12s against a 10s budget.
    const cfg = config();
    const targets = cfg.combos!.free!.targets;
    coolComboTarget("free", targets[0]!, { now: NOW, cooldownMs: 3_000 });
    coolComboTarget("free", targets[1]!, { now: NOW, cooldownMs: 600_000 });
    coolComboTarget("free", targets[2]!, { now: NOW, cooldownMs: 9_000 });

    const sleeps: number[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await pickComboTargetWithWait(cfg, "free", {
        waitForCooldownMs: 10_000, now: NOW,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          // The normal target re-cools the moment its first cooldown lapses, which is what
          // sends the call on to the ordinary wait with budget already spent.
          coolComboTarget("free", targets[0]!, { now: NOW + 3_000, cooldownMs: 600_000 });
        },
      });
      const total = sleeps.reduce((sum, ms) => sum + ms, 0);
      expect(total).toBeLessThanOrEqual(10_000);
    } finally {
      warn.mockRestore();
    }
  });

  test("the ordinary wait measures from after the deferral slept, not before it", async () => {
    // Sharing the budget is not enough on its own: the clock has to move too. The normal
    // target frees at 3s (and immediately re-cools); the last resort frees at 3.5s. After
    // sleeping 3s the remaining wait is 500ms, not the 3,500ms it would be if the fall-through
    // still measured from the original `now`.
    const cfg = config();
    const targets = cfg.combos!.free!.targets;
    coolComboTarget("free", targets[0]!, { now: NOW, cooldownMs: 3_000 });
    coolComboTarget("free", targets[1]!, { now: NOW, cooldownMs: 600_000 });
    coolComboTarget("free", targets[2]!, { now: NOW, cooldownMs: 3_500 });

    const sleeps: number[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await pickComboTargetWithWait(cfg, "free", {
        waitForCooldownMs: 10_000, now: NOW,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          coolComboTarget("free", targets[0]!, { now: NOW + 3_000, cooldownMs: 600_000 });
        },
      });
      expect(sleeps).toEqual([3_000, 500]);
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

describe("the synchronous post-failure hop honors the policy", () => {
  // `advanceComboAfterFailure` is the hop that runs immediately after an upstream failure.
  // Its pick is synchronous and cannot wait, so under the policy it must decline rather than
  // dispatch the emergency target: a null result is what makes the caller fall through to
  // `pickComboTargetWithWait`, the only selector that can wait out a normal target.
  test("a last-resort target is not dispatched while a normal target is briefly cooling", async () => {
    const cfg = config();
    const targets = cfg.combos!.free!.targets;
    const failed = pickComboTarget(cfg, "free", { now: NOW })!;
    expect(failed.target.provider).toBe("a");
    coolComboTarget("free", targets[1]!, { now: NOW, cooldownMs: 3_000 });

    expect(advanceComboAfterFailure(cfg, failed, { now: NOW })).toBeNull();

    const sleeps: number[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pick = await pickComboTargetWithWait(cfg, "free", {
        exclude: failed.attempted,
        waitForCooldownMs: 10_000, now: NOW,
        sleep: async (ms: number) => { sleeps.push(ms); },
      });
      expect(sleeps).toEqual([3_000]);
      expect(pick?.target.provider).toBe("b");
    } finally {
      warn.mockRestore();
    }
  });

  test("a normal target cooling past the wait budget releases the last resort without waiting", async () => {
    const cfg = config();
    const targets = cfg.combos!.free!.targets;
    const failed = pickComboTarget(cfg, "free", { now: NOW })!;
    coolComboTarget("free", targets[1]!, { now: NOW, cooldownMs: 60_000 });

    expect(advanceComboAfterFailure(cfg, failed, { now: NOW })).toBeNull();

    const sleeps: number[] = [];
    const pick = await pickComboTargetWithWait(cfg, "free", {
      exclude: failed.attempted,
      waitForCooldownMs: 10_000, now: NOW,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    expect(sleeps).toEqual([]);
    expect(pick?.target.provider).toBe("c");
  });

  test("without the policy the synchronous hop still takes the last resort", () => {
    // The deferral is scoped to the policy: an unconfigured combo keeps the behaviour it
    // had before, emergency target included.
    const cfg = config({ cooldownWaitPolicy: undefined });
    const targets = cfg.combos!.free!.targets;
    const failed = pickComboTarget(cfg, "free", { now: NOW })!;
    expect(failed.target.provider).toBe("a");
    coolComboTarget("free", targets[0]!, { now: NOW, cooldownMs: 3_000 });
    coolComboTarget("free", targets[1]!, { now: NOW, cooldownMs: 3_000 });

    const next = advanceComboAfterFailure(cfg, failed, { now: NOW });
    expect(next?.target.provider).toBe("c");
  });
});

describe("round-robin keeps the last resort emergency-only", () => {
  test("repeated selections never reach a last-resort target while a normal one is healthy", async () => {
    // The policy is not a failover-only feature: with a zero wait budget, a healthy normal
    // target must still win every ordinary selection, so the emergency target is reached
    // only when the normal one stops being eligible.
    const cfg = config({
      strategy: "round-robin",
      waitForCooldownMs: 0,
      targets: [
        { provider: "a", model: "m1" },
        { provider: "c", model: "m3", lastResort: true },
      ],
    });

    const providers: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const pick = await pickComboTargetWithWait(cfg, "free", {
        waitForCooldownMs: 0, now: NOW, sleep: noSleep,
      });
      providers.push(pick!.target.provider);
    }
    expect(providers).toEqual(["a", "a", "a", "a", "a"]);
  });
});
