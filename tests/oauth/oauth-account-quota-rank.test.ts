import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyModelFamilyForQuota,
  hasHeadroomEvidence,
  isAccountQuotaExhausted,
  rankAccountsByHeadroom,
} from "../../src/oauth/account-quota-rank";
import {
  clearPoolRotationState,
} from "../../src/oauth/pool-kernel";
import {
  clearGenericFailoverHealth,
  eligibleFailoverAccounts,
  genericFailoverRetryAfterSeconds,
  noteGenericPoolSelection,
  preferredInitialAccount,
  rotateGenericOAuthAccountOn429,
} from "../../src/oauth/generic-account-failover";
import {
  clearAccountQuotaCache,
  setCachedProviderAccountQuotaForTests,
} from "../../src/providers/quota";
import {
  getAccountSet,
  saveCredential,
  setActiveAccount,
} from "../../src/oauth/store";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  clearPoolRotationState();
  home = mkdtempSync(join(tmpdir(), "ocx-quota-rank-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
});

afterEach(() => {
  clearPoolRotationState();
  clearGenericFailoverHealth();
  clearAccountQuotaCache("google-antigravity");
  clearAccountQuotaCache("xai");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

const PROVIDER = {
  adapter: "google",
  authMode: "oauth",
} as unknown as OcxProviderConfig;

function config(strategy?: "quota" | "round-robin" | "fill-first"): OcxConfig {
  return {
    providers: {
      "google-antigravity": {
        ...PROVIDER,
        oauthAccountFailover: {
          enabled: true,
          ...(strategy ? { strategy } : {}),
          autoSwitchThreshold: 80,
        },
      },
    },
    oauthAccountFailover: { enabled: true },
    ...(strategy ? { pool: { kernel: true } } : {}),
  } as unknown as OcxConfig;
}

function seedWindows(accountId: string, gem: number, cla: number): void {
  setCachedProviderAccountQuotaForTests("google-antigravity", accountId, {
    updatedAt: Date.now(),
    customWindows: [
      { label: "Gem", percent: gem },
      { label: "Gem (Weekly)", percent: gem },
      { label: "Cla", percent: cla },
      { label: "Cla (Weekly)", percent: cla },
    ],
  });
}

async function seedAntigravityAccounts(count = 2): Promise<string[]> {
  for (let i = 1; i <= count; i++) {
    await saveCredential("google-antigravity", {
      access: `tok-${i}`,
      refresh: `ref-${i}`,
      expires: Date.now() + 3600_000,
      accountId: `acct-${i}`,
    });
  }
  const set = getAccountSet("google-antigravity")!;
  return set.accounts.map(a => a.id);
}

describe("classifyModelFamilyForQuota", () => {
  test("maps Gemini, Claude, and GPT-OSS models, and ignores Gemma", () => {
    expect(classifyModelFamilyForQuota("google-antigravity", "gemini-3.8-flash")).toBe("gem");
    expect(classifyModelFamilyForQuota("google-antigravity", "gemini-pro-agent")).toBe("gem");
    expect(classifyModelFamilyForQuota("google-antigravity", "gemini-3.1-flash-image")).toBe("gem");
    expect(classifyModelFamilyForQuota("google-antigravity", "claude-sonnet-4-5")).toBe("cla");
    expect(classifyModelFamilyForQuota("google-antigravity", "claude-opus-4-6-thinking")).toBe("cla");
    expect(classifyModelFamilyForQuota("google-antigravity", "claude-3-7-sonnet")).toBe("cla");
    expect(classifyModelFamilyForQuota("google-antigravity", "gpt-oss-120b")).toBe("cla");
    expect(classifyModelFamilyForQuota("google-antigravity", "gpt_oss_20b")).toBe("cla");
    expect(classifyModelFamilyForQuota("google-antigravity", "gemma-3-27b")).toBeUndefined();
    expect(classifyModelFamilyForQuota("google-antigravity", "gemma-2-9b-it")).toBeUndefined();
    expect(classifyModelFamilyForQuota("google-antigravity", "gem-experimental")).toBeUndefined();
    expect(classifyModelFamilyForQuota("xai", "gemini-3.8-flash")).toBeUndefined();
    expect(classifyModelFamilyForQuota("google-antigravity", undefined)).toBeUndefined();
    expect(classifyModelFamilyForQuota("google-antigravity", null)).toBeUndefined();
  });
});

describe("model-family headroom filtering", () => {
  test("Gemini request ignores spent Claude window on Antigravity", () => {
    seedWindows("a", 20, 100);
    seedWindows("b", 80, 5);
    const ranked = rankAccountsByHeadroom(
      "google-antigravity",
      ["b", "a"],
      "gemini-3.8-flash",
    );
    expect(ranked[0]).toBe("a");
  });

  test("Claude request ignores healthy Gemini window on Antigravity", () => {
    seedWindows("a", 20, 100);
    seedWindows("b", 80, 5);
    const ranked = rankAccountsByHeadroom(
      "google-antigravity",
      ["a", "b"],
      "claude-sonnet-4-5",
    );
    expect(ranked[0]).toBe("b");
  });

  test("GPT-OSS request uses Claude 3P window on Antigravity", () => {
    seedWindows("a", 10, 95);
    seedWindows("b", 90, 15);
    const ranked = rankAccountsByHeadroom(
      "google-antigravity",
      ["a", "b"],
      "gpt-oss-120b",
    );
    expect(ranked[0]).toBe("b");
  });

  test("ranking does not treat account as exhausted when unrelated family window is spent", () => {
    seedWindows("a", 20, 100);
    seedWindows("b", 60, 40);

    // For Gemini: acct-a has 80% Gem headroom, acct-b has 40% Gem headroom.
    // acct-a must not be marked exhausted by the 100% Cla window.
    const rankedGemini = rankAccountsByHeadroom(
      "google-antigravity",
      ["b", "a"],
      "gemini-3.8-flash",
    );
    expect(rankedGemini[0]).toBe("a");

    // For Claude: acct-a is exhausted (Cla 100%), acct-b has 60% Cla headroom.
    const rankedClaude = rankAccountsByHeadroom(
      "google-antigravity",
      ["a", "b"],
      "claude-opus-4-6-thinking",
    );
    expect(rankedClaude[0]).toBe("b");
  });

  test("non-Antigravity provider ignores modelId and uses all windows", () => {
    setCachedProviderAccountQuotaForTests("xai", "a", {
      fiveHourPercent: 80,
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("xai", "b", {
      fiveHourPercent: 30,
      updatedAt: Date.now(),
    });
    const ranked = rankAccountsByHeadroom("xai", ["a", "b"], "gemini-3.8-flash");
    expect(ranked[0]).toBe("b");
  });

  test("without modelId, Antigravity uses all windows (backward compatibility)", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "a", {
      customWindows: [
        { label: "Gem", percent: 20 },
        { label: "Cla", percent: 99 },
      ],
      updatedAt: Date.now(),
    });
    const ranked = rankAccountsByHeadroom("google-antigravity", ["a"]);
    expect(ranked).toEqual(["a"]);
  });

  test("falls back to unranked ring when family labels are missing or drifted", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "a", {
      updatedAt: Date.now(),
      customWindows: [{ label: "UnknownWindowA", percent: 1 }],
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", "b", {
      updatedAt: Date.now(),
      customWindows: [{ label: "UnknownWindowB", percent: 99 }],
    });
    expect(hasHeadroomEvidence("google-antigravity", ["a", "b"], "gemini-3.8-flash")).toBe(false);
    expect(rankAccountsByHeadroom("google-antigravity", ["b", "a"], "gemini-3.8-flash")).toEqual(["b", "a"]);
  });

  test("does not misclassify gemma as Gemini (no Gem prefix pollution)", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "a", {
      customWindows: [
        { label: "Gem", percent: 10 },
        { label: "Cla", percent: 90 },
      ],
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", "b", {
      customWindows: [
        { label: "Gem", percent: 90 },
        { label: "Cla", percent: 10 },
      ],
      updatedAt: Date.now(),
    });
    const ranked = rankAccountsByHeadroom("google-antigravity", ["a", "b"], "gemma-3-27b");
    expect(ranked).toEqual(["a", "b"]);
  });
});

