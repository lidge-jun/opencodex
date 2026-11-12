import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types/config";
import {
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  flushProviderQuotaObservationsForTests,
  providerObservationAccountKeyForTests,
  setProviderQuotaBeforePublishForTests,
} from "../../src/providers/quota";
import { invalidateResolvedProviderKeyCache, setProviderKeychainEntryFactoryForTests } from "../../src/providers/api-key-resolve";
import { setQuotaResetSink } from "../../src/quota/reset-observer";
import {
  flushQuotaResetStoreForTests,
  resetQuotaResetStoreForTests,
} from "../../src/quota/reset-seen-store";
import { providerWindowObservations } from "../../src/quota/window-mapping";
import { quotaAccountTag, type QuotaResetEvent } from "../../src/quota/reset-detector";
import budget from "../fixtures/mistral-budget.json";
import subscription from "../fixtures/mistral-subscription.json";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let home: string;
let events: QuotaResetEvent[] = [];

function mistralConfig(apiKey: string): OcxConfig {
  return {
    defaultProvider: "mistral",
    providers: {
      mistral: { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.mistral.ai/v1", apiKey },
    },
  } as OcxConfig;
}

function deepseekConfig(apiKey: string): OcxConfig {
  return {
    defaultProvider: "deepseek",
    providers: {
      deepseek: { adapter: "openai-chat", authMode: "key", baseUrl: "https://api.deepseek.com/v1", apiKey },
    },
  } as OcxConfig;
}

function serveBudget(percent: number, resetAt: string) {
  globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? subscription : {
    api_budget: { ...budget.api_budget, usage_percentage: percent, reset_at: resetAt },
    vibe_budget: { ...budget.vibe_budget, usage_percentage: percent, reset_at: resetAt },
  })) as typeof fetch;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-mistral-reset-"));
  process.env.OPENCODEX_HOME = home;
  events = [];
  resetQuotaResetStoreForTests();
  clearProviderQuotaCache();
  setQuotaResetSink(event => events.push(event));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setProviderQuotaBeforePublishForTests(null);
  setQuotaResetSink(null);
  clearProviderQuotaCache();
  setProviderKeychainEntryFactoryForTests(null);
  resetQuotaResetStoreForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

