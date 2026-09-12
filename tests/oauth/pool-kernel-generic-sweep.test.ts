import { describe, expect, test } from "bun:test";
import {
  clearPoolRotationState,
  genericPoolKey,
  peekRoundRobinAccount,
  reconcilePoolRotationState,
  seedPoolRotationAccount,
} from "../../src/oauth/pool-kernel";
import type { GenerationContext } from "../../src/lib/state-store-sweeper";

/**
 * The rotation primitives moved out of src/codex/pool-rotation.ts so every credential
 * kind can share them. Before the move, reconcilePoolRotationState recognised only the
 * two dedicated pool keys and skipped everything else, so a generic OAuth provider's
 * rotation state would have survived the removal of the very account it points at.
 */
function generation(n: number, oauthAccountKeys: string[]): GenerationContext {
  return {
    generation: n,
    providerNames: new Set<string>(),
    comboIds: new Set<string>(),
    comboTargets: new Set<string>(),
    codexAccountIds: new Set<string>(),
    oauthAccountKeys: new Set(oauthAccountKeys),
    configRoots: new Set<string>(),
  } as GenerationContext;
}

describe("generic pool keys are swept", () => {
  test("genericPoolKey namespaces a provider so it cannot collide with the dedicated kinds", () => {
    expect(genericPoolKey("cursor")).toBe("generic:cursor");
    expect(genericPoolKey("cursor")).not.toBe("codex");
    expect(genericPoolKey("anthropic")).not.toBe("anthropic");
  });

  test("a generic entry survives while its account is still live", () => {
    const key = genericPoolKey("cursor");
    clearPoolRotationState(key);
    seedPoolRotationAccount(key, "acct-1");
    // Seeding pins the sticky account, so a peek over both candidates returns it.
    expect(peekRoundRobinAccount(key, ["acct-1", "acct-2"], 5)).toBe("acct-1");

    // Nothing was removed, so the sweep must report no change and leave the pin.
    expect(reconcilePoolRotationState(generation(9001, ["cursor\u0000acct-1"]))).toBe(0);
    expect(peekRoundRobinAccount(key, ["acct-1", "acct-2"], 5)).toBe("acct-1");
    clearPoolRotationState(key);
  });

  test("a generic entry is dropped once its account leaves the roster", () => {
    const key = genericPoolKey("kimi");
    clearPoolRotationState(key);
    seedPoolRotationAccount(key, "gone");
    expect(peekRoundRobinAccount(key, ["gone", "still-here"], 5)).toBe("gone");

    // The account is absent from this generation. Before the generic branch existed
    // this key fell through as unknown and the stale pin survived forever.
    expect(reconcilePoolRotationState(generation(9002, ["kimi\u0000still-here"]))).toBeGreaterThan(0);
    expect(peekRoundRobinAccount(key, ["still-here"], 5)).toBe("still-here");
    clearPoolRotationState(key);
  });

  test("one provider's roster does not sweep another provider's entry", () => {
    const cursor = genericPoolKey("cursor");
    const kimi = genericPoolKey("kimi");
    clearPoolRotationState(cursor);
    clearPoolRotationState(kimi);
    seedPoolRotationAccount(cursor, "c1");
    seedPoolRotationAccount(kimi, "k1");

    expect(reconcilePoolRotationState(generation(9003, ["cursor\u0000c1", "kimi\u0000k1"]))).toBe(0);
    expect(peekRoundRobinAccount(cursor, ["c1", "c2"], 5)).toBe("c1");
    expect(peekRoundRobinAccount(kimi, ["k1", "k2"], 5)).toBe("k1");
    clearPoolRotationState(cursor);
    clearPoolRotationState(kimi);
  });
});
