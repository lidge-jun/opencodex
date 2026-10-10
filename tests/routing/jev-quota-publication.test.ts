import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { publishDecisionAccountQuota, publishDecisionQuotaRoster, readLoadedDecisionQuotaPool, publishDecisionKeyQuota, readLoadedDecisionKeyQuota, invalidateDecisionKeyQuotas, setDecisionAccountUsable } from "../../src/providers/quota-decision-snapshot";
import { publishAnthropicDecisionQuota, publishCodexDecisionQuota } from "../../src/providers/quota-decision-publication";
import { observeMainDecisionCredentialUsable, clearMainAccountInfoCache, observeMainQuotaIdentity, observeMainQuotaCredential, mainDecisionQuotaWriterGeneration, setMainAccountCredentialPresence } from "../../src/codex/main-account-cache";
import { saveCodexAccountCredential, capturePoolQuotaWriter, removeCodexAccountCredential } from "../../src/codex/account-store";
import { applyAccountQuotaFromUpstreamHeaders, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { saveCredential, getAccountSet, getAccountCredential, credentialGeneration, saveAccountCredential, setAccountPaused, markAccountNeedsReauth, removeAccount } from "../../src/oauth/store";
import { probeAnthropicQuotaWithRecovery, setAnthropicQuotaAfterSettlementForTests } from "../../src/providers/quota/anthropic-cooldown-recovery";
import { rawAnthropicUsageWindows, rawAnthropicHeaderWindows } from "../../src/providers/quota/anthropic-decision-windows";
import { fetchAnthropicUsageQuota } from "../../src/providers/quota/vendor-probes-oauth";
import { recordAnthropicAccountQuotaFromHeaders } from "../../src/providers/quota/account-cache";
import { jevQuotaSignalFromWindows } from "../../src/combos/jev-quota";
import { keyReport, publishCollectedDecisionQuota } from "../../src/providers/quota/report-cache";
import { parseOllamaCloudBalance } from "../../src/providers/quota";
import { resolveProviderApiKey, invalidateResolvedProviderKeyCache } from "../../src/providers/api-key-resolve";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { OcxConfig } from "../../src/types";

let home: TempHome;
const now = 2_000_000_000_000;
let clock: ReturnType<typeof spyOn>;
beforeEach(() => { home = createTempHome("ocx-jq-pub-"); clock = spyOn(Date, "now").mockReturnValue(now); clearMainAccountInfoCache(); invalidateDecisionKeyQuotas(); publishDecisionQuotaRoster("anthropic", []); publishDecisionQuotaRoster("codex", []); });
afterEach(() => { setAnthropicQuotaAfterSettlementForTests(undefined); clock.mockRestore(); invalidateDecisionKeyQuotas(); home.remove(); });
const credential = { access: "fixture-access", refresh: "fixture-refresh", expires: now + 3_600_000 };
/** Save a fixture Anthropic credential and return its account id. */
async function anthropicAccount(): Promise<string> {
  await saveCredential("anthropic", credential);
  return getAccountSet("anthropic")!.accounts[0]!.id;
}

test("auth mutation owner publishes pause, reauth, replacement and deletion without JEV loading", async () => {
  const id = await anthropicAccount();
  const generation = credentialGeneration(getAccountCredential("anthropic", id)!);
  publishAnthropicDecisionQuota(id, generation, { weeklyPercent: 90, updatedAt: now });
  expect(readLoadedDecisionQuotaPool("anthropic")?.[0]).toMatchObject({ usable: true, windows: [{ window: "weekly", percent: 90, observedAt: now }] });
  await setAccountPaused("anthropic", id, true);
  expect(readLoadedDecisionQuotaPool("anthropic")?.[0]?.usable).toBe(false);
  await setAccountPaused("anthropic", id, false);
  await markAccountNeedsReauth("anthropic", id, true);
  expect(readLoadedDecisionQuotaPool("anthropic")?.[0]?.usable).toBe(false);
  await saveAccountCredential("anthropic", id, { ...credential, access: "replacement" });
  expect(readLoadedDecisionQuotaPool("anthropic")?.[0]).toMatchObject({ usable: true });
  expect(readLoadedDecisionQuotaPool("anthropic")?.[0]?.windows).toBeUndefined();
  publishAnthropicDecisionQuota(id, generation, { weeklyPercent: 99, updatedAt: now });
  expect(readLoadedDecisionQuotaPool("anthropic")?.[0]?.windows).toBeUndefined();
  await removeAccount("anthropic", id);
  expect(readLoadedDecisionQuotaPool("anthropic")).toEqual([]);
});

test("Anthropic probe publication is captured-generation bound and raw family clocks stay old", async () => {
  const id = await anthropicAccount();
  const generation = credentialGeneration(credential);
  publishAnthropicDecisionQuota(id, generation, { updatedAt: now - 1000, customWindows: [{ label: "Opus", scope: "model", percent: 90 }] });
  const probe = await probeAnthropicQuotaWithRecovery(id, credential.access, async () => ({ weeklyPercent: 20, updatedAt: now }), () => true);
  probe!.publishDecisionQuota();
  expect(readLoadedDecisionQuotaPool("anthropic")?.[0]?.windows).toContainEqual({ window: "opus", percent: 90, observedAt: now - 1000 });
  await saveAccountCredential("anthropic", id, { ...credential, access: "replacement" });
  probe!.publishDecisionQuota();
  expect(readLoadedDecisionQuotaPool("anthropic")?.[0]?.windows).toBeUndefined();
});

test("Codex credential owner and accepted writer reject late generations and display-only writes", () => {
  const cred = { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: now + 3_600_000, chatgptAccountId: "fixture-subject" };
  const generation = saveCodexAccountCredential("fixture", cred);
  const writer = capturePoolQuotaWriter("fixture", { ...cred, generation });
  expect(writer?.credentialGeneration).toBe(generation);
  setAccountQuotaFromParsed("fixture", { weeklyPercent: 90 });
  expect(readLoadedDecisionQuotaPool("codex")?.[0]?.windows).toBeUndefined();
  setAccountQuotaFromParsed("fixture", { weeklyPercent: 90 }, undefined, undefined, null, { writer: writer!, source: "wham", raw: { weeklyPercent: 90 }, observedAt: now });
  expect(readLoadedDecisionQuotaPool("codex")?.[0]?.windows?.[0]?.percent).toBe(90);
  saveCodexAccountCredential("fixture", { ...cred, accessToken: "replacement" });
  setAccountQuotaFromParsed("fixture", { weeklyPercent: 99 }, undefined, undefined, null, { writer: writer!, source: "wham", raw: { weeklyPercent: 99 }, observedAt: now });
  expect(readLoadedDecisionQuotaPool("codex")?.[0]?.windows).toBeUndefined();
  removeCodexAccountCredential("fixture");
  expect(readLoadedDecisionQuotaPool("codex")?.[0]?.usable).toBe(false);
});

test("partial Codex headers and credits preserve omitted window clocks; full observation replaces", () => {
  publishDecisionQuotaRoster("codex", [{ id: "fixture", generation: 1, usable: true }]);
  publishCodexDecisionQuota("fixture", 1, { weeklyPercent: 90, shortPercent: 50 }, now - 1000);
  publishCodexDecisionQuota("fixture", 1, { shortPercent: 20 }, now);
  publishCodexDecisionQuota("fixture", 1, { credits: { unlimited: true, observedAt: now } }, now);
  expect(readLoadedDecisionQuotaPool("codex")?.[0]?.windows).toContainEqual({ window: "weekly", percent: 90, observedAt: now - 1000 });
  publishCodexDecisionQuota("fixture", 1, { weeklyPercent: 20 }, now, "codex", false);
  expect(readLoadedDecisionQuotaPool("codex")?.[0]?.windows).toEqual([{ window: "weekly", percent: 20, observedAt: now }]);
});

test("main writers bind bearer generation and physical disappearance clears evidence", () => {
  observeMainQuotaIdentity("fixture-main"); setMainAccountCredentialPresence(true);
  const writer = observeMainQuotaCredential("fixture-access", "fixture-main")!;
  const generation = mainDecisionQuotaWriterGeneration(writer)!;
  publishCodexDecisionQuota("__main__", generation, { monthlyPercent: 90 }, now, "codex-main");
  expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.windows?.[0]?.percent).toBe(90);
  observeMainQuotaCredential("replacement", "fixture-main");
  expect(mainDecisionQuotaWriterGeneration(writer)).toBeUndefined();
  expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.windows).toBeUndefined();
  setMainAccountCredentialPresence(false);
  setMainAccountCredentialPresence(true);
  expect(mainDecisionQuotaWriterGeneration(writer)).toBeUndefined();
  expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.windows).toBeUndefined();
  expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.usable).toBe(false);
  const current = observeMainQuotaCredential("replacement", "fixture-main")!;
  applyAccountQuotaFromUpstreamHeaders("__main__", new Headers({ "x-codex-tertiary-used-percent": "90" }), undefined, current);
  expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.windows?.[0]?.window).toBe("monthly");
  observeMainDecisionCredentialUsable(false);
  expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.usable).toBe(false);
  observeMainDecisionCredentialUsable(true);
});

