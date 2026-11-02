// Round-robin placement prefers accounts with quota headroom (Lane C). Reserve fixtures exercise
// routing state only; they do not authorize or dispatch Reserve.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  pickAlternateCodexAccount,
  previewCodexAccountForRequest,
  recordCodexUpstreamOutcome,
  resetCodexRoutingForManualSelection,
  resolveCodexAccountForThread,
  resolveCodexAccountForThreadDetailed,
} from "../../src/codex/routing";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { setAccountQuotaFromParsed } from "../../src/codex/quota";
import type { CodexThreadLineage } from "../../src/codex/lineage";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-codex-round-robin-headroom-test");
const NOW = 1_800_000_000_000;
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  const ids = ["a", "b", "c"];
  for (const id of ids) {
    saveCodexAccountCredential(id, {
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: `acct-${id}`,
    });
  }
  return {
    providers: {},
    activeCodexAccountId: "a",
    autoSwitchThreshold: 80,
    accountPoolStrategy: "round-robin",
    accountPoolStickyLimit: 1,
    codexAccounts: ids.map(id => ({ id, email: `${id}@example.test`, isMain: false })),
    ...overrides,
  } as OcxConfig;
}

function usage(a: number | undefined, b: number | undefined, c: number | undefined): void {
  if (a !== undefined) updateAccountQuota("a", a);
  if (b !== undefined) updateAccountQuota("b", b);
  if (c !== undefined) updateAccountQuota("c", c);
}

function newPlacements(config: OcxConfig, count: number, scope?: "shared" | "reserve"): Array<string | null> {
  return Array.from({ length: count }, (_, i) => resolveCodexAccountForThread(null, config, NOW + i, scope));
}