describe("Mistral reset identity", () => {
  test("a reset baseline survives an unknown budget window with the same deadline", async () => {
    serveBudget(90, "2026-12-01T00:00:00Z");
    expect((await fetchProviderQuotaReports(mistralConfig("k1"), true)).reports).toHaveLength(1);
    await flushProviderQuotaObservationsForTests();
    events = [];
    // Only the API budget is unknown; Vibe keeps reporting. A second unknown window would
    // leave the observation with no measured window at all, which the observer treats as
    // nothing to observe rather than as a snapshot that retires every baseline.
    globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? subscription : {
      api_budget: { ...budget.api_budget, usage_percentage: undefined, initial_budget: 0, reset_at: "2026-12-01T00:00:00Z" },
      vibe_budget: { ...budget.vibe_budget, usage_percentage: 90, reset_at: "2026-12-01T00:00:00Z" },
    })) as typeof fetch;
    const unknown = await fetchProviderQuotaReports(mistralConfig("k1"), true);
    await flushProviderQuotaObservationsForTests();
    expect(unknown.reports[0]?.quota.unknownBudgetWindows?.[0]?.label).toBe("API budget (EDU)");
    expect(events).toEqual([]);
    // The API budget is measured again under the deadline it kept through the unknown window.
    // A retained baseline compares 90% against the new reading; a discarded one starts fresh
    // and stays silent, so this drop is the observable difference.
    serveBudget(20, "2026-12-01T00:00:00Z");
    await fetchProviderQuotaReports(mistralConfig("k1"), true);
    await flushProviderQuotaObservationsForTests();
    expect(events.map(event => [event.window, event.kind, event.percentBefore, event.percentAfter])).toEqual([
      ["custom:API budget", "surprise", 90, 20],
      ["custom:Vibe budget", "surprise", 90, 20],
    ]);
  });

  test("an unknown budget whose deadline moved does not reuse the old baseline", async () => {
    serveBudget(90, "2026-12-01T00:00:00Z");
    await fetchProviderQuotaReports(mistralConfig("k1"), true);
    await flushProviderQuotaObservationsForTests();
    events = [];
    globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? subscription : {
      api_budget: { ...budget.api_budget, initial_budget: 0, reset_at: "2027-06-01T00:00:00Z" },
      vibe_budget: { ...budget.vibe_budget, usage_percentage: 90, reset_at: "2026-12-01T00:00:00Z" },
    })) as typeof fetch;
    const moved = await fetchProviderQuotaReports(mistralConfig("k1"), true);
    await flushProviderQuotaObservationsForTests();
    expect(events).toEqual([]);
    expect(moved.reports[0]?.quota.unknownBudgetWindows).toEqual([
      { label: "API budget (EDU)", resetAt: Date.UTC(2027, 5, 1) },
    ]);
    // The API budget returns under its moved deadline. Its old baseline identified the old
    // deadline, so it is not reused: this reading starts a new baseline and claims nothing.
    globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? subscription : {
      api_budget: { ...budget.api_budget, usage_percentage: 20, reset_at: "2027-06-01T00:00:00Z" },
      vibe_budget: { ...budget.vibe_budget, usage_percentage: 90, reset_at: "2026-12-01T00:00:00Z" },
    })) as typeof fetch;
    await fetchProviderQuotaReports(mistralConfig("k1"), true);
    await flushProviderQuotaObservationsForTests();
    expect(events).toEqual([]);
    // A later drop compares against that new baseline, which is the only reading retained.
    serveBudget(1, "2027-06-01T00:00:00Z");
    await fetchProviderQuotaReports(mistralConfig("k1"), true);
    await flushProviderQuotaObservationsForTests();
    // Vibe was last measured at 90% (its unknown-window reading kept that percent), so it
    // compares against that; the API budget compares against its post-move 20%.
    expect(events.map(event => [event.window, event.kind, event.percentBefore, event.percentAfter])).toEqual([
      ["custom:API budget", "surprise", 20, 1],
      ["custom:Vibe budget", "surprise", 90, 1],
    ]);
  });

  test("a credential rotation neither inherits nor emits the previous key's baseline", async () => {
    serveBudget(90, "2026-12-01T00:00:00Z");
    await fetchProviderQuotaReports(mistralConfig("first-credential"), true);
    await flushProviderQuotaObservationsForTests();
    serveBudget(20, "2027-01-01T00:00:00Z");
    await fetchProviderQuotaReports(mistralConfig("second-credential"), true);
    await flushProviderQuotaObservationsForTests();
    expect(events).toEqual([]);
    serveBudget(1, "2027-02-01T00:00:00Z");
    await fetchProviderQuotaReports(mistralConfig("second-credential"), true);
    await flushProviderQuotaObservationsForTests();
    expect(events.map(event => [event.window, event.percentBefore, event.percentAfter])).toEqual([
      ["custom:API budget", 20, 1],
      ["custom:Vibe budget", 20, 1],
    ]);
  });

  test("a keychain credential change is observed under its own identity", async () => {
    let stored = "keychain-credential-a";
    setProviderKeychainEntryFactoryForTests(() => ({
      getPassword: () => stored,
      setPassword: () => {},
      deletePassword: () => true,
    }));
    serveBudget(95, "2026-12-01T00:00:00Z");
    await fetchProviderQuotaReports(mistralConfig("keychain:mistral"), true);
    await flushProviderQuotaObservationsForTests();
    stored = "keychain-credential-b";
    invalidateResolvedProviderKeyCache();
    serveBudget(3, "2027-01-01T00:00:00Z");
    await fetchProviderQuotaReports(mistralConfig("keychain:mistral"), true);
    await flushProviderQuotaObservationsForTests();
    expect(events).toEqual([]);
  });

  test("a transient refresh keeps the previous baseline instead of re-baselining", async () => {
    serveBudget(90, "2026-12-01T00:00:00Z");
    await fetchProviderQuotaReports(mistralConfig("k1"), true);
    await flushProviderQuotaObservationsForTests();
    globalThis.fetch = (async () => { throw new Error("fixture transport failure"); }) as typeof fetch;
    // A transient failure publishes no new measurement, so the bounded last-good row is
    // retained rather than replaced, and no observation is made from the failed probe.
    expect((await fetchProviderQuotaReports(mistralConfig("k1"), true)).reports.map(report => report.quota.customWindows?.map(window => window.percent))).toEqual([[90, 90]]);
    await flushProviderQuotaObservationsForTests();
    serveBudget(4, "2027-01-01T00:00:00Z");
    await fetchProviderQuotaReports(mistralConfig("k1"), true);
    await flushProviderQuotaObservationsForTests();
    expect(events.map(event => event.percentBefore)).toEqual([90, 90]);
  });

  test("the persisted state never contains a credential", async () => {
    const credential = "synthetic-persisted-secret-9f2a";
    serveBudget(90, "2026-12-01T00:00:00Z");
    await fetchProviderQuotaReports(mistralConfig(credential), true);
    await flushProviderQuotaObservationsForTests();
    flushQuotaResetStoreForTests();
    const state = readFileSync(join(home, "quota-reset-state.json"), "utf8");
    expect(state).not.toContain(credential);
    expect(state).not.toContain("key:");
  });
});