test("accepted sole-key collector excludes display reports and detects owner-observed env replacement", () => {
  const provider = { adapter: "openai-chat" as const, baseUrl: "https://fixture.invalid/v1", apiKey: "$JEV_FIXTURE_QUOTA_KEY" };
  const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: provider } };
  const old = process.env.JEV_FIXTURE_QUOTA_KEY;
  try {
    process.env.JEV_FIXTURE_QUOTA_KEY = "fixture-one";
    const measured = { weeklyPercent: 90, updatedAt: now };
    const row = keyReport("fixture", "fixture", measured, provider, resolveProviderApiKey(provider.apiKey)!, measured)!;
    publishCollectedDecisionQuota([row], config);
    expect(readLoadedDecisionKeyQuota("fixture", provider)?.[0]?.percent).toBe(90);
    process.env.JEV_FIXTURE_QUOTA_KEY = "fixture-two";
    resolveProviderApiKey(provider.apiKey);
    expect(readLoadedDecisionKeyQuota("fixture", provider)).toBeUndefined();
    publishCollectedDecisionQuota([row], config);
    expect(readLoadedDecisionKeyQuota("fixture", provider)).toBeUndefined();
    publishDecisionKeyQuota("fixture", provider, [{ window: "weekly", percent: 90, observedAt: now }]);
    const display = keyReport("fixture", "fixture", measured, provider, "fixture-two")!;
    publishCollectedDecisionQuota([display], config);
    expect(readLoadedDecisionKeyQuota("fixture", provider)).toBeUndefined();
  } finally { if (old === undefined) delete process.env.JEV_FIXTURE_QUOTA_KEY; else process.env.JEV_FIXTURE_QUOTA_KEY = old; invalidateResolvedProviderKeyCache(); }
});