describe("round-robin new placement prefers accounts under their threshold", () => {
  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.CODEX_HOME = TEST_DIR;
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearAccountQuota();
    clearPoolRotationState();
  });

  afterEach(() => {
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearPoolRotationState();
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  });

  test("new placements skip an account over the threshold while others are under it", () => {
    const config = makeConfig();
    usage(95, 10, 10);
    const picks = newPlacements(config, 6);
    expect(picks).not.toContain("a");
    expect(picks.filter(id => id === "b")).toHaveLength(3);
    expect(picks.filter(id => id === "c")).toHaveLength(3);
  });

  test("an account exactly at the threshold counts as over it", () => {
    const config = makeConfig();
    usage(80, 10, 10);
    expect(newPlacements(config, 6)).not.toContain("a");
  });

  test("when every account is at or over the threshold, rotation covers all of them", () => {
    const config = makeConfig();
    usage(90, 95, 85);
    expect(new Set(newPlacements(config, 3))).toEqual(new Set(["a", "b", "c"]));
  });

  test("a per-account threshold above current usage keeps that account in rotation", () => {
    const config = makeConfig({ codexAccountAutoSwitchThresholds: { a: 99 } });
    usage(95, 10, 10);
    expect(new Set(newPlacements(config, 3))).toEqual(new Set(["a", "b", "c"]));
  });

  test("a threshold of 0 disables the preference", () => {
    const config = makeConfig({ autoSwitchThreshold: 0 });
    usage(95, 10, 10);
    expect(new Set(newPlacements(config, 3))).toEqual(new Set(["a", "b", "c"]));
  });

  test("unknown usage counts as headroom, so a known hot account is skipped", () => {
    const config = makeConfig();
    usage(95, undefined, undefined);
    expect(newPlacements(config, 4)).not.toContain("a");
  });

  test("an account whose short window is full is not a placement target", () => {
    const config = makeConfig();
    setAccountQuotaFromParsed("a", { shortPercent: 100, shortResetAt: NOW / 1000 + 3_600 });
    usage(undefined, 10, 10);
    expect(newPlacements(config, 4)).not.toContain("a");
  });

  test("a bound conversation keeps its account after that account crosses the threshold", () => {
    const config = makeConfig();
    usage(10, 10, 10);
    expect(resolveCodexAccountForThread("thread-bound", config, NOW)).toBe("a");
    usage(95, 10, 10);
    for (let i = 1; i <= 20; i++) {
      expect(resolveCodexAccountForThread("thread-bound", config, NOW + i)).toBe("a");
    }
  });

  test("preview names the same account the next placement takes", () => {
    const config = makeConfig();
    usage(95, 10, 10);
    for (let i = 0; i < 4; i++) {
      const previewed = previewCodexAccountForRequest(null, config, NOW + i);
      expect(previewed).not.toBe("a");
      expect(resolveCodexAccountForThread(null, config, NOW + i)).toBe(previewed);
    }
  });

  test("the Reserve ring skips the hot account and leaves the shared ring where it was", () => {
    const config = makeConfig();
    usage(95, 10, 10);
    expect(newPlacements(config, 2, "reserve")).toEqual(["b", "c"]);
    expect(resolveCodexAccountForThread(null, config, NOW + 10, "shared")).toBe("b");
  });

  test("a sticky account that crosses the threshold mid-batch is released", () => {
    const config = makeConfig({ accountPoolStickyLimit: 2 });
    usage(10, 10, 10);
    expect(resolveCodexAccountForThread(null, config, NOW)).toBe("a");
    usage(95, 10, 10);
    const picks = [1, 2, 3, 4].map(i => resolveCodexAccountForThread(null, config, NOW + i));
    expect(picks).toEqual(["b", "b", "c", "c"]);
  });

  test("an account rejoins rotation once its usage drops back under the threshold", () => {
    const config = makeConfig();
    usage(95, 10, 10);
    expect(newPlacements(config, 2)).not.toContain("a");
    usage(10, 10, 10);
    expect(newPlacements(config, 3)).toContain("a");
  });

  test("re-placing a conversation whose account went into cooldown avoids a hot sibling", () => {
    const config = makeConfig();
    usage(10, 10, 10);
    expect(resolveCodexAccountForThread("thread-moved", config, NOW)).toBe("a");
    usage(10, 10, 95);
    recordCodexUpstreamOutcome(config, "a", 429, {
      now: NOW + 1,
      resetAt: Math.floor((NOW + 60 * 60_000) / 1_000),
    });
    // The 429's own failover pick already advanced the ring to b, so plain rotation would hand
    // the conversation to c next; c is over the threshold, so it goes to b instead.
    expect(resolveCodexAccountForThread("thread-moved", config, NOW + 2)).toBe("b");
  });

  test("failover keeps plain ring order: leaving a failing account is not a placement", () => {
    const config = makeConfig();
    usage(10, 95, 10);
    expect(pickAlternateCodexAccount(config, "a", NOW)).toBe("b");
  });

  test("a model roster narrows the pool before the headroom preference", () => {
    const config = makeConfig();
    usage(95, 10, 10);
    const selectionOptions = { modelEligibleAccountIds: new Set(["a", "b"]) };
    for (let i = 0; i < 4; i++) {
      const resolution = resolveCodexAccountForThreadDetailed(null, config, NOW + i, undefined, selectionOptions, "gpt-test");
      expect(resolution.accountId).toBe("b");
    }
  });

  test("within the top priority tier, a hot member is skipped instead of descending a tier", () => {
    const config = makeConfig({ codexAccountPriorities: { a: 10, b: 10, c: 0 } });
    usage(95, 10, 10);
    expect(newPlacements(config, 4)).toEqual(["b", "b", "b", "b"]);
  });

  test("an operator's manual selection takes its first placement even over the threshold", () => {
    const config = makeConfig();
    usage(95, 10, 10);
    resetCodexRoutingForManualSelection("a");
    expect(previewCodexAccountForRequest(null, config, NOW)).toBe("a");
    expect(resolveCodexAccountForThread(null, config, NOW)).toBe("a");
    // A successful dispatch spends the one-shot; after that the headroom preference applies again.
    recordCodexUpstreamOutcome(config, "a", 200, { now: NOW + 1 });
    expect(newPlacements(config, 4)).not.toContain("a");
  });

  test("a manual selection also takes the next Reserve placement until a Reserve dispatch spends it", () => {
    const config = makeConfig();
    usage(95, 10, 10);
    resetCodexRoutingForManualSelection("a");
    expect(previewCodexAccountForRequest(null, config, NOW, "reserve")).toBe("a");
    expect(resolveCodexAccountForThread(null, config, NOW, "reserve")).toBe("a");
    // A shared success spends only the shared one-shot; Reserve keeps its own until it is used there.
    recordCodexUpstreamOutcome(config, "a", 200, { now: NOW + 1 });
    expect(newPlacements(config, 3, "reserve")).toContain("a");
    recordCodexUpstreamOutcome(config, "a", 200, { now: NOW + 2, modelId: "gpt-reserve" });
    expect(newPlacements(config, 4, "reserve")).not.toContain("a");
  });

  test("a child of a live conversation still starts on its parent's account", () => {
    const config = makeConfig();
    usage(10, 10, 10);
    expect(resolveCodexAccountForThread("parent-key", config, NOW)).toBe("a");
    usage(95, 10, 10);
    const lineage: CodexThreadLineage = {
      conversationKey: "child-key",
      rootSessionKey: "parent-key",
      parentConversationKey: "parent-key",
      siblingConversationKeys: [],
    };
    const child = resolveCodexAccountForThreadDetailed("child-key", config, NOW + 1, undefined, undefined, undefined, lineage);
    expect(child.accountId).toBe("a");
  });
});

