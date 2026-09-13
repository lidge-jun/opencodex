import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rankAccountsByHeadroom,
  isAccountQuotaExhausted,
  hasHeadroomEvidence,
} from "../../src/oauth/account-quota-rank";
import {
  clearGenericFailoverHealth,
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

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-quota-rank-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
});

afterEach(() => {
  clearGenericFailoverHealth();
  clearAccountQuotaCache("google-antigravity");
  clearAccountQuotaCache("xai");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

describe("model-family headroom filtering", () => {
  test("Gemini request ignores spent Claude window on Antigravity", () => {
    // acct-1 has Claude at 99% (spent) but Gemini at 20% (healthy)
    setCachedProviderAccountQuotaForTests("google-antigravity", "acct-1", {
      customWindows: [
        { label: "Gem", percent: 20 },
        { label: "Gem (Weekly)", percent: 10 },
        { label: "Cla", percent: 99 },
        { label: "Cla (Weekly)", percent: 85 },
      ],
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", "acct-2", {
      customWindows: [
        { label: "Gem", percent: 50 },
        { label: "Gem (Weekly)", percent: 30 },
        { label: "Cla", percent: 10 },
        { label: "Cla (Weekly)", percent: 5 },
      ],
      updatedAt: Date.now(),
    });
    // For a Gemini model, acct-1 (80% Gem headroom) ranks above acct-2 (50% Gem headroom)
    const ranked = rankAccountsByHeadroom(
      "google-antigravity",
      ["acct-2", "acct-1"],
      "gemini-3.8-flash",
    );
    expect(ranked[0]).toBe("acct-1");
  });

  test("Claude request ignores healthy Gemini window on Antigravity", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "acct-1", {
      customWindows: [
        { label: "Gem", percent: 5 },
        { label: "Cla", percent: 95 },
      ],
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", "acct-2", {
      customWindows: [
        { label: "Gem", percent: 90 },
        { label: "Cla", percent: 30 },
      ],
      updatedAt: Date.now(),
    });
    // For a Claude model, acct-2 (70% Cla headroom) ranks above acct-1 (5% Cla headroom)
    const ranked = rankAccountsByHeadroom(
      "google-antigravity",
      ["acct-1", "acct-2"],
      "claude-opus-4-6-thinking",
    );
    expect(ranked[0]).toBe("acct-2");
  });

  test("non-Antigravity provider ignores modelId and uses all windows", () => {
    setCachedProviderAccountQuotaForTests("xai", "acct-1", {
      fiveHourPercent: 80,
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("xai", "acct-2", {
      fiveHourPercent: 30,
      updatedAt: Date.now(),
    });
    const ranked = rankAccountsByHeadroom("xai", ["acct-1", "acct-2"], "grok-3");
    expect(ranked[0]).toBe("acct-2");
  });

  test("without modelId, Antigravity uses all windows (backward compatibility)", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "acct-1", {
      customWindows: [
        { label: "Gem", percent: 20 },
        { label: "Cla", percent: 99 },
      ],
      updatedAt: Date.now(),
    });
    const ranked = rankAccountsByHeadroom("google-antigravity", ["acct-1"]);
    expect(ranked).toEqual(["acct-1"]);
  });
});