test("sole-key credits, USD and unscoped custom meters never become advisory windows", () => {
  const provider = { adapter: "openai-chat" as const, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-meter-key" };
  const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: provider } };
  const meters = {
    creditsUsd: { used: 99, limit: 100, remaining: 1, percent: 99 },
    customWindows: [{ label: "API credits ($1.00 of $100.00 remaining)", percent: 99 }, { label: "Opus", percent: 99 }, { label: "Total subscription credits", percent: 99 }],
    kiroCreditsUsed: 99, kiroCreditsLimit: 100, updatedAt: now,
  };
  publishCollectedDecisionQuota([keyReport("fixture", "fixture", meters, provider, "fixture-meter-key", meters)!], config);
  expect(readLoadedDecisionKeyQuota("fixture", provider) ?? []).toEqual([]);
  const subscription = { ...meters, fiveHourPercent: 12, updatedAt: now };
  publishCollectedDecisionQuota([keyReport("fixture", "fixture", subscription, provider, "fixture-meter-key", subscription)!], config);
  expect(readLoadedDecisionKeyQuota("fixture", provider)?.map(row => [row.window, row.percent])).toEqual([["5h", 12]]);
});

test("Ollama Cloud balance windows are advisory; the included-credit meter is not", () => {
  const provider = { adapter: "openai-chat" as const, baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-ollama-key" };
  const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: provider } };
  /** Publish a collected Ollama Cloud balance body through the real collector path. */
  const publish = (body: Record<string, unknown>) => {
    const quota = parseOllamaCloudBalance(body)!;
    publishCollectedDecisionQuota([keyReport("fixture", "fixture", quota, provider, "fixture-ollama-key", quota)!], config);
  };
  publish({ included: { session: { remaining_percent: 40 }, weekly: { remaining_percent: 25 }, allowance_usd: 10, balance_usd: 0.1 } });
  expect(readLoadedDecisionKeyQuota("fixture", provider)?.map(row => [row.window, row.percent])).toEqual([["5h", 60], ["weekly", 75]]);
  invalidateDecisionKeyQuotas();
  publish({ included: { allowance_usd: 10, balance_usd: 0.1 } });
  expect(readLoadedDecisionKeyQuota("fixture", provider) ?? []).toEqual([]);
});