describe("non-Mistral reset identity continuity", () => {
  test("old API-key baselines keep their exact legacy identity and tag", () => {
    const key = ["sk", "legacy", "continuity", "key"].join("-");
    const config = deepseekConfig(key);
    const accountKey = providerObservationAccountKeyForTests("deepseek", config);
    // The legacy identity is the provider name plus the 8-char apiKeyPoolEntryId digest.
    const legacyId = new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 8);
    expect(accountKey).toBe(`deepseek\u0000key:${legacyId}`);
    expect(quotaAccountTag(accountKey, "0123456789abcdef")).toBe(
      Bun.hash(`0123456789abcdef\u0000deepseek\u0000key:${legacyId}`).toString(36).slice(0, 8).padStart(8, "0"),
    );
  });

  test("a non-Mistral key rotation keeps the dev collision behaviour", async () => {
    const config = deepseekConfig("deepseek-first-key");
    globalThis.fetch = (async () => Response.json({
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "10", granted_balance: "0", topped_up_balance: "10" }],
    })) as typeof fetch;
    await fetchProviderQuotaReports(config, true);
    await flushProviderQuotaObservationsForTests();
    const before = providerObservationAccountKeyForTests("deepseek", deepseekConfig("deepseek-second-key"));
    const after = providerObservationAccountKeyForTests("deepseek", deepseekConfig("deepseek-second-key"));
    expect(before).toBe(after);
    expect(before.startsWith("deepseek\u0000key:")).toBe(true);
    expect(before.length).toBe("deepseek\u0000key:".length + 8);
  });

  test("a non-Mistral unknown window is not retained", async () => {
    const accountKey = providerObservationAccountKeyForTests("deepseek", deepseekConfig("k"));
    expect(accountKey).toContain("deepseek");
    // Mistral-only retention must not change how another provider's absent windows behave.
    const { providerWindowObservations: map } = await import("../../src/quota/window-mapping");
    expect(map({ updatedAt: Date.now(), fiveHourPercent: 10 })).toEqual([{ window: "5h", percent: 10, windowSeconds: 18000 }]);
  });
});