describe("model-family-aware exhaustion check", () => {
  test("global exhaustion check without requestedModelId", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "acct-1", {
      customWindows: [
        { label: "Gem", percent: 20 },
        { label: "Cla", percent: 100 },
      ],
      updatedAt: Date.now(),
    });
    // Global check without requestedModelId evaluates all windows (Cla at 100% -> exhausted)
    expect(isAccountQuotaExhausted("google-antigravity", "acct-1")).toBe(true);
  });

  test("model-filtered exhaustion check respects requested model family", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "acct-1", {
      customWindows: [
        { label: "Gem", percent: 20 },
        { label: "Cla", percent: 100 },
      ],
      updatedAt: Date.now(),
    });

    // For Gemini, acct-1 has 80% Gem headroom -> not exhausted
    expect(isAccountQuotaExhausted("google-antigravity", "acct-1", "gemini-3.8-flash")).toBe(false);

    // For Claude, acct-1 has 0% Cla headroom -> exhausted
    expect(isAccountQuotaExhausted("google-antigravity", "acct-1", "claude-3-7-sonnet")).toBe(true);
  });

  test("ranking does not treat account as exhausted when unrelated family window is spent", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "acct-1", {
      customWindows: [
        { label: "Gem", percent: 20 },
        { label: "Cla", percent: 100 },
      ],
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", "acct-2", {
      customWindows: [
        { label: "Gem", percent: 60 },
        { label: "Cla", percent: 40 },
      ],
      updatedAt: Date.now(),
    });

    // For Gemini: acct-1 has 80% Gem headroom, acct-2 has 40% Gem headroom.
    // acct-1 must not be marked exhausted by the 100% Cla window.
    const rankedGemini = rankAccountsByHeadroom(
      "google-antigravity",
      ["acct-2", "acct-1"],
      "gemini-3.8-flash",
    );
    expect(rankedGemini[0]).toBe("acct-1");

    // For Claude: acct-1 is exhausted (Cla 100%), acct-2 has 60% Cla headroom.
    const rankedClaude = rankAccountsByHeadroom(
      "google-antigravity",
      ["acct-1", "acct-2"],
      "claude-opus-4-6-thinking",
    );
    expect(rankedClaude[0]).toBe("acct-2");
  });

  test("hasHeadroomEvidence respects model family filter", () => {
    setCachedProviderAccountQuotaForTests("google-antigravity", "acct-1", {
      customWindows: [{ label: "Cla", percent: 50 }],
      updatedAt: Date.now(),
    });

    // Only Claude window exists: has evidence for Claude, but not for Gemini
    expect(hasHeadroomEvidence("google-antigravity", ["acct-1"], "claude-3-7-sonnet")).toBe(true);
    expect(hasHeadroomEvidence("google-antigravity", ["acct-1"], "gemini-3.8-flash")).toBe(false);
  });
});