test("snapshot reads cannot mutate retained evidence and config-root changes discard rows", () => {
  publishDecisionQuotaRoster("codex", [{ id: "fixture", generation: 1, usable: true }]);
  publishDecisionAccountQuota("codex", "fixture", 1, [{ window: "weekly", percent: 90, observedAt: now }]);
  const window = readLoadedDecisionQuotaPool("codex")![0]!.windows![0]!;
  window.percent = 0;
  expect(readLoadedDecisionQuotaPool("codex")![0]!.windows![0]!.percent).toBe(90);
  const previous = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home.path("other");
  try { expect(readLoadedDecisionQuotaPool("codex")).toBeUndefined(); } finally { process.env.OPENCODEX_HOME = previous; }
});

test("raw Anthropic producer preserves exact percent and invalid reset/overage stays unknown", async () => {
  const id = await anthropicAccount();
  const generation = credentialGeneration(credential);
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({
    five_hour: { utilization: -1 }, seven_day: { utilization: 69.999 },
    seven_day_opus: { utilization: 120 },
    limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Opus" } }, percent: 89.999 }],
  })) as unknown as typeof globalThis.fetch);
  try {
    const result = await probeAnthropicQuotaWithRecovery(id, credential.access, fresh => fetchAnthropicUsageQuota(credential.access, fresh), () => true);
    result!.publishDecisionQuota();
    const windows = readLoadedDecisionQuotaPool("anthropic")![0]!.windows;
    expect(jevQuotaSignalFromWindows(windows, "claude-opus-4", now).usedPercent).toBe(89.999);
    expect(jevQuotaSignalFromWindows(windows, "claude-sonnet-4", now).usedPercent).toBe(69.999);
  } finally { fetch.mockRestore(); }
  const headers = new Headers({ "anthropic-ratelimit-unified-7d-utilization": "0.699999", "anthropic-ratelimit-unified-7d_oi-utilization": "1.01" });
  recordAnthropicAccountQuotaFromHeaders(id, headers, Number.MAX_SAFE_INTEGER, 200, "claude-sonnet-4", generation);
  expect(jevQuotaSignalFromWindows(readLoadedDecisionQuotaPool("anthropic")![0]!.windows, "claude-sonnet-4", now).usedPercent).toBeCloseTo(69.9999, 8);
  recordAnthropicAccountQuotaFromHeaders(id, new Headers({ "anthropic-ratelimit-unified-7d-utilization": "0.9" }), Number.MAX_SAFE_INTEGER, 200);
  expect(jevQuotaSignalFromWindows(readLoadedDecisionQuotaPool("anthropic")![0]!.windows, "claude-sonnet-4", now).usedPercent).toBeCloseTo(69.9999, 8);
  expect(rawAnthropicHeaderWindows(headers, now).some(row => row.window === "fable")).toBe(false);
  expect(jevQuotaSignalFromWindows(rawAnthropicUsageWindows({ seven_day: { utilization: 90, resets_at: "invalid" } }, now), "a", now).tier).toBe("unknown");
});

test("bounded rosters never hide unknown usable accounts; account-wide quarantine survives replacement", () => {
  publishDecisionQuotaRoster("codex", [{ id: "fixture", generation: 1, usable: true }]);
  setDecisionAccountUsable("codex", "fixture", false);
  publishDecisionQuotaRoster("codex", [{ id: "fixture", generation: 2, usable: true }]);
  expect(readLoadedDecisionQuotaPool("codex")?.[0]?.usable).toBe(false);
  setDecisionAccountUsable("codex", "fixture", true, 2);
  expect(readLoadedDecisionQuotaPool("codex")?.[0]?.usable).toBe(false);
  setDecisionAccountUsable("codex", "fixture", true);
  expect(readLoadedDecisionQuotaPool("codex")?.[0]?.usable).toBe(true);
  const duplicates = Array.from({ length: 12 }, (_, i) => ({ window: "weekly" as const, percent: i === 11 ? 90 : 10, observedAt: now }));
  publishDecisionAccountQuota("codex", "fixture", 2, duplicates);
  expect(jevQuotaSignalFromWindows(readLoadedDecisionQuotaPool("codex")?.[0]?.windows, "a", now).usedPercent).toBe(90);
  publishDecisionQuotaRoster("codex", Array.from({ length: 1025 }, (_, i) => ({ id: String(i), generation: 1, usable: true })));
  expect(readLoadedDecisionQuotaPool("codex")).toBeUndefined();
});