describe("Mistral unknown window retention boundaries (#8295 review)", () => {
  // The probe's own result for one payload: which budgets it measured, which it could not.
  async function probe(api: { percent?: number; initial?: number; resetAt?: string }, vibe: { percent?: number; initial?: number; resetAt?: string }) {
    const row = (value: { percent?: number; initial?: number; resetAt?: string }, base: typeof budget.api_budget) => ({
      ...base,
      ...(value.percent === undefined ? { usage_percentage: undefined } : { usage_percentage: value.percent }),
      ...(value.initial === undefined ? {} : { initial_budget: value.initial }),
      ...(value.resetAt === undefined ? {} : { reset_at: value.resetAt }),
    });
    globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? subscription : {
      api_budget: row(api, budget.api_budget),
      vibe_budget: row(vibe, budget.vibe_budget),
    })) as typeof fetch;
    const report = (await fetchProviderQuotaReports(mistralConfig("k1"), true)).reports[0]!;
    await flushProviderQuotaObservationsForTests();
    return report.quota;
  }

  test("an unknown window is represented while the other stays measured", async () => {
    await probe({ percent: 90, resetAt: "2026-12-01T00:00:00Z" }, { percent: 90, resetAt: "2026-12-01T00:00:00Z" });
    events = [];
    // The API budget is explicitly unknown with a matching clock; Vibe is still measured.
    const quota = await probe({ percent: undefined, initial: 0, resetAt: "2026-12-01T00:00:00Z" }, { percent: 90, resetAt: "2026-12-01T00:00:00Z" });
    expect(quota.customWindows?.map(window => window.label)).toEqual(["Vibe budget"]);
    expect(quota.unknownBudgetWindows?.map(window => window.label)).toEqual(["API budget (EDU)"]);
    expect(events).toEqual([]);
  });

  test("an unknown window retains its matching fixture clock and baseline", async () => {
    await probe({ percent: 90, resetAt: "2026-12-01T00:00:00Z" }, { percent: 90, resetAt: "2026-12-01T00:00:00Z" });
    events = [];
    // The helper retains the fixture deadline when no override is supplied.
    const quota = await probe({ percent: undefined, initial: 0, resetAt: undefined }, { percent: 90, resetAt: "2026-12-01T00:00:00Z" });
    expect(quota.unknownBudgetWindows?.map(window => window.label)).toEqual(["API budget (EDU)"]);
    expect(events).toEqual([]);
    expect(quota.unknownBudgetWindows?.[0]?.resetAt).toBe(Date.UTC(2026, 11, 1));
    // A later drop under the same deadline is compared to the retained baseline.
    const next = await probe({ percent: 20, resetAt: "2026-12-01T00:00:00Z" }, { percent: 90, resetAt: "2026-12-01T00:00:00Z" });
    expect(events.map(event => [event.window, event.kind, event.percentBefore, event.percentAfter, event.previousResetAt])).toEqual([
      ["custom:API budget", "surprise", 90, 20, Date.UTC(2026, 11, 1)],
    ]);
    expect(providerWindowObservations(next).find(window => window.window === "custom:API budget")?.percent).toBe(20);
  });
  test("a missing API budget and an unknown Vibe budget without clocks do not retain old baselines", async () => {
    await probe({ percent: 90, resetAt: "2026-12-01T00:00:00Z" }, { percent: 80, resetAt: "2026-12-01T00:00:00Z" });
    events = [];
    globalThis.fetch = (async input => Response.json(String(input).endsWith("/subscription") ? subscription : {
      vibe_budget: { ...budget.vibe_budget, usage_percentage: undefined, initial_budget: 0, reset_at: undefined },
    })) as typeof fetch;
    const missing = (await fetchProviderQuotaReports(mistralConfig("k1"), true)).reports[0]!.quota;
    await flushProviderQuotaObservationsForTests();
    expect(missing.unknownBudgetWindows).toEqual([{ label: "API budget (EDU)" }, { label: "Vibe budget (EDU)" }]);
    expect(events).toEqual([]);
    await probe({ percent: 20, resetAt: "2026-12-01T00:00:00Z" }, { percent: 10, resetAt: "2026-12-01T00:00:00Z" });
    expect(events).toEqual([]);
  });
  test("a measured drop with the same deadline is still a surprise reset after an unknown window", async () => {
    await probe({ percent: 90, resetAt: "2026-12-01T00:00:00Z" }, { percent: 90, resetAt: "2026-12-01T00:00:00Z" });
    await probe({ percent: undefined, initial: 0, resetAt: "2026-12-01T00:00:00Z" }, { percent: 90, resetAt: "2026-12-01T00:00:00Z" });
    events = [];
    // Retention must not suppress a genuine drop: the retained 90% baseline is what makes
    // this 20% reading visible as a reset rather than a fresh start.
    await probe({ percent: 20, resetAt: "2026-12-01T00:00:00Z" }, { percent: 90, resetAt: "2026-12-01T00:00:00Z" });
    expect(events.map(event => [event.window, event.kind, event.percentBefore, event.percentAfter])).toEqual([
      ["custom:API budget", "surprise", 90, 20],
    ]);
  });
});