describe("model-aware failover and pre-dispatch integration", () => {
  const dummyConfig = {
    providers: {
      "google-antigravity": {
        authMode: "oauth",
        destination: "https://example.com",
        oauthAccountFailover: {
          enabled: true,
          preferHealthyAccounts: true,
        },
      },
    },
  } as unknown as OcxConfig;

  test("preferredInitialAccount keeps active account if it has headroom for requested model family", async () => {
    await saveCredential("google-antigravity", {
      access: "tok-1",
      refresh: "ref-1",
      expires: Date.now() + 3600_000,
      accountId: "acct-1",
    });
    await saveCredential("google-antigravity", {
      access: "tok-2",
      refresh: "ref-2",
      expires: Date.now() + 3600_000,
      accountId: "acct-2",
    });

    const set = getAccountSet("google-antigravity")!;
    const id1 = set.accounts.find(a => a.credential.accountId === "acct-1")!.id;
    const id2 = set.accounts.find(a => a.credential.accountId === "acct-2")!.id;
    await setActiveAccount("google-antigravity", id1);

    // id1 is active. Cla is spent (100%), but Gem is healthy (20%).
    setCachedProviderAccountQuotaForTests("google-antigravity", id1, {
      customWindows: [
        { label: "Gem", percent: 20 },
        { label: "Cla", percent: 100 },
      ],
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", id2, {
      customWindows: [
        { label: "Gem", percent: 50 },
        { label: "Cla", percent: 20 },
      ],
      updatedAt: Date.now(),
    });

    // For a Gemini request: active account (id1) is healthy for Gemini, so returns null
    const preferredGemini = preferredInitialAccount(
      dummyConfig,
      "google-antigravity",
      Date.now(),
      "gemini-3.8-flash",
    );
    expect(preferredGemini).toBeNull();

    // For a Claude request: active account (id1) is spent for Claude, so switches to id2
    const preferredClaude = preferredInitialAccount(
      dummyConfig,
      "google-antigravity",
      Date.now(),
      "claude-opus-4-6-thinking",
    );
    expect(preferredClaude).toBe(id2);
  });

  test("rotateGenericOAuthAccountOn429 uses model-filtered ranking", async () => {
    await saveCredential("google-antigravity", {
      access: "tok-fail",
      refresh: "ref-fail",
      expires: Date.now() + 3600_000,
      accountId: "acct-fail",
    });
    await saveCredential("google-antigravity", {
      access: "tok-gem",
      refresh: "ref-gem",
      expires: Date.now() + 3600_000,
      accountId: "acct-gem-healthy",
    });
    await saveCredential("google-antigravity", {
      access: "tok-cla",
      refresh: "ref-cla",
      expires: Date.now() + 3600_000,
      accountId: "acct-cla-healthy",
    });

    const set = getAccountSet("google-antigravity")!;
    const idFail = set.accounts.find(a => a.credential.accountId === "acct-fail")!.id;
    const idGem = set.accounts.find(a => a.credential.accountId === "acct-gem-healthy")!.id;
    const idCla = set.accounts.find(a => a.credential.accountId === "acct-cla-healthy")!.id;

    // idGem has Gem 10%, Cla 90%
    setCachedProviderAccountQuotaForTests("google-antigravity", idGem, {
      customWindows: [
        { label: "Gem", percent: 10 },
        { label: "Cla", percent: 90 },
      ],
      updatedAt: Date.now(),
    });
    // idCla has Gem 90%, Cla 10%
    setCachedProviderAccountQuotaForTests("google-antigravity", idCla, {
      customWindows: [
        { label: "Gem", percent: 90 },
        { label: "Cla", percent: 10 },
      ],
      updatedAt: Date.now(),
    });

    // Rotate on 429 for Gemini request -> should pick idGem (90% Gem headroom)
    const nextGemini = rotateGenericOAuthAccountOn429(
      dummyConfig,
      "google-antigravity",
      idFail,
      null,
      Date.now(),
      "gemini-3.8-flash",
    );
    expect(nextGemini).toBe(idGem);

    // Rotate on 429 for Claude request -> should pick idCla (90% Cla headroom)
    const nextClaude = rotateGenericOAuthAccountOn429(
      dummyConfig,
      "google-antigravity",
      idFail,
      null,
      Date.now(),
      "claude-opus-4-6-thinking",
    );
    expect(nextClaude).toBe(idCla);
  });

  test("degenerates safely to unranked ring when customWindows labels drift or have no matching prefix", () => {
    const idDrift1 = "antigravity-drift-1";
    const idDrift2 = "antigravity-drift-2";
    const ring = [idDrift1, idDrift2];

    // Both accounts have labels that drift from standard "Gem" / "Cla" prefix (e.g. upstream renamed window labels)
    setCachedProviderAccountQuotaForTests("google-antigravity", idDrift1, {
      customWindows: [
        { label: "UnknownModelWindowA", percent: 95 },
      ],
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", idDrift2, {
      customWindows: [
        { label: "UnknownModelWindowB", percent: 50 },
      ],
      updatedAt: Date.now(),
    });

    // When requestedModelId is specified (gemini), but no windows match "Gem" prefix:
    // headroomOf returns null for both accounts, ranking preserves unranked ring fallback
    const ranked = rankAccountsByHeadroom("google-antigravity", ring, "gemini-3.8-flash");
    expect(ranked).toEqual(ring);
  });

  test("does not misclassify gemma as Gemini (no Gem prefix pollution)", () => {
    const idGem = "antigravity-gem";
    const idCla = "antigravity-cla";
    const ring = [idGem, idCla];

    setCachedProviderAccountQuotaForTests("google-antigravity", idGem, {
      customWindows: [
        { label: "Gem", percent: 10 },
        { label: "Cla", percent: 90 },
      ],
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("google-antigravity", idCla, {
      customWindows: [
        { label: "Gem", percent: 90 },
        { label: "Cla", percent: 10 },
      ],
      updatedAt: Date.now(),
    });

    // When requestedModelId is gemma, it should return undefined family and compare all windows (Math.max of 10 and 90 = 90 for both)
    const ranked = rankAccountsByHeadroom("google-antigravity", ring, "gemma-2-9b-it");
    expect(ranked).toEqual(ring);
  });
});