describe("model-family-aware exhaustion check", () => {
  test("global exhaustion check without requestedModelId evaluates all windows", () => {
    seedWindows("a", 20, 100);
    expect(isAccountQuotaExhausted("google-antigravity", "a")).toBe(true);
  });

  test("model-filtered exhaustion check respects requested model family", () => {
    seedWindows("a", 20, 100);
    expect(isAccountQuotaExhausted("google-antigravity", "a", "gemini-3.8-flash")).toBe(false);
    expect(isAccountQuotaExhausted("google-antigravity", "a", "claude-sonnet-4-5")).toBe(true);
  });

  test("hasHeadroomEvidence respects model family filter", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "a", {
      customWindows: [{ label: "Cla", percent: 50 }],
      updatedAt: Date.now(),
    });
    expect(hasHeadroomEvidence("google-antigravity", ["a"], "claude-sonnet-4-5")).toBe(true);
    expect(hasHeadroomEvidence("google-antigravity", ["a"], "gemini-3.8-flash")).toBe(false);
  });
});

describe("Antigravity family-scoped cooldown and routing", () => {
  test("a Claude 429 still keeps the account for Gemini", async () => {
    const [id1, id2] = await seedAntigravityAccounts(2);
    await setActiveAccount("google-antigravity", id1);
    seedWindows(id1, 10, 100);
    seedWindows(id2, 80, 5);

    const cfg = config();
    // Rotating on Claude 429 chooses id2
    expect(rotateGenericOAuthAccountOn429(cfg, "google-antigravity", id1, null, Date.now(), "claude-sonnet-4-5")).toBe(id2);
    // id1 is in Claude cooldown, but still eligible for Gemini
    expect(eligibleFailoverAccounts("google-antigravity", Date.now(), "gem")).toContain(id1);
    expect(eligibleFailoverAccounts("google-antigravity", Date.now(), "cla")).not.toContain(id1);
    expect(genericFailoverRetryAfterSeconds("google-antigravity")).toBeGreaterThan(0);

    // preferredInitialAccount for Gemini stays on id1
    expect(preferredInitialAccount(cfg, "google-antigravity", Date.now(), "gemini-3.8-flash")).toBeNull();
  });

  test("rotateGenericOAuthAccountOn429 uses model-filtered ranking across multiple accounts", async () => {
    const [idFail, idGem, idCla] = await seedAntigravityAccounts(3);
    await setActiveAccount("google-antigravity", idFail);

    // idGem has Gem 10%, Cla 90%
    seedWindows(idGem, 10, 90);
    // idCla has Gem 90%, Cla 10%
    seedWindows(idCla, 90, 10);

    const cfg = config();
    // Rotate on 429 for Gemini request -> should pick idGem (90% Gem headroom)
    const nextGemini = rotateGenericOAuthAccountOn429(
      cfg,
      "google-antigravity",
      idFail,
      null,
      Date.now(),
      "gemini-3.8-flash",
    );
    expect(nextGemini).toBe(idGem);

    // Rotate on 429 for Claude request -> should pick idCla (90% Cla headroom)
    const nextClaude = rotateGenericOAuthAccountOn429(
      cfg,
      "google-antigravity",
      idFail,
      null,
      Date.now(),
      "claude-opus-4-6-thinking",
    );
    expect(nextClaude).toBe(idCla);
  });

  test("preferredInitialAccount switches away when active account is spent for requested family", async () => {
    const [id1, id2] = await seedAntigravityAccounts(2);
    await setActiveAccount("google-antigravity", id1);
    seedWindows(id1, 20, 100);
    seedWindows(id2, 50, 20);

    const cfg = config();
    // Gemini: active account has 80% Gem headroom -> keep active (null)
    expect(preferredInitialAccount(cfg, "google-antigravity", Date.now(), "gemini-3.8-flash")).toBeNull();
    // Claude: active account is spent for Claude -> switch to id2
    expect(preferredInitialAccount(cfg, "google-antigravity", Date.now(), "claude-sonnet-4-5")).toBe(id2);
  });
});

describe("Antigravity family strategies behind pool.kernel", () => {
  test("fill-first stays on Gemini headroom when only Claude is over threshold", async () => {
    const [id1, id2] = await seedAntigravityAccounts(2);
    await setActiveAccount("google-antigravity", id1);
    seedWindows(id1, 40, 90);
    seedWindows(id2, 10, 10);

    const cfg = config("fill-first");
    // Gemini usage is 40% (under 80% threshold) -> stays active
    expect(preferredInitialAccount(cfg, "google-antigravity", Date.now(), "gemini-3.8-flash")).toBeNull();
    // Claude usage is 90% (over 80% threshold) -> advances to id2
    expect(preferredInitialAccount(cfg, "google-antigravity", Date.now(), "claude-sonnet-4-5")).toBe(id2);
  });

  test("a Claude 429 does not hide the account from Gemini round-robin", async () => {
    const [id1, id2] = await seedAntigravityAccounts(2);
    await setActiveAccount("google-antigravity", id1);
    seedWindows(id1, 20, 20);
    seedWindows(id2, 20, 20);

    const cfg = config("round-robin");
    expect(rotateGenericOAuthAccountOn429(cfg, "google-antigravity", id1, null, Date.now(), "claude-sonnet-4-5")).toBe(id2);
    expect(eligibleFailoverAccounts("google-antigravity", Date.now(), "gem")).toContain(id1);
    expect(eligibleFailoverAccounts("google-antigravity", Date.now(), "cla")).not.toContain(id1);
  });

  test("noteGenericPoolSelection accepts requestedModelId and advances cursor", async () => {
    const [id1, id2] = await seedAntigravityAccounts(2);
    const cfg = config("round-robin");
    expect(() => noteGenericPoolSelection(cfg, "google-antigravity", id1, "gemini-3.8-flash")).not.toThrow();
  });
});

describe("modular Responses model-family forwarding", () => {
  test("initial selection receives the routed model in the transport owner", () => {
    const source = readFileSync(repoPath("src/server/responses/request-transport.ts"), "utf8");
    expect(source).toContain("preferredInitialAccount(config, route.providerName, Date.now(), route.modelId)");
  });

  for (const [owner, retryAfter] of [
    ["passthrough-dispatch.ts", 'upstreamResponse.headers.get("retry-after")'],
    ["adapter-dispatch.ts", 'upstreamResponse.headers.get("retry-after")'],
    ["adapter-continuation.ts", 'response.headers.get("retry-after")'],
    ["sidecar-execution.ts", "retryAfter"],
    ["run-turn-execution.ts", "null"],
  ] as const) {
    test(owner + " forwards the routed model on account rotation", () => {
      const source = readFileSync(repoPath("src/server/responses", owner), "utf8");
      expect(source.match(/\brotateGenericOAuthAccountOn429\s*\(/g)).toHaveLength(1);
      expect(source.replace(/\s+/g, " ")).toContain(
        "rotateGenericOAuthAccountOn429( config, route.providerName, "
          + "transportState.genericFailoverAccountId, " + retryAfter
          + ", Date.now(), route.modelId, )",
      );
    });
  }
});

